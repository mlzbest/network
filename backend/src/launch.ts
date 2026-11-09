/**
 * Node / 容器入口：加载 .env → 构建 Fastify → 挂载 Socket.IO → 监听端口。
 *
 * 应用本体在 server.ts（纯工厂），便于 Cloudflare Workers 通过 app.inject()
 * 复用同一套路由，而不必把 socket.io / dotenv 打进 Worker bundle。
 */
import 'dotenv/config';
import type { Server as HttpServer } from 'node:http';
import { env, corsOrigins } from './env.js';
import { build } from './server.js';
import { initRealtime, broadcastChange } from './realtime/index.js';
import { sendViaExternal } from './edge/smtp.js';

// 数据层不静态依赖 socket.io，改由 Node 入口注入广播实现（Workers 下为 no-op）。
(globalThis as Record<string, unknown>).__DETECT_REALTIME_EMIT__ = broadcastChange;
// SMTP 依赖 node:net / node:tls，Workers 不支持。同样只在 Node 入口注入，
// 保证 Worker bundle 完全不含这两个模块（静态 import 与动态 import 都会被
// esbuild 内联进 bundle 顶层，因此必须走运行时注入）。
(globalThis as Record<string, unknown>).__DETECT_SMTP_SEND__ = sendViaExternal;

async function main() {
  const app = await build();
  const server = app.server as HttpServer;
  initRealtime(server);
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(`[server] 检测网络自建后端已启动: http://localhost:${env.PORT}`);
  console.log(`[server] CORS: ${corsOrigins.join(', ')}`);
}

main().catch((err) => {
  console.error('[server] ❌ 启动失败：', err);
  process.exit(1);
});
