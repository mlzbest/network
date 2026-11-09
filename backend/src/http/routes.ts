import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/guard.js';
import { uploadObject, readObject, removeObject, publicUrl } from '../storage/index.js';

/**
 * 核心路由（健康探活 + 对象存储）。
 *
 * 单独抽出来是为了让 Node 入口（Fastify）和 Cloudflare Workers 入口
 * （轻量路由层）注册完全相同的 handler，避免两套实现漂移。
 */
export async function registerCoreRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));

  // 存储上传（Bearer 鉴权）
  app.post('/api/storage/upload', async (req, reply) => {
    // 必须验签，不能只看前缀：否则任意伪造 `Bearer x` 即可上传
    const user = await requireAuth(req, reply);
    if (!user) return;
    const { bucket, path, contentBase64, contentType } = (req.body ?? {}) as {
      bucket?: string;
      path?: string;
      contentBase64?: string;
      contentType?: string;
    };
    if (!bucket || !path || !contentBase64) {
      return reply.code(400).send({ error: '缺少 bucket / path / contentBase64' });
    }
    const buffer = Buffer.from(contentBase64, 'base64');
    const res = await uploadObject(bucket, path, buffer, contentType || 'application/octet-stream');
    if (res.error) return reply.code(500).send({ error: res.error.message });
    return reply.send({ data: { path, publicUrl: publicUrl(bucket, path) }, error: null });
  });

  // 公开读（头像 / 缩略图 / 聊天媒体）
  app.get('/api/storage/public/*', async (req, reply) => {
    const wildcard = (req.params as any)['*'] as string;
    // 形如 /api/storage/public/<bucket>/<path...>
    const match = `/${wildcard}`.match(/^\/([^/]+)\/(.+)$/);
    if (!match) return reply.code(400).send({ error: '路径格式错误' });
    const bucket = decodeURIComponent(match[1]);
    const path = match[2];
    const { buffer, contentType, error } = await readObject(bucket, path);
    if (error || !buffer) return reply.code(404).send({ error: '文件不存在' });
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const MIME: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', mp3: 'audio/mpeg',
      m4a: 'audio/mp4', pdf: 'application/pdf', txt: 'text/plain',
    };
    // R2 驱动会带回对象真实的 Content-Type；本地驱动无元数据，回落到扩展名猜测
    reply.header('Content-Type', contentType || MIME[ext] || 'application/octet-stream');
    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.send(buffer);
  });

  // 存储删除（Bearer 鉴权，与 Supabase Storage.remove(paths) 语义对齐）
  app.post('/api/storage/remove', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const { bucket, paths } = (req.body ?? {}) as { bucket?: string; paths?: string | string[] };
    if (!bucket || !paths) return reply.code(400).send({ error: '缺少 bucket / paths' });
    const list = (Array.isArray(paths) ? paths : [paths]).map(String);
    if (list.length === 0 || list.length > 50) {
      return reply.code(400).send({ error: 'paths 数量需在 1~50 之间' });
    }
    for (const path of list) {
      const { error } = await removeObject(bucket, path);
      if (error) return reply.code(500).send({ error: error.message });
    }
    return reply.send({ data: { removed: list.length }, error: null });
  });
}
