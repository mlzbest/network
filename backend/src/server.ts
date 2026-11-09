import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { corsOrigins } from './env.js';
import { authRouter } from './auth/router.js';
import { dataRouter } from './data/routes.js';
import { edgeRouter } from './edge/routes.js';
import { registerCoreRoutes } from './http/routes.js';

/**
 * Node 应用工厂：只注册路由，不监听端口、不初始化 Socket.IO。
 * 启动逻辑见 launch.ts；Cloudflare Workers 因 find-my-way 使用 new Function()
 * 而无法运行 Fastify，改用 http/worker-app.ts 注册同一批 handler。
 */
async function build(): Promise<FastifyInstance> {
  // 头像 / 聊天图片经 base64 走 JSON 上传，体积约为原始文件的 1.33 倍。
  // Fastify 默认 bodyLimit 仅 1 MiB，会直接拒绝较大的图片上传。
  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 });

  await app.register(cors, { origin: corsOrigins.includes('*') ? true : corsOrigins });

  await app.register(authRouter);
  await app.register(dataRouter);
  await app.register(edgeRouter);
  await app.register(registerCoreRoutes);

  return app;
}

export { build };
