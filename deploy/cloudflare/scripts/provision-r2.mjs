/**
 * 为生产部署准备持久 R2 资源，并把 S3 凭据写进两个 env 文件。
 *
 *   CLOUDFLARE_API_TOKEN=<token> node scripts/provision-r2.mjs
 *   ... --bucket detect-network-prod --force
 *   ... --sync-only          # 不调 API，只把 .dev.vars 的 R2_* 同步到 deploy/.env
 *   ... --sync-to <path>     # 指定同步目标，默认 ../../deploy/.env
 *
 * 与 backend/scripts/prepare-r2-live.mjs 的区别：后者是 24h 临时令牌 + 测试桶 +
 * 自动清理，用于冒烟；本脚本签发的是**长期**令牌、桶保留、资源不删除，用于上线。
 * 凭据只在内存与 env 文件中，不打印、不进 git。
 *
 * 派生规则（Cloudflare 官方）：Access Key ID = token.id，
 * Secret Access Key = sha256(token.value) 的十六进制。token.value 仅签发时返回一次。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DEV_VARS = join(ROOT, '.dev.vars');
const ENV_TEMPLATE = join(ROOT, '..', '.env.example');
const API = 'https://api.cloudflare.com/client/v4';
const R2_WRITE_GROUP = 'bf7481a1826f439697cb59a20b22293e';
const R2_KEYS = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

const args = process.argv.slice(2);
const value = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const force = args.includes('--force');
const syncOnly = args.includes('--sync-only');
const syncTo = value('--sync-to', join(ROOT, '..', '.env'));
const bucket = value('--bucket', 'detect-network-prod');
const token = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
let accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();

if (!token && !syncOnly) {
  console.error('[r2] 缺少 CLOUDFLARE_API_TOKEN');
  process.exit(2);
}

async function cf(method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  return r.json();
}

function parseEnv(p) {
  if (!existsSync(p)) return {};
  const map = {};
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i > 0) map[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return map;
}

/** 目标不存在时先从模板复制，保证注释与其余键完整；只 upsert 指定键。 */
function upsertEnv(p, updates) {
  if (!existsSync(p)) {
    writeFileSync(p, existsSync(ENV_TEMPLATE) ? readFileSync(ENV_TEMPLATE, 'utf8') : '', 'utf8');
  }
  const lines = readFileSync(p, 'utf8').split(/\r?\n/);
  const seen = new Set();
  const out = lines.map((line) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return line;
    const i = s.indexOf('=');
    if (i < 1) return line;
    const key = s.slice(0, i).trim();
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) out.push(`${k}=${v}`);
  const text = out.join('\n').replace(/\n+$/, '\n');
  writeFileSync(p, text, 'utf8');
}

console.log('\n=== 生产 R2 资源准备 ===\n');

// ── 仅同步：VPS 模式复用已签发的凭据，不重复建桶/签令牌 ──────────────────────
if (syncOnly) {
  const src = parseEnv(DEV_VARS);
  const updates = Object.fromEntries(R2_KEYS.map((k) => [k, src[k]]));
  if (R2_KEYS.some((k) => !updates[k])) {
    console.error('[r2] .dev.vars 缺 R2 凭据，请先跑一次不带 --sync-only 的 provision');
    process.exit(1);
  }
  upsertEnv(syncTo, updates);
  console.log(`[r2] 已把 R2_* 四项同步到 ${syncTo}（值未回显，文件已 gitignore）`);
  console.log(`[r2] bucket=${updates.R2_BUCKET}`);
  process.exit(0);
}

if (!accountId) {
  const a = await cf('GET', '/accounts');
  if (!a.success || !a.result?.length) {
    console.error('[r2] 无法列出账号：', JSON.stringify(a.errors || []));
    process.exit(2);
  }
  accountId = a.result[0].id;
}
console.log(`[r2] Account ID ****${accountId.slice(-6)}`);

const current = parseEnv(DEV_VARS);
if (!force && R2_KEYS.every((k) => current[k])) {
  // 凭据已齐，仍把四项同步到 VPS env，保证两种部署模式一致。
  upsertEnv(syncTo, Object.fromEntries(R2_KEYS.map((k) => [k, current[k]])));
  console.log('[r2] .dev.vars 已含完整 R2 凭据，跳过签发（如需重建加 --force）');
  console.log(`[r2] 当前 bucket=${current.R2_BUCKET}；已同步到 ${syncTo}`);
  process.exit(0);
}

const list = await cf('GET', `/accounts/${accountId}/r2/buckets`);
if (!list.success) {
  console.error('[r2] R2 不可用：', JSON.stringify(list.errors || []));
  process.exit(1);
}
const exists = (list.result?.buckets || []).some((b) => b.name === bucket);
if (!exists) {
  const c = await cf('POST', `/accounts/${accountId}/r2/buckets`, { name: bucket });
  if (!c.success) {
    console.error('[r2] 建桶失败：', JSON.stringify(c.errors || []));
    process.exit(1);
  }
  console.log(`[r2] 已创建桶 ${bucket}`);
} else {
  console.log(`[r2] 复用已有桶 ${bucket}`);
}

const created = await cf('POST', `/accounts/${accountId}/tokens`, {
  name: `detect-network-r2-prod-${new Date().toISOString().slice(0, 10)}`,
  policies: [{
    effect: 'allow',
    resources: {
      [`com.cloudflare.api.account.${accountId}`]: { 'com.cloudflare.edge.r2.bucket.*': '*' },
    },
    permission_groups: [{ id: R2_WRITE_GROUP, name: 'Workers R2 Storage Write' }],
  }],
  // 不设 expires_on → 长期有效，供生产容器持续使用。
});
if (!created.success || !created.result?.id || !created.result?.value) {
  console.error('[r2] 签发长期令牌失败：', JSON.stringify(created.errors || []));
  process.exit(1);
}

const accessKeyId = created.result.id;
const secretAccessKey = createHash('sha256').update(created.result.value).digest('hex');
const updates = {
  R2_ACCOUNT_ID: accountId,
  R2_BUCKET: bucket,
  R2_ACCESS_KEY_ID: accessKeyId,
  R2_SECRET_ACCESS_KEY: secretAccessKey,
};
upsertEnv(DEV_VARS, updates);
upsertEnv(syncTo, updates);

console.log(`[r2] 长期令牌已签发（id ****${accessKeyId.slice(-6)}，仅 R2 写权限）`);
console.log('[r2] S3 凭据已写入 .dev.vars 与 deploy/.env，密钥未回显；两者均已被 .gitignore 排除。');
console.log('[r2] ⚠ 使用 --force 重建时，旧令牌需在 Cloudflare 控制台手动删除。');
console.log('\n[r2] ✅ 完成。Containers 模式接着 `npm run secrets`；VPS 模式直接 compose up。\n');
