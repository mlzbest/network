import Taro from '@tarojs/taro';
import type { Profile } from '@/api/profiles';
import { logDbg } from './logger';

/**
 * 用户资料的纯持久层：只负责把「id → 资料」映射读写到本地存储。
 * 业务判断（命中/补拉/去重）全部在 src/store/profiles-store.ts，这里不做任何逻辑。
 */

const CACHE_KEY = 'chat_profile_cache_v1';
/** 上次登录用户 id：与 auth-store 的 chat_last_uid_v1 同值，用于按账号隔离资料缓存 */
const LAST_UID_KEY = 'chat_last_uid_v1';

type ProfileMap = Record<string, Profile>;

function readLastUid(): string {
  try {
    return Taro.getStorageSync(LAST_UID_KEY) || '';
  } catch {
    return '';
  }
}

/** 同步读取本地资料缓存（异常/无数据返回空对象）。
 * 缓存按账号隔离：若缓存归属的用户 ≠ 当前（或上次）登录用户，
 * 直接视为空——防止换账号冷启动时 hydrate 到别人的资料导致串号。 */
export function loadProfileCache(): ProfileMap {
  try {
    const wrapper = Taro.getStorageSync(CACHE_KEY);
    // 兼容旧格式（裸 map，未按账号隔离）：无法判定归属，宁可丢弃也不冒串号风险
    if (!wrapper || typeof wrapper !== 'object' || !('uid' in wrapper)) return {};
    const { uid, map } = wrapper as { uid: string; map: ProfileMap };
    const currentUid = readLastUid();
    if (!currentUid) return {};
    if (uid && uid !== currentUid) {
      logDbg(`[profile-cache] ⚠️ 缓存归属(${uid.slice(0, 8)})≠当前用户(${currentUid.slice(0, 8)})，丢弃防串号`);
      return {};
    }
    if (map && typeof map === 'object') return map;
  } catch (e) {
    console.warn('[profile-cache] 读取缓存失败:', e);
  }
  return {};
}

/** 整表覆盖写入（由 store 在完成合并后调用），静默失败不阻塞主流程。
 * 成功/失败都打日志——此前"每次进页都要等网络"的排查关键就在于写入是否真的落盘。 */
export function persistProfileCache(map: ProfileMap): void {
  try {
    Taro.setStorageSync(CACHE_KEY, { uid: readLastUid(), map });
    logDbg(`[profile-cache] 💾 资料缓存已落盘 ${Object.keys(map).length} 份（归属用户: ${readLastUid().slice(0, 8) || '未知'}）`);
  } catch (e) {
    console.warn('[profile-cache] ❌ 写入缓存失败（下次冷启动将无法秒出，需等网络）:', e);
  }
}

/** 登出时清空 */
export function clearProfileCache(): void {
  try {
    Taro.removeStorageSync(CACHE_KEY);
    logDbg('[profile-cache] 🧹 资料缓存已清空（登出）');
  } catch (e) {
    console.warn('[profile-cache] 清空缓存失败:', e);
  }
}
