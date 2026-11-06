import Taro from '@tarojs/taro';
import { cloudAuth } from './cloud-adapter';
import {
  getWorkBuddyCloudClient,
  isCloudAuth,
  projectUrlId,
  supabase,
  supabaseAnonKey,
  supabaseUrl,
} from './client';

declare const wx: {
  getAccountInfoSync?: () => { miniProgram?: { appId?: string } };
};

export interface WxMpLoginResult {
  /**
   * 登录后的用户 id。
   *  - legacy：Supabase auth.users.id（业务 profiles.id 与之相同）
   *  - cloud：TCB custom uid，形如 `wx:<openid>`
   */
  userId: string | null;
  /** 微信小程序 openid */
  openid: string;
  /** 微信开放平台 unionid（仅在小程序绑定开放平台时返回） */
  unionid: string | null;
}

/**
 * 云端未配置微信登录或小程序 appid 缺失时抛出，前端可识别后给「去配密钥」的引导。
 * 保留旧类名与语义，减少 `src/api/auth.ts` 等调用方的改动。
 */
export class WxMpConfigMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WxMpConfigMissingError';
  }
}

/**
 * cloud 分支：wx.login code + appid 直接换成 WorkBuddy Cloud 会话。
 * 仅在 `VITE_AUTH_BACKEND=cloud` 时使用。
 */
async function cloudWxLogin(code: string): Promise<WxMpLoginResult> {
  // 触发一次云端客户端初始化：endpoint / publishableKey 缺失时在这里就明确报配置错。
  getWorkBuddyCloudClient();

  const appid = wx.getAccountInfoSync?.()?.miniProgram?.appId;
  if (!appid) {
    throw new WxMpConfigMissingError(
      '未获取到微信小程序 appid，请确认微信开发者工具已配置 appid 或真机运行',
    );
  }

  const { data, error } = await cloudAuth.signInWithWechat(code, appid);
  if (error || !data) {
    throw new WxMpConfigMissingError(
      `云端微信登录失败: ${error?.message || '未知错误'}`,
    );
  }

  const cloudUserId = data.user.id;
  const openid = cloudUserId.startsWith('wx:') ? cloudUserId.slice(3) : cloudUserId;
  return { userId: cloudUserId, openid, unionid: null };
}

/**
 * legacy 分支（默认）：复用旧的 `wx-mp-login` Edge Function。
 *
 * 该部署为 `-j false`，登录前无需 access_token；服务端用 service_role 建号并
 * 生成 magiclink 的 `hashed_token`，前端再用 `auth.verifyOtp` 换成与用户名密码
 * 登录完全相同的 Supabase 会话，保证业务数据 / RLS / Realtime 走同一套身份。
 */
async function legacyWxLogin(code: string): Promise<WxMpLoginResult> {
  const res = await Taro.request<{
    token_hash?: string;
    user_id?: string;
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
    data: { code },
    timeout: 30000,
  });

  const body = res.data;
  if (res.statusCode < 200 || res.statusCode >= 300 || !body?.token_hash) {
    const msg = body?.error || `服务端返回 ${res.statusCode}`;
    if (res.statusCode === 503 || body?.code === 'WX_CONFIG_MISSING') {
      throw new WxMpConfigMissingError(msg);
    }
    throw new Error(`微信登录失败: ${msg}`);
  }

  const { error } = await supabase.auth.verifyOtp({
    token_hash: body.token_hash,
    type: 'magiclink',
  });
  if (error) {
    throw new Error(`微信登录失败: ${error.message}`);
  }

  return {
    userId: body.user_id ?? null,
    openid: body.openid ?? '',
    unionid: body.unionid ?? null,
  };
}

/**
 * 微信小程序一键登录。按当前鉴权后端自动分流：
 * 默认 legacy（用户名密码体系所在栈），`VITE_AUTH_BACKEND=cloud` 时走 WorkBuddy SDK。
 */
export async function wxMpLogin(): Promise<WxMpLoginResult> {
  if (TARO_ENV !== 'weapp') {
    throw new Error('微信登录仅在微信小程序中可用');
  }

  const loginRes = await Taro.login();
  if (!loginRes.code) {
    throw new Error(`wx.login 失败: ${loginRes.errMsg || '未返回 code'}`);
  }

  return isCloudAuth ? cloudWxLogin(loginRes.code) : legacyWxLogin(loginRes.code);
}
