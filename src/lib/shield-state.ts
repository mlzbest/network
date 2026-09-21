/**
 * 全局隐私遮挡状态（模块级单例）
 *
 * 背景：小程序里 navigateTo 后旧页面实例并不销毁，切后台时所有存活页面的
 * PrivacyShield 实例都会收到 onAppHide 广播。为保证「只遮挡切后台那一刻
 * 处于前台的页面」且「遮挡期间任何其他页面露出也要立即补遮」，
 * 把遮挡归属提升到模块级共享，供各页面 useDidShow 做兜底拦截。
 *
 * 关键约定：armedRoute 一律使用「不带前导斜杠」的原始路由
 * （即 Taro.getCurrentPages() 栈顶的 route 原样），reLaunch 时再补 '/'。
 */

let shieldArmed = false; // 是否处于"待遮挡"状态（切后台置位，用户点击解除后复位）
let armedRoute = '';     // 被遮挡页面的路由（切后台时刻最后可见的页面，无前导斜杠）
let lastVisibleRoute = ''; // 全局「最后一次页面显示」的路由（onAppHide 里 getCurrentPages 可能失真，用它兜底）

export function setLastVisibleRoute(route: string): void {
  if (route) lastVisibleRoute = route;
}

export function getLastVisibleRoute(): string {
  return lastVisibleRoute;
}

export function armShield(route: string): void {
  shieldArmed = true;
  armedRoute = route;
  console.log('[shield-state] 遮挡已拉起, 归属页面:', route);
}

export function disarmShield(): void {
  shieldArmed = false;
  armedRoute = '';
  console.log('[shield-state] 遮挡已解除');
}

export function isShieldArmed(): boolean {
  return shieldArmed;
}

export function getArmedRoute(): string {
  return armedRoute;
}
