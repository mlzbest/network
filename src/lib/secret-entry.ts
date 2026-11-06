import Taro from '@tarojs/taro';
import { logDbg } from './logger';

/**
 * 聊天区「进出打点」：登录次数统计的窗口锚点 + 暗号进入计数额度。
 *
 * 两个语义完全不同的时间点，都记在本地 Storage（按账号隔离），不污染 profiles 的活跃度字段：
 * - **窗口起点** `chat_exit_at_v1`：本用户上次从聊天区退回 ping 页的时刻。
 * - **窗口终点** `chat_secret_entry_at_v1`：本次从 ping 页用暗号进入聊天区的时刻。
 *   同一份数据还兼作「一次暗号进入只计 1 次登录」的消费式额度（takeSecretEntry）。
 *
 * 为什么不能沿用 onAuthStateChange 判定登录：supabase-js 在冷启动 getSession、
 * INITIAL_SESSION、TOKEN_REFRESHED 等场景都会回调出有效 user，那些都不是用户「进入」
 * 聊天区；微信切后台/回前台同样会触发 token 刷新。按那条链路计数，用户看到的
 * 「TA 登录 N 次」其实是设备保活次数，与真实使用完全对不上。
 *
 * ⚠️ markSecretEntry 是**覆盖式**（不焚毁）：额度消费由 takeSecretEntry 负责，
 * 统计窗口要用 readSecretEntry 非破坏式读取——否则统计把额度读走、登录就不计数了。
 */
const SECRET_ENTRY_KEY = 'chat_secret_entry_at_v1';
const CHAT_EXIT_KEY = 'chat_exit_at_v1';
/** 暗号额度的有效期：ping 页写标记时 auth 可能还没就绪（bootstrapped 过渡态），
 * 标记必须活到真实 session 到达那一刻；窗口过长又会让几小时后的一次 token 刷新冒领成登录。 */
const SECRET_ENTRY_TTL_MS = 5 * 60 * 1000;

/**
 * ⚠️⚠️ 缺陷⑬（用户报「离开期间对方的登录次数列表也还有点问题」的**根因**，勿再让窗口终点共用额度 TTL）：
 *   旧实现里 `readSecretEntry()`（统计窗口**终点**）与 `takeSecretEntry()`（计数**额度**）
 *   共用同一个 `SECRET_ENTRY_TTL_MS = 5 分钟`。但两者语义完全不同：
 *   - 额度是**消费式**的，5 分钟足够（auth 就绪后立刻被 takeSecretEntry 焚掉）；
 *   - 窗口终点是**非消费式**的，它必须活到用户离开聊天页为止 —— 用户完全可能
 *     在聊天区停留超过 5 分钟（实测数据里同一会话连续登录间隔就有 6 分钟、28 分钟）。
 *   一旦超过 5 分钟，`readSecretEntry()` 返回 null → `win.toAt = null` →
 *   `fetchPeerLoginStats` 的 `if (win.toAt) query.lte(...)` 不设上限 →
 *   统计区间从「上次离开 ～ 本次进入」**退化成「上次离开 ～ 现在」**，
 *   于是把「本次进入之后对方又登录的」也算进窗口内 → **次数虚高、明细多出条目**，
 *   而且弹层顶部区间文案会变成「XX 之后」（用户看到的就是「列表有点问题」）。
 *   正解：窗口终点用**独立的长 TTL**（与退场打点同款「不限时效」思路，但保留一个
 *   宽松上限防陈旧残留），与额度 TTL 彻底解耦。
 */
const SECRET_ENTRY_WINDOW_TTL_MS = 24 * 60 * 60 * 1000;

/** 上次登录用户 id：与 auth-store / profile-cache 同 key，用于按账号隔离打点、防换账号串号 */
const LAST_UID_KEY = 'chat_last_uid_v1';

function readLastUid(): string {
  try {
    return Taro.getStorageSync(LAST_UID_KEY) || '';
  } catch {
    return '';
  }
}

/** 带归属校验地写入时间戳：存 `{ uid, at }` 包装，读取时校验 uid，换账号直接视为空 */
function writeStamp(key: string, label: string): void {
  const at = Date.now();
  try {
    Taro.setStorageSync(key, { uid: readLastUid(), at });
    logDbg(`[secret-entry] 💾 ${label}已落盘: ${new Date(at).toISOString()}`);
  } catch (e) {
    console.warn(`[secret-entry] 写入${label}失败(不影响使用):`, e);
  }
}

/**
 * 读取时间戳。
 * @param expectUid 传入则强制校验归属（退场打点必须按账号隔离）；
 *                  传 null 表示不做归属校验（暗号进入打点：此刻 store 里的 uid 可能还是过渡态值，
 *                  且该 key 只在同一次使用会话内短命，串号风险可忽略）。
 * @param ttlMs 时效窗口，超期视为无效并顺手清除；传 0 表示不限时效。
 */
function readStamp(key: string, expectUid: string | null, ttlMs: number, label: string): number | null {
  let raw: unknown = '';
  try {
    raw = Taro.getStorageSync(key);
  } catch (e) {
    console.warn(`[secret-entry] 读取${label}失败:`, e);
    return null;
  }
  if (!raw || typeof raw !== 'object' || !('at' in raw)) return null;
  const { uid, at } = raw as { uid?: string; at?: number };
  if (typeof at !== 'number' || !at) return null;
  if (expectUid && uid && uid !== expectUid) {
    logDbg(`[secret-entry] ⚠️ ${label}归属(${uid.slice(0, 8)})≠当前用户(${expectUid.slice(0, 8)})，丢弃防串号`);
    return null;
  }
  const age = Date.now() - at;
  if (ttlMs > 0 && (age > ttlMs || age < 0)) {
    logDbg(`[secret-entry] ⏭ ${label}已过期(age=${Math.round(age / 1000)}s)，作废`);
    return null;
  }
  return at;
}

/** 暗号进入聊天区成功时打点（由 ping 页调用）。覆盖式写入，可同时供「计数额度」与「统计窗口终点」使用。 */
export function markSecretEntry(): void {
  writeStamp(SECRET_ENTRY_KEY, '暗号进入打点');
}

/**
 * 消费暗号进入额度：命中返回 true 并清除标记（一次性），保证一次进入只计 1 次登录。
 * 仅供 recordLastLogin 做计数闸门——统计窗口请用 readSecretEntry，别把额度读走。
 */
export function takeSecretEntry(): boolean {
  const at = readStamp(SECRET_ENTRY_KEY, null, SECRET_ENTRY_TTL_MS, '暗号进入额度');
  if (at === null) return false;
  clearSecretEntry();
  logDbg(`[secret-entry] ✅ 命中暗号进入额度(age=${Math.round((Date.now() - at) / 1000)}s)，本次计入登录统计`);
  return true;
}

/**
 * 非破坏式读取本次进入时刻（统计窗口终点）；无有效打点返回 null。
 *
 * ⚠️ 缺陷⑬：这里**必须**用 `SECRET_ENTRY_WINDOW_TTL_MS`（24h）而不是额度的 5 分钟 TTL。
 *    窗口终点要活到用户离开聊天页为止，用户在聊天区停留超过 5 分钟是常态；
 *    共用 5 分钟 TTL 会让 toAt 变 null → 统计区间退化成「上次离开 ～ 现在」→
 *    次数虚高、明细多出条目、区间文案变成「XX 之后」。
 */
export function readSecretEntry(): number | null {
  const at = readStamp(SECRET_ENTRY_KEY, null, SECRET_ENTRY_WINDOW_TTL_MS, '暗号进入时刻(统计窗口终点)');
  // 关键证据日志：窗口终点是否有效直接决定统计区间口径（有效=「上次离开～本次进入」，
  // 失效=退化成「上次离开～现在」导致次数虚高）。排查「登录次数/明细不对」时先看这一行。
  if (at === null) {
    logDbg('[secret-entry] ⚠️ 统计窗口终点缺失（无暗号进入打点或已超 24h），区间将退化为「上次离开 ～ 现在」');
  } else {
    logDbg(`[secret-entry] 📊 统计窗口终点有效: age=${Math.round((Date.now() - at) / 1000)}s（额度 TTL 5 分钟不影响它）`);
  }
  return at;
}

/** 主动作废暗号额度（退出登录时调用，防止残留额度被下一次 token 刷新冒领） */
export function clearSecretEntry(): void {
  try {
    Taro.removeStorageSync(SECRET_ENTRY_KEY);
  } catch (e) {
    console.warn('[secret-entry] 清除暗号进入打点失败:', e);
  }
}

/** 退回 ping 页（离开聊天区）时打点：下一次进入的统计窗口起点 */
export function markChatExit(): void {
  writeStamp(CHAT_EXIT_KEY, '退回 ping 页打点(统计窗口起点)');
}

/**
 * 读取上次退回 ping 页的时刻（统计窗口起点）。
 * 非消费式：同一页面多次重算必须拿到同一个值，否则统计区间会随刷新漂移。
 * 不限时效：用户可能几天后才再次进入聊天区，那段空窗正是要统计的范围。
 */
export function readChatExit(uid: string): number | null {
  return readStamp(CHAT_EXIT_KEY, uid, 0, '退场打点(统计窗口起点)');
}
