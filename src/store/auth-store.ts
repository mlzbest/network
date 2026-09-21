import { create } from 'zustand';
import type { User } from '@supabase/supabase-js';
import * as authApi from '@/api/auth';

interface AuthState {
  user: User | null;
  loaded: boolean;
  signInWithWeapp: () => Promise<void>;
  signInWithAlipay: () => Promise<void>;
  signInWithBaidu: () => Promise<void>;
  signInWithUsername: (username: string, password: string) => Promise<void>;
  signUpWithUsername: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

// 不在 action 里 setState，统一由 subscribeAuthState 推；token 刷新、被踢登录等所有路径走同一条
export const useAuthStore = create<AuthState>(() => ({
  user: null,
  loaded: false,
  signInWithWeapp: () => authApi.signInWithWeapp(),
  signInWithAlipay: () => authApi.signInWithAlipay(),
  signInWithBaidu: () => authApi.signInWithBaidu(),
  signInWithUsername: (username, password) => authApi.signInWithUsername(username, password),
  signUpWithUsername: (username, password) => authApi.signUpWithUsername(username, password),
  signOut: () => authApi.signOut(),
}));

// 模块加载即订阅，无需业务调 init；try/catch 兜底避免 client.ts 异常拖垮 App
try {
  authApi.subscribeAuthState((user) => {
    useAuthStore.setState({ user, loaded: true });
  });
} catch (e) {
  console.warn('[auth-store] supabase 未就绪，鉴权链路未启用：', e);
}
