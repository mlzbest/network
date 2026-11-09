import { Pool, Client } from 'pg';
import { env } from '../env.js';

/**
 * Workers 运行时注入的 Hyperdrive 连接串。
 *
 * Workers 是「每请求一个 isolate 内执行」的模型，不能持有跨请求的长驻连接池。
 * Hyperdrive 在边缘侧维护真实连接池，官方示例即「每请求 new Client()」。
 * Node / VPS 路径没有该注入，走原来的 pg.Pool。
 */
const workerConnectionString = (globalThis as Record<string, unknown>).__DETECT_DB_URL__ as
  | string
  | undefined;

export const pool = workerConnectionString
  ? (undefined as unknown as Pool)
  : new Pool({
      connectionString: env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

if (pool) {
  pool.on('error', (err) => {
    console.error('[db] 空闲连接异常：', err.message);
  });
}

async function workerQuery<T = any>(
  text: string,
  params: any[] = [],
): Promise<{ rows: T[]; rowCount: number | null }> {
  const client = new Client({ connectionString: workerConnectionString });
  await client.connect();
  try {
    const res = await client.query(text, params);
    return { rows: res.rows as T[], rowCount: res.rowCount };
  } finally {
    await client.end();
  }
}

async function workerTransaction<T>(
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: workerConnectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client as unknown as import('pg').PoolClient);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

export async function query<T = any>(
  text: string,
  params: any[] = [],
): Promise<{ rows: T[]; rowCount: number | null }> {
  const start = Date.now();
  try {
    if (workerConnectionString) return await workerQuery<T>(text, params);
    const res = await pool.query(text, params);
    return { rows: res.rows, rowCount: res.rowCount };
  } finally {
    if (Date.now() - start > 200) {
      console.warn(`[db] 慢查询 ${Date.now() - start}ms:`, text.slice(0, 120));
    }
  }
}

export async function withTransaction<T>(
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  if (workerConnectionString) return workerTransaction(fn);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
