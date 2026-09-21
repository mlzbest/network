import Taro from '@tarojs/taro';
import { projectUrlId, supabase, supabaseUrl, supabaseAnonKey } from './client';

/**
 * 百度智能小程序一键登录。
 *
 * 流程：
 *   1) Taro.login() 获取 code
 *   2) POST 到 baidu-login Edge Function 换 magiclink token_hash
 *   3) supabase.auth.verifyOtp 写入 Supabase Session
 */
export async function baiduMpLogin(): Promise<void> {
  if (TARO_ENV !== 'swan') {
    throw new Error('百度登录仅在百度智能小程序中可用');
  }

  const loginRes = await Taro.login();
  const code = loginRes?.code;
  if (!code) {
    throw new Error(`百度登录失败: ${loginRes?.errMsg || '未返回 code'}`);
  }

  const res = await Taro.request<{
    token_hash?: string;
    error?: string;
  }>({
    url: `${supabaseUrl}/functions/v1/baidu-login`,
    method: 'POST',
    header: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      'OneDay-App-Id': projectUrlId,
    },
    data: { code },
    timeout: 60000,
  });

  if (res.statusCode === 405) {
    throw new Error('未实现百度登录功能');
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
