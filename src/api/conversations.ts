import { supabase } from '@/supabase/client';
import type { Database } from '@/supabase/types';
import type { Profile } from './profiles';

export type Conversation = Database['public']['Tables']['conversations']['Row'];
export type ConversationInsert = Database['public']['Tables']['conversations']['Insert'];

/** 带对方资料的会话项 */
export interface ConversationWithPeer extends Conversation {
  peer: Profile;
  unread_count?: number; // 未读消息数
}

/**
 * 查询当前用户的所有会话，附带对方资料和未读消息数。
 * 用两条查询拼合，避免 RLS 下跨表 join 的复杂度。
 */
export async function listConversations(currentUserId: string): Promise<ConversationWithPeer[]> {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .or(`user1_id.eq.${currentUserId},user2_id.eq.${currentUserId}`)
    .order('last_message_at', { ascending: false, nullsFirst: false });
  if (error) throw new Error(`查询会话列表失败: ${error.message}`);
  if (!data || data.length === 0) return [];

  // 收集所有对方 user id
  const peerIds = data.map((c) =>
    c.user1_id === currentUserId ? c.user2_id : c.user1_id,
  );
  const { data: peers, error: peerErr } = await supabase
    .from('profiles')
    .select('*')
    .in('id', peerIds);
  if (peerErr) throw new Error(`查询对方资料失败: ${peerErr.message}`);

  const peerMap = new Map<string, Profile>();
  for (const p of peers ?? []) {
    peerMap.set(p.id, p);
  }

  const conversations = data.map((c) => {
    const peerId = c.user1_id === currentUserId ? c.user2_id : c.user1_id;
    return { ...c, peer: peerMap.get(peerId)! };
  }).filter((c) => c.peer);

  // 过滤掉当前用户已软删除所有消息的会话,并统计未读数
  console.log('[api] 开始过滤已软删除所有消息的会话, 总数:', conversations.length);
  const filteredConversations: ConversationWithPeer[] = [];

  // 步骤1: 收集所有会话ID,一次性查询所有消息
  const conversationIds = conversations.map(c => c.id);
  const { data: allMessages, error: msgErr } = await supabase
    .from('messages')
    .select('id, conversation_id, sender_id, read_at')
    .in('conversation_id', conversationIds);

  if (msgErr) {
    console.error('[api] 查询消息失败:', msgErr);
    return conversations; // 出错时返回原始数据
  }

  // 按会话ID分组消息
  const messagesByConv = new Map<string, Array<{id: string; sender_id: string; read_at: string | null}>>();
  for (const msg of allMessages || []) {
    const msgs = messagesByConv.get(msg.conversation_id) || [];
    msgs.push({ id: msg.id, sender_id: msg.sender_id, read_at: msg.read_at });
    messagesByConv.set(msg.conversation_id, msgs);
  }

  // 步骤2: 查询当前用户的所有软删除记录(不传message_id列表,避免URL过长)
  // message_deletes表有(user_id, message_id)联合唯一索引,按user_id查询效率高
  const { data: deletedRecords, error: delErr } = await supabase
    .from('message_deletes')
    .select('message_id')
    .eq('user_id', currentUserId);

  if (delErr) {
    console.error('[api] 查询软删除记录失败:', delErr);
    return conversations; // 出错时返回原始数据
  }

  const deletedMessageIds = new Set<string>();
  deletedRecords?.forEach(d => deletedMessageIds.add(d.message_id));
  console.log(`[api] 查询到${deletedMessageIds.size}条软删除记录(用户维度全量)`);

  // 步骤3: 遍历每个会话,计算剩余消息数和未读数
  for (const conv of conversations) {
    const convMessages = messagesByConv.get(conv.id) || [];

    // 如果没有消息,跳过该会话
    if (convMessages.length === 0) {
      console.log('[api] 过滤掉会话:', conv.id, '(没有消息)');
      continue;
    }

    // 计算未软删除的消息
    const remainingMessages = convMessages.filter(m => !deletedMessageIds.has(m.id));

    // 计算未读消息数(read_at为NULL且sender不是当前用户)
    const unreadCount = remainingMessages.filter(
      m => m.read_at === null && m.sender_id !== currentUserId
    ).length;

    console.log(`[api] 会话 ${conv.id.substring(0,8)}... : 总消息${convMessages.length}条, 已软删除${convMessages.length - remainingMessages.length}条, 剩余${remainingMessages.length}条, 未读${unreadCount}条`);

    // 只有当还有未软删除的消息时,才保留该会话
    if (remainingMessages.length > 0) {
      filteredConversations.push({ ...conv, unread_count: unreadCount });
    } else {
      console.log('[api] 过滤掉会话:', conv.id, `(所有${convMessages.length}条消息已被软删除)`);
    }
  }

  console.log('[api] 过滤后会话数:', filteredConversations.length);
  return filteredConversations;
}

/**
 * 获取或创建两个用户之间的会话。
 * 如果已存在则返回已有会话，否则新建。
 */
export async function getOrCreateConversation(
  currentUserId: string,
  peerId: string,
): Promise<Conversation> {
  // 先查是否已有会话
  const { data: existing, error: queryErr } = await supabase
    .from('conversations')
    .select('*')
    .or(`user1_id.eq.${currentUserId},user2_id.eq.${currentUserId}`)
    .or(`user1_id.eq.${peerId},user2_id.eq.${peerId}`);
  if (queryErr) throw new Error(`查询会话失败: ${queryErr.message}`);

  // 在结果中找到同时包含两个用户的会话
  const found = (existing ?? []).find(
    (c) =>
      (c.user1_id === currentUserId && c.user2_id === peerId) ||
      (c.user1_id === peerId && c.user2_id === currentUserId),
  );
  if (found) return found;

  // 新建会话
  const insert: ConversationInsert = {
    user1_id: currentUserId,
    user2_id: peerId,
  };
  const { data: created, error: createErr } = await supabase
    .from('conversations')
    .insert(insert)
    .select('*')
    .single();
  if (createErr) throw new Error(`创建会话失败: ${createErr.message}`);
  if (!created) throw new Error('创建会话失败：可能被 RLS 策略拦截');
  return created;
}

/** 更新会话的最后消息（发消息时调用） */
export async function updateLastMessage(
  conversationId: string,
  lastMessage: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('conversations')
    .update({
      last_message: lastMessage,
      last_message_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
    .select('*');
  if (error) throw new Error(`更新会话失败: ${error.message}`);
  if (!data || data.length === 0) throw new Error('更新会话失败：可能被 RLS 策略拦截');
}

/**
 * 删除会话及其所有消息（物理删除）。
 * 直接删除该会话的所有消息记录，然后删除会话本身。
 */
export async function deleteConversation(
  conversationId: string,
  currentUserId: string,
): Promise<void> {
  console.log('[api] 开始删除会话:', conversationId, '用户:', currentUserId);

  try {
    // 步骤1: 查询该会话的所有消息
    console.log('[api] 步骤1: 查询会话消息, conversationId=', conversationId);
    const { data: messages, error: msgErr } = await supabase
      .from('messages')
      .select('id, conversation_id')
      .eq('conversation_id', conversationId);
    if (msgErr) {
      console.error('[api] 查询消息失败:', msgErr);
      throw new Error(`查询消息失败: ${msgErr.message}`);
    }
    console.log('[api] 步骤1完成: 找到', messages?.length || 0, '条消息');

    // 步骤2: 物理删除该会话的所有消息(直接用conversation_id过滤,避免URL过长)
    console.log('[api] 步骤2: 开始物理删除会话消息');
    const { error: deleteErr } = await supabase
      .from('messages')
      .delete()
      .eq('conversation_id', conversationId);

    if (deleteErr) {
      console.error('[api] 删除消息失败:', deleteErr);
      throw new Error(`删除消息失败: ${deleteErr.message}`);
    }

    console.log('[api] 步骤2完成: 会话消息已物理删除');

    // 步骤3: 删除会话本身
    console.log('[api] 步骤3: 删除会话记录...');
    const { error: convErr, count } = await supabase
      .from('conversations')
      .delete()
      .eq('id', conversationId);
    if (convErr) {
      console.error('[api] 删除会话失败:', convErr);
      throw new Error(`删除会话失败: ${convErr.message}`);
    }
    console.log('[api] 步骤3完成: 会话删除成功,受影响行数:', count);
    console.log('[api] ✅ 删除会话完成');
  } catch (error) {
    console.error('[api] ❌ 删除会话异常:', error);
    throw error;
  }
}
