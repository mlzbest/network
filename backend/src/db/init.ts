import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, query } from './pool.js';
import { env } from '../env.js';

/**
 * 初始化数据库结构：读取 schema.sql 并执行。
 * 幂等（所有 CREATE 都带 IF NOT EXISTS）。仅建结构，不灌数据。
 */
async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sqlPath = join(here, 'schema.sql');
  const sql = readFileSync(sqlPath, 'utf8');

  console.log('[db:init] 开始执行 schema.sql ...');
  await query(sql);
  console.log('[db:init] ✅ 结构初始化完成。');

  // 可选：从 Meoo 老库同步存量数据（需 ME00_DATABASE_URL；未配置则跳过）
  if (env.MEOO_DATABASE_URL) {
    console.log('[db:init] 检测到 MEOO_DATABASE_URL，开始增量同步存量数据（data-only）...');
    // 注意：跨库同步建议用 psql + pg_dump 命令行完成（见 schema.sql 顶部注释），
    // 这里仅做占位提示，避免把生产凭据写进运行时逻辑。
    console.log('[db:init] ℹ️ 跨库同步请使用 pg_dump | psql 命令行，已跳过运行时自动同步。');
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('[db:init] ❌ 初始化失败：', err);
    process.exit(1);
  });
