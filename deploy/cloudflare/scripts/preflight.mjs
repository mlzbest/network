/**
 * 部署前置检查（只读，不创建/修改任何云端资源）。
 *
 *   node scripts/preflight.mjs            # Cloudflare Containers 模式（暂缓）
 *   node scripts/preflight.mjs --vps      # VPS + 外部 Postgres 模式
 *   node scripts/preflight.mjs --workers  # Cloudflare Workers Free 模式（当前主路径）
 *   CLOUDFLARE_API_TOKEN=... node scripts/preflight.mjs --workers
 *
 * 检查项：Token/Account、R2 开通、Zone 与域名 DNS、本机工具链、
 *         运行密钥完整性、外部 Postgres 连通性。
 * Containers 模式额外检查 Workers Paid 订阅；Workers/VPS 模式不检查（不需要该订阅）。
 * 退出码：0 全部就绪；1 存在阻塞项；2 Token 不可用。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const API = 'https://api.cloudflare.com/client/v4';
const ZONE_NAME = 'maolizheng.xyz';
const DOMAIN = 'api.maolizheng.xyz';

const vps = process.argv.includes('--vps');
const workers = process.argv.includes('--workers');
const DEV_VARS = join(ROOT, '.dev.vars');
const VPS_ENV = join(ROOT, '..', '.env');
const primaryEnv = vps ? VPS_ENV : DEV_VARS;
const fallbackEnv = vps ? DEV_VARS : VPS_ENV;
const modeLabel = workers
  ? 'Cloudflare Workers Free + Hyperdrive + R2'
  : vps ? 'VPS + 外部 Postgres' : 'Cloudflare Containers';

const token = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
let aid = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
let blockers = 0;

const beijing = () =>
  new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' 北京';

function ok(msg) { console.log(`  [OK]   ${msg}`); }
function warn(msg) { console.log(`  [WARN] ${msg}`); }
function block(msg) { blockers++; console.log(`  [BLOCK] ${msg}`); }

async function cf(path, init = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  return r.json();
}

function parseEnvFile(p) {
  if (!existsSync(p)) return null;
  const out = {};
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

// Workers 模式由 Hyperdrive binding 提供 DATABASE_URL，不作为 Worker Secret 注入；
// 但 provision-hyperdrive / bootstrap-db 仍需要它，所以仅在缺失时告警而非阻塞。
const SECRET_KEYS = workers
  ? ['JWT_SECRET', 'R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']
  : [
      'DATABASE_URL', 'JWT_SECRET',
      'R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
    ];

// 主文件优先，缺失的键从备用文件补齐（R2 凭据由 provision-r2 统一生成）。
const primary = parseEnvFile(primaryEnv);
const fallback = parseEnvFile(fallbackEnv);
const env = { ...(fallback || {}), ...(primary || {}) };
const havePrimary = primary !== null;
// 模板里的 CHANGE_ME 占位值不能算「已填」，否则会带着假密钥上线。
const isSet = (v) => !!v && !/CHANGE_ME|REPLACE_ME|YOUR_/i.test(v);

console.log(`\n=== ${modeLabel} 部署预检 · ${beijing()} ===\n`);

// ── 1. Token / Account ──────────────────────────────────────────────────────
console.log('[1] Cloudflare 凭据（R2 / DNS）');
if (!token) {
  block('未设置 CLOUDFLARE_API_TOKEN');
  console.log('\n结论：缺少凭据，后续云端检查跳过。\n');
  process.exit(2);
}
const accounts = await cf('/accounts');
if (!accounts.success) {
  block(`/accounts 失败：${JSON.stringify(accounts.errors || [])}`);
  console.log('\n结论：Token 不可用。\n');
  process.exit(2);
}
if (!aid) aid = accounts.result?.[0]?.id || '';
ok(`Token 可用，Account ID ${aid.slice(0, 8)}…${aid.slice(-4)}`);

// ── 2. 订阅 ────────────────────────────────────────────────────────────────
console.log(`\n[2] ${workers ? 'Workers Free 与 Hyperdrive 配置' : vps ? '订阅' : '订阅（Containers 硬性要求）'}`);
if (vps) {
  ok('VPS 模式不需要 Workers Paid（无 Workers 订阅费）');
} else if (workers) {
  ok('Workers Free 即可：10 万请求/天 + Hyperdrive 10 万查询/天，无订阅费');
  const cfg = await cf(`/accounts/${aid}/hyperdrive/configs`);
  const list = Array.isArray(cfg.result) ? cfg.result : (cfg.result?.configs || []);
  if (cfg.success && list.length) {
    ok(`Hyperdrive 配置 ${list.length} 个：${list.map((c) => c.name).join(', ')}`);
  } else {
    warn('尚无 Hyperdrive 配置：填 DATABASE_URL 后执行 npm run provision-hyperdrive');
  }
  const wranglerText = readFileSync(join(ROOT, 'wrangler.workers.jsonc'), 'utf8');
  if (wranglerText.includes('00000000000000000000000000000000')) {
    warn('wrangler.workers.jsonc 仍是占位 Hyperdrive id（本地 dev 可用，部署前必须替换为真实 id）');
  } else {
    ok('wrangler.workers.jsonc 已绑定真实 Hyperdrive id');
  }
} else {
  const subs = await cf(`/accounts/${aid}/subscriptions`);
  const plans = (subs.result || []).map((s) => String(s.rate_plan?.id || '').toLowerCase());
  const paid = plans.some((p) => p.includes('workers') && !p.includes('free'));
  if (paid) ok('Workers Paid 已开通');
  else {
    block(`仅有 ${plans.join(', ') || '(无)'}；Containers 仅对 Workers Paid 开放（$5/月起）`);
    console.log('        入口：https://dash.cloudflare.com/?to=/:account/workers/plans');
  }
}

// ── 3. R2 ─────────────────────────────────────────────────────────────────
console.log('\n[3] R2 对象存储（STORAGE_DRIVER=r2）');
const buckets = await cf(`/accounts/${aid}/r2/buckets`);
if (buckets.success) ok(`R2 已开通，现有桶 ${(buckets.result?.buckets || []).length} 个`);
else block(`R2 不可用：${JSON.stringify(buckets.errors || [])}`);

// ── 4. Zone / 域名 ─────────────────────────────────────────────────────────
console.log('\n[4] Zone 与域名 DNS');
const zones = await cf(`/zones?name=${ZONE_NAME}`);
const zone = (zones.result || [])[0];
if (!zone) block(`未找到 Zone ${ZONE_NAME}`);
else {
  ok(`Zone ${zone.name}（${zone.id.slice(0, 8)}…）状态 ${zone.status}`);
  const dns = await cf(`/zones/${zone.id}/dns_records?per_page=100`);
  const records = (dns.result || []).filter((r) => r.name === DOMAIN);
  if (vps) {
    if (!records.length) {
      warn(`${DOMAIN} 尚无 DNS 记录；VPS 模式需手动建 A/AAAA 指向 VPS，或改用 Cloudflare Tunnel`);
    } else {
      ok(`${DOMAIN} 已有 ${records.map((r) => r.type).join('/')} 记录，请确认指向 VPS / Tunnel`);
    }
  } else if (records.length) {
    warn(`${DOMAIN} 已有 ${records.map((r) => r.type).join('/')} 记录；Custom Domain 要求无既有 CNAME，部署前需清理`);
  } else ok(`${DOMAIN} 无既有 DNS 记录，Custom Domain 可自动创建`);
}

// ── 5. 工具链 ──────────────────────────────────────────────────────────────
console.log('\n[5] 工具链');
if (workers) {
  ok('Workers 模式不需要 Docker（纯 JS bundle）');
  const dist = join(ROOT, '..', '..', 'backend', 'dist', 'http', 'worker-app.js');
  if (existsSync(dist)) ok('后端 dist/http/worker-app.js 已构建');
  else block(`缺少 ${dist}；请先执行 npm run build:backend`);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  ok(`wrangler ${pkg.devDependencies?.wrangler || '(未锁定)'}`);
} else {
  try {
    const r = await import('node:child_process').then(({ execFileSync }) =>
      execFileSync('docker', ['--version'], { encoding: 'utf8', timeout: 8000 }).trim());
    ok(`Docker 可用：${r}`);
  } catch {
    if (vps) {
      warn('本机未检测到 Docker：镜像需在 VPS 上构建（compose up --build），本机无法预演');
    } else {
      warn('本机未检测到 Docker：无法用 `wrangler deploy` 本地构建镜像');
      console.log('        改用 Workers Builds（Cloudflare 侧构建，需连接 GitHub）或安装 Docker Desktop');
    }
  }
  if (!vps) {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    ok(`wrangler ${pkg.devDependencies?.wrangler || '(未锁定)'} / @cloudflare/containers ${pkg.dependencies?.['@cloudflare/containers'] || '(未锁定)'}`);
  }
}

// ── 6. 密钥完整性 ──────────────────────────────────────────────────────────
console.log('\n[6] 运行密钥（只检查是否设置，不回显任何值）');
if (!havePrimary) block(`缺少 ${primaryEnv}（复制模板并填写；R2 四项可用 provision-r2 --sync-only 同步）`);
const missing = SECRET_KEYS.filter((k) => !isSet(env[k]));
const filled = SECRET_KEYS.filter((k) => isSet(env[k]));
ok(`已填 ${filled.length}/${SECRET_KEYS.length}：${filled.join(', ') || '(无)'}`);
if (missing.length) block(`未填或仍是模板占位值：${missing.join(', ')}`);
const jwt = isSet(env.JWT_SECRET) ? env.JWT_SECRET : '';
if (jwt && jwt.length < 16) block('JWT_SECRET 少于 16 位');
if (workers && !isSet(env.DATABASE_URL)) {
  warn('DATABASE_URL 未配置：Worker Secret 不需要它，但 provision-hyperdrive / bootstrap-db 需要');
}
if (env.R2_ACCOUNT_ID && env.R2_ACCOUNT_ID !== aid) {
  warn('R2_ACCOUNT_ID 与当前 Cloudflare Account ID 不一致，请确认');
}
if (vps && isSet(env.DATABASE_URL)) {
  try {
    const u = new URL(env.DATABASE_URL);
    if (u.port === '6543') warn('DATABASE_URL 使用 6543 transaction pooler；pg.Pool 长连接应改用 5432 session pooler');
    if (!/sslmode=require/i.test(env.DATABASE_URL)) warn('DATABASE_URL 未带 sslmode=require，跨公网可能明文回退');
  } catch {
    block('DATABASE_URL 不是合法 URL');
  }
}

// ── 7. 外部 Postgres 连通性 ────────────────────────────────────────────────
console.log('\n[7] 外部 Postgres 连通性');
const dbUrl = isSet(env.DATABASE_URL) ? env.DATABASE_URL : process.env.DATABASE_URL;
if (!dbUrl) {
  warn('未配置 DATABASE_URL，跳过连通性测试');
} else {
  try {
    // 复用 backend 已安装的 pg（CJS 包），不额外引入数据库依赖。
    const require = createRequire(join(ROOT, '..', '..', 'backend', 'package.json'));
    const pg = require('pg');
    const host = new URL(dbUrl).host;
    const client = new pg.Client({ connectionString: dbUrl, connectionTimeoutMillis: 8000 });
    await client.connect();
    const { rows } = await client.query('select current_database() as db, version() as v');
    await client.end();
    ok(`可连接 ${host}，database=${rows[0].db}，${String(rows[0].v).split(',')[0]}`);
  } catch (e) {
    block(`Postgres 连接失败：${e?.message || String(e)}`);
  }
}

console.log(`\n=== 预检结束：${blockers === 0 ? '全部就绪，可以部署' : `${blockers} 项阻塞`} ===\n`);
process.exit(blockers === 0 ? 0 : 1);
