import Taro from '@tarojs/taro';
import { logDbg } from '@/lib/logger';

/**
 * 底部 tabBar「会话」图标的未读数字角标。
 *
 * 【为什么单独抽一个模块而不是写在 chats 页里】
 * 角标是**全局 UI 状态**（挂在 tabBar 上，不属于任何一个页面），而它的数据源是
 * 会话列表的未读总数。写入方（chats 页）与清除方（登出、未登录）分散在不同位置，
 * 若各自直接调 `Taro.setTabBarBadge`，很容易出现「一处设了、另一处忘了清」的残留角标。
 * 统一收口到本模块后，所有调用点都走同一套「封顶 + 门控 + 兜底」逻辑。
 *
 * 【为什么必须门控微信环境】`Taro.setTabBarBadge` / `Taro.removeTabBarBadge` 是
 * 微信专有 API，H5 预览端调用会 reject Promise（同步 try-catch 捕不到 → 泄漏成
 * "Uncaught Object"）。项目里 `Taro.getMenuButtonBoundingClientRect()` 已踩过同一个坑，
 * 故这里沿用同一套门控写法：先判 `Taro.getEnv() === Taro.ENV_TYPE.WEAPP`。
 *
 * 【为什么角标数字要封顶 99+】微信原生角标宽度有限，三位数会被截断或撑变形；
 * 而「99+」已经足够表达「很多未读」这个信息，与列表项内徽章的口径保持一致。
 */

/** 「会话」在 tabBar 里的下标（见 src/app.config.ts 的 tabBar.list 顺序） */
export const CHATS_TAB_INDEX = 0;

/** 角标数字上限：超过则显示 `99+`（与列表项内徽章同口径） */
const BADGE_MAX = 99;

/**
 * 把未读总数同步到 tabBar 角标。
 *
 * @param total 未读消息总数；`<= 0` 时清除角标
 *
 * ⚠️ 调用方**不需要**自己判断环境或做 try-catch，本函数已全部兜住。
 * ⚠️ 本函数是幂等的：重复用同一个 total 调用不会产生副作用（微信侧覆盖写）。
 */
export function syncChatsTabBadge(total: number): void {
  // H5 / 其他端没有 tabBar 角标能力，直接跳过（不能让它抛错冒成未捕获异常）
  if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP) return;

  const safe = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  try {
    if (safe > 0) {
      const text = safe > BADGE_MAX ? `${BADGE_MAX}+` : String(safe);
      Taro.setTabBarBadge({ index: CHATS_TAB_INDEX, text });
      logDbg(`[tabbar] 🔴 会话角标已更新: ${text}（未读总数 ${safe}）`);
    } else {
      Taro.removeTabBarBadge({ index: CHATS_TAB_INDEX });
      logDbg('[tabbar] ⚪ 会话角标已清除（无未读）');
    }
  } catch (e) {
    // tabBar 尚未渲染完成（如冷启动极早期）时调用会失败，属预期情况：
    // 下一次列表刷新会再同步一次，不需要在这里重试或提示用户。
    logDbg('[tabbar] ⚠️ 角标同步失败（tabBar 可能尚未就绪，下次刷新会重试）:', (e as Error)?.message || e);
  }
}

/**
 * 清除 tabBar 角标。
 *
 * 【为什么登出必须调它】角标是**跨账号可见**的全局 UI：若 A 账号有 3 条未读时登出，
 * 角标会一直挂在 tabBar 上；B 账号登录后第一眼就看到一个不属于自己的「3」。
 * 与资料缓存 / 位置缓存同理，属于「登出必须清干净」的第三类本地状态。
 */
export function clearChatsTabBadge(): void {
  syncChatsTabBadge(0);
}

/**
 * 从会话列表算出未读总数。
 *
 * ⚠️ 必须用 `?? 0` 兜底：`unread_count` 在 `listConversations` 里做了归一化，
 *    **只在 > 0 时写入**（无未读则为 `undefined`），直接相加会得到 NaN。
 */
export function sumUnread(conversations: Array<{ unread_count?: number }>): number {
  return conversations.reduce((sum, c) => sum + (c.unread_count ?? 0), 0);
}
