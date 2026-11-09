/**
 * Cloudflare R2 驱动验证（无需真实 R2 账号）。
 *
 * 1) 启动本地 S3 mock：独立复算 AWS SigV4，签名不符直接 403；
 * 2) 直接调用 dist/storage/r2.js 验证 PUT / GET / DELETE 与 key 编码；
 * 3) 启动 dist/launch.js（STORAGE_DRIVER=r2 + mock endpoint），走真实
 *    /api/storage/upload → /api/storage/public → /api/storage/remove 链路；
 * 4) 校验 R2_PUBLIC_URL 直出模式与 r2 缺配置时的启动报错。
 */
import http from 'node:http';
import net from 'node:net';
import { createHash, createHmac } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jwt from 'jsonwebtoken';
import {
  signRequest,
  normalizeKey,
  r2PutObject,
  r2GetObject,
  r2DeleteObject,
  r2PublicDirectUrl,
} from '../dist/storage/r2.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(HERE, '..');
const SECRET = 'test-r2-secret-key-0123456789';
const ACCESS_KEY = 'test-access-key';
const BUCKET = 'test-bucket';
const JWT_SECRET = 'local-r2-test-jwt-secret-0123456789';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
};
const section = (name) => console.log(`\n=== ${name} ===`);
const sha256 = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => createHmac('sha256', k).update(d, 'utf8').digest();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 本地 S3 mock ───────────────────────────────────────────────────────────
const objects = new Map();
const signFailures = [];

function verifySig(req, body) {
  const auth = req.headers.authorization || '';
  const m = auth.match(
    /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/,
  );
  if (!m) return `Authorization 格式错误: ${auth}`;
  const [, credential, signedHeaders, signature] = m;
  const parts = credential.split('/');
  if (parts.length !== 5 || parts[2] !== 'auto' || parts[3] !== 's3' || parts[4] !== 'aws4_request') {
    return `scope 错误: ${credential}`;
  }
  const [ak, dateStamp, region] = parts;
  if (ak !== ACCESS_KEY) return `AccessKeyId 错误: ${ak}`;

  const amzDate = req.headers['x-amz-date'];
  if (amzDate?.slice(0, 8) !== dateStamp) return 'x-amz-date 与 credential 日期不一致';
  const payloadHash = req.headers['x-amz-content-sha256'];
  if (payloadHash !== sha256(body)) return 'x-amz-content-sha256 与请求体不符';

  const names = signedHeaders.split(';');
  const canonicalHeaders = names
    .map((n) => `${n}:${String(req.headers[n] ?? '').trim()}\n`)
    .join('');
  const pathname = req.url.split('?')[0];
  const canonicalRequest = [req.method, pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const dateKey = hmac(`AWS4${SECRET}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const expected = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  if (expected !== signature) return `签名不匹配 expected=${expected} got=${signature}`;
  return null;
}

const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const err = verifySig(req, body);
  if (err) {
    signFailures.push(`${req.method} ${req.url}: ${err}`);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'SignatureDoesNotMatch', detail: err }));
    return;
  }
  // path-style：/<bucket>/<key...>
  const raw = req.url.split('?')[0].replace(/^\//, '');
  const slash = raw.indexOf('/');
  const key = decodeURIComponent(raw.slice(slash + 1).replace(/\+/g, '%2B'));
  if (req.method === 'PUT') {
    objects.set(key, { body, contentType: req.headers['content-type'] || 'application/octet-stream' });
    res.writeHead(200, { ETag: `"${sha256(body).slice(0, 16)}"` });
    res.end();
  } else if (req.method === 'GET') {
    const obj = objects.get(key);
    if (!obj) {
      res.writeHead(404, { 'Content-Type': 'application/xml' });
      res.end('<Error><Code>NoSuchKey</Code></Error>');
    } else {
      res.writeHead(200, { 'Content-Type': obj.contentType });
      res.end(obj.body);
    }
  } else if (req.method === 'DELETE') {
    objects.delete(key);
    res.writeHead(204);
    res.end();
  } else {
    res.writeHead(405);
    res.end();
  }
});

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

const mockPort = await freePort();
await new Promise((resolve) => mock.listen(mockPort, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${mockPort}`;
const cfg = {
  accountId: 'test-account',
  bucket: BUCKET,
  accessKeyId: ACCESS_KEY,
  secretAccessKey: SECRET,
  endpoint,
  region: 'auto',
  timeoutMs: 5000,
};

console.log(`[r2-test] S3 mock listening on ${endpoint}`);

// ─── 1. 签名与 key 编码 ─────────────────────────────────────────────────────
section('签名与 key 编码');
{
  const key = 'avatars/中文 头像+1(2).png';
  const signed = signRequest(cfg, 'PUT', key, Buffer.from('x'), 'image/png', new Date('2026-11-09T02:30:00Z'));
  check('Authorization 采用 AWS4-HMAC-SHA256', signed.headers.authorization.startsWith('AWS4-HMAC-SHA256 Credential='));
  check('签名头含 host / x-amz-* / content-type', /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,/.test(signed.headers.authorization));
  check('空格编码为 %20、中文按 UTF-8 百分号编码', signed.url.includes('%E4%B8%AD%E6%96%87%20') && signed.url.includes('%2B'), signed.url);
  check('RFC3986 补充转义括号', signed.url.includes('%28') && signed.url.includes('%29'), signed.url);
  check('x-amz-date 格式 YYYYMMDDTHHMMSSZ', /^\d{8}T\d{6}Z$/.test(signed.headers['x-amz-date']));
  let rejected = 0;
  for (const bad of ['', '../secret', 'a//b', 'a/../b', 'a\\..\\b']) {
    try { normalizeKey(bad); } catch { rejected++; }
  }
  check('拒绝空 key / 目录穿越 / 空路径段', rejected === 5, { rejected });
  check('normalizeKey 去掉前导斜杠并统一反斜杠', normalizeKey('/a\\b.png') === 'a/b.png');
}

// ─── 2. 驱动 PUT / GET / DELETE ─────────────────────────────────────────────
section('驱动对象操作');
{
  const content = Buffer.from('hello-r2-二进制\x00\xff');
  const put = await r2PutObject(cfg, 'avatars/plain.jpg', content, 'image/jpeg');
  check('PUT 成功且返回 ETag', !put.error && !!put.etag, put.error?.message);

  const get = await r2GetObject(cfg, 'avatars/plain.jpg');
  check('GET 内容与写入完全一致', !get.error && get.buffer?.equals(content), get.error?.message);
  check('GET 透传 R2 的 Content-Type', get.contentType === 'image/jpeg', get.contentType);

  const special = 'avatars/中文 头像+1(2).png';
  const put2 = await r2PutObject(cfg, special, content, 'image/png');
  const get2 = await r2GetObject(cfg, special);
  check('特殊字符 key 往返一致（编码未丢失）', !put2.error && !get2.error && get2.buffer?.equals(content), {
    put: put2.error?.message, get: get2.error?.message,
  });

  const missing = await r2GetObject(cfg, 'avatars/not-exist.png');
  check('GET 不存在的对象返回错误而非崩溃', !!missing.error && missing.buffer === null);

  const del = await r2DeleteObject(cfg, 'avatars/plain.jpg');
  const after = await r2GetObject(cfg, 'avatars/plain.jpg');
  check('DELETE 生效（再次 GET 为 404）', !del.error && !!after.error, del.error?.message);

  check('三次操作均通过 mock 的独立 SigV4 复算', signFailures.length === 0, signFailures);
}

// ─── 3. publicUrl 两种模式 ──────────────────────────────────────────────────
section('publicUrl 模式');
{
  const direct = r2PublicDirectUrl('https://cdn.example.com/', 'avatars/中文 图.png');
  check('公开域直出不含 R2 桶名', direct.startsWith('https://cdn.example.com/avatars/'), direct);
  check('公开域 URL 正确编码特殊字符', direct.includes('%E4%B8%AD%E6%96%87%20'), direct);
  check('未配置公开域返回 null（回落后端代理）', r2PublicDirectUrl('', 'a.png') === null);

  const probe = (extra) => {
    const code = `import { publicUrl } from './dist/storage/index.js'; console.log(JSON.stringify(publicUrl('avatars','a b.png')));`;
    return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: BACKEND,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
        JWT_SECRET,
        STORAGE_DRIVER: 'r2',
        R2_ACCOUNT_ID: 'test-account',
        R2_BUCKET: BUCKET,
        R2_ACCESS_KEY_ID: ACCESS_KEY,
        R2_SECRET_ACCESS_KEY: SECRET,
        R2_ENDPOINT: endpoint,
        PUBLIC_BASE_URL: 'https://api.example.com',
        R2_PUBLIC_URL: '',
        ...extra,
      },
    }).trim();
  };
  const proxyUrl = JSON.parse(probe({}));
  check('代理模式返回绝对 URL 且指向 /api/storage/public', proxyUrl === 'https://api.example.com/api/storage/public/avatars/a%20b.png' || proxyUrl === 'https://api.example.com/api/storage/public/avatars/a b.png', proxyUrl);
  const directUrl = JSON.parse(probe({ R2_PUBLIC_URL: 'https://cdn.example.com' }));
  check('配置公开域后改为直出 URL', directUrl === 'https://cdn.example.com/avatars/a%20b.png', directUrl);

  let envFailed = false;
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', `await import('./dist/env.js');`], {
      cwd: BACKEND,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
        JWT_SECRET,
        STORAGE_DRIVER: 'r2',
        R2_ACCOUNT_ID: '',
        R2_BUCKET: '',
        R2_ACCESS_KEY_ID: '',
        R2_SECRET_ACCESS_KEY: '',
      },
    });
  } catch { envFailed = true; }
  check('r2 缺少凭据时启动即报错（不延迟到首次上传）', envFailed);
}

// ─── 4. HTTP 路由端到端 ─────────────────────────────────────────────────────
section('HTTP 路由端到端（真实 dist/launch.js）');
let server;
try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['dist/launch.js'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
      JWT_SECRET,
      PORT: String(port),
      PUBLIC_BASE_URL: base,
      STORAGE_DRIVER: 'r2',
      R2_ACCOUNT_ID: 'test-account',
      R2_BUCKET: BUCKET,
      R2_ACCESS_KEY_ID: ACCESS_KEY,
      R2_SECRET_ACCESS_KEY: SECRET,
      R2_ENDPOINT: endpoint,
      R2_PUBLIC_URL: '',
      R2_TIMEOUT_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  let healthy = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) { healthy = true; break; }
    } catch { /* 尚未启动 */ }
    await sleep(150);
  }
  check('服务以 r2 驱动启动成功', healthy, serverLog.slice(-400));

  if (healthy) {
    const token = jwt.sign({ uid: 'r2-test-user', username: 'r2-test' }, JWT_SECRET);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const content = Buffer.from('png-via-http-route');
    const up = await fetch(`${base}/api/storage/upload`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        bucket: 'avatars',
        path: 'http/e2e.png',
        contentBase64: content.toString('base64'),
        contentType: 'image/png',
      }),
    });
    const upBody = await up.json();
    check('上传接口返回 200 与绝对 publicUrl', up.status === 200 && /^http:\/\//.test(upBody?.data?.publicUrl || ''), upBody);
    check('R2 中对象 key 带业务 bucket 前缀', objects.has('avatars/http/e2e.png'), [...objects.keys()]);

    const got = await fetch(upBody.data.publicUrl);
    const gotBuf = Buffer.from(await got.arrayBuffer());
    check('公开读回内容与上传一致', got.status === 200 && gotBuf.equals(content), { status: got.status });
    check('公开读透传 R2 Content-Type', got.headers.get('content-type') === 'image/png', got.headers.get('content-type'));

    const noAuth = await fetch(`${base}/api/storage/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'avatars', paths: ['http/e2e.png'] }),
    });
    check('删除接口未带 token 返回 401', noAuth.status === 401);

    const rm = await fetch(`${base}/api/storage/remove`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ bucket: 'avatars', paths: ['http/e2e.png'] }),
    });
    check('删除接口返回成功', rm.status === 200 && (await rm.json())?.data?.removed === 1);
    const gone = await fetch(upBody.data.publicUrl);
    check('删除后公开读返回 404', gone.status === 404, { status: gone.status });

    check('HTTP 链路未出现签名错误', signFailures.length === 0, signFailures);
  }
} finally {
  if (server) {
    server.kill();
    await Promise.race([new Promise((r) => server.once('exit', r)), sleep(2000)]);
  }
}

mock.close();
console.log(`\n[r2-test] 结果：${passed} 通过 / ${failed} 失败`);
if (failed) process.exit(1);
