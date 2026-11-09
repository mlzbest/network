/**
 * 在外部 Postgres 上初始化「检测网络」schema（幂等）。
 *
 *   DATABASE_URL='postgres://…' node scripts/bootstrap-db.mjs
 *   # 或从 .dev.vars 自动读取
 *   node scripts/bootstrap-db.mjs
 *
 * 直接执行 backend/src/db/schema.sql（与容器 entrypoint 用的是同一份），
 * 然后核对 9 张业务表是否齐全。不灌数据、不回显连接串。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BACKEND = join(ROOT, '..', '..', 'backend');
const SCHEMA = join(BACKEND, 'src', 'db', 'schema.sql');
// 复用 backend 已安装的 pg（CJS 包），不在此子项目重复引入数据库依赖。
const require = createRequire(join(BACKEND, 'package.json'));

// 与 backend/src/db/schema.sql 的实际 9 张表保持一致。
const TABLES = [
  'profiles', 'conversations', 'messages', 'user_we_run_steps',
  'conversation_deletes', 'message_deletes', 'message_visibility',
  'login_events', 'user_location_history',
];

const args = process.argv.slice(2);
const explicitFile = (() => {
  const i = args.indexOf('--env-file');
  return i >= 0 && args[i + 1] ? args[i + 1] : '';
})();

function keyFromFile(p, key) {
  if (!existsSync(p)) return '';
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(`${key}=`)) continue;
    let v = line.slice(key.length + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
  }
  return '';
}

/**
 * 连接串来源优先级：环境变量（最高，便于临时覆盖）→ --env-file →
 * .dev.vars（Cloudflare 模式）→ deploy/.env（VPS 模式）。
 * 只打印文件路径，不回显连接串。
 */
function resolveDbUrl() {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  const candidates = [
    explicitFile,
    join(ROOT, '.dev.vars'),
    join(ROOT, '..', '.env'),
  ].filter(Boolean);
  for (const p of candidates) {
    const v = keyFromFile(p, 'DATABASE_URL');
    if (v) {
      console.log(`[db] 连接串来源：${p}`);
      return v;
    }
  }
  return '';
}

const url = resolveDbUrl();
if (!url) {
  console.error('[db] 缺少 DATABASE_URL（环境变量或 .dev.vars）');
  process.exit(1);
}
if (!existsSync(SCHEMA)) {
  console.error(`[db] 找不到 schema：${SCHEMA}`);
  process.exit(1);
}

const pg = require('pg');
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
try {
  await client.connect();
  console.log(`[db] 已连接 ${new URL(url).host}`);
  const sql = readFileSync(SCHEMA, 'utf8');
  await client.query(sql);
  console.log('[db] schema.sql 执行完成（全部 CREATE IF NOT EXISTS，可重复运行）');

  const { rows } = await client.query(
    `select tablename from pg_tables where schemaname = current_schema()`,
  );
  const present = new Set(rows.map((r) => r.tablename));
  const missing = TABLES.filter((t) => !present.has(t));
  console.log(`[db] 当前 schema 共 ${rows.length} 张表；业务表命中 ${TABLES.length - missing.length}/${TABLES.length}`);
  if (missing.length) {
    console.error(`[db] 缺失：${missing.join(', ')}`);
    process.exit(1);
  }
  console.log('[db] ✅ 结构就绪');
} catch (e) {
  console.error('[db] 失败：', e?.message || String(e));
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
