/**
 * tsc 只编译 .ts，不会复制 SQL 等运行时资源。
 * 构建后把 schema.sql 放进 dist/db/，使 `node dist/db/init.js` 与
 * `tsx src/db/init.ts` 两种入口都能用同一个相对路径读到它。
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = join(root, 'src', 'db', 'schema.sql');
const dest = join(root, 'dist', 'db', 'schema.sql');

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log('[build] copied src/db/schema.sql -> dist/db/schema.sql');
