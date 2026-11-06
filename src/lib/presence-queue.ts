import Taro from '@tarojs/taro';
import type { PresenceState } from '@/api/profiles';
import { logDbg } from './logger';

/**
 * 在场状态「待补发队列」。
 *
 * 为什么需要它：`reportPresence('offline')` 发生在退 ping 页 / 120 秒超时跳走的瞬间，
 * 那一刻网络差、或请求被权限静默拦下（返回 0 行）都会让「不在线」永远没写进库。
 * 库里停在 online/away 时，展示端要等 `PRESENCE_AWAY_MAX_MS`(30 分钟) 才自动收敛成
 * 「不在线」——用户在这半小时里看到的是假在线。修复方向不是缩短阈值（会误伤真短暂离开的人），
 * 而是把没送达的写入暂存下来，等网络可用时补发。
 *
 * 设计要点：
 * - **只暂存终态与「必须送达的首次在线」**：offline 必入队；online 在冷启动过渡态被门控时
 *   入队（否则库里永远停在上次的 offline，展示端一直显示「不在线」）；away 是高频抖动状态，
 *   入队反而会把「几分钟前的离开」补发到当下造成错乱，故不入队（它有超时推断自愈）。
 * - **按账号隔离**：仿 profile-cache 用 `{ uid, items }` 包装，uid 不符直接丢弃防换账号串号。
 * - **同状态去重保留最新**：同一状态重复入队只留最后一条时间戳，避免补发一串历史抖动。
 * - **时效淘汰**：超过 TTL 的陈旧条目在 flush 前直接丢弃（几天前的 offline 已无意义）。
 */

const QUEUE_KEY = 'chat_presence_queue_v1';

/** 队列容量上限（正常只有 1~3 条，超限说明补发一直失败，丢最旧的） */
const MAX_ITEMS = 5;

/** 条目最长存活时间：超过即视为无意义，flush 时丢弃 */
const ITEM_TTL_MS = 6 * 3600_000;

interface QueueItem {
  state: PresenceState;
  /** ISO 串——补发时原样回写，保留「用户真正离开的那一刻」而不是补发时刻 */
  stamp: string;
  /** 入队时刻（ms），仅用于 TTL 判定，不回写云端 */
  queuedAt: number;
}

interface Wrapper {
  uid: string;
  items: QueueItem[];
}

function readUid(): string {
  try {
    return String(Taro.getStorageSync('chat_last_uid_v1') || '');
  } catch {
    return '';
  }
}

function readWrapper(): Wrapper | null {
  try {
    const raw = Taro.getStorageSync(QUEUE_KEY);
    if (!raw || typeof raw !== 'object' || !('uid' in raw)) return null;
    const w = raw as Wrapper;
    const uid = readUid();
    // 归属不符（换账号 / 老数据）一律视为空，绝不把别人的状态补发到当前账号
    if (!uid || w.uid !== uid) return null;
    return Array.isArray(w.items) ? w : null;
  } catch {
    return null;
  }
}

function writeWrapper(uid: string, items: QueueItem[]): void {
  try {
    Taro.setStorageSync(QUEUE_KEY, { uid, items });
  } catch (e) {
    console.warn('[presence-queue] 队列写入本地失败(不影响使用):', e);
  }
}

/**
 * 入队一条未送达的状态。
 *
 * ⚠️ 允许入队的状态集合（本轮修复后）：
 * - `offline`：终态，必须保证送达（退场瞬间网络差会丢）。
 * - `online`：**新增**。冷启动过渡态（bootstrapped）下 didShow 的 online 上报没有 token、
 *   发出去必被 RLS 当匿名挡掉，旧版直接丢弃 → 库里 presence_state 永远停在上次的 offline，
 *   展示端一直显示「不在线」（用户报的根因）。入队后由 flushPendingPresence 在 auth 就绪时补发。
 * - `away`：仍不入队。它是「切后台/换页」的中间态，补发到当下反而会把
 *   「几分钟前的离开」写成现在的状态，且它有超时推断自愈。
 *
 * @returns 是否实际入队（away / 无登录态返回 false）
 */
export function enqueuePresence(state: PresenceState, stamp: string): boolean {
  // 见文件头：只暂存终态与「必须送达的首次在线」，away 交给超时推断自愈
  if (state !== 'offline' && state !== 'online') return false;
  const uid = readUid();
  if (!uid) {
    console.warn('[presence-queue] ⏭ 无 last_uid 标记，跳过入队');
    return false;
  }
  const wrapper = readWrapper();
  const items = wrapper?.items ?? [];
  // 同状态去重：移除旧的再追加，保证时间戳是最新一次离开
  const next = items.filter((it) => it.state !== state);
  next.push({ state, stamp, queuedAt: Date.now() });
  const trimmed = next.length > MAX_ITEMS ? next.slice(next.length - MAX_ITEMS) : next;
  writeWrapper(uid, trimmed);
  logDbg(`[presence-queue] ➕ 已暂存 ${state} @${new Date(stamp).toLocaleTimeString()}，队列共 ${trimmed.length} 条`);
  return true;
}

/** 当前待补发条数（供日志与测试断言） */
export function pendingCount(): number {
  return readWrapper()?.items?.length ?? 0;
}

/** 清空队列（登出 / 换账号时调用，防止把上一个账号的状态补发到新账号） */
export function clearPresenceQueue(): void {
  try {
    Taro.removeStorageSync(QUEUE_KEY);
    logDbg('[presence-queue] 🧹 队列已清空');
  } catch {
    /* 忽略 */
  }
}

/** flush 进行中标志：启动、回前台、页面显示可能同时触发，避免并发重复补发 */
let flushing = false;

/**
 * 补发队列中所有仍有效的条目。
 * 由调用方注入真正的落库实现（api 层），本模块不 import api 以免与 store/auth 形成环。
 *
 * @param sender 单条发送函数，返回 true 表示已确认落库
 */
export async function flushPresenceQueue(sender: (item: QueueItem) => Promise<boolean>): Promise<void> {
  if (flushing) {
    logDbg('[presence-queue] ⏭ 已有补发任务在跑，跳过本次触发');
    return;
  }
  const wrapper = readWrapper();
  if (!wrapper || wrapper.items.length === 0) return;
  flushing = true;

  const now = Date.now();
  const fresh = wrapper.items.filter((it) => now - it.queuedAt <= ITEM_TTL_MS);
  const dropped = wrapper.items.length - fresh.length;
  if (dropped > 0) logDbg(`[presence-queue] 🗑 丢弃 ${dropped} 条超过 ${Math.round(ITEM_TTL_MS / 3600_000)}h 的陈旧条目`);

  let remaining: QueueItem[] = [...fresh];
  try {
    for (const item of fresh) {
      let ok = false;
      try {
        ok = await sender(item);
      } catch (e) {
        console.warn('[presence-queue] 补发异常，保留待下次:', item.state, e);
      }
      if (ok) {
        remaining = remaining.filter((r) => r !== item);
        logDbg(`[presence-queue] ✅ 补发成功: ${item.state} @${new Date(item.stamp).toLocaleTimeString()}`);
      }
    }
    // 全部送达则清掉 key，否则写回剩余条目
    if (remaining.length === 0) {
      try {
        Taro.removeStorageSync(QUEUE_KEY);
      } catch {
        /* 忽略 */
      }
      logDbg('[presence-queue] 🎉 队列已清空（全部补发成功）');
    } else if (remaining.length !== fresh.length) {
      writeWrapper(wrapper.uid, remaining);
      logDbg(`[presence-queue] ⚠️ 仍有 ${remaining.length} 条未送达，保留待下次`);
    } else if (dropped > 0) {
      writeWrapper(wrapper.uid, remaining);
    }
  } finally {
    flushing = false;
  }
}

export type { QueueItem };
