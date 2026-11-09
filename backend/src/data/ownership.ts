import { query } from '../db/pool.js';
import { isKnownColumn } from '../db/schema-map.js';

export type Op = 'select' | 'insert' | 'update' | 'delete';

/**
 * 自研后端对 RLS 的等价替代：返回必须注入到 WHERE 的所有权谓词。
 * 返回 null 表示「无限制（允许读取全部）」。
 *
 * 规则依据原 Supabase RLS 策略语义反推：
 *  - profiles：SELECT 对所有登录用户可见（联系人/对端资料）；写操作限定 id = uid
 *  - conversations / messages：仅参与者可访问
 *  - *_deletes / *_visibility / login_events / location / steps：仅本人行
 */
export function ownershipWhere(
  table: string,
  op: Op,
  uid: string,
): { sql: string; params: unknown[] } | null {
  switch (table) {
    case 'profiles':
      if (op === 'select') return null; // 可读全部
      return { sql: 'id = $1', params: [uid] };
    case 'conversations':
      if (op === 'insert') return null; // 由 enforceInsertOwner 单独校验参与者
      return { sql: '(user1_id = $1 OR user2_id = $1)', params: [uid] };
    case 'messages': {
      if (op === 'insert') return null; // 由 enforceInsertOwner 校验会话归属 + 发送者
      const sql =
        'conversation_id IN (SELECT id FROM conversations WHERE user1_id = $1 OR user2_id = $1)';
      return { sql, params: [uid] };
    }
    case 'conversation_deletes':
    case 'message_deletes':
    case 'message_visibility':
    case 'login_events':
    case 'user_location_history':
    case 'user_we_run_steps':
      return { sql: 'user_id = $1', params: [uid] };
    default:
      return null;
  }
}

/**
 * 写入（insert）前强制把「所有者列」绑定到当前用户，防止越权冒充。
 * 返回可能被修正后的 values，若非法则抛出。
 */
export async function enforceInsertOwner(
  table: string,
  values: Record<string, unknown>,
  uid: string,
): Promise<Record<string, unknown>> {
  const v = { ...values };
  switch (table) {
    case 'profiles':
      v.id = uid; // 自建后 profile.id 即账号主键
      break;
    case 'conversations': {
      const a = v.user1_id;
      const b = v.user2_id;
      if (a !== uid && b !== uid) {
        // 若客户端只填了对方，则把当前用户补为 user1_id
        if (a == null || b == null) {
          v.user1_id = uid;
          if (v.user2_id == null) v.user2_id = a ?? b;
        } else {
          throw new Error('FORBIDDEN: 你不能创建不属于自己的会话');
        }
      }
      break;
    }
    case 'messages': {
      v.sender_id = uid; // 发送者必须是本人
      // 校验会话确实属于本人
      const { rows } = await query<{ id: string }>(
        'SELECT id FROM conversations WHERE id = $1 AND (user1_id = $2 OR user2_id = $2) LIMIT 1',
        [v.conversation_id, uid],
      );
      if (!rows[0]) throw new Error('FORBIDDEN: 会话不存在或不属于你');
      break;
    }
    case 'conversation_deletes':
    case 'message_deletes':
    case 'message_visibility':
    case 'login_events':
    case 'user_location_history':
    case 'user_we_run_steps':
      v.user_id = uid;
      break;
    default:
      break;
  }
  // 列名校验
  for (const key of Object.keys(v)) {
    if (!isKnownColumn(table, key)) throw new Error(`UNKNOWN_COLUMN: ${table}.${key}`);
  }
  return v;
}
