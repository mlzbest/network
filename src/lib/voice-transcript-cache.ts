import Taro from '@tarojs/taro';

/**
 * 语音转文字结果的本地缓存。
 *
 * 为什么只存本机而不写回 messages 表：用户明确选择「气泡下方展开、仅自己可见」，
 * 且 `messages.content` 对语音消息存的是时长串 `[12s]`——会话列表的
 * `formatVoiceDuration()`（pages/chats/index.tsx）要靠它算出「[语音] 0:12」。
 * 把识别文本塞进 content 会直接砸掉时长摘要，所以这里坚持「不动数据库、只落本地」。
 *
 * key 按 uid + 消息 id 双维度隔离（沿用项目既有的防串号约定），换账号不会看到别人的转写。
 */

const KEY_PREFIX = 'voice_transcript_';

const cacheKey = (uid: string, messageId: string) => `${KEY_PREFIX}${uid}_${messageId}`;

/** 读取单条转写；无缓存或存储异常时返回空串 */
export function readTranscript(uid: string | undefined | null, messageId: string): string {
  if (!uid || !messageId) return '';
  try {
    const v = Taro.getStorageSync(cacheKey(uid, messageId));
    return typeof v === 'string' ? v : '';
  } catch (e) {
    console.warn('[voice-transcript] 读取缓存失败:', e);
    return '';
  }
}

/** 写入单条转写；空文本不写（避免把「没听清」当成有效结果长期占位） */
export function writeTranscript(uid: string | undefined | null, messageId: string, text: string): void {
  if (!uid || !messageId || !text) return;
  try {
    Taro.setStorageSync(cacheKey(uid, messageId), text);
  } catch (e) {
    console.warn('[voice-transcript] 写入缓存失败:', e);
  }
}

/**
 * 批量 hydrate：进入会话时一次性把该会话已有缓存的转写读出来，
 * 让历史识别结果无需重新请求即可展开（默认仍是折叠态，只是数据先备好）。
 */
export function readTranscripts(uid: string | undefined | null, messageIds: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!uid || messageIds.length === 0) return out;
  for (const id of messageIds) {
    const text = readTranscript(uid, id);
    if (text) out[id] = text;
  }
  return out;
}
