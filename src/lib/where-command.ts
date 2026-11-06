import type { Message } from '@/api/messages';

/**
 * 暗号（where 指令）链路的共享常量与判定函数。
 *
 * 【为什么抽成独立模块】这条链路横跨三处：chat 页（触发与回发）、api 层（隐藏记录）、
 * 会话列表（摘要过滤）。常量与判定散落在页面里会让三处口径漂移，
 * 故统一收口到本模块，页面只做编排。
 */

/** 暗号本体：对方发来这个纯文本（不区分大小写、忽略首尾空白）时，本端自动回发一次位置 */
export const WHERE_COMMAND = 'where';

/**
 * 暗号回执（ack）的 content 前缀。
 *
 * 【为什么需要 ack】B 端要隐藏 A 发来的 where，但 message_visibility 的 RLS 只允许
 * **消息发送者本人**插入隐藏行——B 不是那条 where 的发送者，无权隐藏它。
 * 解法：B 回发位置时顺带发一条 ack 信号，A 端收到后由 A 自己（发送者，有权限）隐藏那条 where。
 * 这样既满足 RLS 约束，又不需要放宽权限（放宽会让任一方都能隐藏对方的消息）。
 *
 * content 形如 `where_ack:<被回应的 where 消息 id>`，纯信号、不渲染气泡。
 */
export const WHERE_ACK_PREFIX = 'where_ack:';

/** 判断一条消息是否为暗号指令（只认纯文本，图片/位置等类型一律不算） */
export function isWhereCommand(msg: Message): boolean {
  return msg.content_type === 'text' && msg.content.trim().toLowerCase() === WHERE_COMMAND;
}

/** 构造暗号回执的 content */
export function encodeWhereAck(whereMessageId: string): string {
  return `${WHERE_ACK_PREFIX}${whereMessageId}`;
}

/**
 * 解析暗号回执，返回被回应的 where 消息 id；非 ack 返回 null。
 * ⚠️ 必须容错：content 是裸 TEXT 列，脏数据不能抛异常冒到渲染层。
 */
export function decodeWhereAck(content: string | null | undefined): string | null {
  if (!content || !content.startsWith(WHERE_ACK_PREFIX)) return null;
  const id = content.slice(WHERE_ACK_PREFIX.length).trim();
  return id || null;
}

/** 判断一条消息是否为暗号回执（纯信号，渲染层必须跳过、不画气泡） */
export function isWhereAck(msg: Message): boolean {
  return msg.content_type === 'text' && decodeWhereAck(msg.content) !== null;
}
