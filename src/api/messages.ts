import { supabase } from '@/supabase/client';
import type { Database } from '@/supabase/types';

export type Message = Database['public']['Tables']['messages']['Row'];
export type MessageInsert = Database['public']['Tables']['messages']['Insert'];

/** 消息类型枚举 */
export type MessageType = 'text' | 'image' | 'voice' | 'emoji';

/**
 * 查询某会话的消息列表，排除当前用户已软删除的消息。
 * 按时间升序返回（聊天界面从旧到新展示）。
 */
export async function listMessages(
  conversationId: string,
  currentUserId: string,
): Promise<Message[]> {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(`查询消息失败: ${error.message}`);
    if (!data || data.length === 0) return [];

    // 查询当前用户已软删除的消息 id（通过 JOIN 限定到当前会话，避免超长 IN 子句）
    const { data: deleted, error: delErr } = await supabase
      .from('message_deletes')
      .select('message_id, messages!inner(conversation_id)')
      .eq('user_id', currentUserId)
      .eq('messages.conversation_id', conversationId);
    if (delErr) throw new Error(`查询删除记录失败: ${delErr.message}`);

    const deletedSet = new Set((deleted ?? []).map((d) => d.message_id));
    return data.filter((m) => !deletedSet.has(m.id));
  } catch (e: any) {
    // H5预览环境网络隔离降级处理
    console.error('[api] 查询消息失败:', e.message);
    if (e.message?.includes('Failed to fetch') || e.message?.includes('502')) {
      console.warn('[api] H5环境网络不可用,返回空数组');
      return [];
    }
    throw e;
  }
}

/**
 * 增量查询对方发来的新消息（轮询降级方案专用）。
 * 只取 created_at 晚于给定时间、且非本人发送的少量行，避免全量重拉整表。
 * 结果已排除当前用户软删除过的消息。
 */
export async function listPeerMessagesSince(
  conversationId: string,
  currentUserId: string,
  sinceIso: string,
): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .neq('sender_id', currentUserId)
    .gt('created_at', sinceIso)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`增量查询新消息失败: ${error.message}`);
  if (!data || data.length === 0) return [];

  const ids = data.map((m) => m.id);
  const { data: deleted, error: delErr } = await supabase
    .from('message_deletes')
    .select('message_id')
    .eq('user_id', currentUserId)
    .in('message_id', ids);
  if (delErr) throw new Error(`查询删除记录失败: ${delErr.message}`);
  const deletedSet = new Set((deleted ?? []).map((d) => d.message_id));
  return data.filter((m) => !deletedSet.has(m.id));
}

/**
 * 查询本人在某会话中已被标记已读的消息（轮询降级方案专用），
 * 用于同步自己发出消息的已读回执，结果集只含 read_at 非空的行。
 */
export async function listMyReadMessages(
  conversationId: string,
  currentUserId: string,
): Promise<Array<{ id: string; read_at: string | null }>> {
  const { data, error } = await supabase
    .from('messages')
    .select('id, read_at')
    .eq('conversation_id', conversationId)
    .eq('sender_id', currentUserId)
    .not('read_at', 'is', null);
  if (error) throw new Error(`查询已读回执失败: ${error.message}`);
  return data ?? [];
}

/** 发送消息 */
export async function sendMessage(
  conversationId: string,
  senderId: string,
  content: string,
  contentType: MessageType = 'text',
  mediaUrl?: string,
): Promise<Message> {
  const insert: MessageInsert = {
    conversation_id: conversationId,
    sender_id: senderId,
    content,
    content_type: contentType,
    media_url: mediaUrl || null,
  };
  const { data, error } = await supabase
    .from('messages')
    .insert(insert)
    .select('*')
    .single();
  if (error) throw new Error(`发送消息失败: ${error.message}`);
  if (!data) throw new Error('发送消息失败：可能被 RLS 策略拦截');
  return data;
}

/**
 * 标记某会话中对方发来的消息为已读。
 * 只更新 sender_id != 当前用户 且 read_at 为 NULL 的消息。
 */
export async function markMessagesAsRead(
  conversationId: string,
  currentUserId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .neq('sender_id', currentUserId)
    .is('read_at', null)
    .select('id');
  if (error) throw new Error(`标记已读失败: ${error.message}`);
  // RLS 拦截时 data 为空数组,不视为致命错误(对方消息可能已被删除)
}

/**
 * 软删除消息（仅删除当前用户视图，对方仍可见）。
 * 在 message_deletes 表插入一条记录（幂等处理）。
 */
export async function deleteMessage(
  messageId: string,
  userId: string,
): Promise<void> {
  // 先查询是否已存在
  const { data: existing, error: queryErr } = await supabase
    .from('message_deletes')
    .select('message_id')
    .eq('message_id', messageId)
    .eq('user_id', userId)
    .maybeSingle();

  if (queryErr) throw new Error(`查询删除记录失败: ${queryErr.message}`);
  if (existing) return;

  // 插入删除记录
  const { data, error } = await supabase
    .from('message_deletes')
    .insert({ message_id: messageId, user_id: userId })
    .select('*');
  if (error) throw new Error(`删除消息失败: ${error.message}`);
  if (!data || data.length === 0) throw new Error('删除消息失败：可能被 RLS 策略拦截');
}

/**
 * 批量软删除某会话的所有消息（仅删除当前用户视图，幂等处理）。
 * 为每条消息在 message_deletes 表插入一条记录。
 */
export async function deleteAllMessages(
  conversationId: string,
  userId: string,
): Promise<void> {
  // 先查询该会话的所有消息
  const { data: messages, error: fetchErr } = await supabase
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId);
  if (fetchErr) throw new Error(`查询消息失败: ${fetchErr.message}`);
  if (!messages || messages.length === 0) return;

  // 先查询当前用户的所有软删除记录(不传message_id列表,避免URL过长)
  const { data: existingDeletes, error: queryErr } = await supabase
    .from('message_deletes')
    .select('message_id')
    .eq('user_id', userId);

  if (queryErr) throw new Error(`查询已存在记录失败: ${queryErr.message}`);

  // 过滤出需要插入的记录
  const existingMessageIds = new Set(existingDeletes?.map(d => d.message_id) || []);
  const newDeletes = messages
    .filter(m => !existingMessageIds.has(m.id))
    .map(m => ({
      message_id: m.id,
      user_id: userId,
    }));

  // 只插入不存在的记录
  if (newDeletes.length > 0) {
    const { error } = await supabase
      .from('message_deletes')
      .insert(newDeletes);
    if (error) throw new Error(`清空聊天记录失败: ${error.message}`);
  }
}
