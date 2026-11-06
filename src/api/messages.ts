import { supabase } from '@/supabase/client';
import type { Database } from '@/supabase/types';
import { logDbg } from '../lib/logger';

export type Message = Database['public']['Tables']['messages']['Row'];
export type MessageInsert = Database['public']['Tables']['messages']['Insert'];

/**
 * messages 表基础列。
 * 发送者资料（头像/昵称）**不随消息逐条携带**：同一用户的资料全局只存一份，
 * 由 src/store/profiles-store.ts 统一维护，渲染时按 sender_id 从 store 查即可。
 */
const MSG_SELECT = '*';

/**
 * 消息类型枚举。
 * - file：content 存文件名、media_url 存下载地址
 * - location：content 存 `{lat,lng,name,address}` 的 JSON 串（编解码见 @/lib/location-message），
 *   media_url 留空——位置不需要上传任何文件，地图由客户端按坐标渲染
 */
export type MessageType = 'text' | 'image' | 'voice' | 'emoji' | 'file' | 'location';
// 注：暗号回执（where_ack）复用 'text' 类型 + content 前缀，不新增 content_type——
// content_type 是裸 TEXT 列且渲染端 switch 按类型分支，新增类型要同步改多处渲染逻辑，
// 用前缀信号更轻、且天然被现有 text 分支兜住（渲染层再单独跳过）。

/**
 * content_type 白名单校验。
 * ⚠️ messages.content_type 是**裸 TEXT 列、数据库层没有任何 CHECK 约束**（实测 cloud tables
 * 只有 PK/FK/NOT NULL），所以拼错的类型值会静默落库、渲染端 switch 走 default 分支显示成乱码。
 * 所有写 content_type 的路径都必须先过这个闸门，非法值直接抛错而不是悄悄存进去。
 */
const MESSAGE_TYPES: readonly MessageType[] = ['text', 'image', 'voice', 'emoji', 'file', 'location'];
export function assertMessageType(t: string): MessageType {
  if (!MESSAGE_TYPES.includes(t as MessageType)) {
    console.error(`[api] ❌ 非法 content_type: "${t}"，允许值 ${MESSAGE_TYPES.join('/')}`);
    throw new Error(`非法的消息类型: ${t}`);
  }
  return t as MessageType;
}

/** 撤回时限：发送后 2 分钟内、且对方未读时可撤回 */
export const REVOKE_WINDOW_MS = 2 * 60 * 1000;

/**
 * 判断一条自己发出的消息当前是否可撤回。
 * 条件：未被撤回 + 对方未读 + 仍在撤回时限内。
 * 设备时钟偏差可能让本地判定略宽，服务端 revokeMessage 的条件 UPDATE 是最终兜底。
 */
export function canRevoke(msg: Message): boolean {
  if (msg.revoked_at) return false;
  if (msg.read_at) return false;
  return Date.now() - new Date(msg.created_at).getTime() < REVOKE_WINDOW_MS;
}

/**
 * 查询某会话最近 N 条消息，排除当前用户已软删除的消息。
 * 按时间升序返回（聊天界面从旧到新展示）。
 *
 * 【为什么 limit 而不是全量】聊天记录是纯 append 场景：最新消息永远在尾部，
 * 首屏只需最近 N 条即可渲染；全量拉取会随消息数线性变慢（传输+过滤都在膨胀）。
 * 两条查询并行发出，总耗时≈最慢一条，而非两者之和。
 */
export async function listMessages(
  conversationId: string,
  currentUserId: string,
  limit = 200,
  before?: string,
): Promise<Message[]> {
  try {
    let query = supabase
      .from('messages')
      .select(MSG_SELECT)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);
    // 【历史分页游标】上滑加载更早消息时，只取 created_at 严格早于游标的行。
    // 用 lt 而非 lte：同毫秒消息靠上一页已含的行自然衔接（重复由 store 端 id 去重兜底）。
    if (before) query = query.lt('created_at', before);
    const [msgRes, delRes, hidRes] = await Promise.all([
      query,
      // 查询当前用户已软删除的消息 id（通过 JOIN 限定到当前会话，避免超长 IN 子句）
      supabase
        .from('message_deletes')
        .select('message_id, messages!inner(conversation_id)')
        .eq('user_id', currentUserId)
        .eq('messages.conversation_id', conversationId),
      // 查询当前用户已隐藏的消息 id（暗号链路专用；表为空时结果为空集，行为与改动前一致）
      supabase
        .from('message_visibility')
        .select('message_id, messages!inner(conversation_id)')
        .eq('user_id', currentUserId)
        .eq('messages.conversation_id', conversationId),
    ]);
    if (msgRes.error) throw new Error(`查询消息失败: ${msgRes.error.message}`);
    if (delRes.error) throw new Error(`查询删除记录失败: ${delRes.error.message}`);
    // 隐藏查询失败不阻断：最多让暗号消息多显示一次，不能让整个列表加载失败
    if (hidRes.error) console.warn('[api] ⚠️ 查询隐藏消息失败，本次不过滤:', hidRes.error.message);
    const data = msgRes.data ?? [];
    if (data.length === 0) return [];

    const deletedSet = new Set((delRes.data ?? []).map((d) => d.message_id));
    const hiddenSet = new Set((hidRes.data ?? []).map((d) => d.message_id));
    // 倒序取最近 N 条后恢复升序展示
    const visible = data.filter((m) => !deletedSet.has(m.id) && !hiddenSet.has(m.id)).reverse();
    return visible;
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
 * 增量查询某会话中晚于指定时间的全部新消息（进页增量同步专用）。
 * 与轮询版 listPeerMessagesSince 的区别：不限定发送人——自己从别的设备发的、
 * 对方发的、以及被撤回/标记已读的历史消息变更都需覆盖，故按 created_at 游标拉全量增量。
 * 结果已排除当前用户软删除过的消息，按时间升序返回。
 */
export async function listPeerMessagesSinceAll(
  conversationId: string,
  currentUserId: string,
  sinceIso: string,
): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select(MSG_SELECT)
    .eq('conversation_id', conversationId)
    .gt('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw new Error(`增量查询新消息失败: ${error.message}`);
  if (!data || data.length === 0) return [];

  const ids = data.map((m) => m.id);
  const [deleted, hidden] = await Promise.all([
    supabase
      .from('message_deletes')
      .select('message_id')
      .eq('user_id', currentUserId)
      .in('message_id', ids),
    // 暗号链路：本人隐藏过的消息同样不可见（表为空时结果为空集）
    supabase
      .from('message_visibility')
      .select('message_id')
      .eq('user_id', currentUserId)
      .in('message_id', ids),
  ]);
  if (deleted.error) throw new Error(`查询删除记录失败: ${deleted.error.message}`);
  if (hidden.error) console.warn('[api] ⚠️ 查询隐藏消息失败，本次不过滤:', hidden.error.message);
  const deletedSet = new Set((deleted.data ?? []).map((d) => d.message_id));
  const hiddenSet = new Set((hidden.data ?? []).map((d) => d.message_id));
  const visible = data.filter((m) => !deletedSet.has(m.id) && !hiddenSet.has(m.id));
  return visible;
}

/**
 * 查某人在**当前用户参与的会话**里最近 N 条消息（隐藏命令 `check <用户名> message` 用）。
 *
 * ⚠️ 能力边界（必须如实告知调用方，不能假装能查全）：
 *   messages 的 SELECT RLS 要求「当前用户是该会话的参与者」，所以本函数**只能**查到
 *   目标用户与当前用户之间的消息，查不到目标用户与第三方的聊天记录——那些行会被
 *   RLS 直接过滤掉，返回空数组而不是报错。这是权限设计的必然结果，不是 bug。
 *   因此调用方展示时必须写明「仅限你与 TA 的会话」，否则用户会误以为对方没在聊天。
 *
 * 实现：先按 sender_id 过滤（走 messages 的 sender 索引），再在应用层剔除
 * 本人软删除 / 隐藏过的行——与 listMessages 同口径，避免命令通道看到用户已删的内容。
 */
export async function listRecentMessagesBySender(
  senderId: string,
  currentUserId: string,
  limit = 5,
): Promise<Message[]> {
  if (!senderId) return [];
  try {
    const { data, error } = await supabase
      .from('messages')
      .select(MSG_SELECT)
      .eq('sender_id', senderId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`查询用户消息失败: ${error.message}`);
    const rows = data ?? [];
    if (rows.length === 0) return [];

    const ids = rows.map((m) => m.id);
    const [deleted, hidden] = await Promise.all([
      supabase.from('message_deletes').select('message_id').eq('user_id', currentUserId).in('message_id', ids),
      supabase.from('message_visibility').select('message_id').eq('user_id', currentUserId).in('message_id', ids),
    ]);
    // 删除/隐藏查询失败不阻断：最多多显示几条，不能让整个命令失败
    if (deleted.error) console.warn('[api] ⚠️ 命令通道查询删除记录失败，本次不过滤:', deleted.error.message);
    if (hidden.error) console.warn('[api] ⚠️ 命令通道查询隐藏记录失败，本次不过滤:', hidden.error.message);
    const deletedSet = new Set((deleted.data ?? []).map((d) => d.message_id));
    const hiddenSet = new Set((hidden.data ?? []).map((d) => d.message_id));
    return rows.filter((m) => !deletedSet.has(m.id) && !hiddenSet.has(m.id));
  } catch (e: any) {
    console.warn('[api] 命令通道查询用户消息失败:', e?.message || e);
    return [];
  }
}

/**
 * 增量查询对方发来的新消息（轮询降级方案专用）。
 * 只取 created_at 晚于给定时间、且非本人发送的少量行，避免全量重拉整表。
 * 结果已排除当前用户软删除过与已隐藏的消息。
 */
export async function listPeerMessagesSince(
  conversationId: string,
  currentUserId: string,
  sinceIso: string,
): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select(MSG_SELECT)
    .eq('conversation_id', conversationId)
    .neq('sender_id', currentUserId)
    .gt('created_at', sinceIso)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`增量查询新消息失败: ${error.message}`);
  if (!data || data.length === 0) return [];

  const ids = data.map((m) => m.id);
  const [deleted, hidden] = await Promise.all([
    supabase
      .from('message_deletes')
      .select('message_id')
      .eq('user_id', currentUserId)
      .in('message_id', ids),
    // 暗号链路：本人隐藏过的消息同样不可见（表为空时结果为空集）
    supabase
      .from('message_visibility')
      .select('message_id')
      .eq('user_id', currentUserId)
      .in('message_id', ids),
  ]);
  if (deleted.error) throw new Error(`查询删除记录失败: ${deleted.error.message}`);
  if (hidden.error) console.warn('[api] ⚠️ 查询隐藏消息失败，本次不过滤:', hidden.error.message);
  const deletedSet = new Set((deleted.data ?? []).map((d) => d.message_id));
  const hiddenSet = new Set((hidden.data ?? []).map((d) => d.message_id));
  const peerVisible = data.filter((m) => !deletedSet.has(m.id) && !hiddenSet.has(m.id));
  return peerVisible;
}

/**
 * 查询本人在某会话中状态已推进的消息（轮询降级方案专用），
 * 用于同步自己发出消息的「已送达 / 已读 / 撤回」三态回执。
 *
 * 结果集只含 delivered_at / read_at / revoked_at 至少一项非空的行——
 * 注意：所有成功落库的消息 delivered_at 都会被服务端自动填上，
 * 因此这里返回的行数约等于「本会话中自己发出的全部消息」，
 * 由调用方按 id 与本地状态做差量比对，只对真正变化的行 setState。
 */
export async function listMyChangedMessages(
  conversationId: string,
  currentUserId: string,
): Promise<
  Array<{
    id: string;
    delivered_at: string | null;
    read_at: string | null;
    revoked_at: string | null;
  }>
> {
  const { data, error } = await supabase
    .from('messages')
    .select('id, delivered_at, read_at, revoked_at')
    .eq('conversation_id', conversationId)
    .eq('sender_id', currentUserId)
    .or('delivered_at.not.is.null,read_at.not.is.null,revoked_at.not.is.null');
  if (error) throw new Error(`查询送达/已读/撤回回执失败: ${error.message}`);
  return data ?? [];
}

/**
 * 查询当前用户在某会话中「已隐藏」的消息 id 集合。
 *
 * 【暗号链路专用】message_visibility 表里存在一行 (message_id, user_id) 即表示该消息对
 * 该用户隐藏。表为空时返回空集合，所有读取路径行为与改动前完全一致。
 *
 * ⚠️ 失败时返回空集合而不是抛错：隐藏过滤是「锦上添花」的语义，
 *    查询失败最多让暗号消息多显示一次，绝不能让整个消息列表加载失败。
 */
export async function listHiddenMessageIds(
  conversationId: string,
  currentUserId: string,
): Promise<Set<string>> {
  try {
    const { data, error } = await supabase
      .from('message_visibility')
      .select('message_id, messages!inner(conversation_id)')
      .eq('user_id', currentUserId)
      .eq('messages.conversation_id', conversationId);
    if (error) throw new Error(error.message);
    return new Set((data ?? []).map((d) => d.message_id));
  } catch (e: any) {
    console.warn('[api] ⚠️ 查询隐藏消息失败，本次不过滤（不影响消息加载）:', e?.message || e);
    return new Set<string>();
  }
}

/**
 * 把某条消息对当前用户隐藏（仅暗号链路使用）。
 *
 * ⚠️ RLS 只允许**消息发送者本人**插入隐藏行（见 message_visibility 的 INSERT 策略），
 *    因此本函数只能隐藏「自己发的」消息。要隐藏对方发的消息，必须由对方自己隐藏
 *    （暗号链路用 where_ack 回执把这件事交回给发送者，见 @/lib/where-command）。
 * ⚠️ 幂等：重复插入会撞 UNIQUE(message_id, user_id)，按「已隐藏」静默成功处理。
 */
export async function hideMessageForSelf(
  messageId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('message_visibility')
    .insert({ message_id: messageId, user_id: userId });
  if (error) {
    // 23505 = unique_violation：已经隐藏过，视为成功
    if (error.code === '23505') {
      logDbg('[api] 🙈 该消息已隐藏过，跳过:', messageId);
      return;
    }
    throw new Error(`隐藏消息失败: ${error.message}`);
  }
  logDbg('[api] 🙈 已隐藏消息（仅本人不可见）:', messageId);
}

/**
 * 把某条消息对**当前用户**隐藏，且**不要求当前用户是消息发送者**（暗号链路专用）。
 *
 * 【为什么需要它】`hideMessageForSelf` 的语义是「隐藏自己发的消息」，而暗号链路里
 * B 需要隐藏 **A 发来的** where —— B 是接收方，不是发送者。
 *
 * 【为什么能写进去】`message_visibility` 的 INSERT 策略已放宽为
 * 「`user_id = auth.uid()` 且 自己是该消息所属会话的参与者」：
 *   - B 可以插入 `user_id = B` 的隐藏行 → 那条 where 对 B 立即不可见；
 *   - 但 `user_id` 必须等于自己，A **无法**替 B 插隐藏行去影响 B 的视图，
 *     隐私边界没有被破坏（见 migrations/20261012_120000_*）。
 *
 * ⚠️ 隐藏行必须**始终归属需要隐藏它的那个人**。上一轮试过「B 插占位行 → A 收到 ack 后
 *    删除占位行」的转移方案，结果是删除后归属变成「无人」，对谁都不生效，B 依然能看到。
 * ⚠️ 幂等：重复插入会撞 UNIQUE(message_id, user_id)，按「已隐藏」静默成功处理。
 */
export async function hideMessageForPeer(
  messageId: string,
  currentUserId: string,
): Promise<void> {
  const { error } = await supabase
    .from('message_visibility')
    .insert({ message_id: messageId, user_id: currentUserId });
  if (error) {
    // 23505 = unique_violation：已经隐藏过，视为成功
    if (error.code === '23505') {
      logDbg('[api] 🙈 该消息已隐藏过，跳过:', messageId);
      return;
    }
    throw new Error(`隐藏对方消息失败: ${error.message}`);
  }
  logDbg('[api] 🙈 已隐藏对方发来的消息（隐藏行归属本人）:', messageId);
}

/**
 * 查询某会话中「对方发来的 text 消息」（离线补发暗号专用），按时间**升序**返回。
 *
 * 【为什么用「未隐藏」当已回复判据】B 端处理完一条 where 后，会通过 where_ack 让 A 隐藏那条
 * where；但 B 自己看不到 ack 是否成功。更可靠的判据是：B 端在回发位置后**自己**也会
 * 记录一条「已处理」标记——这里直接用 message_visibility 反查（B 隐藏过的 where 即已处理）。
 * 由于 RLS 不允许 B 隐藏 A 的消息，B 的「已处理」标记落在**自己回发的那条位置消息**上，
 * 故本函数改为：查对方发来的 where，且该 where 之后没有我发出的位置消息。
 *
 * ⚠️【必须取「最新」的 N 条，不能取「最早」的 N 条】（用户报「A 发 where 后看不到 B 回的位置」的根因）
 * 旧实现是 `.order('created_at', { ascending: true }).limit(200)` —— 升序 + limit 的组合
 * 取到的是**最早的 200 条** text 消息。而本函数只用于「找对方最近发来的 where」，
 * 活跃会话的 text 消息动辄上千条（实测某会话 1163 条 text），最新的 where 远在第 200 条之后，
 * 于是调用方 `wheres[wheres.length - 1]` 拿到的是**几个月前的旧 where**：
 *   - 若旧 where 之后 B 回过位置 → 判定「无需补发」，A 的新 where 永远得不到回应；
 *   - 若旧 where 之后没回过 → 补发的是旧 where 的 ack，A 的新 where 依然无人应答。
 * 两种分支都表现为「A 看不到 B 回复的位置」。
 * 正解：先按 `ascending: false` 取**最新**的 N 条，再在应用层反转回升序，
 * 保证「最后一条」永远是真正最新的那条 where。
 *
 * 简化实现：直接查对方发来的最近 N 条 text 消息（升序返回），由调用方按
 * 「最后一条位置消息的时间」过滤出真正待回复的那些。
 */
export async function listPeerWhereCommands(
  conversationId: string,
  currentUserId: string,
): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select(MSG_SELECT)
    .eq('conversation_id', conversationId)
    .neq('sender_id', currentUserId)
    .eq('content_type', 'text')
    // ⚠️ 必须 descending：先取「最新」的 N 条，否则会被最早的 N 条截断（见上方注释）
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(`查询待回复暗号失败: ${error.message}`);
  // 反转回升序：调用方依赖「数组末项 = 最新一条」的语义（wheres[wheres.length - 1]）
  return ((data ?? []) as Message[]).reverse();
}

/**
 * 查询某会话中「我发出的最后一条位置消息」的时间（离线补发判据）。
 * 返回 null 表示我从未在本会话发过位置。
 */
export async function getMyLastLocationSentAt(
  conversationId: string,
  currentUserId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_id', currentUserId)
    .eq('content_type', 'location')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`查询最近位置消息失败: ${error.message}`);
  const row = (data ?? [])[0] as { created_at?: string } | undefined;
  return row?.created_at ?? null;
}

/**
 * 查询某人在**当前用户参与的会话**里最后一条位置消息（隐藏命令 `check <用户名> place` 用）。
 *
 * ⚠️ 能力边界与 listRecentMessagesBySender 完全一致：messages 的 SELECT RLS 要求
 *   「当前用户是该会话的参与者」，所以只能查到目标用户与当前用户之间的位置消息，
 *   查不到 TA 发给第三方的位置——那些行会被 RLS 静默过滤成空数组，不报错。
 *   调用方展示时必须写明「仅含你与 TA 的会话」，否则用户会误读成「对方没发过位置」。
 *
 * ⚠️ 返回的是**原始 content 串**（位置消息的 content 是 `{lat,lng,name,address}` JSON），
 *   由调用方走 `decodeLocation` 解析——本模块不 import location-message，避免循环依赖。
 *
 * @returns 命中时返回 { content, createdAt }；无记录返回 null
 */
export async function getLastLocationMessageBySender(
  senderId: string,
  currentUserId: string,
): Promise<{ content: string; createdAt: string } | null> {
  if (!senderId) return null;
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('id, content, created_at')
      .eq('sender_id', senderId)
      .eq('content_type', 'location')
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) throw new Error(`查询位置消息失败: ${error.message}`);
    const rows = (data ?? []) as { id: string; content: string; created_at: string }[];
    if (rows.length === 0) return null;

    // 与 listRecentMessagesBySender 同口径：剔除本人软删除 / 隐藏过的行，
    // 避免命令通道看到用户已经删掉的位置（多取 5 条是为了过滤后仍有候选）。
    const ids = rows.map((m) => m.id);
    const [deleted, hidden] = await Promise.all([
      supabase.from('message_deletes').select('message_id').eq('user_id', currentUserId).in('message_id', ids),
      supabase.from('message_visibility').select('message_id').eq('user_id', currentUserId).in('message_id', ids),
    ]);
    if (deleted.error) console.warn('[api] ⚠️ 位置查询：删除记录查询失败，本次不过滤:', deleted.error.message);
    if (hidden.error) console.warn('[api] ⚠️ 位置查询：隐藏记录查询失败，本次不过滤:', hidden.error.message);
    const deletedSet = new Set((deleted.data ?? []).map((d) => d.message_id));
    const hiddenSet = new Set((hidden.data ?? []).map((d) => d.message_id));
    const hit = rows.find((m) => !deletedSet.has(m.id) && !hiddenSet.has(m.id));
    if (!hit) return null;
    return { content: hit.content, createdAt: hit.created_at };
  } catch (e: any) {
    console.warn('[api] 命令通道查询位置消息失败:', e?.message || e);
    return null;
  }
}

/**
 * 双方消息条数统计结果（隐藏命令 `check <用户名> stats` 用）。
 *
 * 【为什么按「我 / TA」分开计数，而不是只给一个总数】
 * 用户要的是「对**双方**发送信息的条数进行统计」——只看总数无法回答
 * 「谁说得更多」。分开计数后，结果区能直接给出「我 12 条 / TA 9 条」，
 * 也能算出占比。
 */
export interface MessageStatsResult {
  /** 我发出的条数 */
  mine: number;
  /** TA 发出的条数 */
  peer: number;
  /** 合计（= mine + peer） */
  total: number;
  /** 统计区间起点（ISO，东八区切日/周/月） */
  startIso: string;
  /** 统计区间终点（ISO，= 查询时刻） */
  endIso: string;
}

/**
 * 统计「我」与「TA」在指定时间区间内各自发出的消息条数。
 *
 * 【为什么用 count + head 而不是把消息行拉回来数】
 * 统计只需要数字，不需要内容。`select('id', { count: 'exact', head: true })`
 * 让服务端只回 `Content-Range` 头、不回任何行——一个月几千条消息也只传一个数字，
 * 而拉行回来数会把整段历史都传一遍（正是会话列表曾经变慢的同类问题）。
 *
 * 【为什么分两次请求而不是一次 group by】
 * PostgREST 的聚合需要 RPC 或视图，本项目没有为统计建 RPC；而两次 count 请求
 * 可以并行发出（总耗时≈最慢一条），且各自带 `sender_id` 过滤能走索引。
 * 为一次统计新增一个数据库函数不划算。
 *
 * ⚠️ 能力边界与 listRecentMessagesBySender 完全一致：messages 的 SELECT RLS
 *   要求「当前用户是该会话的参与者」，所以统计的只是**你与 TA 之间**的消息，
 *   TA 与第三方的消息被 RLS 静默过滤，不参与计数。调用方必须如实标注。
 *
 * ⚠️ 不过滤本人软删除 / 隐藏的消息：`message_deletes` / `message_visibility`
 *   是「仅对我隐藏」的视图层标记，消息本身仍在会话里、对方也仍看得到。
 *   统计的是「双方实际发了多少条」，按视图层过滤会让数字随「我删了几条」而变，
 *   反而失真。这一点与 `message` 子命令（列具体内容，必须过滤）刻意不同。
 */
export async function countMessagesBetween(
  peerId: string,
  currentUserId: string,
  startIso: string,
  endIso: string,
): Promise<MessageStatsResult> {
  const base = () =>
    supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', startIso)
      .lte('created_at', endIso);

  const [mineRes, peerRes] = await Promise.all([
    base().eq('sender_id', currentUserId),
    base().eq('sender_id', peerId),
  ]);
  if (mineRes.error) throw new Error(`统计我的消息条数失败: ${mineRes.error.message}`);
  if (peerRes.error) throw new Error(`统计对方消息条数失败: ${peerRes.error.message}`);
  const mine = mineRes.count ?? 0;
  const peer = peerRes.count ?? 0;
  logDbg(`[api] 📊 消息统计 ${startIso} ~ ${endIso}: 我 ${mine} 条 / TA ${peer} 条`);
  return { mine, peer, total: mine + peer, startIso, endIso };
}

/**
 * 判断一个异常是否为「网络传输层失败」——请求根本没送达云端：
 * H5 端 fetch 中断报 TypeError: Failed to fetch / Load failed；
 * 小程序端 wx.request 断网时 supabase-wechat-js 抛 errno 599/600011 等连接类错误。
 * 这类失败没有服务端响应，POST 不可能已落库，重试不会产生重复消息。
 */
function isNetworkFailure(e: any): boolean {
  const msg = String(e?.message ?? e ?? '');
  return (
    msg.includes('Failed to fetch') ||
    msg.includes('Load failed') ||
    msg.includes('NetworkError') ||
    msg.includes('network') ||
    msg.includes('ERR_INTERNET') ||
    msg.includes('request:fail')
  );
}

/** 网络瞬断自动重试前的退避时长（约 800ms，给链路一个恢复窗口） */
const SEND_RETRY_DELAY_MS = 800;

/**
 * 发送消息（replyTo 用于引用回复：携带被引用消息 id + 内容快照冗余）
 *
 * 【网络瞬断自动重试】首次请求若在**网络传输层**失败（status=0 / "Load failed"，
 * 常见于 dev server 重启窗口期或弱网），静默等待后自动重发一次，成功即返回——
 * 减少用户手动点红色感叹号重发的概率。由于网络层失败意味着请求从未到达服务端，
 * 不存在「已写入但响应丢失」的重复风险，可安全重试。
 * ⚠️ 只对网络层失败重试：RLS 403、其他服务端错误都是确定性结果，重试必然再失败，直接抛出。
 *
 * ⚠️ 错误语义要区分清楚，否则会把「会话已被彻底清理」误报成网络故障：
 * messages 的 INSERT RLS 要求 conversation_id 对应会话存在且包含当前用户。
 * 双向软删除改造后，单方删除会话只写 conversation_deletes 标记、不删 conversations 行，
 * 因此**不会**触发这里的 403；只有「双方都删过 → purge_conversation_if_both_deleted
 * 已物理清理 conversations 行」之后，残留旧 conversationId 再发消息才会 403。
 */
export async function sendMessage(
  conversationId: string,
  senderId: string,
  content: string,
  contentType: MessageType = 'text',
  mediaUrl?: string,
  replyTo?: { id: string; content: string },
): Promise<Message> {
  // 落库前闸门：content_type 是裸 TEXT 列（无 DB CHECK），拼错的值会静默落库、
  // 渲染端 switch 走 default 显示成乱码。非法值在此抛错，绝不写进数据库。
  assertMessageType(contentType);
  logDbg(`[api] 📝 sendMessage content_type=${contentType} mediaUrl=${mediaUrl ? '有' : '无'} conversationId=${conversationId}`);
  const insert: MessageInsert = {
    conversation_id: conversationId,
    sender_id: senderId,
    content,
    content_type: contentType,
    media_url: mediaUrl || null,
    reply_to_id: replyTo?.id || null,
    reply_to_content: replyTo?.content || null,
    // 「已送达」= 消息成功写入服务端。由发送方在 INSERT 时一并写入，
    // 不依赖对方客户端在线，因此离线对方也能让发送方看到 ✓✓。
    delivered_at: new Date().toISOString(),
  };

  const doInsert = async (): Promise<{ data: Message | null; error: any }> => {
    try {
      const { data, error } = await supabase
        .from('messages')
        .insert(insert)
        .select('*')
        .single();
      return { data: (data as Message) ?? null, error };
    } catch (e: any) {
      // fetch 层 reject（H5 "Load failed" / 小程序连接失败）会以异常冒出来，归一化成 error 走统一判定
      return { data: null, error: e };
    }
  };

  let { data, error } = await doInsert();
  if (error && isNetworkFailure(error)) {
    console.warn(
      `[api] 🌐 发送遇网络层失败(${String(error?.message ?? error)})，${SEND_RETRY_DELAY_MS}ms 后自动重试一次 conversationId=${conversationId}`,
    );
    await new Promise((r) => setTimeout(r, SEND_RETRY_DELAY_MS));
    const retry = await doInsert();
    data = retry.data;
    error = retry.error;
    if (error && isNetworkFailure(error)) {
      // 重试仍断网：换成友好文案抛出，页面 catch 靠「已被删除」判定不误触会话失效流程，
      // store 照常保留乐观占位标红供手动重发
      console.error('[api] ⚠️ 自动重试仍失败（网络瞬断未恢复）:', String(error?.message ?? error));
      throw new Error('网络连接不稳定，已自动重试仍未成功，稍后可点击消息旁的 ! 重发');
    }
    if (!error) logDbg('[api] ✅ 网络瞬断自动重试成功');
  }

  if (error) {
    const errMsg = String(error.message ?? error);
    console.error('[api] 发送消息失败(服务端错误):', error.code, errMsg);
    if (error.code === '42501' || errMsg.includes('row-level security')) {
      console.warn(`[api] 🚫 发送被 messages 的 INSERT RLS 拒绝，conversationId=${conversationId} —— 双向软删语义下仅有一种可能：会话行已被彻底清理（双方都删过），单方删除不会走到这里`);
      throw new Error('该会话已被删除，无法继续发送');
    }
    throw new Error(`发送消息失败: ${errMsg}`);
  }
  if (!data) throw new Error('发送消息失败：可能被 RLS 策略拦截');
  return data;
}

/**
 * 标记某会话中对方发来的消息为已读。
 * 只更新 sender_id != 当前用户 且 read_at 为 NULL 的消息。
 *
 * 顺带补 delivered_at：对方消息若因历史原因缺送达时间（旧数据、或发送端版本较老），
 * 在此一并补齐，保证「已读」态在 UI 上不会出现「已读但未送达」的矛盾组合。
 */
export async function markMessagesAsRead(
  conversationId: string,
  currentUserId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('messages')
    .update({ read_at: now, delivered_at: now })
    .eq('conversation_id', conversationId)
    .neq('sender_id', currentUserId)
    .is('read_at', null)
    .select('id');
  if (error) throw new Error(`标记已读失败: ${error.message}`);
  // RLS 拦截时 data 为空数组,不视为致命错误(对方消息可能已被删除)
}

/**
 * 撤回自己发出的消息（双方均不可见，保留占位）。
 * 条件 UPDATE：仅当消息仍未被读、未被撤回时才写入 revoked_at，
 * 天然规避「对方刚好在读」的竞态——若已被标记已读则 0 行受影响，视为撤回失败。
 */
export async function revokeMessage(
  messageId: string,
  userId: string,
): Promise<void> {
  const cutoff = new Date(Date.now() - REVOKE_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from('messages')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', messageId)
    .eq('sender_id', userId)
    .is('read_at', null)
    .is('revoked_at', null)
    .gt('created_at', cutoff)
    .select('id');
  if (error) throw new Error(`撤回消息失败: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error('无法撤回：对方可能已读或已超过撤回时限');
  }
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
