/**
 * 本地开发用的嵌入式 Postgres 启动器（无需 Docker / 无需管理员权限）。
 *
 *   node scripts/dev-db.mjs          # 前台启动，Ctrl+C 停止
 *   node scripts/dev-db.mjs --reset  # 删掉数据目录后重建（清空所有数据）
 *
 * 数据落在 backend/.pgdata（已 gitignore）；端口 55432 避开本机可能占用的 5432。
 * 启动后把打印出的 DATABASE_URL 写进 backend/.env 即可。
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', '.pgdata');
const PORT = 55432;
const USER = 'detect';
const PASSWORD = 'detect123';
const DB = 'detect_network';

if (process.argv.includes('--reset')) {
  if (existsSync(DATA_DIR)) {
    console.log(`[dev-db] 删除旧数据目录 ${DATA_DIR} ...`);
    rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  port: PORT,
  user: USER,
  password: PASSWORD,
  authMethod: 'password',
  persistent: true,
  autoRehydrateSymlinks: true,
  onLog: () => {}, // initdb/postgres 日志噪音较大，失败时再看 onError
  onError: (e) => console.error('[dev-db:pg]', e),
});

const alreadyInitialised = existsSync(join(DATA_DIR, 'PG_VERSION'));

if (!alreadyInitialised) {
  console.log('[dev-db] 首次初始化数据目录（initdb）...');
  await pg.initialise();
} else {
  console.log('[dev-db] 复用已有数据目录');
}

await pg.start();
console.log(`[dev-db] ✅ Postgres 已启动 :${PORT}`);

// 建业务库（已存在会抛错，忽略即可）
try {
  await pg.createDatabase(DB);
  console.log(`[dev-db] ✅ 已创建数据库 ${DB}`);
} catch {
  console.log(`[dev-db] 数据库 ${DB} 已存在，跳过创建`);
}

console.log('');
console.log('DATABASE_URL=postgres://' + USER + ':' + PASSWORD + '@localhost:' + PORT + '/' + DB);
console.log('');
console.log('[dev-db] 按 Ctrl+C 停止');

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\n[dev-db] 正在停止 Postgres ...');
  try {
    await pg.stop();
    console.log('[dev-db] 已停止');
  } catch (e) {
    console.error('[dev-db] 停止失败：', e);
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 保持进程存活
await new Promise(() => {});
