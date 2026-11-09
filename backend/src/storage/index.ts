import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, normalize, resolve } from 'node:path';
import { env } from '../env.js';
import {
  r2DeleteObject,
  r2GetObject,
  r2PublicDirectUrl,
  r2PutObject,
  type R2Config,
} from './r2.js';

// 本地目录只在 STORAGE_DRIVER=local 时用到。惰性计算，避免 Cloudflare Workers
// 在模块初始化阶段就调用 fileURLToPath(import.meta.url)（Worker 没有真实文件路径）。
let baseDirCache: string | undefined;
function getBaseDir(): string {
  if (baseDirCache) return baseDirCache;
  let here = '.';
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    // Workers 环境：r2 模式不会走到本地文件分支。
  }
  baseDirCache = resolve(here, '..', '..', env.STORAGE_LOCAL_DIR || 'uploads');
  return baseDirCache;
}

const isR2 = env.STORAGE_DRIVER === 'r2';

/** 构建 R2 配置；env.ts 已做强校验，这里再做一次防御，缺项时给出可读错误。 */
function buildR2Config(): R2Config | null {
  if (!isR2) return null;
  const { R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
  if (!R2_ACCOUNT_ID || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error(
      'STORAGE_DRIVER=r2 但缺少 R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY',
    );
  }
  return {
    accountId: R2_ACCOUNT_ID,
    bucket: R2_BUCKET,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    endpoint: env.R2_ENDPOINT || undefined,
    region: env.R2_REGION,
    timeoutMs: env.R2_TIMEOUT_MS,
  };
}

const r2Config = buildR2Config();

function safePath(bucket: string, path: string): string | null {
  // 防目录穿越：解析后必须仍位于 baseDir 内
  const full = resolve(getBaseDir(), bucket, path);
  const root = resolve(getBaseDir());
  if (full !== root && !full.startsWith(root + require_sep())) return null;
  return full;
}

function require_sep() {
  return process.platform === 'win32' ? '\\' : '/';
}

/** 公开读 URL 相对路径（两种驱动共用） */
function proxyRelativeUrl(bucket: string, path: string): string {
  const clean = normalize(path).replace(/\\/g, '/').replace(/^\/+/, '');
  return `/api/storage/public/${encodeURIComponent(bucket)}/${clean}`;
}

export async function uploadObject(
  bucket: string,
  path: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ error: Error | null }> {
  if (r2Config) {
    // R2 只有一个桶：业务侧传入的 bucket 仅用于组织 key 前缀，避免不同
    // 业务 bucket 同名文件互相覆盖，也无需为每种文件申请一个 R2 桶。
    const key = `${bucket}/${normalize(path).replace(/\\/g, '/').replace(/^\/+/, '')}`;
    const res = await r2PutObject(r2Config, key, buffer, contentType);
    return { error: res.error };
  }
  const full = safePath(bucket, path);
  if (!full) return { error: new Error('非法存储路径') };
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, buffer);
  void contentType;
  return { error: null };
}

export async function readObject(
  bucket: string,
  path: string,
): Promise<{ buffer: Buffer | null; contentType: string | null; error: Error | null }> {
  if (r2Config) {
    const key = `${bucket}/${normalize(path).replace(/\\/g, '/').replace(/^\/+/, '')}`;
    const res = await r2GetObject(r2Config, key);
    return { buffer: res.buffer, contentType: res.contentType, error: res.error };
  }
  const full = safePath(bucket, path);
  if (!full || !existsSync(full)) {
    return { buffer: null, contentType: null, error: new Error('文件不存在') };
  }
  try {
    const buffer = await readFile(full);
    return { buffer, contentType: null, error: null };
  } catch (e: any) {
    return { buffer: null, contentType: null, error: e };
  }
}

export async function removeObject(bucket: string, path: string): Promise<{ error: Error | null }> {
  if (r2Config) {
    const key = `${bucket}/${normalize(path).replace(/\\/g, '/').replace(/^\/+/, '')}`;
    const res = await r2DeleteObject(r2Config, key);
    return { error: res.error };
  }
  const full = safePath(bucket, path);
  if (!full) return { error: new Error('非法存储路径') };
  try {
    await unlink(full);
    return { error: null };
  } catch {
    // 删除不存在的文件视为幂等成功（对齐 Supabase Storage 语义）
    return { error: null };
  }
}

/**
 * 公开读 URL：
 *  - R2 且配置了 R2_PUBLIC_URL（绑定自定义域 / r2.dev 公开域）→ 直出永久 URL；
 *  - 其余情况 → 走后端 /api/storage/public 代理。该 URL 永不过期，
 *    且无需把桶暴露到公网（适合头像这类要长期存进 profiles 的地址）。
 */
export function publicUrl(bucket: string, path: string): string {
  if (r2Config && env.R2_PUBLIC_URL) {
    const direct = r2PublicDirectUrl(
      env.R2_PUBLIC_URL,
      `${bucket}/${normalize(path).replace(/\\/g, '/').replace(/^\/+/, '')}`,
    );
    if (direct) return direct;
  }
  const rel = proxyRelativeUrl(bucket, path);
  // 小程序没有「同源」概念，相对路径无法加载图片；配置 PUBLIC_BASE_URL 后返回绝对地址。
  const base = (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return base ? `${base}${rel}` : rel;
}

export { getBaseDir };
