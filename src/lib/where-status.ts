/**
 * `where` 暗号链路的「等待状态」真源。
 *
 * 【为什么需要它】A 发出 `where` 后，界面上原本**没有任何反馈**：B 不在线（Realtime 推不到）
 * 还是 B 在线但没回位置，A 完全看不出来，只能干等。用户明确要求「让 A 能看出 B 是没在线、
 * 还是没回位置」。
 *
 * 【为什么抽成独立模块而不是写在 chat 页里】这条状态横跨三处：① 发送入口（A 发出 where 时启动）
 * ② Realtime 回调（收到 ack 时清除）③ 顶栏渲染（按状态出文案）。三处若各自维护一套
 * 「什么算等待中 / 什么算超时 / 文案怎么写」，口径必然漂移（改了一处忘了另一处）。
 * 统一收口到本模块后，页面只做「启动 / 清除 / 渲染」三件事，判定与文案都从这里取。
 *
 * 【状态机】只有三个状态，且**单向流转**（waiting → timeout，或任意 → 直接清除）：
 *
 *   idle ──(A 发出 where)──► waiting ──(超时未收到 ack)──► timeout
 *     ▲                         │                            │
 *     └────(收到 ack / 离开页面)─┴────────────────────────────┘
 *
 * ⚠️ 为什么不做「B 在线但没回」这个更细的分支：A 端**无法可靠区分**「B 在线但忽略了」
 *    与「B 在线但定位失败」。B 定位失败时会回一条文字说明（见 handleWhereCommand），
 *    那条文字会正常出现在 A 的列表里，A 自己就能看到原因。若这里再编一个「对方在线但未回复」
 *    的文案，反而会与那条文字说明矛盾。故超时文案只陈述**可确定的事实**：
 *    「还没收到位置」+ 提示对方可能不在线。
 */

/** where 等待状态：idle=无等待，waiting=已发出等待回应，timeout=超时未收到回应 */
export type WhereWaitStatus = 'idle' | 'waiting' | 'timeout';

/**
 * 等待超时时长（毫秒）。
 *
 * 【为什么是 20 秒】B 端收到 where 后要依次做：隐藏 A 的 where（一次网络往返）→ 定位
 * （getLocation 在弱网/冷启动下可能耗时数秒）→ 发位置（一次网络往返）→ 发 ack（一次网络往返）。
 * 实测正常链路在 2-5 秒内完成；20 秒足够覆盖「定位较慢」的情况，又不会让 A 等太久。
 * ⚠️ 超时**不代表失败**：B 可能只是慢，稍后仍会回。故超时文案必须留有余地，
 *    且收到 ack 时仍要能正常清除（状态机允许 timeout → idle）。
 */
export const WHERE_WAIT_TIMEOUT_MS = 20_000;

/** 等待中的提示文案 */
export const WHERE_WAITING_LABEL = '已发送位置请求，等待对方回应…';

/** 超时后的提示文案（只陈述可确定的事实，不编造对方状态） */
export const WHERE_TIMEOUT_LABEL = '对方暂未回应，可能不在线';

/**
 * 按状态派生顶栏文案。
 *
 * ⚠️ 返回 null 表示「不显示」——调用方据此决定是否渲染该行。
 *    这样「什么状态该显示什么」的判定只在本模块一处，渲染层不需要再写 if。
 */
export function whereStatusLabel(status: WhereWaitStatus): string | null {
  if (status === 'waiting') return WHERE_WAITING_LABEL;
  if (status === 'timeout') return WHERE_TIMEOUT_LABEL;
  return null;
}

/**
 * 判断一条**自己发出的**文本消息是否为 where 指令。
 *
 * 【为什么不复用 `isWhereCommand`】那个函数接收的是 `Message` 对象、用于判定「收到的消息」；
 * 本函数接收的是**输入框里的原始文本**（发送前就要判定，此时还没有 Message 对象）。
 * 两者判定口径必须一致（trim + 小写），故这里显式复用同一套规则并写明来源。
 */
export function isWhereText(text: string): boolean {
  return text.trim().toLowerCase() === 'where';
}
