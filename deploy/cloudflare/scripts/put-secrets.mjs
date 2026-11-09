/**
 * 把 .dev.vars 里的密钥批量写入 Worker Secrets。
 *
 *   node scripts/put-secrets.mjs            # 写入远端
 *   node scripts/put-secrets.mjs --dry-run  # 只列出键名
 *
 * 值只通过 stdin 传给 wrangler，绝不出现在命令行参数或日志里。
 * 需要 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID，或已 `wrangler login`。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const dryRun = process.argv.includes('--dry-run');
const workers = process.argv.includes('--workers');
// --workers 时写入 Workers Free 入口（wrangler.workers.jsonc）；默认写 Containers 入口。
const configArgs = workers ? ['-c', 'wrangler.workers.jsonc'] : [];

// Workers Free 模式下数据库由 Hyperdrive binding 提供，DATABASE_URL 只供
// provision-hyperdrive / bootstrap-db 本机使用，绝不能作为 Worker Secret 上传。
// 平台级凭据同理；容器内需要 DATABASE_URL，所以仅在 --workers 时排除。
const WORKERS_SKIP = new Set([
  'DATABASE_URL', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID',
]);

const OPTIONAL = new Set([
  'R2_PUBLIC_URL', 'R2_ENDPOINT',
  'RECOVERY_SMTP_HOST', 'RECOVERY_SMTP_PORT', 'RECOVERY_SMTP_USER',
  'RECOVERY_SMTP_PASS', 'RECOVERY_MAIL_FROM',
  'WX_APP_ID', 'WX_APP_SECRET',
]);

const p = join(ROOT, '.dev.vars');
if (!existsSync(p)) {
  console.error('[secrets] 缺少 .dev.vars，请先复制 .dev.vars.example 并填写');
  process.exit(1);
}

const entries = [];
const skipped = [];
for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 1) continue;
  const key = line.slice(0, i).trim();
  let value = line.slice(i + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (!value) continue;               // 空值 / 注释掉的可选项跳过
  if (workers && WORKERS_SKIP.has(key)) { skipped.push(key); continue; }
  entries.push([key, value]);
}

if (entries.length === 0) {
  console.error('[secrets] .dev.vars 里没有有效键值');
  process.exit(1);
}

if (skipped.length) {
  console.log(`[secrets] Workers 模式跳过内部专用键（不上传）：${skipped.join(', ')}`);
}
console.log(`[secrets] 待写入 ${entries.length} 项：${entries.map(([k]) => k).join(', ')}`);
if (dryRun) {
  console.log('[secrets] --dry-run：未写入');
  process.exit(0);
}

const wrangler = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
let failed = 0;
for (const [key, value] of entries) {
  const r = spawnSync(wrangler, ['secret', 'put', key, ...configArgs], {
    cwd: ROOT,
    input: `${value}\n`,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
  });
  if (r.status === 0) {
    console.log(`[secrets] OK    ${key}${OPTIONAL.has(key) ? ' (可选)' : ''}`);
  } else {
    failed++;
    // wrangler 的报错可能含上下文，但不包含值本身；仍做一次兜底脱敏
    const msg = String(r.stderr || r.stdout || '').replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<redacted>');
    console.error(`[secrets] FAIL  ${key}: ${msg.trim().slice(0, 300)}`);
  }
}

console.log(`[secrets] 完成：成功 ${entries.length - failed}，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
