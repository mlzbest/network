/**
 * 表 → 列白名单。用于校验客户端传入的列名 / 排序字段，杜绝 SQL 注入
 * （列名无法参数化，只能白名单校验）。内容依据 src/supabase/types.ts 的真实结构。
 */
export const TABLE_COLUMNS: Record<string, Set<string>> = {
  profiles: new Set([
    'id', 'username', 'email', 'avatar_url', 'nickname', 'openid', 'unionid',
    'hide_presence', 'created_at', 'last_active_at', 'last_lat', 'last_lng',
    'last_location_at', 'last_login_at', 'last_logout_at', 'last_seen_boundary_at',
    'presence_at', 'presence_state', 'recovery_sent_at', 'recovery_token_hash',
  ]),
  conversations: new Set([
    'id', 'user1_id', 'user2_id', 'last_message', 'last_message_at', 'created_at',
  ]),
  conversation_deletes: new Set(['id', 'user_id', 'conversation_id', 'created_at']),
  messages: new Set([
    'id', 'conversation_id', 'sender_id', 'content', 'content_type', 'media_url',
    'reply_to_id', 'reply_to_content', 'delivered_at', 'read_at', 'revoked_at', 'created_at',
  ]),
  message_deletes: new Set(['id', 'user_id', 'message_id', 'created_at']),
  message_visibility: new Set(['id', 'user_id', 'message_id', 'created_at']),
  login_events: new Set(['id', 'user_id', 'logged_at']),
  user_location_history: new Set(['id', 'user_id', 'lat', 'lng', 'name', 'address', 'recorded_at']),
  user_we_run_steps: new Set(['id', 'user_id', 'day', 'steps', 'created_at', 'updated_at']),
};

export function isKnownTable(table: string): boolean {
  return Object.prototype.hasOwnProperty.call(TABLE_COLUMNS, table);
}

export function isKnownColumn(table: string, column: string): boolean {
  const cols = TABLE_COLUMNS[table];
  return !!cols && cols.has(column);
}
