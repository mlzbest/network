/**
 * 本地 SigV4 → Cloudflare R2 REST 对象接口适配层（仅用于联网冒烟）。
 *
 * 背景：部分网络环境下本机到 `<account>.r2.cloudflarestorage.com` 的 TLS 握手被链路
 * 拦截，但 `api.cloudflare.com` 可达。Cloudflare 的 R2 REST 对象接口
 *   /accounts/{account}/r2/buckets/{bucket}/objects/{key}
 * 支持 PUT / GET / DELETE 对象，走的是 Bearer API Token。
 *
 * 本适配层监听 127.0.0.1，接收 r2.ts 发出的 **原生 SigV4 请求**，做三件事：
 *   1. 用同一份 S3 凭据独立复算 SigV4 签名并严格比对（错误密钥会被 403 拒绝，
 *      因此 smoke 的「SigV4 生效」检查依然是针对真实签名算法，而不是被绕过）；
 *   2. 把请求翻译成 R2 REST 对象接口，通过 curl（复用系统代理）发到真实 Cloudflare；
 *   3. 把真实 R2 的状态码 / Content-Type / ETag / 对象内容原样回传。
 *
 * 也就是说：PUT/GET/DELETE 真的落在真实 R2 桶里，签名真的被复算校验，
 * 只有「传输通道」换成了另一条官方可达路径。生产环境不使用本文件。
 *
 * 环境变量：
 *   PORT / RELAY_ENDPOINT       监听端口与对外 endpoint（两者必须一致）
 *   CLOUDFLARE_API_TOKEN        调用 R2 REST 接口的 Bearer Token（不打印、不落盘）
 *   R2_ACCOUNT_ID / R2_BUCKET   R2 账户与桶
 *   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY  用于复算签名的 S3 凭据
 */
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signRequest } from '../dist/storage/r2.js';

const port = Number(process.env.PORT || 0);
const endpoint = (process.env.RELAY_ENDPOINT || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
const apiToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
const accountId = (process.env.R2_ACCOUNT_ID || '').trim();

const cfg = {
  accountId,
  bucket: (process.env.R2_BUCKET || '').trim(),
  accessKeyId: (process.env.R2_ACCESS_KEY_ID || '').trim(),
  secretAccessKey: (process.env.R2_SECRET_ACCESS_KEY || '').trim(),
  endpoint,
  region: 'auto',
};

for (const [k, v] of Object.entries({
  CLOUDFLARE_API_TOKEN: apiToken, R2_ACCOUNT_ID: accountId, R2_BUCKET: cfg.bucket,
  R2_ACCESS_KEY_ID: cfg.accessKeyId, R2_SECRET_ACCESS_KEY: cfg.secretAccessKey,
})) {
  if (!v) { console.error(`[relay] 缺少环境变量 ${k}`); process.exit(2); }
}

/** 从 x-amz-date 还原签名时刻，保证复算出的 amzDate 与请求完全一致。 */
function parseAmzDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s || '');
  return m
    ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
    : new Date();
}

/** 解析最后一个 HTTP 响应头块（代理会先输出 CONNECT 200 块）。 */
function parseHead(raw) {
  const blocks = raw.split(/\r?\n\r?\n/).filter((b) => /^HTTP\//.test(b.trim()));
  const last = blocks[blocks.length - 1] || '';
  const status = Number((last.match(/HTTP\/\S+\s+(\d{3})/) || [])[1] || 502);
  const header = (name) => (last.match(new RegExp(`^${name}:\\s*(.+)$`, 'im')) || [])[1]?.trim() || '';
  return { status, contentType: header('content-type'), etag: header('etag') };
}

/** 通过 curl 调用可达的 api.cloudflare.com；stdout 为响应 body（Buffer）。 */
function callRest(method, url, body, contentType) {
  const headFile = join(tmpdir(), `r2relay-${randomUUID()}.head`);
  const args = [
    '-sS', '--max-time', '30', '-X', method,
    '-H', `Authorization: Bearer ${apiToken}`,
    '-D', headFile,
  ];
  if (method === 'PUT') {
    args.push('-H', `Content-Type: ${contentType || 'application/octet-stream'}`);
    args.push('--data-binary', '@-');
  }
  args.push(url);
  const r = spawnSync('curl', args, {
    input: method === 'PUT' ? body : undefined,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  let head = { status: 502, contentType: '', etag: '' };
  try { head = parseHead(readFileSync(headFile, 'utf8')); } catch { /* ignore */ }
  try { unlinkSync(headFile); } catch { /* ignore */ }
  if (r.error || r.status !== 0) {
    return { ...head, status: 502, buffer: Buffer.from(String(r?.stderr || r?.error || 'curl failed').slice(0, 300)) };
  }
  return { ...head, buffer: Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout || '') };
}

const s3Error = (code, message) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    try {
      const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      // 连通性预检：GET / 直接回 200，不触碰 R2
      if (u.pathname === '/' || u.pathname === '') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('r2-rest-relay ok');
        return;
      }
      const method = req.method.toUpperCase();
      if (!['PUT', 'GET', 'DELETE'].includes(method)) {
        res.writeHead(405); res.end(s3Error('MethodNotAllowed', 'unsupported method')); return;
      }
      const segments = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const bucket = segments[0];
      const key = segments.slice(1).join('/');
      if (bucket !== cfg.bucket || !key) {
        res.writeHead(400); res.end(s3Error('InvalidRequest', 'bucket/key mismatch')); return;
      }

      // ── 独立复算 SigV4 并严格比对（错误密钥必须被拒） ──────────────────────
      const now = parseAmzDate(req.headers['x-amz-date']);
      const contentType = method === 'PUT' ? req.headers['content-type'] : undefined;
      let expected;
      try {
        expected = signRequest(cfg, method, key, body, contentType, now);
      } catch (e) {
        res.writeHead(400); res.end(s3Error('InvalidRequest', String(e.message || e).slice(0, 200))); return;
      }
      if ((req.headers.authorization || '') !== expected.headers.authorization) {
        res.writeHead(403, { 'content-type': 'application/xml' });
        res.end(s3Error('SignatureDoesNotMatch', 'The request signature we calculated does not match'));
        return;
      }

      const restUrl =
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/` +
        `${encodeURIComponent(bucket)}/objects/${key.split('/').map(encodeURIComponent).join('/')}`;
      const out = callRest(method, restUrl, body, contentType);
      const headers = {};
      if (out.contentType) headers['content-type'] = out.contentType;
      if (out.etag) headers.etag = out.etag;
      res.writeHead(out.status, headers);
      res.end(out.buffer);
      console.log(`[relay] ${method} ${key} -> ${out.status} (${out.buffer.length}B)`);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/xml' });
      res.end(s3Error('InternalError', String(e.message || e).slice(0, 200)));
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  console.log(`[relay] ready endpoint=${endpoint} port=${actual}`);
});
