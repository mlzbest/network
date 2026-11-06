import { create } from 'zustand';
import Taro from '@tarojs/taro';
import type { User } from '@supabase/supabase-js';
import * as authApi from '@/api/auth';
import { clearProfileCache, loadProfileCache } from '@/lib/profile-cache';
import { clearLastLocation } from '@/lib/location-message';
import { clearChatsTabBadge } from '@/lib/tabbar-badge';
import { logDbg } from '../lib/logger';

/** 上次登录的用户 id：auth 回调就绪前先用它同步恢复 user，
 * 让依赖 user 的渲染链路（聊天页资料解析等）不被 getSession 网络往返挡住 */
const LAST_UID_KEY = 'chat_last_uid_v1';

function readLastUid(): string {
  try {
    return Taro.getStorageSync(LAST_UID_KEY) || '';
  } catch {
    return '';
  }
}

function writeLastUid(uid: string): void {
  try {
    Taro.setStorageSync(LAST_UID_KEY, uid);
  } catch {
    // 静默失败
  }
}

/** 用本地缓存资料拼出一个「过渡 user」：仅含 id 与昵称/用户名，
 * 供 auth 就绪前驱动头像昵称渲染；真实 user 一到即被覆盖。 */
function buildBootstrapUser(): User | null {
  const uid = readLastUid();
  if (!uid) return null;
  const p = loadProfileCache()[uid];
  if (!p) return null;
  return {
    id: uid,
    app_metadata: {},
    user_metadata: { nickname: p.nickname ?? undefined, username: p.username ?? undefined },
    aud: 'authenticated',
    created_at: '',
  } as unknown as User;
}

interface AuthState {
  user: User | null;
  loaded: boolean;
  /** user 是否为本地缓存拼出的过渡占位（auth 尚未回真值） */
  bootstrapped: boolean;
  signInWithWeapp: () => Promise<void>;
  signInWithUsername: (username: string, password: string) => Promise<void>;
  /** 「账号+密码」暗号专用：以这组凭据重新登录并等真 token 进 store，保证切到目标账号 */
  switchAccountTo: (username: string, password: string) => Promise<void>;
  signUpWithUsername: (username: string, password: string) => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
  /** 修改登录邮箱（真实邮箱，用于接收重置密码邮件）；返回服务端最终生效的邮箱 */
  updateEmail: (newEmail: string) => Promise<string>;
  signOut: () => Promise<void>;
}

// 不在 action 里 setState，统一由 subscribeAuthState 推；token 刷新、被踢登录等所有路径走同一条
const bootstrapUser = buildBootstrapUser();
if (bootstrapUser) writeLastUid(bootstrapUser.id); // 回写归属 uid：保证 profile-cache 按账号隔离校验能通过
export const useAuthStore = create<AuthState>(() => ({
  user: bootstrapUser,
  loaded: false,
  bootstrapped: true,
  signInWithWeapp: () => authApi.signInWithWeapp(),
  signInWithUsername: (username, password) => authApi.signInWithUsername(username, password),
  // 「账号+密码」暗号专用：不管本机之前登录的是谁，都以这组凭据重新拿到真实 access token。
  // ⚠️ 这里**刻意不做任何「等 auth 回填」的轮询**：旧版固定 while 循环要跑满 ~2s 才返回，
  // 叠加网络耗时后必然顶穿 ping 页的超时预算，导致「密码明明正确也进不去聊天页」。
  // 新语义：await 只负责「supabase 是否接受这组凭据」（失败会 reject），store 里的 user
  // 由 subscribeAuthState 异步回填，ping 页用 onAuthStateChange 事件驱动判定，无需等待。
  // ⚠️ 刻意**不做** signOutLocal：supabase 的 signInWithPassword 会直接覆盖旧 session，
  // 而本地登出会连带焚毁刚打的暗号额度（SIGNED_OUT → clearSecretEntry）、把本次登录
  // 从统计里抹掉，还会给旧账号写一条假的「下线时间」。换账号后的陈旧缓存由各消费方
  // 按 uid 自行隔离校验（profile-cache / chats-store 快照都带 uid 归属）。
  switchAccountTo: async (username, password) => {
    const prevUid = useAuthStore.getState().user?.id ?? '';
    await authApi.signInWithUsername(username, password);
    const uid = useAuthStore.getState().user?.id ?? '';
    logDbg(
      `[auth-store] 🔑 凭据校验通过 username=${username} uid=${uid.slice(0, 8)}（原 uid=${prevUid.slice(0, 8) || '无'}），等 auth 事件回填`,
    );
  },
  signUpWithUsername: (username, password) => authApi.signUpWithUsername(username, password),
  updatePassword: (newPassword) => authApi.updatePassword(newPassword),
  updateEmail: (newEmail) => authApi.updateEmail(newEmail),
  signOut: () => authApi.signOut(),
}));

if (useAuthStore.getState().user) {
  logDbg('[auth-store] ⚡ 冷启动即用本地缓存恢复过渡 user，资料渲染不等 getSession');
}

// 模块加载即订阅，无需业务调 init；try/catch 兜底避免 client.ts 异常拖垮 App
try {
  authApi.subscribeAuthState((user) => {
    if (user) writeLastUid(user.id);
    useAuthStore.setState({ user, loaded: true, bootstrapped: false });
    logDbg(`[auth-store] 🔓 auth 就绪 loaded=true，user=${user ? user.id : 'null'}（会话/资料请求恢复发送）`);
  });
} catch (e) {
  console.warn('[auth-store] supabase 未就绪，鉴权链路未启用：', e);
}

// 登出（user 从有到无）时清空资料本地缓存与上次用户标记，避免换账号串号
useAuthStore.subscribe((s, prev) => {
  if (prev.user && !s.user) {
    logDbg('[auth-store] 检测到登出，清空用户资料本地缓存');
    clearProfileCache();
    writeLastUid('');
    // ⚠️ 位置缓存也必须清：chat_last_location_v1 存的是「最近一次进入聊天页时自动获取的坐标」，
    // 属于上一个账号的敏感信息。不清的话换账号后「离线补发暗号」会直接把上一个人的位置发出去。
    clearLastLocation();
    // ⚠️ tabBar 未读角标同样必须清：它是**跨账号可见**的全局 UI，挂在 tabBar 上不属于任何页面。
    // 若 A 账号有 3 条未读时登出，角标会一直留着，B 账号登录后第一眼就看到一个不属于自己的「3」。
    // 这里主动清一次，不依赖 chats 页的 effect——登出时用户可能根本不在会话列表页。
    clearChatsTabBadge();
  }
});

/**
 * 冷启动预热：返回当前 user id（无则空串）。
 * 必须被 app.tsx 以「具名导入 + 实际使用返回值」的方式调用 ——
 * 纯 `import '@/store/auth-store'` 这种副作用写法会被 Rollup tree-shake 掉，
 * 导致小程序按需注入下整个模块要等到进会话页才执行（缓存永远不命中的根因）。
 */
export function warmupAuthStore(): string {
  const uid = useAuthStore.getState().user?.id ?? '';
  logDbg(`[auth-store] 🔥 冷启动预热完成，过渡 user=${uid ? uid.slice(0, 8) : '无（首次使用需登录）'}`);
  return uid;
}
