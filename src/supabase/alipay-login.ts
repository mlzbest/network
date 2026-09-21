import Taro from '@tarojs/taro';
import { projectUrlId, supabase, supabaseUrl, supabaseAnonKey } from './client';

/**
 * 支付宝小程序一键登录。
 *
 * 流程：
 *   1) Taro.login() 获取 authCode
 *   2) POST 到 alipay-login Edge Function 换 magiclink token_hash
 *   3) supabase.auth.verifyOtp 写入 Supabase Session
 */
export async function alipayMpLogin(): Promise<void> {
  if (TARO_ENV !== 'alipay') {
    throw new Error('支付宝登录仅在支付宝小程序中可用');
  }

  const loginRes = await Taro.login();
  const authCode = loginRes?.code;
  if (!authCode) {
    throw new Error(`支付宝登录失败: ${loginRes?.errMsg || '未返回 authCode'}`);
  }

  const res = await Taro.request<{
    token_hash?: string;
    error?: string;
  }>({
    url: `${supabaseUrl}/functions/v1/alipay-login`,
    method: 'POST',
    header: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      'OneDay-App-Id': projectUrlId,
    },
    data: { auth_code: authCode },
    timeout: 60000,
  });

  if (res.statusCode === 405) {
    throw new Error('未实现支付宝登录功能');
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(res.data?.error || `登录服务返回 ${res.statusCode}`);
  }

  const { token_hash } = res.data;
  if (!token_hash) {
    throw new Error('登录服务返回数据不完整');
  }

  const { error } = await supabase.auth.verifyOtp({
    token_hash,
    type: 'magiclink',
  });
  if (error) {
    throw new Error(`Supabase 登录失败: ${error.message}`);
  }
}
