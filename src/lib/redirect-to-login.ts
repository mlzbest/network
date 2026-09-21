import Taro from '@tarojs/taro';

const RETURN_PATH_KEY = '_auth_return_path';

/**
 * 用 `redirectTo` 替换当前页：避免登录页返回到要求登录的页面被守卫踢回造成跳转循环；
 * 也兼容 tabBar 页面调起登录（`navigateTo` 不能跳出 tabBar 页面外的限制）。
 * returnPath 走 storage 不走 query：绕开 weapp 端 `router.params` 不自动 decode 的跨端差异；
 * 登录页 mount 时由 `consumeReturnPath` 一次性消费掉。
 */
export function redirectToLogin(returnPath?: string) {
  if (returnPath) {
    Taro.setStorageSync(RETURN_PATH_KEY, returnPath);
  } else {
    Taro.removeStorageSync(RETURN_PATH_KEY);
  }
  Taro.redirectTo({ url: '/pages/login/index' });
}

/** 取出并清掉登录前暂存的回跳路径；没有就回会话列表页。供登录页内部使用 */
export function consumeReturnPath(): string {
  const path = Taro.getStorageSync(RETURN_PATH_KEY) as string;
  if (path) Taro.removeStorageSync(RETURN_PATH_KEY);
  return path || '/pages/chats/index';
}
