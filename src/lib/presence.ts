import type { PresenceState } from '@/api/profiles';
import { reportPresenceState } from '@/api/profiles';
import { useAuthStore } from '@/store/auth-store';
import { useProfilesStore } from '@/store/profiles-store';
import { enqueuePresence, flushPresenceQueue } from '@/lib/presence-queue';
import { logDbg } from './logger';

/**
 * 页面级「在场状态」三态真源。
 *
 * 用户明确要求的语义：
 * - **在线 online**：停留在聊天页 / 会话列表页 / 我的页（人在聊天区里）。
 * - **不在当前 away**：切入微信后台，或从上述三页导航离开（didHide 但未退回 ping 页）。
 * - **离线 offline**：退回 ping 页（离开整个聊天区）。展示文案为「离线」（用户要求，不用「不在线」）。
 *
 * 为什么不能沿用旧的心跳超时推断：切后台和退 ping 页在旧模型里都只是「停止写心跳」，
 * 信号完全相同，物理上无法区分——所以必须让客户端在**确定的生命周期点**显式上报枚举值。
 *
 * ⚠️ 类型与落库函数都在 `api/profiles.ts`：本模块若被 api 层反向 import 会形成循环依赖
 *    （presence → auth-store → api/auth → lib/presence），故共享契约一律下沉到 api 层。
 */
export type { PresenceState };

/**
 * 展示端解析结果：三态 + 「对方主动隐藏」第四值 + null（无可信数据，回退旧文案）。
 * 'hidden' 是功能⑦引入的独立终值——它不是「推断不出」，而是「对方明确选择不暴露」，
 * 必须与 null 区分开（null 走旧的心跳口径，hidden 走「已隐藏在线状态」文案）。
 */
export type ResolvedPresence = PresenceState | 'hidden' | null;

/**
 * 「在线」的超时兜底：杀进程 / 微信被系统回收时 JS 代码根本不执行，任何显式上报都发不出去。
 * presence_at 只在页面生命周期点写入，用户**停留在页面内持续活动**（读消息、发消息）时
 * 不会刷新——单看它会在 3 分钟后把真在线的人误判成「不在当前」（用户实测报过）。
 * 因此保活信号取 max(presence_at, last_active_at)：前台心跳每 45 秒写 last_active_at，
 * 切后台时两者同时停摆，约一个心跳周期 + 缓冲后自然过期，不破坏「切后台=不在当前」语义。
 */
export const PRESENCE_ONLINE_STALE_MS = 180_000;

/**
 * 「不在当前」的有效期：away 只在**短时间内**成立（刚切后台、刚离开聊天页）。
 * 超过这个窗口仍没有任何新痕迹（presence_at 与心跳双双停摆）→ 说明人已彻底走了，
 * 必须收敛为「不在线」。⚠️ 不能像旧版那样让 away 永久直出——用户实测报过
 * 「一天都不在还显示不在当前」，就是因为 away 分支没有任何时效判定。
 */
export const PRESENCE_AWAY_MAX_MS = 30 * 60_000;

/**
 * 「不在线」的时效上限：offline 是退场出口写入的强信号，但展示端不能永久信任——
 * 对方之后重新登录活跃时，若仍显示旧 offline 会一直卡在「不在线」。
 * 超过该时长且无任何更新痕迹 → 不再采信 offline（返回 null，调用方回退旧文案）。
 */
export const PRESENCE_OFFLINE_MAX_MS = 24 * 3600_000;

/**
 * 时钟偏差容忍窗口（缺陷①）：手机时间比服务器/本机快几分钟是很常见的
 * （手动改过系统时间、时区异常、NTP 漂移）。旧版对 `presence_at > now` 一律丢弃，
 * 结果是这类账号的状态**永远**解析成 null——对方看到的不是「他的真实状态」，
 * 而是回退的旧文案，且无论他多活跃都不会恢复（用户报过状态一直不对）。
 * 现在容忍窗口内的未来时间照常采信，计算时把时刻钳到 now（等价于「刚刚发生」）；
 * 只有超出窗口的离谱值才当作脏数据丢弃。
 */
export const PRESENCE_CLOCK_SLACK_MS = 5 * 60_000;

/**
 * 把一个可能带时钟偏差的时间戳归一化成可信的 ms 值。
 * @returns 有效时刻（ms，已被钳制到不超过 now）；非法或超容忍窗口的未来值返回 null
 */
function normalizeTs(raw: string | null | undefined, now: number): number | null {
  if (!raw) return null;
  const t = new Date(raw).getTime();
  if (Number.isNaN(t)) return null;
  // 未来值：在容忍窗口内视为「刚刚」，钳到 now；超出则判定为脏数据
  if (t > now) return t - now <= PRESENCE_CLOCK_SLACK_MS ? now : null;
  return t;
}

/** 同一状态的重复上报抑制窗口：防 didShow 抖动 / 多出口连点打爆请求 */
const DEDUPE_MS = 10_000;

let lastReportedState: PresenceState | null = null;
let lastReportedAt = 0;

/**
 * 读取本人 hide_presence（功能⑦写入侧门控）。
 * 走 profiles-store 的内存 map（同步 hydrate 本地缓存），**不打网络**——生命周期点
 * （didHide / reLaunch 前）必须同步判定，不能等异步请求。
 * 读不到资料行时按「未隐藏」处理，保持与历史行为一致。
 */
function selfHidesPresence(): boolean {
  const uid = useAuthStore.getState().user?.id;
  if (!uid) return false;
  return !!useProfilesStore.getState().byId[uid]?.hide_presence;
}

/**
 * 上报本人当前在场状态。
 *
 * ⚠️ 门控 `!!user && !bootstrapped`：auth 冷启动的「过渡 user」没有 access token，
 * PostgREST 会把请求当匿名挡掉（RLS 只返回 0 行、不报错）——与心跳链路同款陷阱。
 * ⚠️ 必须在 `Taro.reLaunch` 之前调用：页面销毁后请求可能被中断。
 *
 * 缺陷②修复：旧版 fire-and-forget + 静默失败，一旦 offline 那一刻网络差就永远丢失，
 * 库里停在 online/away，展示端要等 `PRESENCE_AWAY_MAX_MS`(30 分钟) 才收敛成「不在线」。
 * 现在把落库结果接住：失败的 offline 进本地待补发队列，由 flushPendingPresence 补发。
 */
export function reportPresence(state: PresenceState): void {
  const st = useAuthStore.getState();
  const uid = st.user?.id;
  if (!uid || st.bootstrapped) {
    // ⚠️ 关键修复：过渡态（bootstrapped）没有 access token，此刻发请求必被 RLS 当匿名挡掉，
    // 所以不能直接发——但也**绝不能直接丢弃**。旧版就是直接 return，导致
    // 「冷启动后第一次 didShow 的 online 上报」永久丢失：库里 presence_state 停在
    // 上一次退场写的 offline，展示端于是永远显示「不在线」（用户报的根因之一）。
    // 现在改为入队，等 auth 真值到达后由 flushPendingPresence 补发。
    // ⚠️ 队列按账号隔离（读 chat_last_uid_v1），过渡态下该标记已由 auth-store 回写，
    //    故这里能正确归属；若标记缺失则 enqueuePresence 内部会拒绝入队（返回 false）。
    const queued = enqueuePresence(state, new Date().toISOString());
    logDbg(
      `[presence] ⏳ 未就绪(user=${!!uid} bootstrapped=${st.bootstrapped})，${state} ${queued ? '已入队待补发' : '入队失败(无账号标记)'}`,
    );
    return;
  }
  // 功能⑦：本人选择隐藏在场状态 → 不再向云端上报任何状态。
  // ⚠️ offline 也要拦，否则隐藏者离开时仍会写一条「不在线」，等于泄露了活跃轨迹。
  if (selfHidesPresence()) {
    logDbg(`[presence] 🙈 本人已开启隐藏在线状态，跳过上报 ${state}`);
    return;
  }
  const now = Date.now();
  // offline 是终态、必须保证送达，不参与抑制；online/away 抖动才去重。
  if (state !== 'offline' && lastReportedState === state && now - lastReportedAt < DEDUPE_MS) {
    logDbg(`[presence] ⏭ 同状态 ${state} 在 ${DEDUPE_MS / 1000}s 内已上报，抑制重复`);
    return;
  }
  lastReportedState = state;
  lastReportedAt = now;
  const stamp = new Date(now).toISOString();
  logDbg(`[presence] 📡 上报在场状态: ${state} @${new Date(now).toLocaleTimeString()}`);
  void reportPresenceState(uid, state, stamp).then((ok) => {
    if (ok) return;
    // 只有终态入队（见 presence-queue 文件头说明）；online/away 交给超时推断自愈
    enqueuePresence(state, stamp);
  });
}

/**
 * 补发此前未送达的在场状态（缺陷②出口）。
 * 触发时机：App 启动、从后台回到前台、进入聊天区任一页面。
 * 全程静默，失败保留条目等下次触发。
 */
export async function flushPendingPresence(): Promise<void> {
  const st = useAuthStore.getState();
  const uid = st.user?.id;
  if (!uid || st.bootstrapped) return;
  await flushPresenceQueue(async (item) => {
    if (selfHidesPresence()) {
      logDbg('[presence] 🙈 本人已隐藏在场状态，丢弃待补发条目');
      return true; // 返回 true 让队列把这条清掉，避免开关打开后陈旧条目反复堆积
    }
    return reportPresenceState(uid, item.state, item.stamp);
  });
}

/**
 * 解析对方的在场状态（展示端唯一入口，禁止各处再自写判定）。
 *
 * @param state  presence_state 列原值
 * @param at     presence_at 列原值
 * @param activeAt last_active_at 心跳列——**页面内活动保活信号**。用户停留在聊天页里
 *        读消息、发消息时 presence_at 不会刷新（只在生命周期点写入），单看它会把
 *        真在线的人误判成「不在当前」（用户实测报过）。前台心跳每 45s 写 activeAt，
 *        切后台/杀进程时两者同时停摆自然过期，语义仍自洽。
 * @param hidden 对方 hide_presence 列——功能⑦：为真表示对方主动隐藏在场状态，
 *        此时**不做任何推断**直接返回 'hidden'（调用方显示「对方已隐藏在线状态」）。
 *        ⚠️ 必须在时钟/时效判定之前拦截，否则隐藏者仍会因心跳被推断成在线。
 * @returns 三态之一或 'hidden'；历史账号两列为空 / 时间无效 / offline 陈旧无新痕迹时返回 null
 *          （调用方据此回退旧文案，不给老数据编造状态）。
 */
export function resolvePresence(
  state?: string | null,
  at?: string | null,
  activeAt?: string | null,
  hidden?: boolean | null,
): ResolvedPresence {
  if (hidden) return 'hidden';
  if (!state || !at) return null;
  const now = Date.now();
  // 缺陷①：未来时间不再一刀切丢弃——容忍窗口内钳到 now，超出才当脏数据
  const ts = normalizeTs(at, now);
  if (ts === null) return null;
  const actTs = normalizeTs(activeAt, now);
  const keepAliveTs = actTs === null ? ts : Math.max(ts, actTs);
  // 保活时刻距今：三态共用的唯一分档依据
  const staleMs = now - keepAliveTs;

  const mins = Math.floor(staleMs / 60_000);
  let resolved: PresenceState | null;
  if (state === 'offline') {
    // ⚠️ 关键修复（用户报「好友都发消息了状态还是不在线」的根因）：
    // offline 必须与 away 一样允许被**心跳保活推翻**。旧版这里直接 `resolved = 'offline'`，
    // 于是只要库里 presence_state 卡在 offline，无论对方多活跃都永远显示「不在线」。
    // 卡住的成因很常见：对方退回 ping 页写了 offline，之后重新进入聊天区时
    // reportPresence('online') 恰好撞上 auth 过渡态被门控丢弃（见 reportPresence），
    // 库里就再也没人把 offline 改回来——而心跳每 45s 仍在写 last_active_at。
    // 判据：保活时刻比 offline 上报时刻更新（keepAliveTs > ts）且足够新鲜 → 人已回来。
    if (keepAliveTs > ts && staleMs < PRESENCE_ONLINE_STALE_MS) resolved = 'online';
    // offline 也不能永久采信：对方重新登录后必然写心跳/重新上报，若 offline 已超上限
    // 且期间无任何更新痕迹 → 不再显示「不在线」（否则 120s 超时跳 ping 的旧标记会卡死展示）
    else resolved = staleMs > PRESENCE_OFFLINE_MAX_MS ? null : 'offline';
  } else if (state === 'away') {
    // away 允许被心跳保活推翻：切后台后若又在前台活动（心跳在写）→ 视为回到页面
    if (keepAliveTs > ts && staleMs < PRESENCE_ONLINE_STALE_MS) resolved = 'online';
    // ⚠️ 关键修复：away 不是永久状态。「不在当前」只表示人刚离开聊天区（切后台/换页），
    // 超过有效期仍毫无痕迹 → 人已彻底走了，必须收敛为「不在线」。
    // 旧版这里直接 return 'away'，导致一天不打开小程序也永远显示「不在当前」。
    else resolved = staleMs < PRESENCE_AWAY_MAX_MS ? 'away' : 'offline';
  } else if (state === 'online') {
    // 杀进程兜底：声称在线但保活信号早已停止刷新 → 先降级「不在当前」，再超时 → 「不在线」
    if (staleMs < PRESENCE_ONLINE_STALE_MS) resolved = 'online';
    else resolved = staleMs < PRESENCE_AWAY_MAX_MS ? 'away' : 'offline';
  } else {
    resolved = null;
  }
  logDbg(
    `[presence] 🔍 解析 ${state}(痕迹距今 ${mins} 分, 保活距今 ${Math.floor(staleMs / 1000)}s) → ${resolved ?? 'null(回退旧文案)'}`,
  );
  return resolved;
}

/**
 * 状态标签文案（圆点的文字对应物）。
 * 入参是**解析结果** ResolvedPresence，功能⑦的 'hidden' 在此给出独立文案，
 * 调用方无需再自写分支判断隐藏态。null 返回空串（由调用方回退旧文案）。
 *
 * ⚠️ 文案口径（用户明确要求）：offline 显示「离线」而非「不在线」——
 * 「不在线」是双重否定，读起来绕；「离线」是微信/QQ 等主流 IM 的通用说法，一眼就懂。
 * 三态文案最终为：在线 / 不在当前 / 离线 / 已隐藏在线状态。
 * 改文案只需改这一处（两页六个展示点全部经此函数取标签，禁止在页面里硬编码）。
 */
export function formatPresenceLabel(state: ResolvedPresence): string {
  if (state === 'online') return '在线';
  if (state === 'away') return '不在当前';
  if (state === 'offline') return '离线';
  if (state === 'hidden') return '已隐藏在线状态';
  return '';
}

/**
 * 三态圆点配色真源（用户要求「让三态区分更明显」）。
 *
 * 设计取舍：三态必须**一眼可辨**，所以不能只靠「有/无」和深浅差异——
 * - **在线 online**：亮绿 `#22c55e`（沿用，主流 IM 的「在线」色，语义已建立）。
 * - **不在当前 away**：琥珀 `#f59e0b`。旧版用灰 `#9ca3af`，与「无点」的离线态
 *   在视觉上几乎同族（都是灰调），用户反馈区分不明显；琥珀是暖色，与绿/灰都拉开色相。
 * - **离线 offline**：中灰 `#9ca3af`。⚠️ 用户明确要求**离线也要有点**——
 *   旧版离线不画点，导致「离线」和「老账号无数据」在视觉上无法区分，
 *   且列表里同一列有的有点、有的没点，看起来像渲染缺失。现在三态恒有点，
 *   靠颜色区分；「无点」只保留给 hidden（对方主动隐藏，不能暴露任何活跃痕迹）。
 * - **hidden**：不画点（返回 null），由调用方短路成「已隐藏在线状态」文案。
 *
 * ⚠️ 两页（chat 顶栏 / chats 列表）必须都从这里取色，禁止再各自硬编码十六进制，
 *    否则改一次配色要改两处、极易漏改导致两页口径不一致。
 */
export const PRESENCE_DOT_COLORS: Record<PresenceState, string> = {
  online: '#22c55e',
  away: '#f59e0b',
  offline: '#9ca3af',
};

/**
 * 取三态圆点颜色。hidden / null 返回 null（调用方不画点）。
 * @param state 已解析出的在场状态
 */
export function presenceDotColor(state: ResolvedPresence): string | null {
  if (state === 'online' || state === 'away' || state === 'offline') {
    return PRESENCE_DOT_COLORS[state];
  }
  return null;
}

/** 「正在输入…」文案（功能⑥，与在场状态共用展示位） */
export const TYPING_LABEL = '正在输入…';

/**
 * 非在线两档（不在当前 / 离线）的副说明文案：**统一显示绝对时刻**
 * `最后活跃 MM-DD HH:mm:ss`（用户明确要求 away 与 offline 口径一致，不再用「10分钟前」这类相对时间）。
 *
 * ⚠️ 缺陷③（用户两次报「最后活跃时间还是不对」的根因，勿再改回优先级语义）：
 * 旧版按「可信度优先级」取第一个有效痕迹（在场写入 > 主动下线 > 前台心跳 > 登录），
 * 而调用方把 `presence_at` 排在第一位——当 `presence_state` 卡在 offline 时，
 * `presence_at` 就是那条**陈旧的退场时刻**，于是即使对方心跳每 45 秒一直在刷
 * `last_active_at`，文案也永远停在旧时间（「档位内取最新值」的中间版本同样无效：
 * 每个档位只有一个元素，取 max 等于取它自己）。
 *
 * 现在改为**跨痕迹取最新值**：四个痕迹里谁最新就显示谁。语义上「最后活跃」本来就该是
 * 「最近一次留下痕迹的时刻」，取 max 才是它的字面含义；`last_login_at` 偏乐观的问题
 * 由调用方兜底——它只在其余痕迹全空（老账号）时才可能成为唯一候选。
 *
 * @param state 已解析出的在场状态
 * @param traces 候选痕迹时间戳（调用方顺序 [presence_at, last_logout_at, last_active_at, last_login_at]，
 *        顺序不再影响结果，仅用于日志标注来源）
 * @returns online / hidden 返回空串；全空（老账号无痕迹）也返回空串，调用方只显示状态标签
 */
export function formatPresenceSince(
  state: ResolvedPresence,
  traces: Array<string | null | undefined>,
): string {
  if (state === 'online' || state === 'hidden') return '';
  const now = Date.now();
  const names = ['在场写入', '主动下线', '前台心跳', '登录'];
  let best: number | null = null;
  let bestIdx = -1;
  for (let i = 0; i < traces.length; i += 1) {
    const t = normalizeTs(traces[i], now);
    if (t !== null && (best === null || t > best)) {
      best = t;
      bestIdx = i;
    }
  }
  if (best === null) return '';
  const d = new Date(best);
  const pad = (n: number) => String(n).padStart(2, '0');
  const text = `最后活跃 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  logDbg(`[presence] 🕒 最后活跃取最新痕迹「${names[bestIdx] ?? bestIdx}」→ ${text}`);
  return text;
}
