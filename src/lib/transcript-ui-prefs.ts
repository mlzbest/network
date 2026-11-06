import Taro from '@tarojs/taro';

/**
 * 语音转写块的界面偏好（字号 + 展开记忆）。
 *
 * 为什么单独一个文件：`voice-transcript-cache.ts` 只管「识别文本」这一份数据，
 * 而字号档位与「哪些消息被用户手动展开过」属于**视图偏好**——两者生命周期不同
 * （换字体不该丢转写、清缓存也不该把用户的字号选择抹掉），故分 key 存放。
 *
 * 展开记忆按 uid 隔离（沿用项目既有的防串号约定）；字号是纯个人设备偏好，全局一份即可。
 */

const EXPAND_KEY_PREFIX = 'voice_transcript_expand_';
const FONT_KEY = 'voice_transcript_font_v1';

/** 转写正文字号档位（小程序不能任意值类名，故用离散档） */
export type TranscriptFontScale = 'sm' | 'base' | 'lg';

const FONT_ORDER: TranscriptFontScale[] = ['sm', 'base', 'lg'];
const FALLBACK_FONT: TranscriptFontScale = 'base';

/** 档位 → Tailwind 字号类名。**必须是字面量映射表**，动态拼接会被 Tailwind 扫描漏掉。 */
export const TRANSCRIPT_FONT_CLASS: Record<TranscriptFontScale, string> = {
  sm: 'text-xs',
  base: 'text-sm',
  lg: 'text-base',
};

/** 档位 → 设置行展示文案 */
export const TRANSCRIPT_FONT_LABEL: Record<TranscriptFontScale, string> = {
  sm: '小',
  base: '标准',
  lg: '大',
};

const expandKey = (uid: string) => `${EXPAND_KEY_PREFIX}${uid}`;

/** 读字号档位；存储异常或值非法时回退标准档 */
export function readTranscriptFontScale(): TranscriptFontScale {
  try {
    const v = Taro.getStorageSync(FONT_KEY);
    return FONT_ORDER.includes(v as TranscriptFontScale) ? (v as TranscriptFontScale) : FALLBACK_FONT;
  } catch (e) {
    console.warn('[transcript-prefs] 读取字号失败:', e);
    return FALLBACK_FONT;
  }
}

/** 写字号档位 */
export function writeTranscriptFontScale(scale: TranscriptFontScale): void {
  try {
    Taro.setStorageSync(FONT_KEY, scale);
  } catch (e) {
    console.warn('[transcript-prefs] 写入字号失败:', e);
  }
}

/** 冷启动 hydrate：读出该账号此前手动展开过的消息 id 集合（无记录返回空集） */
export function readExpandedIds(uid: string | undefined | null): Set<string> {
  if (!uid) return new Set();
  try {
    const v = Taro.getStorageSync(expandKey(uid));
    return Array.isArray(v) ? new Set(v.filter((x) => typeof x === 'string')) : new Set();
  } catch (e) {
    console.warn('[transcript-prefs] 读取展开记忆失败:', e);
    return new Set();
  }
}

/**
 * 全量回写展开集合。
 *
 * ⚠️ 采用「整包覆盖」而非增量：调用方只在**用户主动点击**时触发（不在 setState updater 里），
 * 因此不存在并发丢更新；顺带天然淘汰已删除/撤回消息的残留 id，无需额外清理逻辑。
 */
export function writeExpandedIds(uid: string | undefined | null, ids: Set<string>): void {
  if (!uid) return;
  try {
    Taro.setStorageSync(expandKey(uid), Array.from(ids));
  } catch (e) {
    console.warn('[transcript-prefs] 写入展开记忆失败:', e);
  }
}
