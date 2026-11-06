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

import { logDbg } from './logger';

let shieldArmed = false; // 是否处于"待遮挡"状态（切后台置位，用户点击解除后复位）
let armedRoute = '';     // 被遮挡页面的路由（切后台时刻最后可见的页面，无前导斜杠）
let lastVisibleRoute = ''; // 全局「最后一次页面显示」的路由（onAppHide 里 getCurrentPages 可能失真，用它兜底）
// 主动调起系统面板(相册/相机等)导致的瞬时 onAppHide 豁免。
// ❌ 试过「时效窗口 + 固定次数额度」(15s / 3 次)：真机不够用——一次发图会连续
//    产生多次 App 级 onAppHide（拉起相册本身在部分机型抖 1~2 次 → 小程序端压缩
//    再 navigateTo canvas 宿主页又一次 hide/show），多张大图的压缩+上传还容易跑过
//    15 秒，后段 hide 超出额度/窗口过期就被误判为真实切后台亮罩。
// ✅ 现改为「批次级布尔置位」：整批发图开始前置位、finally 释放，期间所有 hide 一律豁免。
let mediaPickerActive = false; // true 表示正处于选图/压缩/上传批次中，hide 全部豁免

/**
 * 开启系统面板豁免（批次级）。
 * 场景：页面内主动调起 chooseMedia/chooseImage/chooseMessageFile/openDocument 等
 * 系统能力时，部分机型/基础库会触发一次或多次 App 级 onAppHide（拉起系统选择器），
 * 导致用户只是选张图就被弹了防护罩。置位期间的 hide 会被 PrivacyShield 全部豁免；
 * 整批 Promise 落定后必须在 finally 调用 endMediaPickerGrace() 释放，
 * 之后的真实切后台照常遮挡。
 */
export function setMediaPickerGrace(): void {
  mediaPickerActive = true;
  logDbg('[shield-state] 系统面板豁免已置位(批次级, 直到 endMediaPickerGrace)');
}

/** 关闭豁免（选图/压缩/上传整批 Promise 落定后在 finally 调用）。 */
export function endMediaPickerGrace(): void {
  if (mediaPickerActive) {
    logDbg('[shield-state] 系统面板豁免已释放');
  }
  mediaPickerActive = false;
}

// 原生全屏预览豁免（previewImage 等）：与相册豁免不同，用户可能停留在系统
// 查看器里任意时长（翻图/缩放），无法用时效窗口覆盖。改为「计数 + 回前台消费」：
// 打开预览时 +1，onAppHide 命中则豁免且不扣减（hide/show 成对出现，额度留给
// 同一次预览的抖动），PrivacyShield 在 onAppShow 时消费归零。
let nativePreviewGrace = 0;

/** 打开 Taro.previewImage 等原生全屏预览前调用，豁免其引发的 App 级 onAppHide。 */
export function setNativePreviewGrace(): void {
  nativePreviewGrace += 1;
  logDbg(`[shield-state] 原生预览豁免置位, 当前额度: ${nativePreviewGrace}`);
}

/** 当前 onAppHide 是否处于原生预览豁免中（不消费额度，供 hide 侧多次判定）。 */
export function isInNativePreviewGrace(): boolean {
  return nativePreviewGrace > 0;
}

/** 回到前台后消费原生预览豁免（onAppShow 侧调用，一次性归零）。 */
export function consumeNativePreviewGrace(): boolean {
  if (nativePreviewGrace <= 0) return false;
  nativePreviewGrace = 0;
  logDbg('[shield-state] 原生预览豁免已消费(回前台)');
  return true;
}

/**
 * 当前 onAppHide 是否处于系统面板豁免中（批次级布尔，不消费额度——
 * 一次发图会产生多次 hide，全部由 endMediaPickerGrace 统一释放）。
 */
export function isInMediaPickerGrace(): boolean {
  if (!mediaPickerActive) return false;
  logDbg('[shield-state] onAppHide 命中系统面板豁免(选图/压缩/上传批次中), 本次不遮挡');
  return true;
}

export function setLastVisibleRoute(route: string): void {
  if (route) lastVisibleRoute = route;
}

export function getLastVisibleRoute(): string {
  return lastVisibleRoute;
}

export function armShield(route: string): void {
  shieldArmed = true;
  armedRoute = route;
  logDbg('[shield-state] 遮挡已拉起, 归属页面:', route);
}

export function disarmShield(): void {
  shieldArmed = false;
  armedRoute = '';
  logDbg('[shield-state] 遮挡已解除');
}

export function isShieldArmed(): boolean {
  return shieldArmed;
}

export function getArmedRoute(): string {
  return armedRoute;
}
