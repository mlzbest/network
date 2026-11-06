import { create } from 'zustand';
import Taro from '@tarojs/taro';
import * as conversationsApi from '@/api/conversations';
import * as profilesApi from '@/api/profiles';
import type { ConversationWithPeer } from '@/api/conversations';
import type { Profile } from '@/api/profiles';
import { buildThumbUrl } from '@/lib/thumb-url';

import { useProfilesStore } from './profiles-store';
import { useAuthStore } from './auth-store';
import { logDbg } from '../lib/logger';

// 会话列表本地缓存 key（按用户隔离，防串号）
const CONV_CACHE_KEY = (uid: string) => `chat_conv_cache_${uid}`;

/** 最近一次已知的登录 uid：用于识别「原地换账号」（暗号切账号不走登出，故需单独判定） */
let lastSeenUid = useAuthStore.getState().user?.id ?? '';

/**
 * 在途的 fetchConversations Promise（并发去重）。
 * 会话列表有 4 个触发源：didShow、Realtime 事件、Realtime 订阅成功补拉、降级轮询。
 * 它们常在几百毫秒内同时到达，旧实现靠 `if (get().loading) return` 直接丢弃后来的请求——
 * 结果是「先到的那次请求返回后，后到的触发源什么都没做」，用户看到的数据可能仍是旧的。
 * 改为复用同一个在途 Promise：所有触发源都等到同一份最新结果，既不重复打 RPC 也不丢刷新。
 *
 * ⚠️ **陈旧在途请求陷阱（用户报「发完消息返回列表看不到最新」的真实根因）**：
 * 本变量是**模块级**的，不随页面实例销毁。用户从会话列表进入聊天页时，列表页只是 hide
 * 而非 unmount，若此刻恰有一个在途请求（上一次 didShow / Realtime 事件 / 降级轮询发起），
 * 它查询到的是**用户发消息之前**的数据。用户发完消息返回列表时，didShow 调
 * `fetchConversations()` 会命中 `if (inflightFetch) return inflightFetch` 直接复用这份旧结果，
 * 于是列表被写回旧数据 —— 表现为「必须下拉刷新才看到」。
 * 对策：① 用户主动返回列表时用 `fetchConversations(true)` 强制发起新请求；
 *      ② 离开列表页（进入聊天页）时调 `invalidateInflightFetch()` 作废在途请求。
 */
let inflightFetch: Promise<void> | null = null;

/**
 * 在途请求的身份令牌（与 inflightFetch 配对）。
 * 用途：请求的 `finally` 里要判断「当前在途请求是否还是我自己」——只有是才清空引用。
 * 若直接拿 Promise 变量自身比对，TS 会因「变量在自身初始化表达式内被引用」报 TS2454；
 * 用独立递增令牌即可绕开，语义等价且更清晰。
 */
let inflightToken: { id: number } | null = null;
let fetchTokenSeq = 0;

/**
 * 作废当前在途请求（不 abort，只让后续调用不再复用它）。
 *
 * 使用场景：会话列表页 `useDidHide`（用户进入聊天页）时调用。此后用户在聊天页发消息、
 * 返回列表，`fetchConversations(true)` 与普通调用都不会再命中这份「发消息之前」的旧结果。
 * ⚠️ 原请求的回包仍会正常 `set`（数据本身合法，只是不含最新消息），随后被新请求覆盖。
 */
export function invalidateInflightFetch(): void {
  if (!inflightFetch) return;
  logDbg('[chats-store] 🧹 作废在途会话列表请求（离开列表页，防返回时复用旧结果）');
  inflightFetch = null;
  inflightToken = null;
}

interface ChatsState {
  /** 当前用户的会话列表 */
  conversations: ConversationWithPeer[];
  /** 所有用户资料（用于用户列表选人发起聊天） */
  profiles: Profile[];
  loading: boolean;
  loaded: boolean;
  /** fetchConversations 是否失败（供页面显示「加载失败·点击重试」；成功后自动清零态） */
  loadError: boolean;
  /** 从本地缓存恢复快照（秒开），在 auth session 就绪前即可调用 */
  restoreFromCache: () => void;
  /**
   * 拉取会话列表。
   * @param force 为 true 时**忽略在途请求**强制发起新查询 —— 用于「用户主动返回列表」
   *   这类必须拿到此刻之后数据的场景（复用陈旧在途请求会让列表停留在发消息之前）。
   *   默认 false，保持并发去重（Realtime 事件 / 轮询 / 订阅成功补拉等同一时间窗内的重复触发仍合并）。
   */
  fetchConversations: (force?: boolean) => Promise<void>;
  fetchProfiles: () => Promise<void>;
  /** 发起聊天：获取或创建会话，返回会话 id */
  startChat: (peerId: string) => Promise<string>;
  /** 删除会话（双向软删除：仅对自己隐藏，双方都删才真正清理数据库） */
  deleteConversation: (conversationId: string) => Promise<void>;
  reset: () => void;
}

export const useChatsStore = create<ChatsState>((set, get) => ({
  conversations: [],
  profiles: [],
  loading: false,
  loaded: false,
  loadError: false,

  restoreFromCache: () => {
    const user = useAuthStore.getState().user;
    if (!user) return;
    try {
      const cached = Taro.getStorageSync(CONV_CACHE_KEY(user.id)) as ConversationWithPeer[];
      if (Array.isArray(cached) && cached.length > 0) {
        // 【已 loaded 时的覆盖判据】旧实现 `if (get().loaded) return` 会让「返回列表」场景
        // 完全跳过缓存恢复——若此刻网络请求还没回来，列表就停留在更早的内存数组上。
        // 现在允许覆盖，但**只允许用更新的缓存覆盖**：比较首条 last_message_at
        // （列表按它倒序，首条即最新），缓存不比内存新就跳过，避免用旧快照盖掉新数据。
        const current = get().conversations;
        if (get().loaded && current.length > 0) {
          const cachedTop = cached[0]?.last_message_at || '';
          const currentTop = current[0]?.last_message_at || '';
          if (cachedTop <= currentTop) {
            logDbg('[chats-store] ⏭️ 已加载且缓存不比内存新，跳过缓存恢复');
            return;
          }
          logDbg(`[chats-store] ⚡ 缓存比内存新(${currentTop} → ${cachedTop})，用缓存覆盖`);
        }
        // 兜底一：旧版本快照可能不含 peer 资料，用全局资料 store 补齐头像昵称，避免列表空白圆
        const profileMap = useProfilesStore.getState().byId;
        // 兜底二：历史缓存里可能残留 unread_count: 0（该字段现仅在「确实有未读」时写入）。
        // 载入即剔除，保证内存态与后续写回的快照都不再携带数字 0。
        let strippedZero = 0;
        // 自愈计数：旧快照里有原图地址但没有缩略图地址（该字段晚于缓存格式诞生）
        let healedThumb = 0;
        const filled = cached.map((c) => {
          if (c.unread_count === 0) {
            strippedZero++;
            c = { ...c, unread_count: undefined };
          }
          // 兜底三：历史快照只存了 media_url、没有 last_message_thumb_url。
          // 这里就地补算一次（纯同步、无网络），让首屏直接用小图而不是原图；
          // 补算结果随下面的 setStorageSync 回写，下次进页无需再算。
          if (c.last_message_media_url && !c.last_message_thumb_url) {
            const thumb = buildThumbUrl(c.last_message_media_url);
            if (thumb) {
              healedThumb++;
              c = { ...c, last_message_thumb_url: thumb };
            }
          }
          if (c.peer && c.peer.avatar_url) return c;
          const peerId = c.user1_id === user.id ? c.user2_id : c.user1_id;
          const cachedProfile = profileMap[peerId];
          return c.peer || !cachedProfile ? c : { ...c, peer: cachedProfile };
        });
        logDbg(
          `[chats-store] ⚡ 命中本地缓存快照 ${filled.length} 个会话，先渲染再后台刷新 | 剔除残留零未读 ${strippedZero} 条(不再携带数字 0)` +
            ` | 补算缩略图 ${healedThumb} 条`,
        );
        set({ conversations: filled });
        // 自愈后的快照回写：只在确实补算过缩略图时写，避免每次进页无意义地盘写
        if (healedThumb > 0) {
          try {
            Taro.setStorageSync(CONV_CACHE_KEY(user.id), filled);
          } catch (e) {
            console.warn('[chats-store] 回写自愈后的会话缓存失败:', e);
          }
        }
      }
    } catch (e) {
      console.warn('[chats-store] 读取会话缓存失败:', e);
    }
  },

  fetchConversations: async (force = false) => {
    const user = useAuthStore.getState().user;
    if (!user) return;
    // 并发去重：已有在途请求时直接复用，不再重复打 RPC（见 inflightFetch 注释）。
    // ⚠️ force=true 时**跳过复用**：用户主动返回列表必须拿到「此刻之后」的数据，
    //    而复用的在途请求可能是发消息之前发起的（陈旧在途请求陷阱，见文件头注释）。
    if (inflightFetch && !force) {
      logDbg('[chats-store] ⏭️ 会话列表已有在途请求，复用同一份结果（跳过重复 RPC）');
      return inflightFetch;
    }
    if (inflightFetch && force) {
      logDbg('[chats-store] 🔄 强制刷新：忽略在途请求，重新发起会话列表查询');
    }
    set({ loading: true });
    // 局部变量持有本次 Promise：finally 里必须比对「当前 inflightFetch 是否还是自己」再清空。
    // 否则「旧请求 finally 晚于新请求赋值」时会把新请求的引用误清，导致并发去重失效、重复打 RPC。
    // ⚠️ 用「哨兵对象 + 闭包内比对」而非直接引用 task：task 在自身 finally 里被引用会触发 TS2454。
    const token = { id: ++fetchTokenSeq };
    const startedAt = Date.now();
    const task = (async () => {
      try {
        const conversations = await conversationsApi.listConversations(user.id);
        // 关键证据日志：打出本次请求耗时与返回的最新时间戳。
        // 排查「返回列表看不到最新」时先看它——若耗时很长说明卡在网络/RPC，
        // 若耗时很短但列表仍旧，说明问题在渲染或后续被别的 set 覆盖。
        logDbg(
          `[chats-store] ✅ 会话列表已更新: ${conversations.length} 个会话, 耗时 ${Date.now() - startedAt}ms` +
            ` | 最新 last_message_at=${conversations[0]?.last_message_at ?? '-'}${force ? ' (force)' : ''}`,
        );
        set({ conversations, loaded: true, loadError: false });
        // 写入本地缓存快照（静默失败，不阻塞主流程）
        try {
          Taro.setStorageSync(CONV_CACHE_KEY(user.id), conversations);
        } catch (e) {
          console.warn('[chats-store] 写入会话缓存失败:', e);
        }
      } catch (e) {
        console.error('[chats-store] 查询会话失败:', e);
        // 仅在「屏幕上完全没有可展示的会话」时才置错误态：若已有本地快照/旧列表在屏，
        // 刷新失败不该用全屏错误盖掉用户已能看到的内容（静默保留旧列表）。
        if (get().conversations.length === 0) set({ loadError: true });
      } finally {
        set({ loading: false });
        // 只有「当前在途请求仍是自己」才清空；被 force 请求覆盖时保留新引用
        if (inflightToken === token) {
          inflightFetch = null;
          inflightToken = null;
        }
      }
    })();
    inflightFetch = task;
    inflightToken = token;
    return task;
  },

  fetchProfiles: async () => {
    try {
      const profiles = await profilesApi.listProfiles();
      // 顺手并入全局资料 store：选人列表/聊天页共用同一份资料，避免重复拉取
      useProfilesStore.getState().upsert(profiles);
      set({ profiles });
    } catch (e) {
      console.error('[chats-store] 查询用户资料失败:', e);
    }
  },

  startChat: async (peerId: string) => {
    const user = useAuthStore.getState().user;
    if (!user) throw new Error('未登录');
    const conversation = await conversationsApi.getOrCreateConversation(user.id, peerId);
    // 刷新会话列表
    get().fetchConversations();
    return conversation.id;
  },

  deleteConversation: async (conversationId: string) => {
    const user = useAuthStore.getState().user;
    if (!user) throw new Error('未登录');
    logDbg('[chats-store] 开始删除会话（双向软删除）:', conversationId);
    const { purged } = await conversationsApi.deleteConversation(conversationId, user.id);

    // 自己的消息快照缓存必须清掉：本视图已不再拥有这个会话，留着旧快照只会让
    // 下次进页 restoreFromCache 渲染出「已经不该看到」的历史消息。
    // ⚠️ 注意语义变化：单方删除时 conversations 行仍在库里、对方照常可见可发送，
    // 不再是物理删除，所以这里不存在「页面能进能看、一发就 403」的问题了。
    try {
      Taro.removeStorageSync(`chat_msg_cache_${user.id}_${conversationId}`);
      logDbg('[chats-store] 🧹 已清除本人该会话的消息快照缓存:', conversationId);
    } catch (e) {
      console.warn('[chats-store] 清除会话消息缓存失败:', e);
    }

    // 乐观移除内存行并同步写回快照缓存：否则列表页 useDidShow 的 restoreFromCache
    // 会在 fetchConversations 网络返回前命中「仍含该会话」的旧缓存把它重新渲染出来（表现为删了还在）。
    const remained = get().conversations.filter((c) => c.id !== conversationId);
    set({ conversations: remained });
    try {
      Taro.setStorageSync(CONV_CACHE_KEY(user.id), remained);
    } catch (e) {
      console.warn('[chats-store] 写入会话缓存失败:', e);
    }
    logDbg(
      `[chats-store] ✅ 会话已从本人列表移除（${purged ? '双方都已删除，数据库已彻底清理' : '仅单方删除，对方仍保留该会话'}），重新拉取列表`,
    );
    // 重新从服务器拉取最新列表,确保数据一致性
    await get().fetchConversations();
  },

  reset: () => set({ conversations: [], profiles: [], loading: false, loaded: false, loadError: false }),
}));

// 登出时清空缓存（防换账号残留）
useAuthStore.subscribe((s, prev) => {
  if (prev.user && !s.user) {
    useChatsStore.getState().reset();
  }
});

// ⚠️ 「账号+密码」暗号切账号**不会**走上面的登出链路：switchAccountTo 刻意不做本地登出
// （登出会焚毁刚打的暗号额度、抹掉本次登录统计、给旧账号写假下线时间），supabase 直接覆盖
// session，store 里看到的是 user A → user B 的「原地换人」。此时内存中仍是 A 的会话列表，
// 而 chats 页 restoreFromCache 有 `loaded` 短路——B 的快照永远读不出来，用户会看到别人的会话。
// 所以这里按 uid 变化主动 reset：清内存 + 把 loaded 置回 false，让新账号的快照得以恢复。
useAuthStore.subscribe((s) => {
  const uid = s.user?.id ?? '';
  if (uid && uid !== lastSeenUid) {
    logDbg(`[chats-store] 🔁 检测到账号变更(${lastSeenUid.slice(0, 8) || '无'}→${uid.slice(0, 8)})，清空上一账号会话列表`);
    lastSeenUid = uid;
    useChatsStore.getState().reset();
  } else if (!s.user) {
    lastSeenUid = '';
  }
});
