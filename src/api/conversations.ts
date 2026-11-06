import { supabase } from '@/supabase/client';
import type { Database } from '@/supabase/types';
import { useProfilesStore } from '@/store/profiles-store';
import { buildThumbUrl } from '@/lib/thumb-url';
import type { Profile } from './profiles';
import { logDbg } from '../lib/logger';

export type Conversation = Database['public']['Tables']['conversations']['Row'];
export type ConversationInsert = Database['public']['Tables']['conversations']['Insert'];

/** 会话级软删除记录（谁把这个会话删了） */
type ConvDeleteRow = Database['public']['Tables']['conversation_deletes']['Row'];

/**
 * 取当前用户已「软删除」的会话 id 集合。
 * conversation_deletes 的 RLS 只允许读自己的行，故无需额外传 user_id 过滤条件
 * （仍显式 eq 一次，避免依赖策略行为）。失败时返回空集合：宁可多显示会话，
 * 也不能因为一次查询抖动就把用户的全部会话抹掉。
 */
async function fetchMyDeletedConvIds(currentUserId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('conversation_deletes')
    .select('conversation_id')
    .eq('user_id', currentUserId);
  if (error) {
    console.error('[api] ⚠️ 查询本人已删除会话失败，本次不做会话隐藏过滤:', error.message);
    return new Set();
  }
  const set = new Set<string>(
    (data as Array<ConvDeleteRow> | null | undefined)?.map((d) => String(d.conversation_id)) ?? [],
  );
  logDbg(`[api] 🗑️ 本人已软删除的会话数: ${set.size}`);
  return set;
}

/**
 * 判断某会话是否已被双方删除（用于决定能否彻底清理 / 是否还该展示）。
 *
 * ⚠️⚠️ 缺陷⑫（用户报「双方删除后再次进入聊天信息还是存在」的**真正根因**，勿再改回前端查询）：
 *   `conversation_deletes` 的 RLS 是 `FOR SELECT USING (user_id = auth.uid())` ——
 *   **只能读到自己的行**。旧实现用 `.in('user_id', [user1_id, user2_id])` 想一次查出双方标记，
 *   但 RLS 会把对方那行直接过滤掉，`deletedUsers` 最多只有 1 个元素 →
 *   `both` **恒为 false** → `deleteConversation` 里 `if (!bothDeleted) return { purged: false }`
 *   永远提前返回 → **`purge_conversation_if_both_deleted` 从未被调用过** →
 *   conversations / messages 行一直留在库里 → 双方都删了、再次发起聊天时
 *   `getOrCreateConversation` 复用旧会话行 → 旧消息全部复活。
 *
 *   正解：**判定必须交给服务端**。`purge_conversation_if_both_deleted` 是 `SECURITY DEFINER`，
 *   它内部查 `conversation_deletes` 时**不受 RLS 限制**，能正确数出双方标记（`v_count >= 2`）
 *   并自行决定是否物理清理。因此前端**不再做这个判断**，直接调 RPC 拿它的返回值即可。
 *
 *   本函数保留仅为兼容历史调用方，语义改为「调用 RPC 并返回它是否真的清理了」。
 *   ⚠️ 不要再用它做「要不要调 purge」的前置门控——那正是本缺陷的成因。
 */
export async function isConversationPurgedByBoth(
  conversation: Pick<Conversation, 'id' | 'user1_id' | 'user2_id'>,
): Promise<boolean> {
  // 直接问服务端：RPC 内部以 SECURITY DEFINER 身份查双方标记，不受 RLS 限制。
  const { data, error } = await supabase.rpc('purge_conversation_if_both_deleted', {
    _conversation_id: conversation.id,
  });
  if (error) {
    console.error('[api] ⚠️ 查询会话双方删除状态失败:', error.message);
    return false;
  }
  const purged = !!data;
  logDbg(
    `[api] 🔎 会话 ${conversation.id} 服务端判定: ${purged ? '双方都已删除，已彻底清理' : '仅单方删除，会话对另一方仍有效'}`,
  );
  return purged;
}

/** 带对方资料的会话项 */
export interface ConversationWithPeer extends Conversation {
  peer: Profile;
  unread_count?: number; // 未读消息数
  last_message_revoked?: boolean; // 最后一条可见消息是否为已撤回消息（列表摘要显示占位文案）
  /**
   * 最后一条可见消息的类型（text/image/voice/emoji/file）。
   * 来自 get_conversation_summaries RPC——conversations.last_message 是发送时写入的
   * 冗余快照（文件消息存的是 '[file]'），列表摘要需要真实文件名时以此列回查 content。
   */
  last_message_type?: string;
  /** 最后一条可见消息的 content（RPC 直出；文件消息即原始文件名、语音消息即 '[12s]' 时长串） */
  last_message_content?: string;
  /** 最后一条可见消息的 media_url（RPC 直出原图地址；文字消息为 null） */
  last_message_media_url?: string;
  /**
   * 列表缩略图专用地址（由 media_url 经服务端缩放生成，64×64）。
   * 与 media_url 同时写入，让本地缓存快照自带缩略图，首屏不必等一次网络刷新。
   */
  last_message_thumb_url?: string;
}

/** RPC 返回的单个会话聚合统计 */
interface ConvSummary {
  conversation_id: string;
  visible_count: number;
  unread_count: number;
  last_visible_revoked: boolean;
  last_visible_content: string | null;
  last_visible_content_type: string | null;
  last_visible_media_url: string | null;
}

/**
 * 查询当前用户的所有会话，附带对方资料和未读消息数。
 * 优化后仅两条网络请求且并行发出：
 * 1. conversations 行（带排序）；
 * 2. get_conversation_summaries RPC——服务端直接算出每个会话的
 *    可见消息数/未读数/最后一条可见消息是否撤回，
 *    替代旧版「全量拉取所有消息行 + 全量软删除记录再内存统计」的
 *    两次大结果集传输（消息越多列表越慢的根因）。
 */
export async function listConversations(currentUserId: string): Promise<ConversationWithPeer[]> {
  const t0 = Date.now();
  // 【关键】先等「返回列表前补写的会话摘要」落库，再发查询。
  // 否则写请求与读请求并发，读常常先返回 → 列表显示上一条摘要（用户报的顽疾根因）。
  // 无待补写时零开销；补写异常时最多等 800ms 后照常查询。
  await waitPendingFlush();
  // 三路并行：会话行 + 服务端统计 + 本人已软删除的会话集合。
  // 双向软删除语义下，「我删过的会话」不再从数据库消失，只在这里过滤掉，
  // 对方仍能看到并继续发消息。
  const [convRes, summaryRes, myDeletedSet] = await Promise.all([
    supabase
      .from('conversations')
      .select('*')
      .or(`user1_id.eq.${currentUserId},user2_id.eq.${currentUserId}`)
      .order('last_message_at', { ascending: false, nullsFirst: false }),
    supabase.rpc('get_conversation_summaries'),
    fetchMyDeletedConvIds(currentUserId),
  ]);
  if (convRes.error) throw new Error(`查询会话列表失败: ${convRes.error.message}`);
  const allData = convRes.data ?? [];
  // 先剔除本人已删除的会话，再进入后续统计与资料拼装
  const data = allData.filter((c) => !myDeletedSet.has(c.id));
  const hiddenCount = allData.length - data.length;
  if (hiddenCount > 0) {
    logDbg(`[api] 🙈 已隐藏 ${hiddenCount} 个本人删除过的会话（对另一方依然有效）`);
  }
  if (data.length === 0) return [];

  // RPC 失败时降级：无未读数、不过滤空会话（保证列表仍能展示）
  const summaryMap = new Map<string, ConvSummary>();
  if (!summaryRes.error) {
    for (const s of (summaryRes.data ?? []) as unknown as ConvSummary[]) {
      summaryMap.set(s.conversation_id, s);
    }
  } else {
    console.warn('[api] 会话统计RPC失败，降级为无未读统计:', summaryRes.error.message);
  }

  // 收集所有对方 user id
  const peerIds = data.map((c) =>
    c.user1_id === currentUserId ? String(c.user2_id ?? '') : String(c.user1_id ?? ''),
  );

  // 【资料优先走全局 store】会话列表是进聊天页前的必经路径，对方资料通常已在
  // profiles-store 内存/本地缓存里（冷启动 hydrate + 上次进页 upsert）。
  // 命中即零网络，只有真正缺失的 id 才补拉——避免每次刷新都无条件打一次 profiles 全表查询。
  const profileStore = useProfilesStore.getState();
  const missingPeerIds: string[] = peerIds.filter((id) => id && !profileStore.byId[id]);
  if (missingPeerIds.length > 0) {
    logDbg(`[api] 🌐 会话列表对方资料缺失 ${missingPeerIds.length}/${peerIds.length} 人，补拉一次`);
    await profileStore.ensure(missingPeerIds);
  } else {
    logDbg(`[api] ⚡ 会话列表对方资料 ${peerIds.length} 人全部命中全局 store，零网络`);
  }
  const peerMap = new Map<string, Profile>();
  for (const id of peerIds) {
    const p = useProfilesStore.getState().byId[id];
    if (p) peerMap.set(id, p);
  }
  logDbg(`[api] ⚡ 对方资料就绪 ${peerMap.size}/${peerIds.length} 份（来源：全局 store）`);

  const filteredConversations: ConversationWithPeer[] = [];
  let normalizedUnread = 0; // 有未读（真正带角标）的会话数，供日志核对归一化结果
  for (const c of data) {
    const peerId = c.user1_id === currentUserId ? c.user2_id : c.user1_id;
    const peer = peerMap.get(peerId);
    if (!peer) continue;
    const summary = summaryMap.get(c.id);
    // RPC 可用时过滤掉「没有任何可见消息」的会话（与旧行为一致）
    if (summary && summary.visible_count === 0) continue;
    // 未读数归一化：只有「确实有未读」时才写入 unread_count。
    // 无未读时该字段为 undefined，列表项不会渲染任何角标节点，
    // 也不会把数字 0 带进缓存快照 / 日志 / 后续版本可能新增的徽标文案里。
    const unread = summary?.unread_count ?? 0;
    if (unread > 0) normalizedUnread++;
    filteredConversations.push({
      ...c,
      peer,
      ...(unread > 0 ? { unread_count: unread } : {}),
      last_message_revoked: summary?.last_visible_revoked ?? false,
      // RPC 不可用（summary 缺失）时留空，列表按 conversations.last_message 快照兜底显示
      ...(summary?.last_visible_content_type ? { last_message_type: summary.last_visible_content_type } : {}),
      ...(summary?.last_visible_content ? { last_message_content: summary.last_visible_content } : {}),
      ...(summary?.last_visible_media_url ? { last_message_media_url: summary.last_visible_media_url } : {}),
      // 缩略图地址随列表一起算好并写入缓存快照：首屏命中旧快照时也能直接画出小图，
      // 不必等一次网络刷新（buildThumbUrl 纯同步、失败返回空串，调用方降级回原图）
      ...(summary?.last_visible_media_url
        ? { last_message_thumb_url: buildThumbUrl(summary.last_visible_media_url) }
        : {}),
    });
  }

  logDbg(
    `[api] 会话列表加载完成: ${filteredConversations.length}/${data.length} 个会话, 耗时 ${Date.now() - t0}ms` +
      ` | 未读归一化: ${normalizedUnread} 个会话有未读(带角标), ${filteredConversations.length - normalizedUnread} 个无未读(字段已剔除，不再携带数字 0)`,
  );
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
  if (found) {
    // 双向软删除语义：我删过它、但它还在库里（说明对方没删），
    // 现在我又主动发起聊天 → 视为「恢复」，清掉我这边的删除标记即可复用原会话，
    // 不能新建第二条会话，否则双方会出现两个并行会话。
    //
    // ⚠️ 缺陷⑥（用户报「双方都删除全部信息后，再次发起聊天第一次提醒已删除并闪退，
    //    第二次发起时之前信息都还在」的根因之一，勿再只清自己那一条）：
    //    旧实现只清「我」的删除标记。但双方都删过时，服务端 purge 函数**可能没被调用**
    //    （对方删除时若本端已删，purge 会执行；但若 purge 因网络/RLS 失败，或对方是在
    //    本端删除之前删的，库里就会残留**两条** conversation_deletes 标记而 conversations
    //    行仍在）。此时我重新发起 → 只清掉我这条 → 库里还剩对方那条 → 会话列表 RPC
    //    `get_conversation_summaries` 仍把它当「被删除会话」过滤掉 → 列表里看不到它，
    //    但 chat 页能进（conversations 行在）→ 用户看到「发起了却不在列表里」的错乱。
    //    正解：复用旧会话时**把该会话的全部删除标记一起清掉**（双方都恢复可见），
    //    语义上等价于「这条会话被重新激活」。RLS 允许删自己的行，对方那条删不掉时
    //    只告警不阻断（对方下次自己发起时也会走同一段逻辑清掉）。
    const { data: clearedRows, error: restoreErr } = await supabase
      .from('conversation_deletes')
      .delete()
      .eq('conversation_id', found.id)
      .select('user_id');
    if (restoreErr) {
      console.error('[api] ⚠️ 恢复会话（清除删除标记）失败:', restoreErr.message);
    } else {
      logDbg(
        `[api] ♻️ 复用旧会话并清除删除标记 ${clearedRows?.length ?? 0} 条（含对方残留标记），会话已重新激活:`,
        found.id,
      );
    }
    return found;
  }

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

/** 按 id 获取单个会话（聊天页用于取参与者 id） */
export async function getConversation(conversationId: string): Promise<Conversation | null> {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .maybeSingle();
  if (error) throw new Error(`查询会话失败: ${error.message}`);
  return data;
}

/**
 * 校验会话行是否仍然存在且当前用户可见。
 *
 * ⚠️ 双向软删除语义下，返回的 exists 只代表「数据库里还有这行、且包含我」，
 * 不代表「这个会话还该展示给我」。是否已被本人删除由 deletedByMe 单独表达：
 * - deletedByMe=true 且 bothDeleted=false → 会话仍活着（对方还能看、还能收消息），
 *   只是对我隐藏。此时页面应退回列表而不是提示「会话已删除」。
 * - 会话行真的不存在（bothGone）→ 才是彻底删除，发消息必撞 messages INSERT RLS → 403。
 */
export async function ensureConversationExists(
  conversationId: string,
  currentUserId: string,
): Promise<{
  exists: boolean;
  deletedByMe: boolean;
  conversation: Conversation | null;
}> {
  const [conversation, myDeletedSet] = await Promise.all([
    getConversation(conversationId),
    fetchMyDeletedConvIds(currentUserId),
  ]);
  const belongsToMe =
    !!conversation && (conversation.user1_id === currentUserId || conversation.user2_id === currentUserId);
  const deletedByMe = myDeletedSet.has(conversationId);
  logDbg(
    `[api] 🔎 会话有效性校验: ${conversationId} → ` +
      `${belongsToMe ? '存在且属于本人' : conversation ? '存在但不含当前用户' : '不存在（已被双方彻底清理）'}` +
      `${deletedByMe ? ' | 本人已标记删除（仅对自己隐藏）' : ''}`,
  );
  return { exists: belongsToMe, deletedByMe, conversation };
}

/**
 * 更新会话的最后消息（发消息时调用）。
 *
 * 【两段式写入 —— 时间戳立即落库，摘要尾沿合并】
 * 会话列表的排序与时间显示都依赖 `last_message_at`，而摘要文案其实由
 * `get_conversation_summaries` RPC 直出（`conversations.last_message` 只是兜底快照）。
 * 旧实现把两者一起塞进 1200ms 的尾沿合并定时器里，导致「发完消息立刻返回列表」时
 * `last_message_at` 还没落库 —— 列表按旧时间排序、显示旧时间，用户必须下拉刷新才看到。
 *
 * 现在拆成两段：
 * ① `last_message_at` **立即**写一次（轻量、单字段），保证返回列表时排序与时间已是最新；
 * ② `last_message` 摘要仍走尾沿合并（窗口内多次发送只提交最后一次内容），
 *    避免快速连发产生一串注定被覆盖的冗余写。
 * ⚠️ 语义安全：本函数在 messages-store 里是 fire-and-forget（`.catch` 吞掉失败），
 * 两段都只减少/提前写次数、绝不改变最终落库值；不同会话各自独立计时，互不影响。
 */
const LAST_MSG_MERGE_MS = 1200;
const lastMsgPending = new Map<string, { timer: any; message: string }>();

/**
 * 【返回列表竞态的唯一解】最近一次「补写摘要」的 Promise 句柄。
 *
 * 为什么必须有它：chat 页 `useDidHide` 的 flush 与 chats 页 `useDidShow` 的
 * `fetchConversations(true)` 是**两个并发的网络请求**——写摘要的请求还没落库，
 * 读列表的请求就已经返回了，于是列表拿到的是上一条摘要（用户报「返回看不到最新，
 * 要下拉刷新」的真正根因）。让 `listConversations` 在发查询前先 await 这个句柄，
 * 读请求就自动排在写请求之后，无需依赖两个生命周期回调的先后顺序。
 *
 * ⚠️ 只保存「最近一次」：更早的 flush 若仍未完成，其写入内容已被后一次覆盖，
 * 等它没有意义。句柄在完成后自动清空（比对身份，避免误清新一轮）。
 */
let pendingFlush: Promise<void> | null = null;

/** 等待补写落库的最长时间：补写网络异常时不能把列表查询一起拖死 */
const FLUSH_WAIT_TIMEOUT_MS = 800;

/**
 * 等待最近一次摘要补写落库（带超时保护）。
 * 无待补写时零开销直接返回；超时只告警不抛出，保证列表查询永远能继续。
 */
async function waitPendingFlush(): Promise<void> {
  const task = pendingFlush;
  if (!task) return;
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      task,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FLUSH_WAIT_TIMEOUT_MS);
      }),
    ]);
    logDbg(`[conversations] ⏳ 列表查询前已等待摘要补写落库 ${Date.now() - t0}ms`);
  } catch {
    // 补写失败不影响列表查询：继续走正常读取（拿到旧摘要也比拿不到列表好）
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function updateLastMessage(
  conversationId: string,
  lastMessage: string,
): Promise<void> {
  // ① 时间戳立即落库：这是列表排序/时间显示的关键字段，绝不能等合并窗口。
  //    失败只告警不抛出——摘要那一段仍会照常尝试，避免一次网络抖动让整条链路静默失效。
  const nowIso = new Date().toISOString();
  try {
    const { data, error } = await supabase
      .from('conversations')
      .update({ last_message_at: nowIso })
      .eq('id', conversationId)
      .select('id');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) throw new Error('可能被 RLS 策略拦截');
    logDbg(`[conversations] ⏱️ last_message_at 已立即落库: ${conversationId} → ${nowIso}`);
  } catch (e) {
    console.warn('[conversations] ⚠️ 立即更新 last_message_at 失败(摘要仍会重试):', e);
  }

  // ② 摘要尾沿合并：窗口内多次调用只保留最后一次内容，到点统一提交。
  const existing = lastMsgPending.get(conversationId);
  if (existing?.timer) clearTimeout(existing.timer);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      const entry = lastMsgPending.get(conversationId);
      if (entry) lastMsgPending.delete(conversationId);
      void doUpdateLastMessage(conversationId, lastMessage).finally(resolve);
    }, LAST_MSG_MERGE_MS);
    lastMsgPending.set(conversationId, { timer, message: lastMessage });
  });
}

/**
 * 立即提交所有待合并的会话摘要（不等 1200ms 窗口）。
 *
 * 使用场景：用户发完消息立刻点返回键回会话列表 —— 本页 `useDidHide` 先于列表
 * `useDidShow` 触发，此刻若摘要还在合并窗口内，列表查到的 `last_message` 仍是上一条。
 * 在 hide 时主动 flush，可保证列表首屏就拿到最新摘要。
 *
 * ⚠️ 同步清掉定时器，避免 flush 之后原定时器到点再写一次（重复写无害但浪费一次请求）。
 * ⚠️ 返回 Promise 但**调用方不必 await**（页面生命周期回调不能 async）：
 *    真正的等待发生在 `listConversations` 里——它会在发查询前 await 本函数登记的句柄，
 *    从而保证「读」一定排在「写」之后，不依赖两个生命周期回调的先后顺序。
 */
export function flushPendingLastMessage(): Promise<void> {
  if (lastMsgPending.size === 0) return Promise.resolve();
  const entries = Array.from(lastMsgPending.entries());
  lastMsgPending.clear();
  logDbg(`[conversations] 🚀 flush 待提交会话摘要 ${entries.length} 条（返回列表前补写）`);
  const task = Promise.all(
    entries.map(([conversationId, entry]) => {
      if (entry.timer) clearTimeout(entry.timer);
      return doUpdateLastMessage(conversationId, entry.message).catch((e) => {
        console.warn(`[conversations] ⚠️ flush 会话摘要失败: ${conversationId}`, e);
      });
    }),
  ).then(() => {
    logDbg(`[conversations] ✅ flush 摘要已全部落库（列表查询可安全读取最新值）`);
  });
  // 登记句柄供 listConversations 等待；完成后比对身份再清空，避免误清新一轮
  pendingFlush = task;
  void task.finally(() => {
    if (pendingFlush === task) pendingFlush = null;
  });
  return task;
}

/**
 * 清空会话摘要（last_message / last_message_at 置 null）。
 *
 * 使用场景：用户「删除全部消息」后，该会话在 `get_conversation_summaries` RPC 里
 * 不再产出任何行（ranked 里没有它的消息），列表侧 `summary` 为 undefined，
 * 于是退回读 `conversations.last_message` 这份**旧快照** —— 不主动清掉，
 * 列表就会一直显示已被删除的最后一条内容，与「记录已清空」自相矛盾。
 *
 * ⚠️ 必须**先清掉该会话待合并的摘要定时器**：否则 1200ms 窗口到点后
 *    `doUpdateLastMessage` 会把刚清空的字段又写回旧摘要（清空动作被覆盖）。
 * ⚠️ 失败只告警不抛出：消息本身已经软删成功，摘要没清干净只是列表文案略旧，
 *    不该让整个「清空聊天记录」操作报错回滚。
 */
export async function clearLastMessage(conversationId: string): Promise<void> {
  const pending = lastMsgPending.get(conversationId);
  if (pending) {
    if (pending.timer) clearTimeout(pending.timer);
    lastMsgPending.delete(conversationId);
    logDbg(`[conversations] 🧹 已取消该会话待合并的摘要写入: ${conversationId}`);
  }
  const { data, error } = await supabase
    .from('conversations')
    .update({ last_message: null, last_message_at: null })
    .eq('id', conversationId)
    .select('id');
  if (error) throw new Error(`清空会话摘要失败: ${error.message}`);
  if (!data || data.length === 0) throw new Error('清空会话摘要失败：可能被 RLS 策略拦截');
  logDbg(`[conversations] 🧹 会话摘要已置空（列表将显示「开始聊天吧」）: ${conversationId}`);
}

async function doUpdateLastMessage(
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
 * 删除会话（双向软删除语义）。
 *
 * 新行为：只写入一条属于当前用户的 conversation_deletes 记录 —— 会话对自己隐藏，
 * 但 conversations 行与 messages 行都保留，**对方照常可见、可继续收发消息**。
 * 只有当双方都各自删除过（purge_conversation_if_both_deleted 返回 true）时，
 * 才由服务端函数真正清理 conversations + messages。
 *
 * @returns purged 是否已彻底清理（双方都删过了）
 */
export async function deleteConversation(
  conversationId: string,
  currentUserId: string,
): Promise<{ purged: boolean }> {
  logDbg('[api] 开始软删除会话（仅对自己隐藏）:', conversationId, '用户:', currentUserId);

  try {
    // 步骤1: 取会话行，确认它存在且包含当前用户（否则后面的标记毫无意义）
    const conversation = await getConversation(conversationId);
    if (!conversation) {
      console.warn('[api] ⚠️ 会话行不存在，可能已被双方彻底清理，无需再标记删除');
      return { purged: true };
    }
    if (conversation.user1_id !== currentUserId && conversation.user2_id !== currentUserId) {
      console.error('[api] ❌ 会话不包含当前用户，拒绝标记删除:', conversationId);
      throw new Error('删除失败：该会话不属于你');
    }

    // 步骤2: 写入删除标记（ON CONFLICT 幂等：重复删除不会报错也不会产生第二行）
    logDbg('[api] 步骤2: 写入 conversation_deletes 删除标记...');
    const { data: markedRows, error: markErr } = await supabase
      .from('conversation_deletes')
      .upsert(
        { conversation_id: conversationId, user_id: currentUserId },
        { onConflict: 'conversation_id,user_id' },
      )
      .select('id');
    if (markErr) {
      console.error('[api] 写入删除标记失败:', markErr);
      throw new Error(`删除会话失败: ${markErr.message}`);
    }
    if (!markedRows || markedRows.length === 0) {
      console.error('[api] ⚠️ 删除标记影响 0 行：大概率被 conversation_deletes 的 INSERT RLS 策略拦截');
      throw new Error('删除会话失败：权限策略未放行（conversation_deletes 缺少 INSERT 策略）');
    }
    logDbg('[api] ✅ 删除标记已写入，本会话对本人隐藏');

    // 步骤3: 交给服务端判定「是否双方都已删除」并顺带彻底清理。
    // ⚠️ 缺陷⑫：这里**绝不能**再用前端查询做前置门控（旧版 `isConversationPurgedByBoth`
    //    查 conversation_deletes 时被 RLS 挡掉对方那行 → 恒为 false → purge 永不执行 →
    //    双方都删了但 conversations/messages 一直留在库里 → 再次发起聊天时旧消息全部复活）。
    //    `purge_conversation_if_both_deleted` 是 SECURITY DEFINER，内部查双方标记不受 RLS 限制，
    //    由它自己判断 v_count >= 2 才清理；返回值 true 即代表「已彻底清理」。
    logDbg('[api] 步骤3: 调用 RPC 由服务端判定双方删除状态并彻底清理...');
    const { data: purged, error: purgeErr } = await supabase.rpc('purge_conversation_if_both_deleted', {
      _conversation_id: conversationId,
    });
    if (purgeErr) {
      console.error('[api] 彻底清理会话失败:', purgeErr);
      throw new Error(`清理会话失败: ${purgeErr.message}`);
    }
    if (!purged) {
      logDbg('[api] 🟡 仅单方删除，会话在数据库中保留，对方仍可见可发送');
      return { purged: false };
    }
    logDbg('[api] ✅ 双方都已删除，会话与全部消息已从数据库彻底清理');
    return { purged: true };
  } catch (error) {
    console.error('[api] ❌ 删除会话异常:', error);
    throw error;
  }
}
