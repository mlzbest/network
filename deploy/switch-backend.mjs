/**
 * 前端鉴权/数据后端开关（幂等、可逆、只改两个键）。
 *
 *   node deploy/switch-backend.mjs status
 *   node deploy/switch-backend.mjs selfhost --dry-run
 *   node deploy/switch-backend.mjs selfhost --api-base https://api.maolizheng.xyz
 *   node deploy/switch-backend.mjs legacy            # 一键回滚到 Meoo Cloud 网关
 *   node deploy/switch-backend.mjs selfhost --check # 切换前探测 /api/health
 *
 * 实际生效的只有两个键（源码依据：src/supabase/client.ts、src/supabase/selfhost-client.ts）：
 *   VITE_AUTH_BACKEND        legacy | cloud | selfhost
 *   VITE_SELFHOST_API_BASE   仅 selfhost 时读取
 * ⚠ 旧文档里写过的 VITE_DATA_BACKEND 并不存在，前端从不读取，本脚本不会写入该键。
 *
 * 切换前请先确认生产 Worker 已部署且 /api/health 返回 200；否则小程序会连到一个
 * 不存在的域名。脚本不会自动部署，也不会自动执行切换。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DEFAULT_FILES = ['.env', '.env.miniprogram'];
const DEFAULT_API_BASE = 'https://api.maolizheng.xyz';
const resolveFile = (rel) => (isAbsolute(rel) ? rel : join(ROOT, rel));

const argv = process.argv.slice(2);
const command = argv[0] || 'status';
const dryRun = argv.includes('--dry-run');
const doCheck = argv.includes('--check');
const apiBaseArg = argv.indexOf('--api-base');
const apiBase = (apiBaseArg >= 0 ? argv[apiBaseArg + 1] : DEFAULT_API_BASE).replace(/\/+$/, '');
const filesArg = argv.indexOf('--files');
const files = filesArg >= 0 ? argv[filesArg + 1].split(',') : DEFAULT_FILES;

if (!['status', 'selfhost', 'legacy'].includes(command)) {
  console.error(`[switch] 未知命令 ${command}；可用：status / selfhost / legacy`);
  process.exit(2);
}
if (apiBaseArg >= 0 && !argv[apiBaseArg + 1]) {
  console.error('[switch] --api-base 缺少值');
  process.exit(2);
}
if (command === 'selfhost' && !/^https?:\/\//i.test(apiBase)) {
  console.error('[switch] --api-base 必须是完整 http(s) URL');
  process.exit(2);
}

const AUTH_KEY = 'VITE_AUTH_BACKEND';
const BASE_KEY = 'VITE_SELFHOST_API_BASE';
const AUTH_LINE = /^(\s*#?\s*)(VITE_AUTH_BACKEND)(\s*=\s*)(.*)$/;
const BASE_LINE = /^(\s*#?\s*)(VITE_SELFHOST_API_BASE)(\s*=\s*)(.*)$/;

function parse(text) {
  const out = { auth: null, base: null, baseCommented: false, stale: false };
  for (const line of text.split(/\r?\n/)) {
    const a = line.match(AUTH_LINE);
    if (a && !line.trim().startsWith('#')) out.auth = a[4].trim().replace(/^["']|["']$/g, '');
    const b = line.match(BASE_LINE);
    if (b) {
      out.base = b[4].trim().replace(/^["']|["']$/g, '');
      out.baseCommented = line.trim().startsWith('#');
    }
    if (/^\s*#?\s*VITE_DATA_BACKEND\s*=/.test(line)) out.stale = true;
  }
  return out;
}

function rewrite(text, target) {
  const lines = text.split(/\r?\n/);
  const next = [];
  let authSeen = false;
  let baseSeen = false;
  let authPos = -1;
  for (const line of lines) {
    if (AUTH_LINE.test(line)) {
      if (!authSeen) {
        authSeen = true;
        next.push(`${AUTH_KEY}="${target}"`);
        authPos = next.length - 1;
      } else if (line.trim().startsWith('#')) {
        next.push(line); // 保留注释说明，不制造重复有效键
      }
      continue;
    }
    if (BASE_LINE.test(line)) {
      if (!baseSeen) {
        baseSeen = true;
        if (target === 'selfhost') next.push(`${BASE_KEY}="${apiBase}"`);
        else next.push(line.trim().startsWith('#') ? line : `# ${line}`);
      } else if (line.trim().startsWith('#')) {
        next.push(line);
      }
      continue;
    }
    next.push(line);
  }

  if (!authSeen) {
    next.push(`${AUTH_KEY}="${target}"`);
    authPos = next.length - 1;
  }
  if (target === 'selfhost' && !baseSeen) {
    next.splice(authPos + 1, 0, `${BASE_KEY}="${apiBase}"`);
  }
  return next.join('\n');
}

const stateOf = (s) =>
  `${AUTH_KEY}=${s.auth ?? '∅'} | ${BASE_KEY}=` +
  (s.base ? (s.baseCommented ? '已注释' : s.base) : '∅');

// ── status：只读，不碰任何文件 ───────────────────────────────────────────────
if (command === 'status') {
  console.log(`=== 前端后端开关状态 · ${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} 北京 ===\n`);
  for (const rel of files) {
    const p = resolveFile(rel);
    if (!existsSync(p)) {
      console.log(`  ${rel.padEnd(22)} 文件不存在`);
      continue;
    }
    const s = parse(readFileSync(p, 'utf8'));
    console.log(`  ${rel.padEnd(22)} ${AUTH_KEY}=${s.auth ?? '(未设置)'}  ${BASE_KEY}=${s.base ? (s.baseCommented ? '(已注释) ' + s.base : s.base) : '(未设置)'}`);
    if (s.stale) console.log(`    ⚠ 检测到无效的 VITE_DATA_BACKEND，前端不读取该键，可删除`);
  }
  process.exit(0);
}

// ── 可选：切换前探测后端健康 ─────────────────────────────────────────────────
if (doCheck && command === 'selfhost') {
  try {
    const res = await fetch(`${apiBase}/api/health`, { signal: AbortSignal.timeout(8000) });
    const body = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`HTTP ${res.status} ${body.slice(0, 120)}`);
    console.log(`[switch] 健康检查通过：${apiBase}/api/health → ${res.status}`);
  } catch (e) {
    console.error(`[switch] 健康检查失败：${e?.message || String(e)}`);
    console.error('[switch] 未切换。请先完成生产部署，或去掉 --check 强制切换。');
    process.exit(3);
  }
}

// ── 备份 + 写入 ─────────────────────────────────────────────────────────────
const stamp = new Date(Date.now() + 8 * 3600_000).toISOString().replace(/[:.]/g, '-');
const backupDir = join(HERE, '.backups', stamp);
const changed = [];
for (const rel of files) {
  const p = resolveFile(rel);
  if (!existsSync(p)) {
    console.error(`[switch] 跳过 ${rel}：文件不存在`);
    continue;
  }
  const original = readFileSync(p, 'utf8');
  const updated = rewrite(original, command);
  const before = parse(original);
  const after = parse(updated);

  if (updated === original) {
    console.log(`[switch] ${rel} 已是 ${command}，无需改动`);
    continue;
  }
  console.log(`[switch] ${rel}: ${stateOf(before)}  →  ${stateOf(after)}`);

  if (dryRun) {
    console.log(`[switch] --dry-run：未写入 ${rel}`);
    continue;
  }

  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, basename(rel)), original, 'utf8');
  writeFileSync(p, updated, 'utf8');
  changed.push(rel);
}

if (changed.length) {
  console.log(`\n[switch] 已改动 ${changed.length} 个文件，原文件备份：${backupDir}`);
  console.log(`[switch] 反向切换：node deploy/switch-backend.mjs ${command === 'selfhost' ? 'legacy' : 'selfhost'}`);
}
if (command === 'selfhost' && !dryRun && changed.length) {
  console.log('\n[switch] 接下来重新构建小程序：pnpm build:weapp（Vite 环境变量在构建时注入）。');
  console.log('[switch] 确认 api 域名已加入微信小程序后台 request 合法域名白名单。');
}
