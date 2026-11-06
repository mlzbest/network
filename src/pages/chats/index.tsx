import { View, Text, Image, Input, ScrollView } from '@tarojs/components';
import Taro, { useDidShow, useDidHide, usePullDownRefresh } from '@tarojs/taro';
import { useChatsStore, invalidateInflightFetch } from '@/store/chats-store';
import { useAuthStore } from '@/store/auth-store';
import { redirectToLogin } from '@/lib/redirect-to-login';
import { isAuthReady } from '@/lib/auth-ready';
import { useState, useRef, useEffect, useCallback } from 'react';
import { shallow } from 'zustand/shallow';
import { useProfilesStore } from '@/store/profiles-store';
import { getWindowInfo } from '@/lib/system-info';
import {
  abandonGuard,
  bumpGuard,
  claimFreshEntry,
  clearBackgroundNote,
  elapsedSinceStart,
  getLatestGeneration,
  notePageHidden,
  resolveEntryMode,
  retainGeneration,
  resumeGuard,
  startGuard,
} from '@/lib/page-guard';
import { supabase } from '@/supabase/client';
import type { LoginWindow, Profile, PeerLoginStats } from '@/api/profiles';
import { fetchPeerLoginStatsBatch } from '@/api/profiles';
import type { ConversationWithPeer } from '@/api/conversations';
import { isPeerOnline, formatLastSeen } from '@/lib/online-status';
import { reportPresence, resolvePresence, formatPresenceLabel, formatPresenceSince, flushPendingPresence, presenceDotColor, PRESENCE_DOT_COLORS } from '@/lib/presence';
import { formatLoginDetailTime, toIso } from '@/lib/login-time';
import { markChatExit, readChatExit, readSecretEntry } from '@/lib/secret-entry';
import { syncMySteps } from '@/api/steps';
import PrivacyShield from '@/components/privacy-shield';
import { isShieldArmed, getArmedRoute, disarmShield } from '@/lib/shield-state';
import { logDbg } from '@/lib/logger';
import { clearChatsTabBadge, sumUnread, syncChatsTabBadge } from '@/lib/tabbar-badge';
import ErrorBoundary from '@/components/error-boundary';


// 本页 route（与 app.config.ts pages 一致），供 guard 做栈顶前台校验与代次归属
const PAGE_ROUTE = 'pages/chats/index';

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const hm = `${h}:${m}`;
  const now = new Date();
  const dayDiff = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86400000,
  );
  // 今天：时分；昨天：「昨天 HH:mm」；本周内（7天内）：「周X」；更早：月日（跨年带年份）
  if (dayDiff <= 0) return hm;
  if (dayDiff === 1) return `昨天 ${hm}`;
  if (dayDiff < 7) {
    const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return weekNames[d.getDay()];
  }
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() < now.getFullYear() ? `${d.getFullYear()}-${mm}-${dd}` : `${mm}-${dd}`;
}

/**
 * 会话列表最后一条消息摘要。
 * conversations.last_message 是发送时写入的冗余快照，非文字消息存的是类型占位符
 * （'[file]' / '[image]' / '[voice]' 等）。这里统一按 RPC 带回的 last_message_type
 * 重建可读文案：
 * - file → 「[文件] 真实文件名」（文件名取 last_visible_content）
 * - voice → 「[语音] 0:12」（时长来自语音消息 content，形如 '[12s]'，见 chat 页 handleUploadVoice）
 * - image → 「[图片]」（缩略图由渲染层用 last_message_media_url 单独画）、emoji → 「[表情]」
 * 其他类型（含 text）维持原快照口径；RPC 不可用时 type 缺失 → 对快照做占位符翻译兜底。
 */
const TYPE_LABEL: Record<string, string> = {
  image: '[图片]',
  voice: '[语音]',
  emoji: '[表情]',
  // ⚠️ location 必须在这里登记：位置消息的 content 是 `{lat,lng,name,address}` 的 JSON 串，
  //    漏登记会让会话列表直接把原始 JSON 渲染出来（用户会看到 {"lat":39.9,...} 这种脏数据）。
  location: '[位置]',
  // 暗号回执（where_ack）是纯信号消息，content 形如 `where_ack:<uuid>`。
  // 它不该出现在会话列表摘要里——登记成空串，由 summarizeLastMessage 跳过该条取上一条。
  where_ack: '',
};

/**
 * 语音时长串 → 'm:ss'。语音消息的 content 落库形态是 `[12s]`（秒数向上取整），
 * 也兼容历史里可能出现的裸数字/`12s`。解析不出来就返回空串，摘要退回纯 `[语音]`。
 */
function formatVoiceDuration(raw?: string): string {
  const m = /\[?(\d+(?:\.\d+)?)s?\]?/i.exec(raw || '');
  if (!m) return '';
  const total = Math.max(0, Math.round(Number(m[1])));
  if (!Number.isFinite(total)) return '';
  const mm = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * 摘要行是否需要展示左侧缩略图（目前仅图片消息有 media_url 可用）。
 * 优先用服务端缩放好的小图地址（64×64），缺失时降级回原图直链——
 * 宁可多耗一点流量也不能让列表画不出图。
 */
function getSummaryThumbUrl(item: ConversationWithPeer): string {
  if (item.last_message_revoked) return '';
  if (item.last_message_type !== 'image') return '';
  return item.last_message_thumb_url || item.last_message_media_url || '';
}

function summarizeLastMessage(item: ConversationWithPeer): string {
  const snap = item.last_message || '';
  // 暗号回执（where_ack）是纯信号消息，不该出现在摘要里。
  // ⚠️ 必须在最前面拦截：它的 content_type 是 'text'，会一路走到最后的 fallback
  //    把 `where_ack:<uuid>` 原样显示在会话列表上（用户会看到一串内部协议串）。
  if (snap.startsWith('where_ack:')) return '暂无消息';
  if (item.last_message_type === 'file') {
    // 优先 RPC 直出的真实文件名；缺失时退回快照（剥掉可能的 '[文件] ' 前缀）
    const name = item.last_message_content || snap.replace(/^\[(?:file|文件)\]\s*/, '');
    return `[文件] ${name || '文件'}`;
  }
  if (item.last_message_type === 'voice') {
    const dur = formatVoiceDuration(item.last_message_content);
    return dur ? `[语音] ${dur}` : TYPE_LABEL.voice;
  }
  const label = item.last_message_type ? TYPE_LABEL[item.last_message_type] : undefined;
  if (label) return label;
  // RPC 不可用（降级轮询/旧缓存快照）时，把英文占位符就地翻译，避免列表露出 [image]/[voice]
  const fallback = snap.replace(/^\[(image|voice|emoji|location)\]$/, (_m, t) => TYPE_LABEL[t]);
  return fallback || '暂无消息';
}

function getDisplayName(nickname: string | null, username: string | null): string {
  return nickname || username || '微信用户';
}

// 在线判定与「最近在线/离线」文案统一抽到 @/lib/online-status（会话列表与聊天详情页共用同一口径）；
// 登录明细时间格式化统一抽到 @/lib/login-time（两页 + 弹层共用）。

const ChatsPage = () => {
  logDbg('[chats] 🚀 ChatsPage 组件初始化');
  const { conversations, loading, loaded, loadError, restoreFromCache, fetchConversations, fetchProfiles, startChat, deleteConversation, profiles: contactProfiles } = useChatsStore();
  const { user, loaded: authLoaded } = useAuthStore();
  const [hiddenClickCount, setHiddenClickCount] = useState(0);
  // 「发起聊天」联系人选择弹层。
  // ⚠️ 不能用 Taro.showActionSheet：微信与 H5 都硬性限制 itemList 最多 6 项，
  //    用户数到 7 个时整个弹层直接 fail（且旧代码的 fail 回调只认 cancel，错误被静默吞掉），
  //    表现为点 + 号毫无反应、无法选人。这里改为自定义可滚动/可搜索列表，无数量上限。
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerKeyword, setPickerKeyword] = useState('');
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const hiddenClickTimerRef = useRef<any>(null);
  const pollingTimerRef = useRef<any>(null); // 降级轮询计时器(仅 Realtime 订阅失败时启用)
  const realtimeChannelRef = useRef<any>(null); // conversations 表 Realtime 通道（didShow 建、didHide 退）
  const realtimeOkRef = useRef(false); // Realtime 是否已连上：连上即停轮询，避免双通道重复刷新
  const refreshDebounceRef = useRef<any>(null); // 事件合并防抖：连续多条变更只触发一次列表刷新
  // 最近一次「主动刷新」的时刻：didShow 与 Realtime 订阅成功都会补拉一次，
  // 两者相隔通常只有几百毫秒，靠它抑制重复的整表重拉（见 shouldSkipRedundantRefresh）。
  const lastRefreshAtRef = useRef(0);
  // 「在线/离线」是时间驱动的（心跳超时即离线），光靠事件重拉不够——
  // 页面可见期间每 30 秒 tick 一次，让绿点与文案在无人改库时也能自动收敛。
  const [onlineTick, setOnlineTick] = useState(0);
  // 「对方在我离开聊天区期间登录了几次 + 最后登录详细时间」——批量拉取，peerId → stats。
  // 与 chat 详情页同款口径，列表页用 fetchPeerLoginStatsBatch 一次查全部对方（避免逐行 N 请求）。
  const [loginStatsMap, setLoginStatsMap] = useState<Map<string, PeerLoginStats>>(new Map());
  // 统计重算触发器：窗口锚点与对方登录事件都是时间驱动，需 tick 才能刷新列表统计行。
  const [statsTick, setStatsTick] = useState(0);
  const lastMessageAtMapRef = useRef<Map<string, string>>(new Map()); // 记录每个会话的最后消息时间戳
  // 对方「登录/下线时间」指纹（id → login|logout）：Realtime profiles UPDATE 与降级轮询
  // 都靠它比对是否变化，避免把无关资料改动（改昵称头像）也当成在线状态刷新。
  const peerSeenMapRef = useRef<Map<string, string>>(new Map());
  // 120秒无操作自动返回 ping 页：起点/代次统一由模块级 page-guard 管理，
  // 组件内只持有本实例的代次号（旧实例补跑一律静默忽略，防误踢新页面）。
  const genRef = useRef(0);
  // 全局资料 store：列表头像统一按 peer id 从 byId 查（冷启动第一帧即有缓存值）。
  // ⚠️ 订阅整个 byId map 会让「任何一份资料变化」都触发整页重渲染——对方每 45 秒一次
  //    心跳上报（presence_at 变化）就会重渲染整个会话列表，长列表下体感明显发卡。
  //    这里改为只订阅「本列表真正用到的 peer 资料指纹」：指纹不变则 zustand 判定相等、
  //    不触发重渲染，把心跳类无关变更挡在渲染之外。
  const peerIdsKey = conversations
    .map((c) => (c.user1_id === user?.id ? c.user2_id : c.user1_id))
    .sort()
    .join(',');
  const profileById = useProfilesStore(
    useCallback(
      (s) => {
        const picked: Record<string, Profile> = {};
        for (const id of peerIdsKey ? peerIdsKey.split(',') : []) {
          const p = s.byId[id];
          if (p) picked[id] = p;
        }
        return picked;
      },
      [peerIdsKey],
    ),
    // 浅比较：只要这批 peer 的资料对象引用没变（zustand upsert 会换新对象），就不重渲染
    shallow,
  );
  // 功能⑤：Realtime profiles UPDATE 到达时，只强制重拉那一份资料（比整表重拉会话轻得多）
  const refreshProfiles = useProfilesStore((s) => s.refresh);
  // 需求：对方「从离线变为在线」时给一个**不打断操作**的轻提示。
  // 为什么不用 Taro.showToast：toast 会盖住页面中部、且在小程序里是模态式浮层，
  // 用户正在滑动/长按列表时被打断；这里改为「列表项内联的一枚小标签 + 短暂高亮」，
  // 完全在文档流内，不抢焦点、不遮挡任何可点区域，几秒后自动消失。
  // 只存 peerId（不是会话 id）：同一对方在列表里只会出现一次，且状态转变是按人判定的。
  const [justOnlineIds, setJustOnlineIds] = useState<Set<string>>(new Set());
  // 每个 peerId 的「上线提示」自动消失计时器：重复触发时先清旧的，避免提前熄灭
  const justOnlineTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // 头像图片加载失败的 peer id：失败后回退昵称首字占位，避免空白圆/布局跳动
  const [avatarErrorIds, setAvatarErrorIds] = useState<Set<string>>(new Set());
  // 摘要缩略图加载失败的会话 id：失败后不再画缩略图，只留文案（与头像同款降级思路）
  const [thumbErrorIds, setThumbErrorIds] = useState<Set<string>>(new Set());

  // 列表头像解析汇总打点（替代逐条渲染日志，避免每帧刷屏淹没关键信息）
  useEffect(() => {
    if (conversations.length === 0) return;
    const peerIds = Array.from(
      new Set(
        conversations
          .map((c) => (c.user1_id === user?.id ? c.user2_id : c.user1_id))
          .filter(Boolean),
      ),
    );
    const hit = peerIds.filter((id) => profileById[id]).length;
    const withAvatar = peerIds.filter((id) => profileById[id]?.avatar_url).length;
    logDbg(`[chats] ⚡ 列表头像解析汇总: ${conversations.length} 个会话 / ${peerIds.length} 个对方，资料命中 ${hit}，带头像 ${withAvatar}`);
  }, [conversations, profileById, user?.id]);

  // 批量拉取「对方在我离开聊天区期间登录了几次 + 最后登录详细时间」。
  // 门控 authLoaded && user：过渡态无 token 会被 login_events 的 RLS 当匿名挡掉。
  // 统计窗口 = [上次退回 ping 页时刻, 本次暗号进入时刻]（两个锚点都存在本地 Storage，
  // 与 chat 详情页完全同口径）；fromAt 为空退化为全部历史，toAt 为空等价于「到现在为止」。
  // ⚠️ 不再依赖 profiles.last_seen_boundary_at——那是「本次登录之后」的旧口径。
  // statsTick 每 30 秒重算一次，让「TA 又登录了」能在列表里收敛成最新次数/在线状态。
  // 【防抖】conversations 每次刷新都是新数组引用，若直接依赖它，Realtime 每来一条
  // 消息都会立刻重打一次 login_events 批量查询。这里延迟 800ms 合并连续刷新，
  // 只对「稳定后」的会话集合查一次；statsTick 变化同样走这条防抖路径。
  useEffect(() => {
    // 门控用 isAuthReady：过渡态无 token，login_events 的 RLS 会把请求当匿名挡掉
    if (!isAuthReady() || !user?.id || conversations.length === 0) {
      setLoginStatsMap(new Map());
      return;
    }
    const peerIds = Array.from(
      new Set(
        conversations
          .map((c) => (c.user1_id === user.id ? c.user2_id : c.user1_id))
          .filter(Boolean),
      ),
    );
    if (peerIds.length === 0) {
      setLoginStatsMap(new Map());
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const fromAt = toIso(readChatExit(user.id));
        const toAt = toIso(readSecretEntry());
        const win: LoginWindow = { fromAt, toAt };
        const map = await fetchPeerLoginStatsBatch(peerIds, win);
        logDbg(`[chats] 📊 登录统计窗口 ${fromAt ?? '-'} ~ ${toAt ?? '-'} 对方 ${peerIds.length} 人 / 有统计 ${map.size} 人`);
        if (!cancelled) setLoginStatsMap(map);
      })();
    }, 800);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [authLoaded, user?.id, conversations, statsTick]);
  // ⚠️ 依赖里保留 authLoaded 是刻意的：isAuthReady() 读的是 store 快照，不是响应式值，
  //    必须靠 authLoaded 变化来触发本 effect 在「真实登录态到达」后重跑一次。

  // 统计重算计时器：页面可见期间每 30 秒 tick 一次（与在线绿点同款机制）。
  useEffect(() => {
    const t = setInterval(() => setStatsTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // navigationStyle custom 后需自绘顶部：状态栏避让 + 胶囊右留白。
  // 胶囊右留白 = 屏宽 - 胶囊左缘 + 8px，保证+号永远落在胶囊左侧可点区。
  // getMenuButtonBoundingClientRect 在 H5 预览会 reject Promise（errMsg:
  // 暂时不支持 API），同步 try-catch 捕不到 → 泄漏成 "Uncaught Object"；
  // 故仅在微信端调用，H5 直接回退 96px 固定留白
  const sysInfo = getWindowInfo();
  const statusBarHeight = sysInfo.statusBarHeight ?? 20;
  const isWeappEnv = Taro.getEnv() === Taro.ENV_TYPE.WEAPP;
  const [capsuleRightPadding, setCapsuleRightPadding] = useState(96);
  useEffect(() => {
    if (!isWeappEnv) return;
    try {
      const rect = Taro.getMenuButtonBoundingClientRect();
      const winW = sysInfo.windowWidth;
      if (rect && typeof rect.left === 'number' && rect.left > 0 && winW > 0) {
        setCapsuleRightPadding(Math.round(winW - rect.left + 8));
      }
    } catch (e) {
      logDbg('[chats] getMenuButtonBoundingClientRect 异常，回退固定留白');
    }
  }, [isWeappEnv, sysInfo]);
  logDbg('[chats] custom 导航栏生效，状态栏高度:', statusBarHeight, '胶囊右留白:', capsuleRightPadding);

  // 隐藏按钮点击处理(连续3次跳转到Ping页)
  const handleHiddenClick = () => {
    const newCount = hiddenClickCount + 1;
    logDbg(`[chats] 隐藏按钮点击次数: ${newCount}`);
    setHiddenClickCount(newCount);
    bumpGuard(genRef.current); // 点击视为用户操作，重置 120 秒起点

    // 清除之前的定时器
    if (hiddenClickTimerRef.current) {
      clearTimeout(hiddenClickTimerRef.current);
    }

    // 设置2秒内重置计数器
    hiddenClickTimerRef.current = setTimeout(() => {
      logDbg('[chats] 隐藏按钮计数器重置');
      setHiddenClickCount(0);
    }, 2000);

    // 达到3次点击
    if (newCount >= 3) {
      logDbg('[chats] 触发隐藏功能: 跳转到Ping页面');
      setHiddenClickCount(0);
      if (hiddenClickTimerRef.current) {
        clearTimeout(hiddenClickTimerRef.current);
      }
      Taro.showToast({ title: '进入网络检测', icon: 'success', duration: 1500 });
      setTimeout(() => {
        // 用 reLaunch 关闭所有页面再打开 ping，彻底清空页面栈，
        // 避免回到 ping 后仍残留返回键 / 可右滑退回聊天列表
        logDbg('[chats] 🚪 [EXIT_HIDDEN_CLICK] 主动离开本页, 废弃计时起点');
        markChatExit(); // 打退场点：下一次进入聊天区的登录统计窗口从这里起算
        reportPresence('offline'); // 退回 ping 页 = 不在线（必须在 reLaunch 前发起）
        abandonGuard();
        Taro.reLaunch({ url: '/pages/ping/index' });
      }, 500);
    }
  };

  /** 所有「离开 chats 页」出口的统一收口：只有最新代次实例才允许发起跳转 */
  const exitToPing = (tag: string) => {
    if (genRef.current !== getLatestGeneration()) {
      logDbg(`[chats] 🛑 [GUARD_STALE] ${tag} 但本实例代次(${genRef.current})已过期, 忽略跳转`);
      return;
    }
    logDbg(`[chats] 🚪 [${tag}] 废弃计时, reLaunch 回 ping 页`);
    markChatExit(); // 打退场点：下一次进入聊天区的登录统计窗口从这里起算
    reportPresence('offline'); // 退回 ping 页 = 不在线（必须在 reLaunch 前发起）
    abandonGuard();
    Taro.reLaunch({ url: '/pages/ping/index' });
  };

  // 页面显示时:区分页面切换vs从后台切回
  useDidShow(() => {
    const timeStr = new Date().toLocaleTimeString();
    // ① resolveEntryMode 一次性完成「栈顶前台校验 + didHide/onAppHide 配对判定」。
    //    ⚠️ 原实现在这里读存储里的「当前活跃页」来判页面切换——微信切后台会冻结
    //    JS 定时器，回前台瞬间挂起的 tick 抢在 didShow 前补跑，读到旧值就把计时器
    //    clear 掉，导致「停在页面不操作也永不跳转」（本次 bug 根因）。
    //    现在起点与判定全部交给模块级 page-guard，tick 只做纯时间比较。
    const entry = resolveEntryMode(PAGE_ROUTE);
    if (entry.mode === 'stale') {
      logDbg(`[chats] 👻 [GUARD_STALE] [${timeStr}] didShow 但栈顶非本页(旧实例补触发), 忽略本次生命周期`);
      return;
    }
    genRef.current = entry.mode === 'resume' ? retainGeneration(PAGE_ROUTE) : claimFreshEntry(PAGE_ROUTE);
    clearBackgroundNote();

    // ② 兜底拦截：遮挡未解除期间(如点原生返回键/右滑)落到本页，立即弹回被遮挡页。
    //    例外：若被遮挡页此刻已不在页面栈里(如遮挡后曾 reLaunch 去 ping 再暗号进入列表)，
    //    弹回只会把用户刚打开的本页顶走，此时直接解除遮挡、正常停留本页。
    if (isShieldArmed() && getArmedRoute() !== PAGE_ROUTE) {
      const armedInStack = Taro.getCurrentPages().some((p) => p.route === getArmedRoute());
      if (armedInStack) {
        logDbg('[chats] 检测到遮挡未解除, 兜底弹回:', getArmedRoute());
        abandonGuard();
        Taro.reLaunch({ url: '/' + getArmedRoute() });
        return;
      }
      logDbg('[chats] 遮挡归属页已不在页面栈, 解除遮挡并停留本页');
      disarmShield();
    }

    // ③ 计时决策：resume 按已流逝时长补判/续跑；fresh 全新起表 120s
    const elapsed = entry.elapsedMs;
    logDbg(`[chats] 🧭 [${timeStr}] didShow — mode:`, entry.mode, '| 已流逝(s):', Math.floor(elapsed / 1000), '| 代次:', genRef.current);
    if (entry.mode === 'resume') {
      if (elapsed >= 120000) {
        logDbg(`[chats] 🔙 后台切回补判已超时(${Math.floor(elapsed / 1000)}秒)`);
        exitToPing('EXIT_RESUME');
        return;
      }
      resumeGuard(genRef.current);
    } else {
      startGuard({ pageRoute: PAGE_ROUTE, generation: genRef.current, onTimeout: () => exitToPing('EXIT_TICK') });
    }

    // 再检查登录状态
    // ⚠️ 必须用 isAuthReady 而不是裸 authLoaded：冷启动时 auth-store 会先用本地缓存
    //    拼出一个「过渡 user」（bootstrapped=true, loaded=false）让渲染不等 getSession。
    //    过渡态**没有 access token**，此刻发起的任何 PostgREST 请求都会被 RLS 当匿名挡掉，
    //    表现为「Failed to fetch ... 400」这类噪音错误。必须等真实登录态（loaded && !bootstrapped）。
    if (!isAuthReady()) return;
    if (!user) {
      redirectToLogin();
      return;
    }
    // 每次显示页面都刷新会话列表,确保登录后能看到最新数据。
    // ⚠️ 必须传 force=true：用户从聊天页返回时，若此刻恰有一个「发消息之前发起」的在途请求，
    //    普通调用会直接复用它 → 列表被写回旧数据（用户报「返回看不到最新，要下拉刷新」的根因）。
    //    强制刷新保证拿到此刻之后的数据；lastRefreshAtRef 仍要写，让紧随其后的
    //    Realtime 订阅成功补拉被 1.5s 窗口抑制，避免刚 force 完又立刻重复拉一次。
    lastRefreshAtRef.current = Date.now();
    fetchConversations(true);
    // ⚠️ 这里**不再**调 fetchProfiles()：它内部是 `profiles.select('*')` 全表查询，
    //    每次返回列表都无条件打一次，且与 fetchConversations 的 RPC 抢同一条网络/连接池，
    //    是「返回列表很慢」的隐形拖累。列表所需的对方资料已由 listConversations 内部
    //    走 profiles-store.ensure(缺失 id) 按需补齐（命中内存即零网络），完全覆盖本页需求；
    //    选人列表（+号）在 handleStartChat 里会自己 await fetchProfiles()，不受影响。
    logDbg('[chats] ⚡ didShow 已发起强制刷新（不再附带 profiles 全表查询）');
    // ⚠️ 缺陷④补充（用户报「最后活跃时间还是不对」的收尾）：didShow 必须**主动**重拉一次
    //    本列表所有对方资料。原因：从 chat 页返回时，若对方恰在 chat 页内活跃（心跳一直在写
    //    last_active_at），而 Realtime profiles UPDATE 事件因网络抖动丢失，列表就会拿
    //    「进 chat 页之前」的旧资料渲染——30 秒 tick 虽能自愈，但用户返回列表的第一眼是错的。
    //    这里用 refreshProfiles（强制重拉）而非 ensure（只拉缺失）：ensure 对已存在但陈旧的
    //    资料零网络，正是「读陈旧快照」的成因。批量一次查询，代价可控。
    const didShowPeerIds = peerIdsKey ? peerIdsKey.split(',').filter(Boolean) : [];
    if (didShowPeerIds.length > 0) {
      logDbg(`[chats] 🔄 didShow 强制重拉 ${didShowPeerIds.length} 位对方资料（防返回列表读到陈旧快照）`);
      void refreshProfiles(didShowPeerIds);
    }
    // Realtime 优先 + 轮询降级（与 chat 详情页同款策略）：
    // didShow 可能因 resume 路径重建订阅，先清掉旧通道再建，防重复订阅
    stopRealtime();
    startRealtime();

    // ④ 进页主动同步步数：每次进入会话列表页都去微信拉一次最新步数并落库，
    //    这样随后进聊天详情页打开步数卡片时，看到的就是刚同步的新数据（而不是上次的旧值）。
    //    ⚠️ 必须放在 authLoaded/user 门控之后：syncMySteps 内部要读 session 拿 uid，
    //       冷启动过渡态（bootstrapped）没有 access token，请求必被 RLS 挡掉。
    //    ⚠️ 不 await、失败静默：步数同步是「锦上添花」的旁路，绝不能拖慢或阻断会话列表加载；
    //       H5 预览态没有微信 JSAPI，syncMySteps 会抛「请在微信小程序中打开」，属预期降级。
    //    ⚠️ 不传 peerId：本页是列表页、没有单一对比对象，只同步「我自己的」步数即可。
    void syncMySteps()
      .then((r) => {
        logDbg(`[chats] 👟 进页步数同步完成 today=${r.today} 明细${r.mine.length}天`);
      })
      .catch((e: any) => {
        console.warn('[chats] ⚠️ 进页步数同步失败（静默，不影响列表）:', (e as Error)?.message || e);
      });

    // ⑤ 在场状态：停留在会话列表页 = 在线。必须在 stale/遮挡弹回/超时退场分支
    //    return 之后，否则旧实例补触发会把状态覆盖成错的。
    reportPresence('online');
    // 缺陷②：进入聊天区也是补发未送达状态的时机（网络可能已恢复 / auth 可能已就绪）。
    // ⚠️ 冷启动过渡态下 reportPresence('online') 会入队而非直接发（无 token 必被 RLS 挡），
    //    这里紧跟一次 flush：若此刻 auth 已就绪则立即补发，否则留给 app.tsx 的
    //    auth subscribe 在真值到达时补发（两条路径都覆盖，避免状态卡在旧值）。
    void flushPendingPresence();
  });

  // 进入页面先用本地缓存快照渲染（秒开），网络请求在 auth 就绪后由 didShow 补发
  useEffect(() => {
    logDbg('[chats] ⚡ 尝试恢复会话列表缓存快照');
    restoreFromCache();
  }, [restoreFromCache]);

  // 监听conversations变化,更新时间戳映射
  useEffect(() => {
    if (conversations && conversations.length > 0) {
      const newMap = new Map<string, string>();
      for (const conv of conversations) {
        if (conv.last_message_at) {
          newMap.set(conv.id, conv.last_message_at);
        }
      }
      lastMessageAtMapRef.current = newMap;
      logDbg('[chats] 📊 已更新', newMap.size, '个会话的时间戳映射');
      // 未读角标验证：unread_count 归一化后只有「确实有未读」的会话才带该字段，
      // 无未读会话不再携带数字 0（角标节点完全不渲染）
      const unreadConvs = conversations.filter((c) => (c.unread_count ?? 0) > 0);
      const zeroUnreadConvs = conversations.filter((c) => c.unread_count === 0);
      logDbg(`[chats] 🔴 角标渲染核对: ${conversations.length} 个会话 / ${unreadConvs.length} 个有未读(显示红点) / ${zeroUnreadConvs.length} 个残留零未读(应为 0，若有则说明归一化未生效)`);
      if (unreadConvs.length > 0) {
        logDbg('[chats] 🔴 未读角标待渲染(外层未裁剪容器):', unreadConvs.map((c) => `${c.id}=${c.unread_count}`).join(', '));
      }
    }
  }, [conversations]);

  // ===== 未读总数同步到 tabBar 角标 =====
  //
  // 【为什么挂在 conversations 的 effect 上，而不是在 fetchConversations 的调用点逐个插入】
  // 会话列表有 6 条刷新路径（didShow 强制刷新 / Realtime 两条通道 / 订阅成功补拉 /
  // 降级轮询 / 下拉刷新）。若在每个调用点各写一次角标同步，新增刷新路径时必然漏掉一处，
  // 表现为「列表数字对了但 tabBar 角标不动」。改为订阅 `conversations` 这个**唯一真源**后，
  // 无论哪条路径写入了新列表，角标都会自动跟着收敛，天然不会漏。
  //
  // 【为什么依赖数组里带 user?.id】登出时 auth-store 会把 user 置空、conversations 被
  // reset 成空数组，此时必须把角标清掉——否则 A 账号的未读数会挂在 tabBar 上被 B 账号看到。
  // 这里用 `!user` 分支显式清除，而不是依赖「空数组 → total=0 → 清除」，
  // 因为登出瞬间 conversations 可能还没被 reset（存在一帧的旧数据）。
  //
  // 【为什么不需要 useDidHide 里清】角标反映的是「服务端真实未读数」，切后台/离开页面
  // 都不改变这个事实，清了反而会让用户切回来时看到角标闪一下。
  useEffect(() => {
    if (!user) {
      clearChatsTabBadge();
      return;
    }
    const total = sumUnread(conversations);
    syncChatsTabBadge(total);
  }, [conversations, user]);

  // 页面隐藏时:记录 hide 时刻 + 仅停表（保留起点供后台切回补判），清理轮询
  useDidHide(() => {
    const timeStr = new Date().toLocaleTimeString();
    logDbg(`[chats] 👻 [${timeStr}] useDidHide 触发, 记录 hide 时刻 + 仅停表(保留计时起点供切回补判)`);

    // 记录 hide 时刻：与随后的 App onAppHide 配对，供下次 didShow 区分
    // 「切后台导致的 hide」(保留起点) vs 「导航离开导致的 hide」(作废旧起点)。
    notePageHidden(PAGE_ROUTE);

    // 导航离开或切后台都会触发 hide → 先记「不在当前」；若随后退回 ping 页，
    // exitToPing 会用 offline 覆盖（offline 不参与抑制、保证送达）。
    reportPresence('away');

    // 清理实时订阅与降级轮询
    stopRealtime();

    // 【作废在途请求】用户进入聊天页后可能发消息再返回；若此刻有一个「发消息之前发起」的
    // 在途请求还挂着，返回时 didShow 的 fetchConversations 会复用它 → 列表停留在旧数据。
    // 这里主动作废（不 abort，只让后续调用不再复用），从源头消除该可能。
    invalidateInflightFetch();
  });

  // 在线状态自驱动计时器：仅页面可见期间运行（didShow/didHide 控制启停）。
  //
  // ⚠️ 缺陷④（用户三次报「最后活跃时间还是不对」的最终根因）：
  // tick 只让组件重渲染，**不会重新拉数据**——它拿的还是 profiles-store 里那份旧资料。
  // 本页此前只有两条路径能刷新对方资料：① Realtime profiles UPDATE 事件；
  // ② 降级轮询（且它只调 fetchConversations，而该函数从 store 取资料、并不回源）。
  // 于是事件通道不可用时，对方心跳每 45 秒刷新的 last_active_at 永远进不了本端内存，
  // 「最后活跃」永久停在进页那一刻。修复：tick 里顺带强制重拉一次本列表所有对方资料
  // （一次批量查询，10 秒轮询之外的低频兜底），让「时间流逝」本身也能驱动数据更新。
  useEffect(() => {
    const t = setInterval(() => {
      setOnlineTick((n) => n + 1);
      // ⚠️ 必须 filter(Boolean)：会话列表为空时 peerIdsKey 是空串，而 `''.split(',')`
      //    返回 `['']`（长度 1），会让下面的 length 判断误通过、白发一次 `in('id', [''])` 查询。
      const ids = peerIdsKey ? peerIdsKey.split(',').filter(Boolean) : [];
      if (ids.length > 0) {
        logDbg(`[chats] 🔄 30s tick 强制重拉 ${ids.length} 位对方资料（兜底 Realtime 事件通道不可用）`);
        void refreshProfiles(ids);
      }
    }, 30_000);
    return () => clearInterval(t);
  }, [peerIdsKey, refreshProfiles]);

  // 轻提示计时器兜底清理：页面卸载时把未到期的「上线提示」定时器全部清掉，
  // 避免它们在新实例里触发 setState（旧实例已卸载）造成无意义的重渲染。
  useEffect(() => {
    const timers = justOnlineTimersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  // ===== Realtime 订阅：监听 conversations 表变化，新消息秒级到达 =====
  // conversations 已加入 supabase_realtime 发布；RLS 保证只有参与者收到自己会话的事件。
  // 事件只当「触发器」用——收到变更后走 fetchConversations 重算未读数/摘要，
  // 不在事件回调里手工 patch 列表（避免与 RPC 统计结果不一致）。
  const scheduleRefresh = () => {
    if (refreshDebounceRef.current) return; // 300ms 窗口内的后续事件直接丢弃，等这一次刷新完成
    refreshDebounceRef.current = setTimeout(() => {
      refreshDebounceRef.current = null;
      logDbg('[chats] ⚡ Realtime 触发会话列表刷新（force，跳过陈旧在途请求）');
      lastRefreshAtRef.current = Date.now();
      // ⚡ force=true：Realtime 事件是新数据的明确信号。不带 force 时 fetchConversations
      // 会复用在途请求（inflightFetch），而那个请求可能是「消息发出之前」发起的——
      // 复用它等于拿旧结果盖掉新事件，用户看到的就是「列表迟迟不更新」。
      void fetchConversations(true);
    }, 300);
  };

  /**
   * 判断「刚发生过一次主动刷新」而跳过本次补拉。
   * 场景：didShow 里 fetchConversations() 之后紧接着 startRealtime()，
   * 订阅成功回调又会补拉一次——两次请求间隔通常 <1s，结果完全重复。
   * 窗口取 1.5s：足够覆盖订阅握手耗时，又不会把用户真实操作后的刷新误吞。
   */
  const shouldSkipRedundantRefresh = () => Date.now() - lastRefreshAtRef.current < 1500;

  /**
   * 需求：对方「离线 → 在线」时点亮列表项上的轻提示。
   *
   * 判定口径与列表渲染**完全同源**（都走 resolvePresence），避免出现「绿点亮了但没提示」
   * 或「提示了但绿点没亮」这种自相矛盾的状态。
   *
   * ⚠️ 旧状态必须从 `useProfilesStore.getState().byId` 现读，不能用组件闭包里的
   *    `profileById`——它是收窄订阅的派生值，Realtime 回调闭包捕获的可能是上一轮渲染的
   *    快照；而 refreshProfiles 是异步的，回调执行时 store 里仍是**转变前**的真值，
   *    正好是我们要的「旧状态」。
   *
   * ⚠️ 只在「确实从非在线变成在线」时提示：首次拿到资料（旧值为 undefined）不提示，
   *    否则冷启动进列表会把所有在线好友都闪一遍，变成噪音。
   */
  const flagPeerCameOnline = (peerId: string) => {
    const prev = useProfilesStore.getState().byId[peerId];
    if (!prev) return; // 无旧资料 → 首次加载，不算「转变」
    const wasOnline =
      resolvePresence(prev.presence_state, prev.presence_at, prev.last_active_at, prev.hide_presence) === 'online';
    if (wasOnline) return; // 本来就在线，不是「变为在线」
    // 对方隐藏在场状态时不提示：那等于绕开隐私设置暴露活跃情况
    if (prev.hide_presence) return;
    logDbg(`[chats] 🟢 检测到对方由离线变为在线，点亮轻提示: ${peerId.substring(0, 8)}...`);
    setJustOnlineIds((s) => (s.has(peerId) ? s : new Set(s).add(peerId)));
    const old = justOnlineTimersRef.current.get(peerId);
    if (old) clearTimeout(old);
    justOnlineTimersRef.current.set(
      peerId,
      setTimeout(() => {
        justOnlineTimersRef.current.delete(peerId);
        setJustOnlineIds((s) => {
          if (!s.has(peerId)) return s;
          const next = new Set(s);
          next.delete(peerId);
          return next;
        });
      }, 6000),
    );
  };

  const startRealtime = () => {
    const channel = supabase
      .channel('chats:list')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'conversations' },
        (payload) => {
          const conv = payload.new as { id: string; last_message_at: string | null };
          const oldTime = lastMessageAtMapRef.current.get(conv.id) || '';
          const newTime = conv.last_message_at || '';
          logDbg(`[chats] ⚡ Realtime收到conversations UPDATE: ${conv.id.substring(0, 8)}... (${oldTime} → ${newTime})`);
          // 仅当 last_message_at 真的前进才刷新（撤回/已读等无关更新不触发整表重拉）
          if (newTime && newTime !== oldTime) scheduleRefresh();
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'conversations' },
        () => {
          logDbg('[chats] ⚡ Realtime收到conversations INSERT(对方发起了新会话), 刷新列表');
          scheduleRefresh();
        },
      )
      // 【兜底通道】直接订阅 messages 表的 INSERT。
      //
      // 【为什么 conversations 的 UPDATE 监听还不够】正常情况下对方发消息会走
      // messages-store → `updateLastMessage()` 写 `conversations.last_message_at`，
      // 从而触发上面的 UPDATE 监听。但只要有**任何一条发送路径绕过了 messages-store**
      // （例如批量诊断页的 send 命令直接调 `api/messages.ts` 的 sendMessage，
      // 它只 INSERT messages 表、完全不碰 conversations 行），`last_message_at`
      // 就不会前进，UPDATE 事件永远不来，列表只能靠用户手动下拉刷新。
      // 直接监听 messages 表把「消息落库」这个**最底层事实**作为触发源，
      // 无论发送方走哪条路径都能感知到。
      //
      // 【为什么不需要 filter】聊天页的订阅带 `filter: 'conversation_id=eq.xxx'`
      // 是因为它只关心一个会话；列表页要感知**所有**会话的新消息，故监听全表。
      // 事件量由 RLS 兜住：`users_select_messages` 要求当前用户是该会话参与者，
      // Realtime 的 postgres_changes 按 RLS 过滤，所以只会收到「我参与的会话」的消息，
      // 收不到无关用户的（见 migrations/20260825_061319_create_messages_table.sql）。
      //
      // 【为什么只监听 INSERT，不监听 UPDATE】UPDATE 事件在本项目里对应「标记已读」
      // （`receivers_mark_read_messages`）与「撤回」（`senders_update_own_messages`），
      // 两者都不改变列表排序与摘要，监听它们只会白白触发整表重拉。
      // 撤回场景另有 conversations 的 UPDATE 通道覆盖（撤回会写 `[撤回了一条消息]` 摘要）。
      //
      // 【为什么与 conversations UPDATE 重复触发也无害】`scheduleRefresh` 的 300ms
      // 防抖会把同一时间窗内的多次触发合并成一次 `fetchConversations()`，
      // 对方连发 10 条也只打一次 RPC（服务端 RPC 实测仅 1.9ms）。
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const msg = payload.new as { id?: string; conversation_id?: string; sender_id?: string };
          // 自己发的消息不触发刷新：本端发送时列表已在 chat 页返回时刷新过，
          // 且自己发消息必然伴随 conversations UPDATE（messages-store 会写摘要），
          // 再刷一次纯属浪费。只关心「对方发来的」。
          if (msg.sender_id && msg.sender_id === user?.id) return;
          logDbg(
            `[chats] ⚡ Realtime收到messages INSERT(对方发来新消息): 会话 ${String(msg.conversation_id).substring(0, 8)}... 消息 ${String(msg.id).substring(0, 8)}...`,
          );
          scheduleRefresh();
        },
      )
      // 双向软删除：本人或对方写入 conversation_deletes 时，conversations 行本身不变，
      // 只能靠这张标记表的 INSERT 事件让列表感知「某一方删了这个会话」。
      // RLS 只允许本人读自己的删除记录，故对方删除时本端收不到事件（符合语义：
      // 对方删除不该影响我的列表），真正双方都删后 conversations 行被清理 → DELETED 事件。
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'conversation_deletes' },
        (payload) => {
          const rec = payload.new as { conversation_id: string; user_id: string };
          logDbg(`[chats] 🗑️ Realtime收到删除标记: 会话 ${rec.conversation_id.substring(0, 8)}... 被用户 ${rec.user_id.substring(0, 8)}... 删除, 刷新列表`);
          scheduleRefresh();
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'conversations' },
        (payload) => {
          logDbg('[chats] 🧹 Realtime收到conversations DELETE(双方均已删除，会话已彻底清理), 刷新列表:', (payload.old as { id?: string })?.id);
          scheduleRefresh();
        },
      )
      // 对方登录/下线/心跳：profiles 已加入 supabase_realtime 发布。事件只当触发器——
      // 命中「当前任一会话的对方 id」才重拉（改昵称头像等无关更新忽略）。
      // ⚠️ payload.new 可能因 WAL 副本身份模式缺列，故不直接吃它的值 patch UI，只用于判定 id。
      // ⚠️ 心跳每 45 秒一次也会产生事件，但 scheduleRefresh 的 300ms 防抖会合并，重拉频率可控。
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles' },
        (payload) => {
          const p = payload.new as { id?: string };
          if (!p.id) return;
          const isPeer = conversations.some((c) => {
            const pid = c.user1_id === user?.id ? c.user2_id : c.user1_id;
            return pid === p.id;
          });
          if (!isPeer) return; // 非会话对方的资料变更，忽略
          logDbg(`[chats] ⚡ Realtime收到对方 profiles UPDATE: ${p.id.substring(0, 8)}..., 即时重算在线状态`);
          // 需求：先按「转变前」的旧状态判定是否要亮轻提示。
          // ⚠️ 必须在 refreshProfiles 之前调用——它内部会 upsert 覆盖 store，
          //    调用之后就再也读不到旧状态了（这正是「离线→在线」判定的唯一依据）。
          flagPeerCameOnline(p.id);
          // 功能⑤：事件到达即重算，不再等 30 秒 tick。走 profiles-store.refresh 只拉
          // 资料（比 fetchConversations 整表重拉轻得多）；列表副文案订阅 byId，
          // upsert 后自动重渲染。conversations 的 last_message_at 由上面的专用监听负责。
          void refreshProfiles([p.id]);
        },
      );
    realtimeChannelRef.current = channel;

    channel.subscribe((status) => {
      logDbg('[chats] Realtime订阅状态:', status);
      if (status === 'SUBSCRIBED') {
        realtimeOkRef.current = true;
        // 订阅成功：停掉降级轮询，并**无条件**补拉一次。
        // ⚠️ 这里刻意不再走 shouldSkipRedundantRefresh() 抑制：didShow 的 force 刷新与
        //    订阅握手是并发的，握手期间（200~500ms）到达的 conversations UPDATE 事件会丢；
        //    若此时又被 1.5s 窗口抑制掉补拉，列表就永远停在旧摘要上（用户报「返回看不到最新」）。
        //    服务端 RPC 实测仅 1.9ms，多这一次补拉的代价可忽略，换来的是「订阅建立后必有新鲜数据」。
        stopPolling();
        logDbg('[chats] 🔁 Realtime 订阅成功，无条件补拉一次（不再被 1.5s 窗口抑制）');
        lastRefreshAtRef.current = Date.now();
        fetchConversations();
      } else if (status === 'CHANNEL_ERROR' || status === 'CLOSED' || status === 'TIMED_OUT') {
        if (!realtimeChannelRef.current) return; // 已主动退订后的状态回调，忽略
        console.warn('[chats] ⚠️ Realtime订阅异常:', status, '- 启动轮询降级方案');
        realtimeOkRef.current = false;
        startPolling();
      }
    });
  };

  const stopRealtime = () => {
    if (refreshDebounceRef.current) {
      clearTimeout(refreshDebounceRef.current);
      refreshDebounceRef.current = null;
    }
    if (realtimeChannelRef.current) {
      realtimeChannelRef.current.unsubscribe();
      realtimeChannelRef.current = null;
      logDbg('[chats] 📴 已取消 Realtime 订阅');
    }
    realtimeOkRef.current = false;
    stopPolling();
  };

  const stopPolling = () => {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  };

  // 降级轮询函数(仅 Realtime 订阅失败时启用):每10秒轻量查询,有变化才刷新完整数据
  const startPolling = () => {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
    }
    logDbg('[chats] 🔄 Realtime 不可用,启动降级轮询(每10秒)');
    pollingTimerRef.current = setInterval(async () => {
      try {
        const currentUser = useAuthStore.getState().user;
        if (!currentUser) return;

        // 步骤1: 轻量查询,只获取每个会话的参与者与最后消息时间
        const [latestRes, deletedRes] = await Promise.all([
          supabase
            .from('conversations')
            .select('id, user1_id, user2_id, last_message_at')
            .or(`user1_id.eq.${currentUser.id},user2_id.eq.${currentUser.id}`)
            .order('last_message_at', { ascending: false, nullsFirst: false }),
          // 双向软删除：本人删过的会话不再出现在列表里，轮询降级路径也必须过滤，
          // 否则 Realtime 不可用时被删的会话会被轮询「复活」。
          supabase.from('conversation_deletes').select('conversation_id').eq('user_id', currentUser.id),
        ]);
        if (latestRes.error) {
          console.error('[chats] 轮询查询失败:', latestRes.error);
          return;
        }
        const myDeletedSet = new Set(
          deletedRes.error
            ? []
            : ((deletedRes.data ?? []) as { conversation_id: string }[]).map((d) => d.conversation_id),
        );
        if (deletedRes.error) {
          console.warn('[chats] ⚠️ 轮询查询本人删除标记失败，本次跳过软删过滤:', deletedRes.error.message);
        }
        const latestConversations = (latestRes.data ?? []).filter((c) => !myDeletedSet.has(c.id));
        const hiddenCount = (latestRes.data ?? []).length - latestConversations.length;
        if (hiddenCount > 0) {
          logDbg(`[chats] 🙈 轮询已过滤 ${hiddenCount} 个本人删除过的会话`);
        }

        if (!latestConversations || latestConversations.length === 0) {
          logDbg('[chats] 轮询: 没有会话');
          return;
        }

        // 步骤2: 检查是否有会话的last_message_at发生变化（含「本端已删除导致行消失」）
        let hasChanges = hiddenCount > 0;
        const currentMap = new Map<string, string>();

        for (const conv of latestConversations) {
          const lastTime = conv.last_message_at || '';
          currentMap.set(conv.id, lastTime);

          const oldTime = lastMessageAtMapRef.current.get(conv.id) || '';
          if (lastTime !== oldTime) {
            hasChanges = true;
            logDbg(`[chats] 检测到会话 ${conv.id.substring(0,8)}... 有新消息: ${oldTime} → ${lastTime}`);
          }
        }
        for (const id of lastMessageAtMapRef.current.keys()) {
          if (!currentMap.has(id)) {
            hasChanges = true;
            logDbg(`[chats] 检测到会话 ${id.substring(0, 8)}... 已不在有效列表（对方彻底清理或本人已删除）`);
          }
        }

        // 步骤3: 只有当有变化时才刷新完整数据
        let needRefresh = hasChanges;
        if (hasChanges) {
          logDbg('[chats] 📥 检测到新消息,刷新完整会话列表');
        } else {
          logDbg('[chats] ⏸️ 无新消息,跳过刷新');
        }

        // 步骤4（在线状态兜底）：Realtime 不可用时，profiles UPDATE 事件也收不到，
        // 这里轻量查一次所有对方的登录/下线/心跳时间，指纹变化则重拉资料刷新展示。
        const peerIds = Array.from(
          new Set(
            latestConversations
              .map((c) => (c.user1_id === currentUser.id ? c.user2_id : c.user1_id))
              .filter(Boolean),
          ),
        );
        if (peerIds.length > 0) {
          const seenRes = await supabase
            .from('profiles')
            .select('id, last_login_at, last_logout_at, last_active_at, presence_state, presence_at, hide_presence')
            .in('id', peerIds);
          if (!seenRes.error) {
            const rows = (seenRes.data ?? []) as Profile[];
            let seenChanged = false;
            for (const r of rows) {
              // 指纹含 hide_presence：功能⑦开关被对方改动时，本端也必须感知并重拉资料
              const fp = `${r.last_login_at || ''}|${r.last_logout_at || ''}|${r.last_active_at || ''}|${r.presence_state || ''}|${r.presence_at || ''}|${r.hide_presence ? 1 : 0}`;
              if (peerSeenMapRef.current.get(r.id) !== fp) {
                seenChanged = true;
                peerSeenMapRef.current.set(r.id, fp);
                // 需求：Realtime 不可用时轻提示也必须生效，故降级轮询路径同样做「离线→在线」判定。
                // 这里读的是 profiles-store 里的旧资料（本轮还没 refresh），语义与 Realtime 路径一致。
                flagPeerCameOnline(r.id);
              }
            }
            if (seenChanged) {
              logDbg('[chats] 🕒 轮询检测到对方登录/下线/心跳时间变化, 需要刷新资料');
              needRefresh = true;
            }
          }
        }

        // 【合并刷新】消息变化与资料变化在同一轮里只触发一次整表重拉。
        // 旧实现两处各自 await fetchConversations()，10 秒内可能连打两次完整 RPC。
        if (needRefresh) {
          lastRefreshAtRef.current = Date.now();
          await fetchConversations();
          lastMessageAtMapRef.current = currentMap;
        }
      } catch (e) {
        console.error('[chats] 轮询失败:', e);
      }
    }, 10000); // 每10秒轮询一次
  };

  // 长按菜单
  const handleLongPress = useCallback((item: { id: string; peer: { nickname: string | null; username: string | null } }) => {
    const name = getDisplayName(item.peer.nickname, item.peer.username);
    Taro.showActionSheet({
      itemList: ['删除会话'],
      success: async (res) => {
        if (res.tapIndex === 0) {
          logDbg('[chats] 准备软删除会话（仅对本方隐藏）:', item.id, '对方:', name);
          Taro.showModal({
            title: '确认删除',
            content: `确定要删除与"${name}"的会话吗？\n仅从你的列表移除，对方仍会保留该会话；双方都删除后才会彻底清除数据。`,
            success: async (modalRes) => {
              if (modalRes.confirm) {
                try {
                  await deleteConversation(item.id);
                  logDbg('[chats] ✅ 会话已软删除（仅对本方隐藏，对方列表不受影响）:', item.id);
                  bumpGuard(genRef.current); // 删除会话视为用户操作，重置 120 秒起点
                  Taro.showToast({ title: '已删除', icon: 'success', duration: 1500 });
                } catch (e) {
                  console.error('[chats] ❌ 删除会话异常:', e);
                  Taro.showToast({ title: (e as Error).message || '删除失败', icon: 'none', duration: 3000 });
                }
              }
            },
          });
        }
      },
      fail: (err) => {
        // 用户取消选择或点击遮罩层，静默处理
        if (err.errMsg?.includes('cancel')) {
          logDbg('[chats] 用户取消长按菜单');
        }
      },
    });
    logDbg('[chats] 🏷️ 长按菜单打开, 视为用户操作, 重置 120 秒起点');
    bumpGuard(genRef.current);
  }, [deleteConversation]);

  const handleOpenChat = useCallback((item: { id: string; peer: { id: string; nickname: string | null; username: string | null } }) => {
    const peerName = encodeURIComponent(getDisplayName(item.peer.nickname, item.peer.username));
    Taro.navigateTo({
      url: '/pages/chat/index?conversationId=' + item.id + '&peerId=' + item.peer.id + '&peerName=' + peerName,
    });
  }, []);

  usePullDownRefresh(async () => {
    // 下拉刷新是用户主动操作，必须拿到「此刻之后」的数据：传 force=true 跳过在途请求复用，
    // 否则可能复用一份「下拉之前发起」的旧结果，用户会以为下拉没生效。
    logDbg('[chats] 🔄 下拉刷新：强制重新拉取会话列表');
    await fetchConversations(true);
    Taro.stopPullDownRefresh();
    logDbg('[chats] 🔄 下拉刷新完成, 视为用户操作, 重置 120 秒起点');
    bumpGuard(genRef.current);
  });

  // 渲染门禁放宽：auth 未就绪不再整页挡「加载中」——
  // 有缓存快照（conversations.length>0）直接渲染列表，后台静默刷新；
  // 无缓存且首次请求在途时才显示加载态。
  // ⚠️ 这里必须用 isAuthReady()：过渡态（bootstrapped）的 user 是本地缓存拼的，
  //    此时 loaded=false，若按 `authLoaded && !user` 判定会漏掉「过渡态但无 user」，
  //    也会在过渡态误判为已登录。isAuthReady 同时覆盖「真值已到」与「确实未登录」。
  if (isAuthReady() && !user) {
    redirectToLogin();
    return null;
  }

  if (!authLoaded) {
    if (conversations.length === 0) {
      return (
        <View className="min-h-screen bg-background flex items-center justify-center">
          <Text className="text-muted-foreground">加载中...</Text>
        </View>
      );
    }
    logDbg('[chats] ⚡ auth 未就绪但已有缓存快照，先渲染列表');
  } else if (!loaded && loading && conversations.length === 0) {
    return (
      <View className="min-h-screen bg-background flex items-center justify-center">
        <Text className="text-muted-foreground">加载中...</Text>
      </View>
    );
  }

  // 联系人候选：排除自己 + 按显示名/用户名实时过滤。纯派生值，无 Hook 调用，
  // 放在渲染门禁之后也不会破坏 Hooks 顺序。
  const pickerKeywordLower = pickerKeyword.trim().toLowerCase();
  const contactList = (contactProfiles ?? []).filter(
    (p) =>
      p.id !== user?.id &&
      (!pickerKeywordLower ||
        getDisplayName(p.nickname, p.username).toLowerCase().includes(pickerKeywordLower) ||
        (p.username ?? '').toLowerCase().includes(pickerKeywordLower)),
  );

  /** 打开选人弹层：先弹再拉数据，避免网络慢时「点了没反应」 */
  const handleStartChat = async () => {
    bumpGuard(genRef.current);
    setPickerKeyword('');
    setPickerOpen(true);
    setPickerLoading(true);
    try {
      await fetchProfiles();
    } finally {
      setPickerLoading(false);
    }
  };

  const closePicker = () => {
    setPickerOpen(false);
    bumpGuard(genRef.current);
  };

  /** 选中某个联系人 → 建（或复用）会话 → 跳聊天页 */
  const handlePickPeer = async (peer: Profile) => {
    if (pickerBusy) return;
    setPickerBusy(true);
    bumpGuard(genRef.current);
    try {
      Taro.showLoading({ title: '创建会话', mask: true });
      const convId = await startChat(peer.id);
      Taro.hideLoading();
      setPickerOpen(false);
      Taro.navigateTo({
        url: '/pages/chat/index?conversationId=' + convId + '&peerId=' + peer.id + '&peerName=' + encodeURIComponent(getDisplayName(peer.nickname, peer.username)),
      });
    } catch (e) {
      Taro.hideLoading();
      Taro.showToast({ title: (e as Error).message || '创建会话失败', icon: 'none' });
    } finally {
      setPickerBusy(false);
    }
  };

  return (
    <ErrorBoundary route="pages/chats/index">
    <PrivacyShield>
    <View className="min-h-screen bg-background">
      {/* 调试信息:计时器状态改由 [chats]/[page-guard] 日志观测，不再渲染状态条 */}
      <View className="flex flex-row items-center justify-between px-4 py-3 bg-card border-b border-border" style={{ paddingTop: `${statusBarHeight + 12}px`, paddingRight: `${capsuleRightPadding}px` }}>
        <View onClick={handleHiddenClick} className="cursor-pointer">
          <Text className="text-xl font-bold text-foreground">网络查看</Text>
        </View>
        {/* +号按胶囊实际位置动态避让，永远落在胶囊左侧可点区 */}
        <View
          onClick={() => {
            logDbg('[chats] 点击发起聊天按钮(+号, 已避开胶囊区)');
            handleStartChat();
          }}
          className="active:opacity-60 px-4 py-1"
        >
          <View className="i-lucide-message-circle-plus w-6 h-6 text-primary" />
        </View>
      </View>

      {loadError && conversations.length === 0 ? (
        <View className="flex flex-col items-center justify-center py-20">
          <View className="i-lucide-wifi-off w-16 h-16 text-muted-foreground" />
          <Text className="text-muted-foreground mt-4">列表加载失败，请检查网络</Text>
          <View
            onClick={() => {
              logDbg('[chats] 点击重试加载会话列表（强制刷新）');
              fetchConversations(true);
            }}
            className="active:opacity-60 mt-5 px-5 py-2 rounded-full bg-secondary"
          >
            <Text className="text-primary text-sm leading-none">点击重试</Text>
          </View>
        </View>
      ) : conversations.length === 0 ? (
        <View className="flex flex-col items-center justify-center py-20">
          <View className="i-lucide-message-square w-16 h-16 text-muted-foreground" />
          <Text className="text-muted-foreground mt-4">还没有记录，点右上角 + 新建一条</Text>
        </View>
      ) : (
        <View>
          {conversations.map((item) => {
            const peerId = item.user1_id === user?.id ? item.user2_id : item.user1_id;
            // 优先接口 peer，回退全局资料 store（改资料后 store 最新；快照缺 peer 时也能出图）
            const storePeer = profileById[peerId];
            const peer = item.peer || storePeer;
            const name = getDisplayName(peer?.nickname ?? null, peer?.username ?? null);
            const initial = name.charAt(0);
            // 若接口 peer 无头像但 store 有更新值，取 store 的
            const avatarUrl = ((storePeer?.avatar_url) || (peer?.avatar_url)) && !avatarErrorIds.has(peerId)
              ? (storePeer?.avatar_url || peer?.avatar_url)
              : '';
            return (
              <View
                key={item.id}
                className="relative"
                onLongPress={() => handleLongPress(item)}
              >
                {/* 会话内容。轻提示态给整行加一层极淡的绿色底（inline rgba，小程序下
                    透明度类名会丢，必须走 style），几秒后自动褪去，不遮挡任何可点区域。 */}
                <View
                  className="flex items-center gap-3 px-4 py-3 bg-card border-b border-border"
                  style={justOnlineIds.has(peerId) ? { backgroundColor: 'rgba(34, 197, 94, 0.08)' } : undefined}
                  onClick={() => handleOpenChat(item)}
                >
                  {/* 外层不裁剪、仅做定位；头像单独放一个 overflow-hidden 圆容器（避免角标被圆形裁剪切掉） */}
                  <View className="relative w-12 h-12 shrink-0">
                    <View className="w-12 h-12 rounded-full bg-secondary overflow-hidden">
                      {avatarUrl ? (
                        <Image
                          src={avatarUrl}
                          className="w-12 h-12"
                          mode="aspectFill"
                          style={{ display: 'block', width: '100%', height: '100%' }}
                          onError={() => setAvatarErrorIds((prev) => (prev.has(peerId) ? prev : new Set(prev).add(peerId)))}
                        />
                      ) : (
                        <View className="w-12 h-12 flex items-center justify-center">
                          <Text className="text-secondary-foreground text-lg font-medium">{initial}</Text>
                        </View>
                      )}
                    </View>
                    {/* 未读消息角标：头像内部右下角的红色数字徽章。
                        unread_count 现仅在「确实有未读」时存在，无未读时该节点完全不渲染。
                        ⚠️ 数字必须封顶显示 99+：三位数会把徽章撑得很宽、压住头像，
                           而「99+」已经足够表达「很多未读」这个信息。
                        ⚠️ 尺寸用 min-w + px 而非固定 w：1 位数时是正圆，2-3 位数时自动
                           横向撑开成胶囊形，不会把数字挤成两行。
                        ⚠️ 必须 inline backgroundColor：小程序下 bg-red-500 这类类名
                           在部分基础库会丢色（项目统一约定透明度/色值走 inline style）。
                        ⚠️ 数字用 leading-none + 居中：H5 端 flex 容器内 Text 行高撑开
                           会把数字折成两行溢出圆角块。 */}
                    {(item.unread_count ?? 0) > 0 && (
                      <View
                        className="absolute bottom-0 right-0 rounded-full flex items-center justify-center px-1"
                        style={{ backgroundColor: '#ef4444', minWidth: '18px', height: '18px' }}
                      >
                        <Text className="text-white leading-none" style={{ fontSize: '10px' }}>
                          {(item.unread_count ?? 0) > 99 ? '99+' : item.unread_count}
                        </Text>
                      </View>
                    )}
                    {/* 在场状态角标（三态）：在线=绿点、不在当前=灰点、离线=无点。
                        老账号无在场记录时回退旧的心跳超时判定（仅亮绿点），不给老数据编造灰点。
                        onlineTick 参与运算：让页面可见期间每 30 秒自动重算一次超时收敛。 */}
                    {(() => {
                      void onlineTick;
                      const ps = resolvePresence(
                        storePeer?.presence_state ?? peer?.presence_state,
                        storePeer?.presence_at ?? peer?.presence_at,
                        storePeer?.last_active_at ?? peer?.last_active_at,
                        storePeer?.hide_presence ?? peer?.hide_presence,
                      );
                      // 功能⑦：对方主动隐藏 → 不渲染任何角标（任何颜色的点都不给，否则等于泄露）
                      if (ps === 'hidden') return null;
                      // 配色统一走 presenceDotColor（三态真源）：在线=亮绿、不在当前=琥珀、离线=中灰。
                      // ⚠️ 离线现在**也画点**（用户要求三态区分更明显）：旧版离线不画点，
                      //    与「老账号无数据」在视觉上无法区分，看起来像渲染缺失。
                      // 老账号无在场记录（ps=null）仍回退旧心跳判定，只可能亮绿点，不给老数据编造灰点。
                      const dotColor = ps
                        ? presenceDotColor(ps)
                        : isPeerOnline(
                            storePeer?.last_login_at ?? peer?.last_login_at,
                            storePeer?.last_logout_at ?? peer?.last_logout_at,
                            storePeer?.last_active_at ?? peer?.last_active_at,
                          )
                          ? PRESENCE_DOT_COLORS.online
                          : null;
                      return dotColor ? (
                        <View
                          className="absolute top-0 right-0 w-3 h-3 rounded-full"
                          style={{ backgroundColor: dotColor }}
                        />
                      ) : null;
                    })()}
                  </View>
                  <View className="flex-1 min-w-0">
                    <View className="flex items-center justify-between">
                      <View className="flex items-center gap-2 min-w-0">
                        <Text className="text-foreground font-medium block">{name}</Text>
                        {/* 需求：对方刚由离线变为在线时，名字旁挂一枚小标签（几秒后自动消失）。
                            放在名字右侧而非整行浮层——不遮挡摘要/时间，也不影响任何点击热区。 */}
                        {justOnlineIds.has(peerId) && (
                          <View className="px-2 py-1 rounded-full bg-secondary shrink-0">
                            <Text className="text-xs text-primary leading-none">刚刚上线</Text>
                          </View>
                        )}
                      </View>
                      <Text className="text-muted-foreground text-xs shrink-0 ml-2">
                        {formatTime(item.last_message_at)}
                      </Text>
                    </View>
                    {/* 摘要行：图片消息左侧带一枚小缩略图（加载失败/撤回则不画，退回纯文案）。
                        flex + min-w-0 保证文案仍可 truncate，不被缩略图挤爆。 */}
                    {(() => {
                      const thumbUrl = getSummaryThumbUrl(item);
                      const showThumb = !!thumbUrl && !thumbErrorIds.has(item.id);
                      return (
                        <View className="flex items-center gap-2 mt-1">
                          {showThumb && (
                            <View className="w-8 h-8 rounded bg-secondary overflow-hidden shrink-0">
                              <Image
                                src={thumbUrl}
                                className="w-8 h-8"
                                mode="aspectFill"
                                style={{ display: 'block', width: '100%', height: '100%' }}
                                onError={() =>
                                  setThumbErrorIds((prev) => (prev.has(item.id) ? prev : new Set(prev).add(item.id)))
                                }
                              />
                            </View>
                          )}
                          <Text className="text-muted-foreground text-sm truncate block flex-1 min-w-0 leading-none">
                            {item.last_message_revoked ? '[撤回了一条消息]' : summarizeLastMessage(item)}
                          </Text>
                        </View>
                      );
                    })()}
                    {/* 对方在场状态文案（三态）：在线→「在线」；不在当前/离线→「{状态} · {痕迹时间}」；
                        老账号无在场记录时回退旧 formatLastSeen，全空则不占行。onlineTick 驱动超时收敛。 */}
                    {(() => {
                      void onlineTick;
                      const ps = resolvePresence(
                        storePeer?.presence_state ?? peer?.presence_state,
                        storePeer?.presence_at ?? peer?.presence_at,
                        storePeer?.last_active_at ?? peer?.last_active_at,
                        storePeer?.hide_presence ?? peer?.hide_presence,
                      );
                      // 功能⑦：隐藏态必须**单独短路**，绝不能落到下面的 formatLastSeen——
                      // 那会把登录/心跳时间又算出来，等于绕开隐私设置暴露了活跃情况。
                      if (ps === 'hidden') {
                        return (
                          <Text className="text-muted-foreground text-xs truncate block mt-1">
                            {formatPresenceLabel('hidden')}
                          </Text>
                        );
                      }
                      if (!ps) {
                        const seen = formatLastSeen(
                          storePeer?.last_login_at ?? peer?.last_login_at,
                          storePeer?.last_logout_at ?? peer?.last_logout_at,
                          storePeer?.last_active_at ?? peer?.last_active_at,
                        );
                        return seen ? (
                          <Text className="text-muted-foreground text-xs truncate block mt-1">{seen}</Text>
                        ) : null;
                      }
                      const label = formatPresenceLabel(ps);
                      if (ps === 'online') {
                        return (
                          <Text className="text-muted-foreground text-xs truncate block mt-1">{label}</Text>
                        );
                      }
                      // ⚠️ 缺陷③：四个痕迹**取最新值**（谁最新显示谁），顺序不再代表优先级。
                      // 旧版按优先级取第一个，presence_at 卡在陈旧退场时刻时会压过持续刷新的心跳。
                      const since = formatPresenceSince(ps, [
                        storePeer?.presence_at ?? peer?.presence_at,
                        storePeer?.last_logout_at ?? peer?.last_logout_at,
                        storePeer?.last_active_at ?? peer?.last_active_at,
                        storePeer?.last_login_at ?? peer?.last_login_at,
                      ]);
                      return (
                        <Text className="text-muted-foreground text-xs truncate block mt-1">
                          {since ? `${label} · ${since}` : label}
                        </Text>
                      );
                    })()}
                    {/* 登录统计行（三分支，与 chat 详情页同口径）：
                        ① 对方当前在场为「在线」→ 只显示「已在线」，隐藏窗口次数；
                        ② 否则窗口内 count>0 → 「你离开期间登录 N 次 · 最后 …」；
                        ③ count=0 → 不占行。 */}
                    {(() => {
                      void onlineTick;
                      const ps = resolvePresence(
                        storePeer?.presence_state ?? peer?.presence_state,
                        storePeer?.presence_at ?? peer?.presence_at,
                        storePeer?.last_active_at ?? peer?.last_active_at,
                        storePeer?.hide_presence ?? peer?.hide_presence,
                      );
                      // 功能⑦：隐藏者不暴露「已在线」这类活跃结论，整行不渲染
                      if (ps === 'hidden') return null;
                      const online = ps
                        ? ps === 'online'
                        : isPeerOnline(
                            storePeer?.last_login_at ?? peer?.last_login_at,
                            storePeer?.last_logout_at ?? peer?.last_logout_at,
                            storePeer?.last_active_at ?? peer?.last_active_at,
                          );
                      if (online) {
                        return (
                          <Text className="text-muted-foreground text-xs truncate block mt-1">已在线</Text>
                        );
                      }
                      const st = loginStatsMap.get(peerId);
                      if (!st || st.count <= 0) return null;
                      const lastAt = st.lastLoggedAt;
                      return (
                        <Text className="text-muted-foreground text-xs truncate block mt-1">
                          {`你离开期间登录 ${st.count} 次${lastAt ? ` · 最后 ${formatLoginDetailTime(lastAt)}` : ''}`}
                        </Text>
                      );
                    })()}
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* 选择联系人弹层：替代 Taro.showActionSheet（itemList 上限 6 项，用户数一多整个弹层直接 fail）。
          自定义列表可滚动、可搜索，无数量上限；遮罩与卡片是兄弟节点，父层统一处理点击关闭。 */}
      {pickerOpen && (
        <View
          className="fixed inset-0 z-50"
          style={{
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            padding: '0 24px',
            backgroundColor: 'rgba(0,0,0,0.5)',
          }}
          onClick={closePicker}
        >
          {/* 居中卡片而非底部抽屉：chats 是 tabBar 页，原生 tabBar 层级高于页面内容，
              底部抽屉会被它盖住一截；居中卡片完全避开。 */}
          <View
            className="w-full bg-card rounded-xl flex flex-col"
            style={{ maxHeight: '70vh' }}
            onClick={(e) => {
              e.stopPropagation();
              bumpGuard(genRef.current);
            }}
          >
            <View className="flex items-center justify-between px-4 py-3 border-b border-border">
              <Text className="text-foreground font-medium">选择联系人</Text>
              <View className="active:opacity-60 px-2" onClick={closePicker}>
                <Text className="text-muted-foreground text-sm">取消</Text>
              </View>
            </View>

            <View className="px-4 py-2">
              <Input
                className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm"
                value={pickerKeyword}
                onInput={(e) => setPickerKeyword(e.detail.value)}
                placeholder="搜索用户名 / 昵称"
                placeholderClass="text-muted-foreground"
                adjustPosition={false}
              />
            </View>

            <ScrollView scrollY className="flex-1" style={{ maxHeight: '52vh' }}>
              {contactList.length === 0 ? (
                <View className="flex items-center justify-center py-12">
                  <Text className="text-muted-foreground text-sm">
                    {pickerLoading
                      ? '正在加载联系人…'
                      : pickerKeywordLower
                        ? '没有匹配的用户'
                        : '暂无其他用户'}
                  </Text>
                </View>
              ) : (
                contactList.map((p) => {
                  const name = getDisplayName(p.nickname, p.username);
                  return (
                    <View
                      key={p.id}
                      className="flex items-center gap-3 px-4 py-3 border-b border-border active:opacity-60"
                      onClick={() => handlePickPeer(p)}
                    >
                      <View className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center">
                        <Text className="text-secondary-foreground text-base">{name.charAt(0)}</Text>
                      </View>
                      <View className="flex-1 min-w-0">
                        <Text className="text-foreground block truncate">{name}</Text>
                        {p.username ? (
                          <Text className="text-muted-foreground text-xs block truncate">@{p.username}</Text>
                        ) : null}
                      </View>
                    </View>
                  );
                })
              )}
            </ScrollView>
          </View>
        </View>
      )}
    </View>
    </PrivacyShield>
    </ErrorBoundary>
  );
};

export default ChatsPage;
