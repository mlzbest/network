/**
 * Cloudflare R2 存储驱动（S3 兼容 API / AWS SigV4 签名）。
 *
 * 刻意不引入 @aws-sdk/client-s3：后端只需要 PUT / GET / DELETE 三个对象操作，
 * 用 node:crypto + 全局 fetch 即可完成，镜像不增加约 10 MB 的 SDK 依赖，
 * 也避免 pnpm 构建脚本白名单的额外维护成本。
 *
 * R2 的 SigV4 参数：region = "auto"、service = "s3"、path-style 寻址
 * （https://<account_id>.r2.cloudflarestorage.com/<bucket>/<key>）。
 */
import { createHash, createHmac } from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const TERMINATOR = 'aws4_request';

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 覆盖默认 endpoint；用于本地 S3 mock 或其它 S3 兼容服务 */
  endpoint?: string;
  /** R2 固定为 auto；其它 S3 兼容服务可覆盖 */
  region?: string;
  /** 单次请求超时（毫秒） */
  timeoutMs?: number;
}

const sha256hex = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 编码：AWS 要求连 !'()* 也转义，encodeURIComponent 不会处理这几个字符。 */
function awsEncode(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * 对象 key 规范化。拒绝目录穿越与控制字符，避免把本地文件系统那套
 * `..` 语义带进对象存储，也避免签名 URI 被中间代理二次规范化。
 */
export function normalizeKey(key: string): string {
  const cleaned = String(key || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned) throw new Error('R2: 对象 key 不能为空');
  if (cleaned.includes('\0')) throw new Error('R2: 对象 key 含非法字符');
  const segments = cleaned.split('/');
  if (segments.some((s) => s === '.' || s === '..' || s === '')) {
    throw new Error('R2: 对象 key 含非法路径段');
  }
  return cleaned;
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/** 生成一次带 SigV4 签名的请求。导出以便测试独立复算校验。 */
export function signRequest(
  cfg: R2Config,
  method: 'PUT' | 'GET' | 'DELETE',
  rawKey: string,
  body: Buffer,
  contentType?: string,
  now: Date = new Date(),
): SignedRequest {
  const region = cfg.region || 'auto';
  const endpoint = (cfg.endpoint || `https://${cfg.accountId}.r2.cloudflarestorage.com`).replace(
    /\/+$/,
    '',
  );
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    throw new Error(`R2: endpoint 非法: ${endpoint}`);
  }
  if (base.search) throw new Error('R2: endpoint 不能带查询串');

  const key = normalizeKey(rawKey);
  const basePath = base.pathname.replace(/\/+$/, '');
  // canonicalUri 与实际请求 URL 使用同一份编码，避免签名与发送路径不一致
  const objectPath = `/${awsEncode(cfg.bucket)}/${key.split('/').map(awsEncode).join('/')}`;
  const canonicalUri = `${basePath}${objectPath}`;

  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20261109T023541Z
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);

  const headers: Record<string, string> = {
    host: base.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (method === 'PUT') {
    headers['content-type'] = contentType || 'application/octet-stream';
  }

  // 签名头必须按字典序拼接；host 一并显式发送，保证与签名时的值严格一致
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    method,
    canonicalUri,
    '', // 本驱动不使用查询参数
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${SERVICE}/${TERMINATOR}`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const dateKey = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, SERVICE);
  const signingKey = hmac(serviceKey, TERMINATOR);
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  headers.authorization =
    `${ALGORITHM} Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { url: `${base.origin}${canonicalUri}`, headers };
}

async function send(
  cfg: R2Config,
  method: 'PUT' | 'GET' | 'DELETE',
  key: string,
  body: Buffer = Buffer.alloc(0),
  contentType?: string,
): Promise<Response> {
  const { url, headers } = signRequest(cfg, method, key, body, contentType);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: method === 'PUT' ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
    });
  } catch (e: any) {
    throw new Error(`R2 ${method} 网络失败: ${e?.message || e}`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`R2 ${method} 失败 (${res.status}): ${detail}`);
  }
  return res;
}

export async function r2PutObject(
  cfg: R2Config,
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ etag: string | null; error: Error | null }> {
  try {
    const res = await send(cfg, 'PUT', key, buffer, contentType);
    return { etag: res.headers.get('etag'), error: null };
  } catch (e: any) {
    return { etag: null, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

export async function r2GetObject(
  cfg: R2Config,
  key: string,
): Promise<{ buffer: Buffer | null; contentType: string | null; error: Error | null }> {
  try {
    const res = await send(cfg, 'GET', key);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType: res.headers.get('content-type'), error: null };
  } catch (e: any) {
    return { buffer: null, contentType: null, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

export async function r2DeleteObject(
  cfg: R2Config,
  key: string,
): Promise<{ error: Error | null }> {
  try {
    await send(cfg, 'DELETE', key);
    return { error: null };
  } catch (e: any) {
    return { error: e instanceof Error ? e : new Error(String(e)) };
  }
}

/**
 * 公开域直出 URL。R2 的自定义域 / r2.dev 公开域已经绑定到桶，
 * 因此 URL 里不带桶名，只有对象 key：`https://pub-xxx.r2.dev/<key>`。
 * 未配置公开域时返回 null，由后端 /api/storage/public 代理读取（URL 永不过期）。
 */
export function r2PublicDirectUrl(publicUrl: string, key: string): string | null {
  if (!publicUrl) return null;
  const normalized = normalizeKey(key);
  return `${publicUrl.replace(/\/+$/, '')}/${normalized.split('/').map(awsEncode).join('/')}`;
}
