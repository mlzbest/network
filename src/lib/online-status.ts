/**
 * 在线状态判定的唯一真源（会话列表页与聊天详情页共用，保证口径绝对一致）。
 * 数据基础：profiles 的 last_login_at / last_logout_at / last_active_at 三个可空时间戳。
 * 写入侧见 api/profiles.ts（recordLastLogin/recordLogout/recordHeartbeat）与
 * app.tsx 的 App 级心跳定时器（前台每 45 秒写一次 last_active_at）。
 */

/** 在线判定的统一口径：取「最近一次活跃信号」与当前时刻比。
 *  心跳周期 45 秒 + 微信定时器冻结的抖动余量 → 120 秒内视为在线；
 *  超过即判离线（对方切后台/杀进程后最迟约 2 分钟收敛为离线）。 */
export const ONLINE_WINDOW_MS = 120_000;

/**
 * 相对时间分级：1 分钟内→刚刚；<60 分钟→N分钟前；今天内→今天 HH:mm；昨天→昨天 HH:mm；
 * 7 天内→周X；更早→MM-DD（跨年带年份），与会话列表 formatTime 口径一致。
 */
export function relativeTime(dateStr: string): string {
  const d = new Date(dateStr);
  const min = Math.floor((Date.now() - d.getTime()) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const hm = `${h}:${m}`;
  const now = new Date();
  const dayDiff = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86400000,
  );
  if (dayDiff <= 0) return `今天 ${hm}`;
  if (dayDiff === 1) return `昨天 ${hm}`;
  if (dayDiff < 7) {
    const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return weekNames[d.getDay()];
  }
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() < now.getFullYear() ? `${d.getFullYear()}-${mm}-${dd}` : `${mm}-${dd}`;
}

/** 归一化三份资料时间戳：未来时间（时钟偏差/时区异常）一律丢弃，避免「-5分钟前」。 */
function normalizeSeen(
  loginAt?: string | null,
  logoutAt?: string | null,
  activeAt?: string | null,
): { login: string | null; logout: string | null; active: string | null } {
  const guard = (s?: string | null) => (s && Date.now() - new Date(s).getTime() >= 0 ? s : null);
  return { login: guard(loginAt), logout: guard(logoutAt), active: guard(activeAt) };
}

/**
 * 对方是否「当前在线」（绿点的唯一依据）。
 * 优先级：① 主动下线时间晚于登录与心跳 → 立即离线（最快路径）；
 * ② 有心跳 → 距今 <120 秒才算在线（切后台/杀进程靠超时推断）；
 * ③ 从未写过心跳的老数据 → 回退按登录时间同窗口判定，避免误亮。
 */
export function isPeerOnline(
  loginAt?: string | null,
  logoutAt?: string | null,
  activeAt?: string | null,
): boolean {
  const { login, logout, active } = normalizeSeen(loginAt, logoutAt, activeAt);
  const loginTs = login ? new Date(login).getTime() : 0;
  const activeTs = active ? new Date(active).getTime() : 0;
  if (logout) {
    const logoutTs = new Date(logout).getTime();
    if (logoutTs >= loginTs && logoutTs >= activeTs) return false;
  }
  const lastAlive = Math.max(loginTs, activeTs);
  if (!lastAlive) return false;
  return Date.now() - lastAlive < ONLINE_WINDOW_MS;
}

/**
 * 「最近在线/离线」文案。与绿点共用 isPeerOnline 口径，保证文字与标识不打架：
 * - 在线 → 「刚刚在线 / N分钟前在线」；
 * - 离线 → 取最近一次留下的痕迹（下线 > 心跳 > 登录）显示「离线 · X」；
 * - 三条时间全空 → 返回空串（调用方据此不渲染、不占位）。
 */
export function formatLastSeen(
  loginAt?: string | null,
  logoutAt?: string | null,
  activeAt?: string | null,
): string {
  const { login, logout, active } = normalizeSeen(loginAt, logoutAt, activeAt);
  if (isPeerOnline(login, logout, active)) {
    const rel = relativeTime(active ?? login!);
    return rel === '刚刚' ? '刚刚在线' : `${rel}在线`;
  }
  const stamps = [logout, active, login].filter(Boolean) as string[];
  if (stamps.length === 0) return '';
  const latest = stamps.reduce((a, b) => (new Date(a).getTime() >= new Date(b).getTime() ? a : b));
  return `离线 · ${relativeTime(latest)}`;
}

/**
 * 「本次已在线时长」文案（聊天详情页顶栏「已在线 · X」用）。
 *
 * ⚠️ 与 relativeTime 语义完全不同，不可互相替代：
 *   - relativeTime 回答「距今多久前」（时间点 → 现在）；
 *   - 本函数回答「已经持续了多久」（起点 → 现在）。
 * 起点取对方**本次进入在线状态时写入的 presence_at**（reportPresence('online') 落库的时刻），
 * 因此它天然就是「本次在线」的起点，不需要额外维护会话级状态。
 *
 * 输出分级（面向非技术用户，只给到分钟粒度，避免秒级数字跳动）：
 *   <1 分钟 → 「不到 1 分钟」；<60 分钟 → 「N 分钟」；≥60 分钟 → 「N 小时 M 分钟」（M=0 时省略）。
 * 空值 / 非法值 / 未来时间（时钟偏差）一律返回空串，调用方据此退回不带时长的「已在线」。
 */
export function formatOnlineDuration(presenceAt?: string | null): string {
  if (!presenceAt) return '';
  const start = new Date(presenceAt).getTime();
  if (!Number.isFinite(start)) return '';
  const diffMs = Date.now() - start;
  // 未来时间（设备时钟偏差/时区异常）不编造时长，直接退回空串
  if (diffMs < 0) return '';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return '不到 1 分钟';
  if (mins < 60) return `${mins} 分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

/**
 * 「不在当前 / 离线」的时间痕迹文案（三态展示里非在线两档的副说明）。
 * 取最近一次留下的痕迹（下线 > 在场写入 > 心跳 > 登录），与 formatLastSeen 同口径。
 */
export function formatAwaySince(
  loginAt?: string | null,
  logoutAt?: string | null,
  activeAt?: string | null,
  presenceAt?: string | null,
): string {
  const { login, logout, active } = normalizeSeen(loginAt, logoutAt, activeAt);
  const pAt = presenceAt && Date.now() - new Date(presenceAt).getTime() >= 0 ? presenceAt : null;
  const stamps = [logout, pAt, active, login].filter(Boolean) as string[];
  if (stamps.length === 0) return '';
  const latest = stamps.reduce((a, b) => (new Date(a).getTime() >= new Date(b).getTime() ? a : b));
  return relativeTime(latest);
}
