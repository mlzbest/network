/**
 * 一键准备「真实 Cloudflare R2」凭据并跑联网冒烟。
 *
 * 只需要一个 Cloudflare API Token（环境变量 CLOUDFLARE_API_TOKEN）；脚本会：
 *   1. 自动解析 Account ID，探测 R2 是否已开通；
 *   2. 已开通时自动创建测试桶（不存在才建）；
 *   3. 通过 Cloudflare API 签发一枚 24 小时、仅 R2 写权限的临时 API Token，
 *      按官方规则推导出 S3 凭据：Access Key ID = token.id，
 *      Secret Access Key = sha256(token.value) 的十六进制；
 *   4. 把凭据写入 backend/.env（已被 .gitignore 忽略），执行 smoke-r2-live.mjs；
 *   5. 无论成败都删除临时 Token、还原/删除 .env，并删除本次创建的测试桶。
 *
 * 用法（在仓库任意目录均可）：
 *   CLOUDFLARE_API_TOKEN=<token> node backend/scripts/prepare-r2-live.mjs
 *   CLOUDFLARE_API_TOKEN=<token> node backend/scripts/prepare-r2-live.mjs \
 *     --bucket my-bucket --endpoint https://<s3-proxy> --timeout 20000
 *
 * 可选参数：
 *   --bucket <name>       测试桶名，默认 network-selfhost-smoke
 *   --endpoint <url>      覆盖 R2_ENDPOINT（本机到 *.r2.cloudflarestorage.com 不通时可指向中转）
 *   --public-url <url>    R2 自定义公开域（可选）
 *   --timeout <ms>        单次请求超时，默认 15000
 *   --force-relay         强制走 R2 REST 适配层（验证兜底通道 / 绕过 S3 端点阻断）
 *   --keep-bucket         保留本次创建的测试桶
 *   --keep-env            保留 backend/.env（默认运行后删除）
 *
 * 安全：Token 只存在于进程内存与请求头，绝不写入文件；日志不回显任何密钥。
 * 退出码：透传冒烟脚本的 0/1/2/3；准备阶段失败返回 5。
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(HERE, '..');
const API_BASE = 'https://api.cloudflare.com/client/v4';
const ENV_FILE = join(BACKEND, '.env');
const SMOKE = join(HERE, 'smoke-r2-live.mjs');
const RELAY = join(HERE, 'r2-rest-relay.mjs');
// Account 级权限组：Workers R2 Storage Write
const R2_WRITE_GROUP = 'bf7481a1826f439697cb59a20b22293e';

const argv = process.argv.slice(2);
const value = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(name);

const bucket = value('--bucket', 'network-selfhost-smoke');
const endpointOverride = value('--endpoint', '');
const publicUrl = value('--public-url', '');
const timeoutMs = value('--timeout', '15000');
const keepBucket = flag('--keep-bucket');
const keepEnv = flag('--keep-env');

const apiToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
if (!apiToken) {
  console.error('[prepare] 缺少 CLOUDFLARE_API_TOKEN 环境变量，无法自动获取 R2 凭据。');
  process.exit(2);
}

/** Cloudflare v4 API 调用。走 curl 以复用系统代理（本机 Node fetch 直连被 403）。 */
function cf(method, path, body) {
  const args = [
    '-sS', '--max-time', '25', '-X', method,
    '-H', `Authorization: Bearer ${apiToken}`,
    '-H', 'Content-Type: application/json',
  ];
  if (body !== undefined) args.push('-d', JSON.stringify(body));
  args.push(API_BASE + path);
  const r = spawnSync('curl', args, {
    encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) throw new Error(`curl 调用失败: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`curl 退出码 ${r.status}: ${String(r.stderr).slice(0, 200)}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`Cloudflare API 返回非 JSON: ${String(r.stdout).slice(0, 200)}`);
  }
}

const beijing = (d) => new Date(d.getTime() + 8 * 3600 * 1000)
  .toISOString().replace('T', ' ').slice(0, 19) + ' 北京';
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
let tokenId = '';
let bucketCreated = false;
let envOriginal = null;
let createdBucket = false;
let r2Enabled = false;
let smokeStatus = 3;
let relay = null;
let relayUsed = false;
let endpoint = endpointOverride;

try {
  // ─── 1. Account ID ─────────────────────────────────────────────────────────
  if (!accountId) {
    const r = cf('GET', '/accounts');
    if (!r.success || !r.result?.length) throw new Error('无法列出 Cloudflare 账号，请检查 Token 是否有效');
    accountId = r.result[0].id;
  }
  console.log(`[prepare] Account ID: ****${accountId.slice(-6)}（共 ${accountId.length} 位）`);

  // ─── 2. 探测 R2 状态 / 创建测试桶 ───────────────────────────────────────────
  const list = cf('GET', `/accounts/${accountId}/r2/buckets`);
  if (list.success) {
    r2Enabled = true;
    const exists = (list.result?.buckets || []).some((b) => b.name === bucket);
    console.log(`[prepare] R2 已开通；测试桶 ${bucket} ${exists ? '已存在' : '不存在'}`);
    if (!exists) {
      const c = cf('POST', `/accounts/${accountId}/r2/buckets`, { name: bucket });
      if (c.success) { bucketCreated = true; createdBucket = true; console.log(`[prepare] 已创建测试桶 ${bucket}`); }
      else console.log(`[prepare] 创建桶失败: ${JSON.stringify(c.errors || [])}`);
    }
  } else {
    const codes = (list.errors || []).map((e) => e.code);
    if (codes.includes(10042)) {
      console.log('[prepare] ⚠ R2 尚未开通（错误 10042）。Cloudflare 要求先在 Dashboard 人工开通');
      console.log('[prepare]   （免费额度也需绑定支付方式），任何 API 都无法代开。');
      console.log('[prepare]   开通入口: https://dash.cloudflare.com/?to=/:account/r2/overview');
      console.log('[prepare]   本轮仍会用真实签发的 S3 凭据跑一次冒烟，以验证网络链路与脚本行为。');
    } else {
      console.log(`[prepare] ⚠ R2 桶列表失败: ${JSON.stringify(list.errors || [])}`);
    }
  }

  // ─── 3. 签发临时 R2 Token，推导 S3 凭据 ─────────────────────────────────────
  const expires = new Date(Date.now() + 24 * 3600 * 1000);
  const created = cf('POST', `/accounts/${accountId}/tokens`, {
    name: `network-r2-smoke-${new Date().toISOString().slice(0, 10)}`,
    policies: [{
      effect: 'allow',
      resources: {
        [`com.cloudflare.api.account.${accountId}`]: { 'com.cloudflare.edge.r2.bucket.*': '*' },
      },
      permission_groups: [{ id: R2_WRITE_GROUP, name: 'Workers R2 Storage Write' }],
    }],
    expires_on: expires.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  if (!created.success || !created.result?.id || !created.result?.value) {
    throw new Error(`签发 R2 Token 失败: ${JSON.stringify(created.errors || [])}`);
  }
  tokenId = created.result.id;
  const accessKeyId = tokenId;
  const secretAccessKey = createHash('sha256').update(created.result.value).digest('hex');
  console.log(`[prepare] 已签发临时 R2 Token（仅 R2 写权限，过期 ${beijing(expires)}）`);
  console.log(`[prepare] Access Key ID 已就绪（长度 ${accessKeyId.length}），Secret 由 token value 派生，均不回显`);

  // ─── 3.5 网络自检：S3 端点不通时自动启用 R2 REST 适配层 ─────────────────────
  if (!endpoint) {
    const forced = flag('--force-relay');
    let needRelay = forced;
    let probeCode = 0;
    if (!needRelay) {
      const s3Probe = spawnSync('curl', [
        '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '12',
        `https://${accountId}.r2.cloudflarestorage.com/`,
      ], { encoding: 'utf8', windowsHide: true });
      probeCode = Number(String(s3Probe.stdout || '').trim()) || 0;
      needRelay = probeCode === 0;
    }
    if (needRelay) {
      console.log(`[prepare] 启用 R2 REST 适配层${forced ? '（--force-relay）' : '（S3 端点 TLS 不通）'}：走 api.cloudflare.com 通道`);
      const p = await freePort();
      endpoint = `http://127.0.0.1:${p}`;
      relay = spawn(process.execPath, [RELAY], {
        cwd: BACKEND,
        env: {
          ...process.env,
          PORT: String(p),
          RELAY_ENDPOINT: endpoint,
          R2_ACCOUNT_ID: accountId,
          R2_BUCKET: bucket,
          R2_ACCESS_KEY_ID: accessKeyId,
          R2_SECRET_ACCESS_KEY: secretAccessKey,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let relayLog = '';
      relay.stdout.on('data', (d) => { relayLog += d; });
      relay.stderr.on('data', (d) => { relayLog += d; });
      let ready = false;
      for (let i = 0; i < 40; i++) {
        try {
          const r = await fetch(`${endpoint}/`, { signal: AbortSignal.timeout(1000) });
          if (r.ok) { ready = true; break; }
        } catch { /* 尚未启动 */ }
        await sleep(150);
      }
      if (!ready) throw new Error(`R2 REST 适配层启动失败: ${relayLog.slice(-300)}`);
      relayUsed = true;
      console.log(`[prepare] 适配层就绪 ${endpoint}（SigV4 仍由驱动原生生成并被独立复算校验）`);
    } else {
      console.log(`[prepare] R2 S3 端点可达（预检 HTTP ${probeCode}），直连官方 endpoint`);
    }
  }

  // ─── 4. 写 backend/.env 并跑冒烟 ────────────────────────────────────────────
  envOriginal = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : null;
  const envText = [
    '# 由 prepare-r2-live.mjs 临时生成，脚本结束后自动还原/删除',
    `R2_ACCOUNT_ID=${accountId}`,
    `R2_BUCKET=${bucket}`,
    `R2_ACCESS_KEY_ID=${accessKeyId}`,
    `R2_SECRET_ACCESS_KEY=${secretAccessKey}`,
    'R2_REGION=auto',
    `R2_TIMEOUT_MS=${timeoutMs}`,
    endpoint ? `R2_ENDPOINT=${endpoint}` : '# R2_ENDPOINT=（默认 Cloudflare 官方端点）',
    publicUrl ? `R2_PUBLIC_URL=${publicUrl}` : '# R2_PUBLIC_URL=（未绑定公开域）',
    '',
  ].join('\n');
  writeFileSync(ENV_FILE, envText, { encoding: 'utf8', mode: 0o600 });
  console.log('[prepare] 凭据已写入 backend/.env（已 gitignore）');

  const childEnv = { ...process.env };
  delete childEnv.CLOUDFLARE_API_TOKEN; // 不把主 Token 传给冒烟/后端子进程
  console.log('[prepare] ── 开始真实 R2 联网冒烟 ──');
  const smoke = spawnSync(process.execPath, [SMOKE], {
    cwd: BACKEND, env: childEnv, stdio: 'inherit', windowsHide: true,
  });
  smokeStatus = smoke.status ?? 1;
  console.log(`[prepare] ── 冒烟结束，退出码 ${smokeStatus} ──`);
} catch (e) {
  console.error(`[prepare] 准备阶段失败: ${String(e.message || e).slice(0, 300)}`);
  smokeStatus = 5;
} finally {
  // ─── 5. 清理 ───────────────────────────────────────────────────────────────
  if (relay) {
    relay.kill();
    console.log('[prepare] R2 REST 适配层已停止');
  }
  if (tokenId && accountId) {
    try {
      const d = cf('DELETE', `/accounts/${accountId}/tokens/${tokenId}`);
      console.log(`[prepare] 临时 Token 已${d.success ? '删除' : '删除失败（请手动确认）'}`);
    } catch (e) { console.log(`[prepare] 临时 Token 删除异常: ${String(e.message).slice(0, 120)}`); }
  }
  if (envOriginal !== null) {
    try { writeFileSync(ENV_FILE, envOriginal); console.log('[prepare] backend/.env 已还原为原内容'); } catch { /* ignore */ }
  } else if (!keepEnv && existsSync(ENV_FILE)) {
    try { unlinkSync(ENV_FILE); console.log('[prepare] 临时 backend/.env 已删除'); } catch { /* ignore */ }
  }
  if (bucketCreated && !keepBucket && accountId) {
    try {
      const d = cf('DELETE', `/accounts/${accountId}/r2/buckets/${bucket}`);
      console.log(`[prepare] 测试桶 ${bucket} 已${d.success ? '删除' : '删除失败（请手动确认）'}`);
    } catch (e) { console.log(`[prepare] 测试桶删除异常: ${String(e.message).slice(0, 120)}`); }
  }
  if (!r2Enabled) {
    console.log('\n[prepare] 结论：R2 服务未开通（10042），本轮无法完成真实对象读写。');
    console.log('[prepare] 请在 Dashboard 开通 R2 后重跑本脚本，即可全自动完成冒烟。');
  }
  if (smokeStatus === 0) {
    console.log(`\n[prepare] 结论：真实 R2 联网冒烟全部通过${relayUsed ? '（经 R2 REST 适配层绕过本机 S3 端点阻断）' : '（直连 R2 S3 端点）'}。`);
  }
  if (smokeStatus === 3) {
    console.log('\n[prepare] 结论：本机到 *.r2.cloudflarestorage.com 的 TLS 握手失败（网络层）。');
    console.log('[prepare] api.cloudflare.com 正常，说明是该域名被本机链路/代理拦截。');
    console.log('[prepare] 可换网络重试，或用 --endpoint 指向可达的 S3 兼容中转。');
  }
}

process.exit(smokeStatus);
