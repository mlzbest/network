import Taro from '@tarojs/taro';
import { logDbg } from './logger';

/**
 * 系统信息兼容层：替代已废弃的 Taro.getSystemInfoSync()。
 *
 * 微信基础库 2.20.1+ 起 getSystemInfoSync 被拆分为
 * getWindowInfo / getDeviceInfo / getAppBaseInfo，旧 API 会打 deprecation 警告。
 * 新 API 仅小程序端存在，H5 预览下 Taro 仍回落到旧接口 —— 故这里优先用新 API、
 * 取不到时静默回退旧 API，保证两端行为一致且小程序端不再出现废弃警告。
 */

export interface WindowInfo {
  statusBarHeight: number;
  windowWidth: number;
  windowHeight: number;
}

export interface DeviceInfo {
  platform: string;
  system: string;
  brand: string;
  model: string;
}

export interface AppBaseInfo {
  SDKVersion: string;
}

type AnyObj = Record<string, unknown>;

/** 每个新 API 首次调用时打一条日志，便于在运行时日志确认已走拆分后的新接口 */
const loggedApis = new Set<string>();

function callCompat(newApi: string, oldKeys?: (keyof AnyObj)[]): AnyObj {
  const taro = Taro as unknown as Record<string, ((...args: unknown[]) => AnyObj) | undefined>;
  // 优先调用拆分后的新 API（小程序端）
  const fn = taro[newApi];
  if (typeof fn === 'function') {
    try {
      const r = fn.call(Taro) ?? {};
      if (!loggedApis.has(newApi)) {
        loggedApis.add(newApi);
        logDbg(`[system-info] ✅ 已使用拆分后的新 API wx.${newApi}，不再触发 getSystemInfoSync 废弃警告`, r);
      }
      return r;
    } catch (e) {
      console.warn(`[system-info] ${newApi} 调用失败，回退 getSystemInfoSync:`, e);
    }
  }
  // H5 或低版本基础库：回退旧 API（可按需只取指定字段）
  try {
    const all = Taro.getSystemInfoSync() as unknown as AnyObj;
    if (!oldKeys) return all;
    const picked: AnyObj = {};
    for (const k of oldKeys) picked[k] = all[k];
    return picked;
  } catch (e) {
    console.warn('[system-info] getSystemInfoSync 兜底也失败:', e);
    return {};
  }
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 窗口相关信息：状态栏高度、可视区宽高（自定义导航栏避让、滚动区高度计算用） */
export function getWindowInfo(): WindowInfo {
  const r = callCompat('getWindowInfo', ['statusBarHeight', 'windowWidth', 'windowHeight']);
  return {
    statusBarHeight: num(r.statusBarHeight),
    windowWidth: num(r.windowWidth),
    windowHeight: num(r.windowHeight),
  };
}

/** 设备信息：机型、系统等（网络诊断展示用；brand/model 在 iOS 上属隐私接口，未授权时为空） */
export function getDeviceInfo(): DeviceInfo {
  const r = callCompat('getDeviceInfo', ['platform', 'system', 'brand', 'model']);
  return {
    platform: str(r.platform),
    system: str(r.system),
    brand: str(r.brand),
    model: str(r.model),
  };
}

/** 小程序基础库版本（网络诊断展示用） */
export function getAppBaseInfo(): AppBaseInfo {
  const r = callCompat('getAppBaseInfo', ['SDKVersion']);
  return { SDKVersion: str(r.SDKVersion) };
}
