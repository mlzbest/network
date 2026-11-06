import Taro from '@tarojs/taro';

/**
 * 「最近使用过的表情」本地记忆。
 *
 * 为什么单独一个文件：它是一份**纯本机视图偏好**（不写库、不跨设备同步），
 * 与 `transcript-ui-prefs.ts` 同属「界面偏好」这一类，但生命周期独立——
 * 清转写缓存不该把最近表情抹掉，反之亦然，故分 key 存放。
 *
 * ⚠️ 按 uid 隔离（沿用项目既有的防串号约定）：表情使用习惯是个人数据，
 *    换账号后看到上一个人的最近表情属于串号。key 里带 uid，登出时无需额外清理
 *    （不同 uid 天然读不到彼此的记录），但 `clearRecentEmojis` 仍保留给「清空」入口用。
 */

const KEY_PREFIX = 'chat_recent_emojis_v1_';

/** 最近表情最多保留几个：面板顶部只有一行（6 列），多存无意义 */
export const RECENT_EMOJI_LIMIT = 6;

const keyOf = (uid: string | undefined | null) => `${KEY_PREFIX}${uid ?? ''}`;

/**
 * 读取该账号的最近表情（最新的在前）。
 *
 * ⚠️ 必须做「去重 + 只保留字符串 + 截断到上限」三重清洗：
 *    本地存储是用户可被外部改写的（开发者工具、旧版本残留），脏数据直接渲染会出空块。
 */
export function readRecentEmojis(uid: string | undefined | null): string[] {
  if (!uid) return [];
  try {
    const v = Taro.getStorageSync(keyOf(uid));
    if (!Array.isArray(v)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of v) {
      if (typeof item !== 'string' || item === '') continue;
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
      if (out.length >= RECENT_EMOJI_LIMIT) break;
    }
    return out;
  } catch (e) {
    console.warn('[recent-emojis] 读取最近表情失败:', e);
    return [];
  }
}

/**
 * 记录一次表情使用，返回**更新后**的完整列表（调用方直接 setState，不必再读一次）。
 *
 * ⚠️ 采用「整包覆盖」而非增量：调用方只在用户点击表情时触发，不存在并发丢更新。
 * ⚠️ 已存在的表情要**提到最前**而不是重复追加——否则连点同一个表情会把整行挤满同一个符号。
 */
export function pushRecentEmoji(uid: string | undefined | null, emoji: string): string[] {
  if (!uid || !emoji) return readRecentEmojis(uid);
  const prev = readRecentEmojis(uid);
  const next = [emoji, ...prev.filter((x) => x !== emoji)].slice(0, RECENT_EMOJI_LIMIT);
  try {
    Taro.setStorageSync(keyOf(uid), next);
  } catch (e) {
    console.warn('[recent-emojis] 写入最近表情失败:', e);
  }
  return next;
}

/** 清空该账号的最近表情（登出/清缓存入口用） */
export function clearRecentEmojis(uid: string | undefined | null): void {
  if (!uid) return;
  try {
    Taro.removeStorageSync(keyOf(uid));
  } catch (e) {
    console.warn('[recent-emojis] 清空最近表情失败:', e);
  }
}
