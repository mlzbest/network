/**
 * 创建（或复用）Hyperdrive 配置，并把 id 写回 wrangler.workers.jsonc。
 *
 *   DATABASE_URL=... CLOUDFLARE_API_TOKEN=... node scripts/provision-hyperdrive.mjs
 *   node scripts/provision-hyperdrive.mjs --dry-run     # 只校验连接串，不创建
 *
 * DATABASE_URL 也可以放在 .dev.vars 或 ../../deploy/.env（值不回显）。
 * Workers Free 计划包含 Hyperdrive：10 万次查询/天，无额外费用。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CONFIG = join(ROOT, 'wrangler.workers.jsonc');
const STATE = join(ROOT, '.hyperdrive.json');
const API = 'https://api.cloudflare.com/client/v4';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const nameArg = args.indexOf('--name');
const CONFIG_NAME = nameArg >= 0 ? args[nameArg + 1] : 'detect-network-pg';

function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) out[line.slice(0, i).trim()] = value;
  }
  return out;
}

const fileEnv = {
  ...readEnvFile(join(ROOT, '..', '..', 'deploy', '.env')),
  ...readEnvFile(join(ROOT, '.dev.vars')),
};
const databaseUrl = (process.env.DATABASE_URL || fileEnv.DATABASE_URL || '').trim();
const token = (process.env.CLOUDFLARE_API_TOKEN || '').trim();

if (!databaseUrl) {
  console.error('[hyperdrive] 缺少 DATABASE_URL（Supabase Session pooler 5432 + ?sslmode=require）');
  console.error('[hyperdrive] 可写入 deploy/cloudflare/.dev.vars 或 deploy/.env，不必贴在命令行里。');
  process.exit(2);
}

let parsed;
try {
  parsed = new URL(databaseUrl);
} catch (e) {
  console.error('[hyperdrive] DATABASE_URL 不是合法 URL：', e.message);
  process.exit(2);
}
if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
  console.error('[hyperdrive] 仅支持 postgres/postgresql 协议');
  process.exit(2);
}
const port = Number(parsed.port || 5432);
if (port === 6543) {
  console.error('[hyperdrive] 检测到 6543 transaction pooler：不支持 prepared statements，请改用 5432 Session pooler');
  process.exit(2);
}
const user = decodeURIComponent(parsed.username);
const password = decodeURIComponent(parsed.password);
const host = parsed.hostname;
const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'postgres';
if (!user || !password || !host) {
  console.error('[hyperdrive] 连接串缺少 user / password / host');
  process.exit(2);
}
if (!/sslmode=require/.test(parsed.search)) {
  console.warn('[hyperdrive] ⚠️ 连接串未带 ?sslmode=require，跨公网可能明文回退');
}

const masked = `${parsed.protocol}//${user.slice(0, 6)}***@${host}:${port}/${database}`;
console.log(`[hyperdrive] 源库（脱敏）：${masked}`);
console.log(`[hyperdrive] 配置名：${CONFIG_NAME}；缓存：disabled（聊天写多读多，避免读到过期 SELECT）`);
if (dryRun) {
  console.log('[hyperdrive] --dry-run：未调用 Cloudflare API');
  process.exit(0);
}
if (!token) {
  console.error('[hyperdrive] 缺少 CLOUDFLARE_API_TOKEN');
  process.exit(2);
}

function cf(method, path, body) {
  const argv = [
    '-sS', '--max-time', '25', '-X', method,
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Content-Type: application/json',
  ];
  if (body) argv.push('-d', JSON.stringify(body));
  argv.push(API + path);
  const r = spawnSync('curl', argv, {
    encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`curl 失败：${String(r.stderr || '').slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw new Error(`API 返回非 JSON：${String(r.stdout).slice(0, 200)}`);
  }
  if (!json.success) {
    throw new Error(`Cloudflare API：${(json.errors || []).map((e) => `${e.code}:${e.message}`).join('; ')}`);
  }
  return json.result;
}

let accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
if (!accountId) {
  const accounts = cf('GET', '/accounts');
  accountId = Array.isArray(accounts) ? accounts[0]?.id : accounts?.id;
}
if (!accountId) {
  console.error('[hyperdrive] 无法解析 Account ID，请显式设置 CLOUDFLARE_ACCOUNT_ID');
  process.exit(2);
}
console.log(`[hyperdrive] Account ID：${accountId.slice(0, 8)}…${accountId.slice(-4)}`);

const list = cf('GET', `/accounts/${accountId}/hyperdrive/configs`);
const configs = Array.isArray(list) ? list : (list?.configs || []);
const existing = configs.find((c) => c.name === CONFIG_NAME);

let id;
if (existing && !force) {
  id = existing.id;
  console.log(`[hyperdrive] 复用已有配置 ${CONFIG_NAME}（id ${id.slice(0, 8)}…）`);
} else {
  const body = {
    name: CONFIG_NAME,
    origin: {
      scheme: 'postgresql',
      host,
      port,
      database,
      user,
      password,
    },
    caching: { disabled: true },
  };
  try {
    const created = cf('POST', `/accounts/${accountId}/hyperdrive/configs`, {
      ...body,
      mtls: { sslmode: 'require' },
    });
    id = created.id;
  } catch (e) {
    // 部分账户/源库不接受显式 mtls.sslmode；去掉后重试一次（pg 驱动仍会按
    // 连接串的 sslmode=require 协商 TLS）。
    console.warn('[hyperdrive] 带 mtls 创建失败，去掉 mtls 重试：', String(e.message).slice(0, 160));
    const created = cf('POST', `/accounts/${accountId}/hyperdrive/configs`, body);
    id = created.id;
  }
  console.log(`[hyperdrive] 已创建配置（id ${id.slice(0, 8)}…）`);
}
if (!id || !/^[0-9a-f]{32}$/i.test(id)) {
  console.error('[hyperdrive] 未取得合法 Hyperdrive id', id);
  process.exit(1);
}

// 只替换 wrangler.workers.jsonc 里 hyperdrive 段的 id，保留全部注释与格式。
const original = readFileSync(CONFIG, 'utf8');
const placeholder = '00000000000000000000000000000000';
const idPattern = /("id"\s*:\s*")([0-9a-f]{32})(")/i;
let updated;
if (original.includes(placeholder)) {
  updated = original.replace(placeholder, id);
} else if (idPattern.test(original)) {
  updated = original.replace(idPattern, `$1${id}$3`);
} else {
  console.error('[hyperdrive] wrangler.workers.jsonc 中未找到 hyperdrive id 字段，请手动填入：' + id);
  process.exit(1);
}
writeFileSync(CONFIG, updated, 'utf8');
writeFileSync(STATE, JSON.stringify({ id, name: CONFIG_NAME, host, port, database }, null, 2) + '\n', 'utf8');
console.log('[hyperdrive] ✅ 已写回 wrangler.workers.jsonc（本地 dev 仍用 localConnectionString）');
console.log('[hyperdrive] 下一步：npm run secrets -- --workers → npm run dry-run:workers → npm run deploy:workers');
