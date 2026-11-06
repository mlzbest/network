import { create } from 'zustand';
import Taro from '@tarojs/taro';
import * as messagesApi from '@/api/messages';
import * as conversationsApi from '@/api/conversations';
import type { Message, MessageType } from '@/api/messages';
import { useAuthStore } from './auth-store';
import { logDbg } from '../lib/logger';

/** 发送失败后暂存的重发载荷（仅内存态，页面刷新即失效；重发成功后移除） */
export interface FailedPayload {
  content: string;
  contentType: MessageType;
  mediaUrl?: string;
  replyTo?: { id: string; content: string };
}

// 消息首屏快照缓存（按 用户+会话 隔离，防串号）
const MSG_CACHE_KEY = (uid: string, cid: string) => `chat_msg_cache_${uid}_${cid}`;

// receiveMessage 的批量合并队列：100ms 窗口内的多条新消息一次性 setState
const receiveMergeRef: { current: Message[] | null } = { current: null };
/** 导出给页面使用：会话被删除后需按同一规则清掉该会话的脏快照 */
export const msgCacheKeyOf = MSG_CACHE_KEY;
/** 每个会话缓存的最近消息条数上限（控制 storage 体积，单 key ≤1MB） */
const MSG_CACHE_LIMIT = 100;

/** 本地增量同步时，单轮最多拉取的消息条数（防止长时间离线后一次拉爆） */
const SYNC_PAGE_SIZE = 200;

/** 首屏加载条数 / 上滑加载历史的单页条数。
 * 首屏不宜太大：全量渲染会拖慢小程序长列表；剩余历史靠「点击加载更多」分页补齐。 */
const FIRST_PAGE_SIZE = 50;
const OLDER_PAGE_SIZE = 50;

/**
 * 会话列表摘要里非文字消息的占位文案（写入 conversations.last_message）。
 * 统一在这里出中文，避免旧缓存快照 / RPC 降级路径露出 [image] / [voice] 这类英文标记。
 * file 特殊：content 存的就是原始文件名，摘要要带名字，故由调用方拼前缀。
 */
const LAST_MSG_LABEL: Record<string, string> = {
  image: '[图片]',
  voice: '[语音]',
  emoji: '[表情]',
  // 位置消息的 content 是 JSON 串，绝不能直接当摘要写进会话列表（会露出 {"lat":...}）
  location: '[位置]',
};

export function lastMessageLabel(contentType: MessageType, content: string): string {
  if (contentType === 'file') return `[文件] ${content || '文件'}`;
  return LAST_MSG_LABEL[contentType] ?? `[${contentType}]`;
}

/** 本机软删除记录（按用户隔离）。服务端 listMessages 只返回「最近N条且未删」，
 * 无法告知更早的历史消息是否被删过——靠本机这份持久化墓碑集合在展示层过滤兜底。 */
const DEL_TOMBSTONES_KEY = (uid: string) => `chat_msg_deleted_${uid}`;

const readTombstones = (uid: string): Set<string> => {
  try {
    const arr = Taro.getStorageSync(DEL_TOMBSTONES_KEY(uid)) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
};

const writeTombstone = (uid: string, messageId: string) => {
  try {
    const set = readTombstones(uid);
    if (set.has(messageId)) return;
    set.add(messageId);
    // 墓碑集合防无限膨胀：超 500 条时丢弃最旧部分（消息本身已不在缓存窗口内时无影响）
    const arr = Array.from(set).slice(-500);
    Taro.setStorageSync(DEL_TOMBSTONES_KEY(uid), arr);
  } catch (e) {
    console.warn('[messages-store] 写入软删除墓碑失败:', e);
  }
};

/** 图片占位行的上传进度（仅内存态：不落库、不写快照缓存，随 reset 清空） */
export interface ImageProgress {
  /** 0-100；-1 表示不确定进度（压缩阶段无法量化），展示端按「进行中」处理 */
  percent: number;
  stage: 'compressing' | 'uploading' | 'sent' | 'cancelled';
}

interface MessagesState {
  /** 当前会话的消息列表 */
  messages: Message[];
  loading: boolean;
  loaded: boolean;
  /** fetchMessages 是否失败（供页面显示「加载失败·点击重试」；成功后自动清零态） */
  loadError: boolean;
  /** 当前会话 id */
  conversationId: string | null;
  /** 发送失败的乐观占位消息 id 集合（气泡旁显示红色感叹号，点击重发） */
  failedIds: Set<string>;
  /** 失败消息的重发载荷（按临时 id 索引） */
  failedPayloads: Record<string, FailedPayload>;
  /** 【发送中】已上屏但尚未拿到服务端回执的占位行 id 集合（仅内存态）。
   *  与 failedIds 互斥：失败时从本集合移除、加入 failedIds。
   *  页面据此把状态渲染成「发送中」，而不是误显示成「未送达」。 */
  sendingIds: Set<string>;
  /** 【多图发送】temp 占位行的逐张进度（按 tempId 索引，仅内存态）。
   *  页面在图片气泡内据此渲染进度条/文案，取代全局 showLoading 的「上传中 n/N」。 */
  imageProgress: Record<string, ImageProgress>;
  /** 写入/覆盖单张进度（传 null 删除该项，用于收尾清屏） */
  setImageProgress: (tempId: string, progress: ImageProgress | null) => void;
  /** 批量清理若干 tempId 的进度（取消或整批完成时调用） */
  clearImageProgress: (tempIds: string[]) => void;
  /** 重发一条失败消息：成功后用真实行替换占位；再失败则保留标记可继续重试 */
  retrySend: (tempId: string) => Promise<void>;
  /** 从本地缓存恢复某会话的首屏消息快照（秒开），已有服务端数据则跳过 */
  restoreFromCache: (conversationId: string) => void;
  /** 加载历史消息（有缓存基准则走增量同步，仅拉新消息；否则全量拉最近一屏） */
  fetchMessages: (conversationId: string) => Promise<void>;
  /** 是否还有更早的历史消息未加载（首屏只取最近一屏，上滑分页补齐） */
  hasMoreOlder: boolean;
  /** 上滑「加载更多」是否进行中 */
  loadingOlder: boolean;
  /** 加载更早的一页历史消息：以当前最早一条 created_at 为游标。
   *  resolve 返回新增条数（0 表示已到尽头或失败），页面据此决定是否保持滚动位置。 */
  loadOlderMessages: () => Promise<number>;
  /** 发送消息：先乐观插入占位行，失败则保留占位并标红可重发。
   *  resolve 时机 = 落库成功（页面据此清空输入框/滚动）；失败 reject 供页面 toast。 */
  sendMessage: (
    conversationId: string,
    content: string,
    contentType?: MessageType,
    mediaUrl?: string,
    replyTo?: { id: string; content: string },
  ) => Promise<Message>;
  /** 移除一条失败占位（用户选择放弃重发时调用） */
  dismissFailed: (tempId: string) => void;
  /** 【多图取消】移除尚未标红的 temp 占位（无 failedPayloads，不能走 dismissFailed）。
   *  用于「用户取消上传」与「上传阶段就失败」两种场景：这些行既没落库也没有可重发的
   *  mediaUrl，留着会变成点 ! 也发不出去的僵尸气泡。 */
  dismissPendingImages: (tempIds: string[]) => void;
  /** 批量预挂图片占位：按选图顺序一次性追加 N 条 temp- 行，立刻上屏。
   *  返回下标 → tempId 映射，供 sendImageBatch 原位替换/标红。
   *  ⚠️ 只上屏、不发请求 —— 目的是让用户先看到自己选的图，后台再边传边补真值。 */
  stageImagePlaceholders: (conversationId: string, count: number) => Promise<string[]>;
  /** 批量发送已上传的图片（配合 stageImagePlaceholders 使用）。
   *  【为什么能并发】占位已按选图顺序预先排好，每条结果**原位替换**自己的占位行，
   *  不像 sendMessage 那样「追加到末尾」，因此不存在乱序问题；网络层并发可显著提速。
   *  @returns { sent, failedTempIds, conversationGone } */
  sendImageBatch: (
    conversationId: string,
    urls: string[],
    tempIds: string[],
    replyTo?: { id: string; content: string },
  ) => Promise<{ sent: number; failedTempIds: string[]; conversationGone: boolean }>;
  /** 接收 Realtime 推送的新消息（来自对方） */
  receiveMessage: (message: Message) => void;
  /** 标记某会话中对方发来的消息为已读 */
  markAsRead: (conversationId: string) => Promise<void>;
  /** 软删除消息（仅从自己视图移除） */
  deleteMessage: (messageId: string) => Promise<void>;
  /** 撤回自己发出且对方未读的消息（双方替换为撤回占位） */
  revokeMessage: (messageId: string) => Promise<void>;
  /** 批量软删除某会话的所有消息 */
  deleteAllMessages: (conversationId: string) => Promise<void>;
  reset: () => void;
}

export const useMessagesStore = create<MessagesState>((set, get) => ({
  messages: [],
  loading: false,
  loaded: false,
  loadError: false,
  hasMoreOlder: true,
  loadingOlder: false,
  conversationId: null,
  failedIds: new Set<string>(),
  failedPayloads: {},
  sendingIds: new Set<string>(),
  imageProgress: {},

  setImageProgress: (tempId, progress) => {
    const next = { ...get().imageProgress };
    if (progress === null) delete next[tempId];
    else next[tempId] = progress;
    set({ imageProgress: next });
  },

  clearImageProgress: (tempIds) => {
    if (tempIds.length === 0) return;
    const next = { ...get().imageProgress };
    let changed = false;
    tempIds.forEach((id) => {
      if (next[id]) {
        delete next[id];
        changed = true;
      }
    });
    if (changed) set({ imageProgress: next });
  },

  restoreFromCache: (conversationId: string) => {
    const user = useAuthStore.getState().user;
    if (!user) return;
    // 已有该会话的服务端数据则不覆盖（同一会话重复进页时保留内存里的最新列表）
    if (get().loaded && get().conversationId === conversationId) return;
    // ⚠️ 缺陷⑦（用户报「第二次发起时之前信息都还在」的根因，勿再删掉这段清场）：
    //    旧实现只判断「loaded 且 conversationId 相同」就 return，**没有处理「切到另一个会话」**。
    //    从会话 A 返回列表、再进会话 B 时，store 里仍是 A 的 messages 且 conversationId=A，
    //    于是 restoreFromCache(B) 读不到 B 的缓存（新会话本来就没有）→ 什么都不做 →
    //    store 里 A 的消息原样留着。紧接着 fetchMessages(B) 看到
    //    `state.conversationId === B` 为 false 会走全量分支（这条没问题），
    //    但**页面在 fetch 返回前的那几帧渲染的是 A 的消息**；更糟的是若 B 恰好复用了
    //    某个旧 conversationId（双方删除后重建、或缓存 key 撞上），
    //    `state.conversationId === conversationId` 成立且 messages 非空 → 被当成
    //    「B 的本地基线」走**增量同步**，只拉基线之后的新消息 → 旧消息全部复活。
    //    正解：只要目标会话与当前 store 里的会话不是同一个，先**清空消息与全部发送态**，
    //    再尝试用目标会话自己的缓存填充。这样「切会话」永远是干净起点。
    const switching = get().conversationId !== conversationId;
    if (switching) {
      logDbg(
        `[messages-store] 🔄 切换会话 ${get().conversationId ?? '(空)'} → ${conversationId}，清空上一会话的消息与发送态`,
      );
      set({
        messages: [],
        loaded: false,
        loadError: false,
        hasMoreOlder: true,
        loadingOlder: false,
        conversationId,
        failedIds: new Set<string>(),
        failedPayloads: {},
        sendingIds: new Set<string>(),
        imageProgress: {},
      });
    }
    try {
      const cached = Taro.getStorageSync(MSG_CACHE_KEY(user.id, conversationId)) as Message[];
      if (Array.isArray(cached) && cached.length > 0) {
        // 快照写入后若用户删过消息，缓存可能略旧——按墓碑集合再过滤一次兜底
        const tombstones = readTombstones(user.id);
        const list = tombstones.size > 0
          ? cached.filter((m) => !tombstones.has(m.id))
          : cached;
        if (list.length === 0) return;
        logDbg(`[messages-store] ⚡ 命中消息快照缓存 ${list.length} 条，先渲染再后台刷新`);
        set({ messages: list, conversationId });
      }
    } catch (e) {
      console.warn('[messages-store] 读取消息缓存失败:', e);
    }
  },

  fetchMessages: async (conversationId: string) => {
    const user = useAuthStore.getState().user;
    if (!user) return;
    if (get().loading) return;

    // 缓存基线：restoreFromCache 已把本会话快照放进 store（conversationId 匹配且非空）
    const state = get();
    const hasBaseline =
      state.conversationId === conversationId && state.messages.length > 0;
    const baselineCount = hasBaseline ? state.messages.length : 0;

    set({ loading: true, conversationId });
    try {
      const t0 = Date.now();
      let merged: Message[];
      if (hasBaseline) {
        // 【增量同步】本地已有消息，只拉「基线最后一条之后」的新消息。
        // created_at 唯一性由服务端排序保证；同毫秒消息靠 id 去重兜底。
        //
        // ⚠️ 基线必须取「最后一条**真实**消息行」的 created_at，**绝不能**直接取数组末项：
        //    temp- 乐观占位行的 created_at 是本机时钟拼的（见 sendMessage），
        //    设备时钟一旦领先服务端，`.gt('created_at', since)` 就会把对方随后发来的
        //    消息**全部漏掉** —— 表现为「我发的消息我看得到，对方发的我永远看不到」，
        //    且因为每次进页都拿同一个偏大的基线，漏拉会一直持续（不会自愈）。
        //    与 loadOlderMessages 的游标口径保持一致（那里同样跳过 temp- 行）。
        const lastReal = [...state.messages].reverse().find((m) => !String(m.id).startsWith('temp-'));
        if (!lastReal) {
          // 极端情况：本地全是未落库的占位行，没有可信基线 → 退回全量拉最近一屏
          const messages = await messagesApi.listMessages(conversationId, user.id, FIRST_PAGE_SIZE);
          const tombstones = readTombstones(user.id);
          const realIds = new Set(messages.map((m) => m.id));
          const pending = state.messages.filter((m) => !realIds.has(m.id));
          merged = tombstones.size > 0
            ? [...messages.filter((m) => !tombstones.has(m.id)), ...pending]
            : [...messages, ...pending];
          set({ hasMoreOlder: messages.length >= FIRST_PAGE_SIZE });
          logDbg(`[messages-store] ⚠️ 本地无真实消息基线，退回全量拉取 ${messages.length} 条`);
          set({ messages: merged, loaded: true, loadError: false });
          try {
            Taro.setStorageSync(MSG_CACHE_KEY(user.id, conversationId), merged.slice(-MSG_CACHE_LIMIT));
          } catch (e) {
            console.warn('[messages-store] 写入消息缓存失败:', e);
          }
          return;
        }
        const since = lastReal.created_at;
        const fresh = await messagesApi.listPeerMessagesSinceAll(
          conversationId,
          user.id,
          since,
        );
        const existIds = new Set(state.messages.map((m) => m.id));
        const additions = fresh.filter((m) => !existIds.has(m.id));
        merged = additions.length > 0
          ? [...state.messages, ...additions]
          : state.messages;
        logDbg(
          `[messages-store] ⚡ 增量同步完成 新增${additions.length}条/基线${baselineCount}条, 耗时 ${Date.now() - t0}ms`,
        );
      } else {
        // 冷启动：拉最近一屏（服务端已 limit，不再随消息总量线性膨胀）。
        // hasMoreOlder 用「原始返回条数」判断而非过滤后的 merged.length——
        // 软删墓碑可能滤掉若干条，若按 merged.length 判会误以为已到尽头。
        const messages = await messagesApi.listMessages(conversationId, user.id, FIRST_PAGE_SIZE);
        const tombstones = readTombstones(user.id);
        merged = tombstones.size > 0
          ? messages.filter((m) => !tombstones.has(m.id))
          : messages;
        set({ hasMoreOlder: messages.length >= FIRST_PAGE_SIZE });
        logDbg(`[messages-store] 消息加载完成 ${merged.length} 条(原始${messages.length}), 耗时 ${Date.now() - t0}ms`);
      }
      set({ messages: merged, loaded: true, loadError: false });
      // 写入首屏快照缓存（只留最近 N 条，静默失败不阻塞）
      try {
        Taro.setStorageSync(MSG_CACHE_KEY(user.id, conversationId), merged.slice(-MSG_CACHE_LIMIT));
      } catch (e) {
        console.warn('[messages-store] 写入消息缓存失败:', e);
      }
    } catch (e) {
      console.error('[messages-store] 查询消息失败:', e);
      // 仅在「完全没有可展示数据」时才置错误态：若已有本地快照/历史消息在屏，
      // 刷新失败不该用全屏错误盖掉用户已能看到的内容（静默保留旧列表）。
      if (get().messages.length === 0) set({ loadError: true });
    } finally {
      set({ loading: false });
    }
  },

  loadOlderMessages: async () => {
    const state = get();
    const user = useAuthStore.getState().user;
    if (!user || !state.conversationId) return 0;
    if (state.loadingOlder || !state.hasMoreOlder) return 0;
    // 游标取「最早的真实消息行」created_at：temp- 乐观占位行的时间是本机拼的，不能当游标
    const oldest = state.messages.find((m) => !String(m.id).startsWith('temp-'));
    if (!oldest) return 0;

    set({ loadingOlder: true });
    try {
      const raw = await messagesApi.listMessages(
        state.conversationId,
        user.id,
        OLDER_PAGE_SIZE,
        oldest.created_at,
      );
      const tombstones = readTombstones(user.id);
      const existIds = new Set(state.messages.map((m) => m.id));
      const older = raw.filter((m) => !tombstones.has(m.id) && !existIds.has(m.id));
      set({
        messages: [...older, ...state.messages],
        // 原始返回不足一页 → 已到历史尽头
        hasMoreOlder: raw.length >= OLDER_PAGE_SIZE,
      });
      logDbg(`[messages-store] ⬆️ 加载更早消息 +${older.length} 条(原始${raw.length})，当前共 ${get().messages.length} 条`);
      return older.length;
    } catch (e) {
      console.warn('[messages-store] 加载更早消息失败:', e);
      Taro.showToast({ title: '加载历史消息失败', icon: 'none' });
      return 0;
    } finally {
      set({ loadingOlder: false });
    }
  },

  sendMessage: async (
    conversationId: string,
    content: string,
    contentType: MessageType = 'text',
    mediaUrl?: string,
    replyTo?: { id: string; content: string },
  ) => {
    const user = useAuthStore.getState().user;
    if (!user) throw new Error('未登录');

    // 【乐观插入】先放一条临时占位行（temp- 前缀 id），立刻上屏；
    // 成功后原地替换为服务端真实行，失败则保留占位并标红供点击重发。
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const placeholder: Message = {
      id: tempId,
      conversation_id: conversationId,
      sender_id: user.id,
      content,
      content_type: contentType,
      media_url: mediaUrl ?? null,
      created_at: new Date().toISOString(),
      read_at: null,
      revoked_at: null,
      reply_to_id: replyTo?.id ?? null,
      reply_to_content: replyTo?.content ?? null,
      delivered_at: null,
    } as Message;
    set({
      messages: [...get().messages, placeholder],
      sendingIds: new Set(get().sendingIds).add(tempId),
    });

    const payload: FailedPayload = { content, contentType, mediaUrl, replyTo };
    try {
      // 【发送前拦截】过渡态 user（本地缓存拼出、无 access token）发请求必被 RLS 当匿名挡掉；
      // 会话行已删除时同样会撞 messages INSERT RLS。提前判定可避免把「未登录/会话已删」
      // 误报成网络故障，也省掉一次注定失败的请求。
      const authState = useAuthStore.getState();
      if (authState.bootstrapped) {
        console.warn(`[messages-store] ⛔ auth 仍为本地缓存过渡态(无 token)，拦截发送 conversationId=${conversationId}`);
        throw new Error('登录状态尚未就绪，请稍候重试');
      }
      const message = await messagesApi.sendMessage(
        conversationId,
        user.id,
        content,
        contentType,
        mediaUrl,
        replyTo,
      );
      // 真实行替换占位（保持位置在末尾），并摘掉「发送中」标记
      const nextSending = new Set(get().sendingIds);
      nextSending.delete(tempId);
      set({
        messages: [...get().messages.filter((m) => m.id !== tempId), message],
        sendingIds: nextSending,
      });
      // 发送即产生新消息，回写快照缓存（静默失败不阻塞；不含 temp 占位行）
      try {
        Taro.setStorageSync(MSG_CACHE_KEY(user.id, conversationId), get().messages.slice(-MSG_CACHE_LIMIT));
      } catch (e) {
        console.warn('[messages-store] 发送后写入消息缓存失败:', e);
      }
      // 更新会话最后消息（不阻塞发送）。非文字类型直接写中文占位符，
      // 让「旧缓存快照 / RPC 降级」等读不到类型的场景也不会露出 [image]/[voice]。
      const summary = contentType === 'text' ? content : lastMessageLabel(contentType, content);
      logDbg(`[messages-store] 🏷️ 会话摘要写入: type=${contentType} → "${summary}"`);
      conversationsApi.updateLastMessage(conversationId, summary).catch((e) => {
        console.warn('[messages-store] 更新会话最后消息失败:', e);
      });
      return message;
    } catch (err) {
      // 失败：保留占位行 + 记录失败标记与载荷，页面据此显示红色感叹号
      console.warn(`[messages-store] ⚠️ 发送失败，已保留占位 ${tempId} 可重发:`, err);
      const nextSending = new Set(get().sendingIds);
      nextSending.delete(tempId);
      set({
        failedIds: new Set(get().failedIds).add(tempId),
        failedPayloads: { ...get().failedPayloads, [tempId]: payload },
        sendingIds: nextSending,
      });
      throw err;
    }
  },

  dismissFailed: (tempId: string) => {
    const nextFailed = new Set(get().failedIds);
    nextFailed.delete(tempId);
    const nextPayloads = { ...get().failedPayloads };
    delete nextPayloads[tempId];
    const nextSending = new Set(get().sendingIds);
    nextSending.delete(tempId);
    set({
      messages: get().messages.filter((m) => m.id !== tempId),
      failedIds: nextFailed,
      failedPayloads: nextPayloads,
      sendingIds: nextSending,
    });
  },

  dismissPendingImages: (tempIds: string[]) => {
    if (tempIds.length === 0) return;
    const idSet = new Set(tempIds);
    const list = get().messages;
    if (!list.some((m) => idSet.has(m.id))) return; // 已被原位替换成真实行，无需清场
    const nextSending = new Set(get().sendingIds);
    tempIds.forEach((id) => nextSending.delete(id));
    set({ messages: list.filter((m) => !idSet.has(m.id)), sendingIds: nextSending });
    logDbg(`[messages-store] 🧹 清理 ${tempIds.length} 条未完成的图片占位`);
  },

  stageImagePlaceholders: async (conversationId: string, count: number) => {
    const user = useAuthStore.getState().user;
    if (!user || count <= 0) return [];
    const stamp = Date.now();
    const placeholders: Message[] = [];
    for (let i = 0; i < count; i += 1) {
      placeholders.push({
        id: `temp-${stamp}-img${i}-${Math.random().toString(36).slice(2, 8)}`,
        conversation_id: conversationId,
        sender_id: user.id,
        content: '[图片]',
        content_type: 'image',
        // media_url 留空：页面按「图片待发送」占位块渲染，上传完成后原位替换真值
        media_url: null,
        created_at: new Date(stamp + i).toISOString(),
        read_at: null,
        revoked_at: null,
        reply_to_id: null,
        reply_to_content: null,
        delivered_at: null,
      } as Message);
    }
    set({
      messages: [...get().messages, ...placeholders],
      sendingIds: new Set([...get().sendingIds, ...placeholders.map((p) => p.id)]),
    });
    logDbg(`[messages-store] 🖼️ 预挂 ${count} 条图片占位，先上屏再后台边传边补`);
    return placeholders.map((p) => p.id);
  },

  sendImageBatch: async (conversationId, urls, tempIds, replyTo) => {
    const user = useAuthStore.getState().user;
    const result = { sent: 0, failedTempIds: [] as string[], conversationGone: false };
    if (!user || urls.length === 0) return result;

    const authState = useAuthStore.getState();
    if (authState.bootstrapped) {
      // 过渡态无 token：整批标记失败（与 sendMessage 的拦截语义一致），不发注定被 RLS 挡掉的请求
      console.warn('[messages-store] ⛔ auth 仍为过渡态，批量图片发送已拦截');
      urls.forEach((u, i) => markImageFailed(i, u, '登录状态尚未就绪，请稍候重试'));
      result.failedTempIds = tempIds.slice();
      return result;
    }

    /** 把第 index 条占位标红并记录重发载荷（mediaUrl 用已上传的 url，重发无需重传） */
    function markImageFailed(index: number, url: string, errMsg: string) {
      const tempId = tempIds[index];
      if (!tempId) return;
      const nextFailed = new Set(get().failedIds);
      nextFailed.add(tempId);
      const nextSending = new Set(get().sendingIds);
      nextSending.delete(tempId);
      set({
        failedIds: nextFailed,
        sendingIds: nextSending,
        failedPayloads: {
          ...get().failedPayloads,
          [tempId]: { content: '[图片]', contentType: 'image', mediaUrl: url, replyTo: index === 0 ? replyTo : undefined },
        },
      });
      console.warn(`[messages-store] ⚠️ 第 ${index + 1} 张图片发送失败(${errMsg})，占位 ${tempId} 可重发`);
    }

    /** 单张：落库成功后**原位替换**自己的占位行（不追加到末尾，故并发不会乱序） */
    const sendOne = async (index: number) => {
      const tempId = tempIds[index];
      const url = urls[index];
      try {
        const message = await messagesApi.sendMessage(
          conversationId,
          user.id,
          '[图片]',
          'image',
          url,
          index === 0 ? replyTo : undefined, // 引用只随第一条生效（与微信批量回复一致）
        );
        const list = get().messages;
        const pos = list.findIndex((m) => m.id === tempId);
        if (pos >= 0) {
          const next = list.slice();
          next[pos] = message;
          set({ messages: next });
        } else {
          // 占位已被外部刷新移除（如 Realtime 全量重拉）→ 直接追加真实行
          set({ messages: [...list, message] });
        }
        // 【逐张进度】该行已是真实消息，清掉它的内存态进度与「发送中」标记
        if (tempId) {
          const nextProgress = { ...get().imageProgress };
          const nextSending = new Set(get().sendingIds);
          nextSending.delete(tempId);
          if (nextProgress[tempId]) delete nextProgress[tempId];
          set({ imageProgress: nextProgress, sendingIds: nextSending });
        }
        result.sent += 1;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.includes('已被删除')) {
          // 会话行已被彻底清理：整批终止，剩余占位一并清掉（重发必再撞同一个 403）
          console.warn('[messages-store] 🚫 批量图片发送被 messages INSERT RLS 拒绝 → 会话已失效');
          result.conversationGone = true;
          const remaining = tempIds.slice(index);
          const nextSending = new Set(get().sendingIds);
          remaining.forEach((id) => nextSending.delete(id));
          set({
            messages: get().messages.filter((m) => !remaining.includes(m.id)),
            failedIds: new Set(Array.from(get().failedIds).filter((id) => !remaining.includes(id))),
            sendingIds: nextSending,
          });
          return;
        }
        markImageFailed(index, url, msg);
        result.failedTempIds.push(tempId);
      }
    };

    // 【有限并发】并发 3：既显著快于串行，又不至于让小程序并发请求数触顶反而变慢
    const CONCURRENCY = 3;
    let cursor = 0;
    const workers = new Array(Math.min(CONCURRENCY, urls.length)).fill(0).map(async () => {
      while (cursor < urls.length) {
        if (result.conversationGone) return;
        const current = cursor;
        cursor += 1;
        await sendOne(current);
      }
    });
    await Promise.all(workers);

    if (result.sent > 0) {
      // 发送即产生新消息，回写快照缓存（静默失败不阻塞；不含 temp 占位行）
      try {
        Taro.setStorageSync(
          MSG_CACHE_KEY(user.id, conversationId),
          get().messages.filter((m) => !String(m.id).startsWith('temp-')).slice(-MSG_CACHE_LIMIT),
        );
      } catch (e) {
        console.warn('[messages-store] 批量图片发送后写入缓存失败:', e);
      }
      conversationsApi.updateLastMessage(conversationId, LAST_MSG_LABEL.image).catch((e) => {
        console.warn('[messages-store] 批量图片后更新会话摘要失败:', e);
      });
    }
    logDbg(`[messages-store] 🖼️ 批量图片发送结束 成功${result.sent}/失败${result.failedTempIds.length}${result.conversationGone ? '/会话已失效' : ''}`);
    return result;
  },

  retrySend: async (tempId: string) => {
    const state = get();
    const payload = state.failedPayloads[tempId];
    const convId = state.conversationId;
    const user = useAuthStore.getState().user;
    if (!payload || !convId || !user) {
      Taro.showToast({ title: '无法重发，请重新输入', icon: 'none' });
      state.dismissFailed(tempId);
      return;
    }
    // 先把旧占位移出失败集合（避免重发期间仍显红），再走一次完整发送流程
    const nextFailed = new Set(state.failedIds);
    nextFailed.delete(tempId);
    const nextPayloads = { ...state.failedPayloads };
    delete nextPayloads[tempId];
    const nextSending = new Set(state.sendingIds);
    nextSending.delete(tempId);
    set({
      messages: state.messages.filter((m) => m.id !== tempId),
      failedIds: nextFailed,
      failedPayloads: nextPayloads,
      sendingIds: nextSending,
    });
    try {
      await get().sendMessage(convId, payload.content, payload.contentType, payload.mediaUrl, payload.replyTo);
      Taro.showToast({ title: '重发成功', icon: 'success' });
    } catch (e) {
      console.warn('[messages-store] 重发再次失败:', e);
      Taro.showToast({ title: (e as Error).message || '重发失败', icon: 'none' });
    }
  },

  receiveMessage: (message: Message) => {
    // 避免重复添加（自己发的消息已本地追加）
    const exists = get().messages.some((m) => m.id === message.id);
    if (exists) return;
    // ⚡ 批量合并：连续多条消息（连发/批量导入）在 100ms 窗口内只触发一次 setState，
    // 避免每条消息都让聊天页全量重渲染一次。窗口极短，单条消息场景感知不到延迟。
    const pending = receiveMergeRef.current;
    if (pending) {
      // 已有合并窗口：并入队列，由既有的定时器统一提交
      if (!pending.some((m) => m.id === message.id)) pending.push(message);
      return;
    }
    receiveMergeRef.current = [message];
    setTimeout(() => {
      const batch = receiveMergeRef.current;
      receiveMergeRef.current = null;
      if (!batch || batch.length === 0) return;
      set((state) => {
        const seen = new Set(state.messages.map((m) => m.id));
        const fresh = batch.filter((m) => !seen.has(m.id));
        if (fresh.length === 0) return {};
        return { messages: [...state.messages, ...fresh] };
      });
      // 快照缓存写入也放进合并窗口：setStorageSync 是同步 IO（序列化+磁盘写，5-20ms/次），
      // 连发多条时只在窗口到期写一次，避免每条消息都阻塞主线程
      const user = useAuthStore.getState().user;
      const cid = get().conversationId;
      if (user && cid) {
        try {
          Taro.setStorageSync(MSG_CACHE_KEY(user.id, cid), get().messages.slice(-MSG_CACHE_LIMIT));
        } catch (e) {
          console.warn('[messages-store] 收消息后写入缓存失败:', e);
        }
      }
    }, 100);
  },

  markAsRead: async (conversationId: string) => {
    const user = useAuthStore.getState().user;
    if (!user) return;
    try {
      await messagesApi.markMessagesAsRead(conversationId, user.id);
      // 本地同步: 将对方发来的未读消息标记为已读
      //
      // ⚠️ 缺陷⑤（用户报「对方不在也变已读」的根因之一）：这里**必须**只改
      // `sender_id !== user.id` 的行。API 层 markMessagesAsRead 的 SQL 已用
      // `.neq('sender_id', currentUserId)` 正确过滤，本地镜像若漏掉同一条件，
      // 就会把「我发的消息」也标成已读 → 双勾凭空出现（对方根本没在线）。
      // 同时补 delivered_at：与 API 层保持一致，避免出现「已读但未送达」的矛盾组合。
      const now = new Date().toISOString();
      set({
        messages: get().messages.map((m) =>
          m.sender_id !== user.id && !m.read_at
            ? { ...m, read_at: now, delivered_at: m.delivered_at ?? now }
            : m,
        ),
      });
    } catch (e) {
      console.warn('[messages-store] 标记已读失败:', e);
    }
  },

  revokeMessage: async (messageId: string) => {
    const user = useAuthStore.getState().user;
    if (!user) throw new Error('未登录');
    await messagesApi.revokeMessage(messageId, user.id);
    // 本地立即替换为撤回占位（Realtime UPDATE 事件会向对方推送同样状态）
    set({
      messages: get().messages.map((m) =>
        m.id === messageId ? { ...m, revoked_at: new Date().toISOString() } : m,
      ),
    });
    // 更新会话摘要为撤回提示（不阻塞撤回）
    const convId = get().conversationId;
    if (convId) {
      conversationsApi.updateLastMessage(convId, '[撤回了一条消息]').catch((e) => {
        console.warn('[messages-store] 撤回后更新会话摘要失败:', e);
      });
    }
  },

  deleteMessage: async (messageId: string) => {
    const user = useAuthStore.getState().user;
    if (!user) throw new Error('未登录');
    await messagesApi.deleteMessage(messageId, user.id);
    // 从本地视图移除
    set({ messages: get().messages.filter((m) => m.id !== messageId) });
    // 落墓碑记录：冷启动全量拉取时服务端窗口外的软删除靠它过滤兜底
    writeTombstone(user.id, messageId);
    // 同步刷新快照缓存，防止下次进页秒开时旧快照仍含已删消息
    const cid = get().conversationId;
    if (cid) {
      try {
        Taro.setStorageSync(MSG_CACHE_KEY(user.id, cid), get().messages.slice(-MSG_CACHE_LIMIT));
      } catch (e) {
        console.warn('[messages-store] 删除后写入缓存失败:', e);
      }
    }
  },

  deleteAllMessages: async (conversationId: string) => {
    const user = useAuthStore.getState().user;
    if (!user) throw new Error('未登录');
    await messagesApi.deleteAllMessages(conversationId, user.id);
    // ⚠️ 缺陷⑨（用户报「删除全部消息后重新进入会话表现异常」的根因，勿再只写 set({ messages: [] })）：
    //   旧版只清 messages 数组，其余状态全部残留 ——
    //   ① `loaded` 仍为 true 且 `conversationId` 未变 → 重进本页时 fetchMessages 的
    //      `hasBaseline`（conversationId 相同 && messages.length > 0）虽因空数组为 false 走全量，
    //      但 `restoreFromCache` 开头的 `if (get().loaded && get().conversationId === conversationId) return;`
    //      会**直接短路**，导致缓存恢复与后台刷新都被跳过，页面停在「已加载但空」的假状态；
    //   ② `hasMoreOlder` 残留 false → 明明服务端还有对方新发的消息，却不再显示「加载更多」；
    //   ③ `failedIds`/`failedPayloads`/`sendingIds`/`imageProgress` 残留 → 已删消息的失败气泡
    //      与上传进度仍挂在 store 里，重进会话可能渲染出「幽灵」占位行。
    //   故这里按 restoreFromCache 的 switching 分支同款口径做**完整清场**，
    //   但**保留 conversationId**（用户仍停留在当前会话页，会话本身没被删除）。
    set({
      messages: [],
      loaded: false,
      loadError: false,
      hasMoreOlder: true,
      loadingOlder: false,
      failedIds: new Set<string>(),
      failedPayloads: {},
      sendingIds: new Set<string>(),
      imageProgress: {},
    });
    // 清空本地视图与快照缓存（整会话删除无需逐条落墓碑，直接作废缓存）
    try {
      Taro.removeStorageSync(MSG_CACHE_KEY(user.id, conversationId));
    } catch (e) {
      console.warn('[messages-store] 清除会话缓存失败:', e);
    }
    // 会话列表摘要同步置空：RPC get_conversation_summaries 对「全部消息被软删」的会话
    // 不返回任何行，列表会退回读 conversations.last_message 旧快照 —— 不清就会一直显示
    // 已删记录的最后一条内容。置空后列表显示「开始聊天吧」，与空会话语义一致。
    conversationsApi.clearLastMessage(conversationId).catch((e) => {
      console.warn('[messages-store] 清空会话摘要失败(不影响消息已删除):', e);
    });
  },

  reset: () => set({ messages: [], loading: false, loaded: false, loadError: false, conversationId: null, imageProgress: {}, sendingIds: new Set<string>(), failedIds: new Set<string>(), failedPayloads: {} }),
}));

// 登出时清空缓存
useAuthStore.subscribe((s, prev) => {
  if (prev.user && !s.user) useMessagesStore.getState().reset();
});
