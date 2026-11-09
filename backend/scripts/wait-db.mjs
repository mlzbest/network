/**
 * 容器启动前等待 Postgres 可达。
 * compose 的 healthcheck 已提供保障，这里额外覆盖 Cloudflare Containers /
 * 独立 docker run 等没有编排依赖的场景。
 *
 * 注意：某些网络环境下连接是「被丢包」而非 ECONNREFUSED，此时 pg 的
 * client.query() 可能一直不 settle，导致顶层 await 悬挂、脚本静默退出。
 * 因此每次探测都显式 connect() 并用 Promise.race 加硬超时。
 */
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[wait-db] DATABASE_URL 未设置');
  process.exit(1);
}

const maxAttempts = Number(process.env.DB_WAIT_RETRIES || 30);
const intervalMs = Number(process.env.DB_WAIT_INTERVAL_MS || 2000);
const probeTimeoutMs = Number(process.env.DB_WAIT_PROBE_MS || 5000);

async function probe() {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: probeTimeoutMs,
  });
  let timer;
  const hardTimeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`探测超时 ${probeTimeoutMs}ms`)), probeTimeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        await client.connect();
        await client.query('SELECT 1');
      })(),
      hardTimeout,
    ]);
    return null;
  } catch (err) {
    return err?.message || String(err);
  } finally {
    clearTimeout(timer);
    // 不 await：失败连接上的 end() 也可能挂起，不能拖住重试循环
    void client.end().catch(() => {});
  }
}

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  const err = await probe();
  if (!err) {
    console.log(`[wait-db] 数据库就绪（第 ${attempt} 次探测）`);
    process.exit(0);
  }
  console.warn(`[wait-db] 尚未就绪 (${attempt}/${maxAttempts}): ${err}`);
  if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, intervalMs));
}

console.error('[wait-db] 超过重试次数，放弃启动');
process.exit(1);
