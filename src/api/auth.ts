import type { User } from '@supabase/supabase-js';
import Taro from '@tarojs/taro';
import { supabase } from '@/supabase/client';
import { wxMpLogin } from '@/supabase/wx-mp-login';

/** store 内部走 onAuthStateChange 不需要这个；业务侧主动取用 */
export async function getCurrentUser(): Promise<User | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}

export async function signInWithWeapp(): Promise<void> {
  await wxMpLogin();
}

export async function signInWithAlipay(): Promise<void> {
  const { alipayMpLogin } = await import('@/supabase/alipay-login');
  await alipayMpLogin();
}

export async function signInWithBaidu(): Promise<void> {
  const { baiduMpLogin } = await import('@/supabase/baidu-login');
  await baiduMpLogin();
}

/**
 * 用户名自动包成 `{username}@meoo.local` 兼容 Supabase 邮箱认证
 * 返回具体错误类型，方便前端展示友好提示
 */
export async function signInWithUsername(username: string, password: string): Promise<void> {
  console.log('[auth] 开始登录, username:', username);
  const email = `${username}@meoo.local`;
  console.log('[auth] 转换后邮箱:', email);

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    console.error('[auth] Supabase 返回错误:', error.message, error.status, error);
    // 根据 Supabase 错误信息分类，返回具体错误类型
    const msg = error.message || '';
    let errorType = 'unknown';
    
    if (msg.includes('Invalid login credentials') || msg.includes('Invalid credentials')) {
      errorType = 'invalid_credentials';
    } else if (msg.includes('User not found') || msg.includes('does not exist')) {
      errorType = 'user_not_found';
    } else if (msg.includes('rate limit') || msg.includes('Too many requests')) {
      errorType = 'rate_limit';
    } else if (msg.includes('email_confirmed') || msg.includes('Email not confirmed')) {
      errorType = 'email_not_confirmed';
    }
    
    throw Object.assign(new Error(error.message), { errorType, status: error.status });
  }

  console.log('[auth] 登录成功, user:', data.user?.id);
}

/** `options.data.username` 透传到 `raw_user_meta_data`，由 `handle_new_user` 触发器写入 profiles */
export async function signUpWithUsername(username: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signUp({
    email: `${username}@meoo.local`,
    password,
    options: { data: { username } },
  });
  if (error) throw new Error(`注册失败: ${error.message}`);
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(`登出失败: ${error.message}`);
}

/** 会话失效后的统一处理:清掉本地过期session,避免auth-js反复自动刷新(预览态会刷"Failed to fetch") */
async function handleExpiredSession(reason: string): Promise<void> {
  console.warn(`[api/auth] ${reason}，已清除过期会话，准备跳转ping页重新进入`);
  try {
    // 静默登出:仅清本地session/storage,不请求服务端(signOut带网络调用,网络断时同样会失败)
    await supabase.auth.signOut({ scope: 'local' });
  } catch (e) {
    console.warn('[api/auth] 清除本地会话失败:', e);
  }
  // 登录过期后统一回到ping入口页(与120秒无操作超时同款机制),由暗号重新进入聊天
  try {
    await Taro.reLaunch({ url: '/pages/ping/index' });
    console.log('[api/auth] 已跳转到ping页面');
  } catch (e) {
    console.warn('[api/auth] 跳转ping页面失败:', e);
  }
}

/** store 注入 setState 用；业务订阅 `useAuthStore` 即可。返回 unsubscribe。 */
export function subscribeAuthState(onChange: (user: User | null) => void): () => void {
  // 初始化时尝试获取 session，token 失效则静默清除
  supabase.auth
    .getSession()
    .then(({ data }) => onChange(data.session?.user ?? null))
    .catch(async (e) => {
      const msg = (e as Error)?.message || '';
      // Refresh token 失效时静默处理，视为未登录
      if (msg.includes('Invalid Refresh Token') || msg.includes('Refresh Token Not Found')) {
        await handleExpiredSession('Refresh Token 已失效');
        onChange(null);
      } else {
        console.warn('[api/auth] getSession 失败：', e);
        onChange(null);
      }
    });

  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((event, session) => {
    // auth-js 自动刷新失败(TOKEN_REFRESH_FAILED/NETWORK_ERROR)时不会抛异常到这里,
    // 但事件可用于兜底;真正需要处理的是刷新后仍拿不到有效会话的INITIAL_SESSION场景
    if (event === 'SIGNED_OUT') {
      onChange(null);
      return;
    }
    onChange(session?.user ?? null);
  });

  return () => subscription.unsubscribe();
}
