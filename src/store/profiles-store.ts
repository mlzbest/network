import { create } from 'zustand';
import { supabase } from '@/supabase/client';
import type { Profile } from '@/api/profiles';
import * as profilesApi from '@/api/profiles';
import { loadProfileCache, persistProfileCache, clearProfileCache } from '@/lib/profile-cache';
import { useAuthStore } from './auth-store';
import { logDbg } from '../lib/logger';

/**
 * 全局用户资料 store：唯一一份「id → 资料」内存映射，底层以本地缓存为初始数据源。
 *
 * 为什么需要它：此前各页面各自读 profile-cache + 各自发 profiles 请求，
 * 同一份资料被重复拉取、且聊天页的资料预取挂在「登录态已就绪」之后，
 * 导致即使缓存里有内容也要等 auth 完成才开始渲染 —— 这是头像不秒出的主因。
 *
 * 设计要点：
 * - 模块加载即同步读本地缓存 → 冷启动第一帧内存里就有资料；
 * - ensureProfiles(ids) 命中即返回，缺失者合并成一次批量请求，并发去重；
 * - 任何来源（会话列表 / 消息 / 改资料）拿到的资料都 upsert 进来 → 全页面共享并自动刷新。
 */

type ProfileMap = Record<string, Profile>;

interface ProfilesState {
  /** id → 资料 的全局映射（所有消费方只读派生，不直接改） */
  byId: ProfileMap;
  /** 按 id 取一份资料（无则 undefined） */
  get: (id: string) => Profile | undefined;
  /** 确保拿到这批 id 的资料：命中直接返回，缺失者一次批量补拉（并发去重） */
  ensure: (ids: string[]) => Promise<void>;
  /** 强制重新拉取指定 id（改资料后想让最新值立刻生效时用） */
  refresh: (ids: string[]) => Promise<void>;
  /** 外部（会话列表/消息列表等）已拿到的资料并入全局 */
  upsert: (profiles: Profile[]) => void;
  reset: () => void;
}

/** 进行中的补拉请求：同一批 id 并发调用 ensure 时复用同一个 Promise，避免重复打网络 */
const inflight = new Map<string, Promise<void>>();

/** 已确认下载成功过的头像 URL：用于预热去重（URL 带时间戳天然唯一，改图即换 key） */
export const avatarLoadedUrls = new Set<string>();

/** 头像预热：资料一入 store 就提前下载，聊天气泡渲染时直接命中图片缓存。
 * H5 端 new Image() 即可；小程序端 <Image> 不是全局构造函数，
 * 尝试通过原生 wx.createImage（部分基础库提供），否则静默跳过。 */
export function preloadAvatar(url: string | null | undefined): void {
  if (!url || avatarLoadedUrls.has(url)) return;
  try {
    const g = globalThis as unknown as {
      Image?: new () => { src: string; onload: () => void; onerror: () => void };
      wx?: { createImage?: () => { src: string; onload: () => void; onerror: () => void } };
    };
    let img: { src: string; onload: () => void; onerror: () => void } | null = null;
    if (typeof g.Image === 'function') img = new g.Image();
    else if (typeof g.wx?.createImage === 'function') img = g.wx.createImage();
    if (!img) return;
    img.onload = () => {
      avatarLoadedUrls.add(url);
      logDbg(`[profiles-store] 🖼️ 头像预热成功: ${url.slice(0, 50)}`);
    };
    img.onerror = () => {
      console.warn(`[profiles-store] ⚠️ 头像预热失败（渲染时再试）: ${url.slice(0, 50)}`);
    };
    img.src = url;
  } catch {
    // 预热失败不影响主流程
  }
}

function stableKey(ids: string[]): string {
  return [...ids].sort().join(',');
}

const initialCache = loadProfileCache();
logDbg(`[profiles-store] 🧊 模块加载，本地缓存 hydrate ${Object.keys(initialCache).length} 份资料`);

export const useProfilesStore = create<ProfilesState>((set, get) => ({
  // 同步读本地缓存作为初值：进页首帧即可拿到上次用过的头像昵称
  byId: initialCache,

  get: (id) => get().byId[id],

  ensure: async (ids) => {
    const t0 = Date.now();
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    if (uniq.length === 0) return;
    const missing = uniq.filter((id) => !get().byId[id]);
    if (missing.length === 0) {
      logDbg(`[profiles-store] ⚡ ${uniq.length} 个 id 全部命中内存，无需请求 (${Date.now() - t0}ms)`);
      return;
    }
    const key = stableKey(missing);
    const pending = inflight.get(key);
    if (pending) {
      logDbg(`[profiles-store] ♻️ 复用进行中的补拉请求(${missing.length} 人)`);
      return pending;
    }
    const task = (async () => {
      try {
        logDbg(`[profiles-store] 🌐 内存缺失 ${missing.length} 人 → 一次批量拉取 profiles`);
        const list = await profilesApi.fetchProfilesByIds(missing);
        get().upsert(list);
        logDbg(`[profiles-store] ✅ 补拉完成 ${list.length} 份，总耗时 ${Date.now() - t0}ms`);
      } catch (e) {
        console.warn('[profiles-store] 批量拉取资料失败，头像昵称降级显示:', e);
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, task);
    return task;
  },

  refresh: async (ids) => {
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    if (uniq.length === 0) return;
    try {
      const list = await profilesApi.fetchProfilesByIds(uniq, true);
      get().upsert(list);
      logDbg(`[profiles-store] 🔄 强制刷新 ${list.length}/${uniq.length} 份资料`);
    } catch (e) {
      console.warn('[profiles-store] 强制刷新资料失败:', e);
    }
  },

  upsert: (profiles) => {
    const fresh = (profiles ?? []).filter((p) => p && p.id);
    if (fresh.length === 0) return;
    set((state) => {
      const next: ProfileMap = { ...state.byId };
      for (const p of fresh) next[p.id] = p;
      // 头像 URL 一旦变化（改头像），让旧图缓存失效，避免 <Image src> 命中旧图不更新
      for (const p of fresh) {
        const old = state.byId[p.id];
        if (old && old.avatar_url !== p.avatar_url && old.avatar_url) avatarLoadedUrls.delete(old.avatar_url);
      }
      persistProfileCache(next);
      return { byId: next };
    });
    logDbg(`[profiles-store] ⬆️ 并入 ${fresh.length} 份资料，全局现有 ${Object.keys(get().byId).length} 份`);
    // 预热：小程序端用 Image 组件把头像提前下载进微信图片缓存（同 URL 二次渲染直接命中）；
    // H5 端 preloadAvatar 走 new Image()。两端各自静默失败不阻塞。
    for (const p of fresh) preloadAvatar(p.avatar_url);
  },

  reset: () => {
    clearProfileCache();
    inflight.clear();
    set({ byId: {} });
    logDbg('[profiles-store] 🧹 已清空全局资料（登出），防止换账号串号');
  },
}));

// 登出时清空（沿用项目既有 subscribe 模式）
useAuthStore.subscribe((s, prev) => {
  if (prev.user && !s.user) useProfilesStore.getState().reset();
});

// ⚠️ 「账号+密码」暗号切账号是 user A → user B 的**原地换人**（switchAccountTo 刻意不做本地
// 登出，避免焚毁暗号额度/抹掉登录统计），上面的登出分支不会触发。资料缓存本身带 uid 归属校验
// （profile-cache 读时比对 chat_last_uid_v1），但内存 byId 是跨账号累积的——不重置会让新账号
// 首帧直接渲染出旧账号那批人的头像昵称，且 persistProfileCache 会把它们再写回缓存。
let lastSeenProfileUid = useAuthStore.getState().user?.id ?? '';
useAuthStore.subscribe((s) => {
  const uid = s.user?.id ?? '';
  if (uid && uid !== lastSeenProfileUid) {
    logDbg(`[profiles-store] 🔁 账号变更(${lastSeenProfileUid.slice(0, 8) || '无'}→${uid.slice(0, 8)})，清空上一账号资料内存映射`);
    lastSeenProfileUid = uid;
    useProfilesStore.getState().reset();
  } else if (!s.user) {
    lastSeenProfileUid = '';
  }
});

/** 便捷读取：在 React 外（api 层）按 id 取一份已入全局的资料 */
export function getCachedProfileById(id: string): Profile | undefined {
  if (!id) return undefined;
  return useProfilesStore.getState().byId[id];
}

/**
 * 冷启动预热：返回内存中已有的资料份数。
 * 必须被 app.tsx 以「具名导入 + 实际使用返回值」的方式调用 ——
 * 纯 `import '@/store/profiles-store'` 副作用写法会被 Rollup tree-shake 掉，
 * 小程序按需注入下整个模块要等到进会话页才执行，
 * 本地缓存 hydrate 就永远赶不上首屏（头像每次等网络的根因）。
 */
export function warmupProfilesStore(): number {
  const count = Object.keys(useProfilesStore.getState().byId).length;
  logDbg(`[profiles-store] 🔥 冷启动预热完成，内存现有 ${count} 份资料`);
  return count;
}

/**
 * ⚠️ 全局 Realtime 订阅：监听 profiles 表的所有 UPDATE 事件，即时更新内存映射。
 *
 * 【为什么需要它】此前 profiles-store 完全依赖被动拉取（ensure/refresh），
 * 对方修改昵称/头像后，当前用户只有在下一次 ensure() 或手动 refresh() 时才能看到变更。
 * 这导致聊天页顶部对方信息延迟高达 30 秒（轮询间隔），体验极差。
 *
 * 【工作原理】模块加载时即建立订阅，不受 auth 状态影响。
 * RLS 会自动过滤，只推送当前用户有权看到的行（所有人可读，故全量推送）。
 * 收到事件后直接用 payload.new 更新 store，零网络延迟。
 *
 * 【WAL REPLICA IDENTITY 注意】PostgreSQL 默认 FULL 模式，payload.new 包含完整行数据。
 * 若未来改为 MINIMAL 模式，payload.new 可能缺列，需降级为 refresh() 重新拉取。
 */
try {
  const profilesChannel = supabase.channel('profiles-global-realtime');
  profilesChannel
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'profiles' },
      (payload) => {
        const updated = payload.new as Profile;
        if (updated?.id) {
          // 直接用 payload 更新 store，避免网络往返
          useProfilesStore.getState().upsert([updated]);
          logDbg(`[profiles-store] 📡 Realtime 即时更新: ${updated.id} (${updated.nickname || updated.username})`);
        }
      },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        logDbg('[profiles-store] ✅ profiles 全局 Realtime 订阅已建立');
      } else if (status === 'CHANNEL_ERROR') {
        console.warn('[profiles-store] ⚠️ profiles Realtime 订阅失败，降级为轮询模式');
      }
    });
} catch (e) {
  // supabase client 未初始化时的兜底（理论上不会发生，因为本模块在 app.tsx 之后加载）
  console.warn('[profiles-store] ⚠️ 无法建立 profiles Realtime 订阅:', e);
}
