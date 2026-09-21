import Taro from '@tarojs/taro';
import { projectUrlId, supabase, supabaseUrl, supabaseAnonKey } from './client';

export interface WxMpLoginResult {
  /** Supabase Session 中的用户 id（auth.users.id），未登录成功时为 null */
  userId: string | null;
  /** 微信小程序 openid */
  openid: string;
  /** 微信开放平台 unionid（仅在小程序绑定开放平台时返回） */
  unionid: string | null;
}

/** Edge Function 返回 code === 'WX_CONFIG_MISSING' 时抛出，前端可识别后给"去配密钥"的引导。 */
export class WxMpConfigMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WxMpConfigMissingError';
  }
}

/**
 * 微信小程序一键登录。
 *
 * 流程：
 *   1) wx.login 获取 code
 *   2) POST 到 wx-mp-login Edge Function 换 magiclink token_hash
 *   3) supabase.auth.verifyOtp 写入 Supabase Session
 *
 * 前置：
 *   - 已部署：edge-runtime deploy --name wx-mp-login --no-jwt
 *   - 已在「云服务 → 登录认证 → 微信登录」配置 WX_APP_ID / WX_APP_SECRET
 *     未配置时本函数会抛出 WxMpConfigMissingError，调用方应给出「去配置密钥」的引导
 *
 * @throws WxMpConfigMissingError 服务端环境变量缺失
 * @throws Error 其他失败原因（wx.login 失败、网络错误、verifyOtp 失败等）
 */
export async function wxMpLogin(): Promise<WxMpLoginResult> {
  if (TARO_ENV !== 'weapp') {
    throw new Error('微信登录仅在微信小程序中可用');
  }

  // 1) wx.login 拿 code
  const loginRes = await Taro.login();
  if (!loginRes.code) {
    throw new Error(`wx.login 失败: ${loginRes.errMsg || '未返回 code'}`);
  }

  // 2) 调用 wx-mp-login Edge Function
  const res = await Taro.request<{
    token_hash?: string;
    user_id?: string | null;
    openid?: string;
    unionid?: string | null;
    code?: string;
    error?: string;
  }>({
    url: `${supabaseUrl}/functions/v1/wx-mp-login`,
    method: 'POST',
    header: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      'OneDay-App-Id': projectUrlId,
    },
    data: { code: loginRes.code },
    timeout: 60000,
  });

  // 服务端环境变量未配置 → 抛出特定错误，调用方可识别并展示引导
  if (res.statusCode === 503 && res.data?.code === 'WX_CONFIG_MISSING') {
    throw new WxMpConfigMissingError(
      res.data.error || '微信登录尚未配置：请到「云服务 → 登录认证 → 微信登录」配置 WX_APP_ID 和 WX_APP_SECRET',
    );
  }
  // 405 Method Not Allowed → wx-mp-login Edge Function 未部署
  if (res.statusCode === 405) {
    throw new Error('未实现微信登录功能');
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(res.data?.error || `登录服务返回 ${res.statusCode}`);
  }
  const { token_hash, user_id, openid, unionid } = res.data;
  if (!token_hash || !openid) {
    throw new Error('登录服务返回数据不完整');
  }

  // 3) verifyOtp 写入 Supabase session
  const { error: verifyError } = await supabase.auth.verifyOtp({
    token_hash,
    type: 'magiclink',
  });
  if (verifyError) {
    throw new Error(`Supabase 登录失败: ${verifyError.message}`);
  }

  return {
    userId: user_id ?? null,
    openid,
    unionid: unionid ?? null,
  };
}
