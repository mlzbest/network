/**
 * 检测网络 · 自建后端 → Cloudflare Containers 入口 Worker
 *
 * 链路：
 *   小程序/H5 → Custom Domain → Worker → 单例 Durable Object → Container:4000
 *   Container 内跑 backend/dist/server.js（Fastify + Socket.IO + pg + R2）
 *
 * 设计要点：
 *   1. 固定单例：后端 Socket.IO 的广播是进程内状态，多实例会漏推送。
 *      max_instances=1，并用 getContainer() 的默认单例名路由所有请求。
 *   2. 容器磁盘全临时：Postgres 与对象存储都在容器外（DATABASE_URL + R2）。
 *      enableInternet 必须为 true，否则 5432 / R2 443 出站会被挡。
 *   3. 密钥只在 Worker 侧，通过 envVars 在容器启动时注入；不进镜像、不进 wrangler.jsonc。
 *   4. 不覆写 Container.fetch()：@cloudflare/containers 的 containerFetch 内部已用
 *      WebSocketPair 双向代理 WebSocket，Socket.IO 与 HTTP 都能透传。
 */
import { Container, getContainer } from '@cloudflare/containers';

export interface Env {
  DETECT_BACKEND: DurableObjectNamespace<DetectBackend>;

  // secrets（wrangler secret put / .dev.vars）
  DATABASE_URL: string;
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

  // vars（wrangler.jsonc）
  PORT: string;
  TZ: string;
  NODE_ENV: string;
  CORS_ORIGINS: string;
  JWT_EXPIRES_IN: string;
  PUBLIC_BASE_URL: string;
  STORAGE_DRIVER: string;
  R2_REGION: string;
  R2_TIMEOUT_MS: string;
  DB_WAIT_RETRIES: string;
  DB_WAIT_INTERVAL_MS: string;
  DB_WAIT_PROBE_MS: string;
}

/** 只把白名单里的标量传进容器，避免把 DO binding / 运行时对象序列化进去。 */
const CONTAINER_ENV_KEYS = [
  'DATABASE_URL', 'JWT_SECRET', 'JWT_EXPIRES_IN', 'PORT', 'TZ', 'NODE_ENV',
  'CORS_ORIGINS', 'PUBLIC_BASE_URL',
  'STORAGE_DRIVER', 'STORAGE_LOCAL_DIR',
  'R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'R2_PUBLIC_URL', 'R2_ENDPOINT', 'R2_REGION', 'R2_TIMEOUT_MS',
  'DB_WAIT_RETRIES', 'DB_WAIT_INTERVAL_MS', 'DB_WAIT_PROBE_MS',
  'RECOVERY_SMTP_HOST', 'RECOVERY_SMTP_PORT', 'RECOVERY_SMTP_USER',
  'RECOVERY_SMTP_PASS', 'RECOVERY_MAIL_FROM',
  'WX_APP_ID', 'WX_APP_SECRET',
] as const;

function collectContainerEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CONTAINER_ENV_KEYS) {
    const value = (env as unknown as Record<string, unknown>)[key];
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  // 容器没有持久盘，不允许任何回落到本地目录的写法。
  out.STORAGE_DRIVER = 'r2';
  return out;
}

// Container 基类 constructor 的 ctx 是 `DurableObject['ctx']`（默认泛型），
// 直接写 DurableObjectState 会因泛型默认值不匹配而报错，这里从类签名精确取出。
type ContainerCtx = ConstructorParameters<typeof Container>[0];

export class DetectBackend extends Container<Env> {
  // pingEndpoint 是「host + path」形式，Container 用 `http://${pingEndpoint}` 探测端口。
  // 指向后端自带的 /api/health，便于日志里区分就绪探测与真实业务请求。
  pingEndpoint = 'container/api/health';
  requiredPorts = [4000];

  constructor(ctx: ContainerCtx, env: Env) {
    super(ctx, env, {
      defaultPort: 4000,
      // 空闲 20 分钟后休眠；休眠后磁盘回到镜像初始状态（数据不在本地，安全）。
      // 冷启动约 1-3s + wait-db + schema init，调大可减少用户侧首包延迟。
      sleepAfter: '20m',
      // 必须为 true：外部 Postgres(5432) 与 R2 S3(443) 都需要出站。
      // 设为 false 时只有 80/443 能走 outbound handler，5432 会被直接拒绝。
      enableInternet: true,
      envVars: collectContainerEnv(env),
    });
  }

  override onStart(): void {
    console.log('[container] detect-network backend ready on :4000');
  }

  override onStop(params: { exitCode: number; reason: 'exit' | 'runtime_signal' }): void {
    console.log('[container] stopped', params.exitCode, params.reason);
  }

  override onError(error: unknown): never {
    console.error('[container] startup failed:', error);
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Worker 自身探活：不唤醒容器，用于确认入口 Worker 已部署。
    if (url.pathname === '/__worker/health') {
      return Response.json({ ok: true, worker: 'detect-network-api', ts: Date.now() });
    }

    // 单例路由：所有请求（含 /api/health、/socket.io/ WebSocket 升级）走同一实例。
    // 不覆写 Container.fetch()，保留库内置的 WebSocket 双向代理。
    return getContainer(env.DETECT_BACKEND).fetch(request);
  },
} satisfies ExportedHandler<Env>;
