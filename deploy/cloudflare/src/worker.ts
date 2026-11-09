/**
 * 检测网络 · Cloudflare Workers Free 入口（无容器、无 Workers Paid）
 *
 * 链路：
 *   小程序/H5 → Custom Domain → Worker → app.inject() → backend/dist/server.js
 *                                      ↘ Hyperdrive → 外部 Postgres（Supabase 免费层）
 *                                      ↘ R2 REST（SigV4，复用 backend/src/storage/r2.ts）
 *
 * 与 Containers 入口（src/index.ts）互斥：同一个 custom domain 只能绑一个 Worker。
 *
 * 三个关键适配：
 *   1. Workers 没有长驻端口，Fastify 不能 listen()；用 app.inject() 把 Request/Response
 *      翻译成内存请求，路由、鉴权、数据层代码零改动复用。
 *   2. env.ts 顶层解析环境变量，静态 import 会早于 bindings 注入 → 必须动态 import，
 *      并在 import 之前把标量 bindings 与 Hyperdrive 连接串写入 globalThis。
 *   3. pg.Pool 是跨请求长连接池，Workers 不适用 → pool.ts 检测 __DETECT_DB_URL__
 *      后改为「每请求 new Client()」，真实连接池由 Hyperdrive 在边缘侧维护。
 */

interface HyperdriveBinding {
  connectionString: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

export interface Env {
  HYPERDRIVE: HyperdriveBinding;

  // secrets（wrangler secret put / .dev.vars）
  JWT_SECRET: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_PUBLIC_URL?: string;
  R2_ENDPOINT?: string;
  RECOVERY_SMTP_HOST?: string;
  RECOVERY_SMTP_PORT?: string;
  RECOVERY_SMTP_USER?: string;
  RECOVERY_SMTP_PASS?: string;
  RECOVERY_MAIL_FROM?: string;
  WX_APP_ID?: string;
  WX_APP_SECRET?: string;

  // vars（wrangler.workers.jsonc）
  NODE_ENV?: string;
  TZ?: string;
  CORS_ORIGINS?: string;
  JWT_EXPIRES_IN?: string;
  PUBLIC_BASE_URL?: string;
  STORAGE_DRIVER?: string;
  R2_REGION?: string;
  R2_TIMEOUT_MS?: string;
}

/** 只把标量 bindings 注入后端 env，避免把 HYPERDRIVE 对象混进 process.env。 */
const SCALAR_ENV_KEYS = [
  'JWT_SECRET', 'JWT_EXPIRES_IN', 'PORT', 'TZ', 'NODE_ENV',
  'CORS_ORIGINS', 'PUBLIC_BASE_URL',
  'STORAGE_DRIVER', 'R2_ACCOUNT_ID', 'R2_BUCKET',
  'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'R2_PUBLIC_URL', 'R2_ENDPOINT', 'R2_REGION', 'R2_TIMEOUT_MS',
  'RECOVERY_SMTP_HOST', 'RECOVERY_SMTP_PORT', 'RECOVERY_SMTP_USER',
  'RECOVERY_SMTP_PASS', 'RECOVERY_MAIL_FROM',
  'WX_APP_ID', 'WX_APP_SECRET',
] as const;

interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  rawPayload: Uint8Array;
}

interface InjectApp {
  inject(opts: {
    method: string;
    url: string;
    headers: Record<string, string>;
    payload?: Uint8Array;
  }): Promise<InjectResponse>;
}

let appPromise: Promise<InjectApp> | undefined;

async function getApp(env: Env): Promise<InjectApp> {
  if (!appPromise) {
    const injected: Record<string, string> = {};
    for (const key of SCALAR_ENV_KEYS) {
      const value = (env as unknown as Record<string, unknown>)[key];
      if (typeof value === 'string' && value !== '') injected[key] = value;
    }
    // Worker 无持久盘，本地存储分支必须关闭；数据库改由 Hyperdrive 提供。
    injected.STORAGE_DRIVER = 'r2';
    injected.DATABASE_URL = env.HYPERDRIVE.connectionString;
    injected.PORT = '4000';

    (globalThis as Record<string, unknown>).__DETECT_ENV__ = injected;
    (globalThis as Record<string, unknown>).__DETECT_DB_URL__ = env.HYPERDRIVE.connectionString;

    // Fastify 4 的 find-my-way 使用 new Function()，Workers 禁用动态代码求值，
    // 因此这里加载轻量路由层（与 Node 入口共享同一批业务 handler）。
    // @ts-ignore —— 后端 dist 由 Wrangler 在打包时解析，类型由 InjectApp 约束。
    const mod = await import('../../../backend/dist/http/worker-app.js');
    appPromise = mod.buildWorkerApp() as Promise<InjectApp>;
  }
  return appPromise;
}

function toResponse(res: InjectResponse, method: string): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (value == null) continue;
    const lower = key.toLowerCase();
    if (lower === 'transfer-encoding' || lower === 'connection') continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, String(item));
    } else {
      headers.set(key, String(value));
    }
  }
  const body = method === 'HEAD' ? null : new Uint8Array(res.rawPayload);
  return new Response(body, { status: res.statusCode, headers });
}

/** scrypt 基准：Workers Free 每次调用只有 10ms CPU，密码哈希必须先量化。 */
async function bench(): Promise<Response> {
  // @ts-ignore —— 同上，后端产物运行时解析。
  const { hashPassword, verifyPassword } = await import('../../../backend/dist/auth/password.js');
  const t0 = performance.now();
  const stored = await hashPassword('bench-password-123');
  const t1 = performance.now();
  const ok = await verifyPassword('bench-password-123', stored);
  const t2 = performance.now();
  return Response.json({
    runtime: 'cloudflare-workers',
    hashMs: Math.round((t1 - t0) * 100) / 100,
    verifyMs: Math.round((t2 - t1) * 100) / 100,
    totalMs: Math.round((t2 - t0) * 100) / 100,
    verified: ok,
    note: 'Workers Free CPU 上限 10ms/请求（网络等待不计入）；此处为 wall time，含原生 crypto 执行',
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 纯 Worker 探活：不加载后端、不连数据库，用于确认部署成功。
    if (url.pathname === '/__worker/health') {
      return Response.json({ ok: true, worker: 'detect-network-worker', ts: Date.now() });
    }
    if (url.pathname === '/__worker/bench') return bench();

    const method = request.method.toUpperCase();
    try {
      const app = await getApp(env);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });

      let payload: Uint8Array | undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        payload = new Uint8Array(await request.arrayBuffer());
      }

      const res = await app.inject({
        method,
        url: url.pathname + url.search,
        headers,
        payload,
      });
      return toResponse(res, method);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[worker] request failed:', message);
      return Response.json(
        { error: 'internal_error', message: message.slice(0, 300) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Env>;
