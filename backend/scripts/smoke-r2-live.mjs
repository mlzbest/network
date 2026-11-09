/**
 * 真实 Cloudflare R2 联网冒烟。
 *
 * 凭据全部从环境变量读取，脚本不打印任何密钥；报错文本也会做脱敏替换。
 * 用法：
 *   R2_ACCOUNT_ID=... R2_BUCKET=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
 *     node scripts/smoke-r2-live.mjs
 *
 * 输出退出码：0 全通过 / 1 功能失败 / 2 凭据缺失 / 3 网络层不可达。
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import {
  r2PutObject,
  r2GetObject,
  r2DeleteObject,
  r2PublicDirectUrl,
} from '../dist/storage/r2.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(HERE, '..');
// 允许把凭据放在 backend/.env（已 gitignore）；命令行导出的环境变量优先。
dotenv.config({ path: join(BACKEND, '.env'), quiet: true });
const REQUIRED = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
if (missing.length) {
  console.error(`[r2-live] 缺少环境变量: ${missing.join(', ')}`);
  console.error('[r2-live] 请写入 backend/.env（已 gitignore）或直接作为环境变量传入。');
  process.exit(2);
}

const accountId = process.env.R2_ACCOUNT_ID.trim();
const bucket = process.env.R2_BUCKET.trim();
const accessKeyId = process.env.R2_ACCESS_KEY_ID.trim();
const secret = process.env.R2_SECRET_ACCESS_KEY.trim();
const endpoint = (process.env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
const publicBase = process.env.R2_PUBLIC_URL?.trim() || '';
const cfg = {
  accountId,
  bucket,
  accessKeyId,
  secretAccessKey: secret,
  endpoint,
  region: process.env.R2_REGION?.trim() || 'auto',
  timeoutMs: Number(process.env.R2_TIMEOUT_MS) || 15_000,
};

const JWT_SECRET = 'r2-live-smoke-local-jwt-0123456789';
let passed = 0;
let failed = 0;
let cleanupNeeded = false;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` -> ${redact(detail)}` : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return String(s)
    .split(accessKeyId).join('<ACCESS_KEY>')
    .split(secret).join('<SECRET>')
    .slice(0, 400);
};
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const runId = `${Date.now()}-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 8)}`;
const key = `__smoke__/${runId}/probe.txt`;
const content = Buffer.from(`r2-live-smoke ${new Date().toISOString()} ${runId}\n`);

console.log('[r2-live] 脱敏配置摘要：');
console.log(`  endpoint     : ${new URL(endpoint).host}`);
console.log(`  accountId    : 长度 ${accountId.length}，尾号 ****${accountId.slice(-4)}`);
console.log(`  bucket       : ${bucket}`);
console.log(`  region       : ${cfg.region}`);
console.log(`  公开域        : ${publicBase ? new URL(publicBase).host : '（未配置，走后端代理）'}`);
console.log(`  测试对象 key  : ${key}`);

// ─── 0. 连通性预检（区分网络问题与凭据问题）─────────────────────────────────
section('连通性预检');
{
  let status = 0;
  let err = null;
  try {
    // 不带签名的请求，R2 应回 4xx；只要能建立 TLS 并拿到 HTTP 状态码即算网络可达
    const r = await fetch(`${endpoint}/`, { signal: AbortSignal.timeout(cfg.timeoutMs) });
    status = r.status;
  } catch (e) {
    err = e;
  }
  if (err) {
    console.error(`[r2-live] 无法与 ${new URL(endpoint).host} 建立 TLS/HTTP 连接。`);
    console.error(`[r2-live] 原因：${redact(err?.message || String(err))}${err?.cause?.code ? ` / ${err.cause.code}` : ''}`);
    console.error('[r2-live] 这不是凭据错误。可能原因：占位 Account ID 的 SNI 被 Cloudflare 拒绝、');
    console.error('[r2-live] 本机网络/代理拦截 *.r2.cloudflarestorage.com，或 R2_ENDPOINT 填错。');
    console.error('[r2-live] 可换网络重试，或把 R2_ENDPOINT 指向可达的 S3 兼容中转。');
    process.exit(3);
  }
  check(`TLS + HTTP 可达（未签名请求返回 ${status}）`, status > 0 && status < 500, { status });
}

// ─── 1. 直连驱动：PUT / GET / DELETE ────────────────────────────────────────
section('真实 R2 对象操作');
let server;
try {
  const put = await r2PutObject(cfg, key, content, 'text/plain; charset=utf-8');
  cleanupNeeded = !put.error;
  check('PUT 上传成功', !put.error, put.error?.message);
  if (put.error) throw new Error('PUT 失败，跳过后续对象操作');

  const get = await r2GetObject(cfg, key);
  check('GET 内容与上传完全一致', !get.error && get.buffer?.equals(content), get.error?.message);
  check('GET 带回对象 Content-Type', (get.contentType || '').startsWith('text/plain'), get.contentType);

  // 错误密钥必须被 R2 拒绝，证明服务端确实在验签（而不是恰好放行匿名请求）
  const bad = await r2GetObject({ ...cfg, secretAccessKey: `wrong-${secret.slice(0, -2)}xx` }, key);
  check('错误密钥被 R2 拒绝（SigV4 生效）', !!bad.error && bad.buffer === null, {
    error: bad.error?.message, hasBuffer: !!bad.buffer,
  });

  if (publicBase) {
    const direct = r2PublicDirectUrl(publicBase, key);
    let ok = false;
    let note = '';
    try {
      const r = await fetch(direct, { signal: AbortSignal.timeout(cfg.timeoutMs) });
      ok = r.status === 200;
      note = `HTTP ${r.status}`;
    } catch (e) { note = e?.message || String(e); }
    // 公开域未绑定属于配置未完成，只警告不判失败
    console.log(`  ${ok ? 'PASS' : 'WARN'}  公开域直读 ${new URL(publicBase).host}: ${redact(note)}${ok ? '' : '（需在 R2 绑定自定义域或启用公开访问）'}`);
    if (ok) passed++;
  }

  const del = await r2DeleteObject(cfg, key);
  cleanupNeeded = false;
  check('DELETE 删除成功', !del.error, del.error?.message);
  const gone = await r2GetObject(cfg, key);
  check('删除后对象不可读', !!gone.error, { error: gone.error?.message, status: gone.buffer?.length });

  // ─── 2. 本地后端 + 真实 R2 的 HTTP 全链路 ─────────────────────────────────
  section('后端 HTTP 路由（真实 R2 落盘）');
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
      R2_ACCOUNT_ID: accountId,
      R2_BUCKET: bucket,
      R2_ACCESS_KEY_ID: accessKeyId,
      R2_SECRET_ACCESS_KEY: secret,
      R2_ENDPOINT: endpoint,
      R2_REGION: cfg.region,
      R2_TIMEOUT_MS: String(cfg.timeoutMs),
      R2_PUBLIC_URL: '', // 强制走后端代理，避免公开域未绑定干扰 HTTP 段
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
  check('服务以 r2 驱动启动', healthy, serverLog.slice(-400));

  if (healthy) {
    const token = jwt.sign({ uid: 'r2-live-smoke', username: 'r2-live-smoke' }, JWT_SECRET);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const up = await fetch(`${base}/api/storage/upload`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        bucket: 'avatars',
        path: `http/${runId}.txt`,
        contentBase64: content.toString('base64'),
        contentType: 'text/plain',
      }),
    });
    const upBody = await up.json().catch(() => ({}));
    check('上传接口 200 且返回绝对 publicUrl', up.status === 200 && /^http:\/\//.test(upBody?.data?.publicUrl || ''), upBody);

    if (upBody?.data?.publicUrl) {
      const got = await fetch(upBody.data.publicUrl);
      const buf = Buffer.from(await got.arrayBuffer());
      check('公开读回内容与上传一致', got.status === 200 && buf.equals(content), { status: got.status });
      check('公开读透传 Content-Type', (got.headers.get('content-type') || '').startsWith('text/plain'), got.headers.get('content-type'));
    }

    const rm = await fetch(`${base}/api/storage/remove`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ bucket: 'avatars', paths: [`http/${runId}.txt`] }),
    });
    check('删除接口成功', rm.status === 200, { status: rm.status });
    // 独立确认 R2 中该对象确已不存在
    const stillThere = await r2GetObject(cfg, `avatars/http/${runId}.txt`);
    check('删除后 R2 对象确已清除', !!stillThere.error, { error: stillThere.error?.message });
  }
} catch (e) {
  failed++;
  console.log(`  FAIL  流程异常中断 -> ${redact(e?.message || String(e))}`);
} finally {
  if (cleanupNeeded) {
    // 中途失败时尽力清理测试对象，避免留下垃圾
    try { await r2DeleteObject(cfg, key); console.log('[r2-live] 已清理残留测试对象'); } catch { /* ignore */ }
  }
  if (server) {
    server.kill();
    await Promise.race([new Promise((r) => server.once('exit', r)), sleep(2000)]);
  }
}

console.log(`\n[r2-live] 结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
