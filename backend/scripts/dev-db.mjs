/**
 * 本地开发数据库启动器：PGlite（编译成 WASM 的真实 PostgreSQL 内核）
 *
 *   node scripts/dev-db.mjs
 *
 * 为什么不用真 postgres.exe：本机沙箱会拦掉初始化的进程/共享内存操作
 * （initdb 直接以 0xC0000409 退出）。PGlite 跑在 Node 进程内，通过
 * PGLiteSocketServer 暴露标准 pg wire 协议，后端 pg 连接池代码完全不用改。
 * 若你的环境能跑真二进制（如装了 Docker 或本地 PG），用 scripts/dev-db-native.mjs。
 *
 * 数据持久化在 backend/.pgdata-pglite（已 gitignore）。
 * 端口 55432，与常见的 5432 错开。
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', '.pgdata-pglite');
const PORT = Number(process.env.PGLITE_PORT || 55432);
const HOST = '127.0.0.1';

console.log(`[dev-db] 数据目录: ${DATA_DIR}`);

const db = new PGlite(DATA_DIR);
await db.waitReady;
console.log('[dev-db] PGlite 已就绪');

// 允许 pg Pool 开多个连接；单连接时并发查询容易互相排队超时
const server = new PGLiteSocketServer({ db, port: PORT, host: HOST, maxConnections: 10 });
await server.start();

console.log(`[dev-db] ✅ 已监听 ${HOST}:${PORT}`);
console.log('');
console.log(`DATABASE_URL=postgres://postgres:postgres@${HOST}:${PORT}/postgres`);
console.log('');
console.log('[dev-db] 按 Ctrl+C 停止');

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\n[dev-db] 正在停止 ...');
  try {
    await server.stop();
    await db.close();
    console.log('[dev-db] 已停止');
  } catch (e) {
    console.error('[dev-db] 停止失败：', e);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await new Promise(() => {});
