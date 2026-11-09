import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { requireAuth } from '../auth/guard.js';
import { runQuery, type QuerySpec } from './query-engine.js';

/**
 * 写操作后的实时广播通过运行时注入，而不是静态 import realtime/index.ts：
 * 后者会引入 socket.io（长驻进程依赖），打不进 Cloudflare Workers bundle。
 * Node 入口 launch.ts 注入真实实现；Workers 未注入时自动降级为 no-op
 * （前端 .channel() 本就是轮询兜底，实时性不受影响）。
 */
type ChangeEmitter = (
  table: string,
  eventType: 'INSERT' | 'UPDATE' | 'DELETE',
  newRow: unknown,
  oldRow?: unknown,
) => void;

function broadcastChange(
  table: string,
  eventType: 'INSERT' | 'UPDATE' | 'DELETE',
  newRow: unknown,
  oldRow?: unknown,
): void {
  const emit = (globalThis as Record<string, unknown>).__DETECT_REALTIME_EMIT__ as
    | ChangeEmitter
    | undefined;
  emit?.(table, eventType, newRow, oldRow);
}

export async function dataRouter(app: FastifyInstance) {
  // 通用数据接口：替代 supabase.from().select/insert/update/delete
  app.post('/api/db', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const spec = (req.body ?? {}) as QuerySpec;
    if (!spec.op || !spec.table) {
      return reply.code(400).send({ error: '缺少 op / table' });
    }
    const result = await runQuery(spec, user.uid);

    // 写操作后广播变更（替代 postgres_changes）
    if (spec.op !== 'select' && !result.error) {
      const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
      const eventType = spec.op === 'insert' ? 'INSERT' : spec.op === 'update' ? 'UPDATE' : 'DELETE';
      for (const row of rows) {
        broadcastChange(spec.table, eventType, spec.op === 'delete' ? null : row, spec.op === 'delete' ? row : undefined);
      }
    }

    return reply.send(result);
  });

  // RPC：替代 supabase.rpc()
  app.post('/api/rpc', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const { name, params } = (req.body ?? {}) as { name?: string; params?: Record<string, unknown> };

    if (name === 'get_conversation_summaries') {
      const { rows } = await query(
        'SELECT * FROM get_conversation_summaries($1)',
        [user.uid],
      );
      return reply.send({ data: rows, error: null });
    }

    if (name === 'purge_conversation_if_both_deleted') {
      const convId = (params as any)?._conversation_id as string | undefined;
      if (!convId) return reply.code(400).send({ error: '缺少 _conversation_id' });
      // 先写入当前用户的软删除标记（等价原 SECURITY DEFINER 前置步骤）
      await query(
        `INSERT INTO conversation_deletes (user_id, conversation_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, conversation_id) DO NOTHING`,
        [user.uid, convId],
      );
      const { rows } = await query<{ purge_conversation_if_both_deleted: boolean }>(
        'SELECT purge_conversation_if_both_deleted($1) AS purge_conversation_if_both_deleted',
        [convId],
      );
      const purged = rows[0]?.purge_conversation_if_both_deleted ?? false;
      if (purged) broadcastChange('conversations', 'DELETE', null, { id: convId });
      return reply.send({ data: purged, error: null });
    }

    return reply.code(404).send({ error: `未知 RPC: ${name}` });
  });
}
