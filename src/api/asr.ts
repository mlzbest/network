import Taro from '@tarojs/taro';
import { projectUrlId, resolveCloudFnUrl, supabase, supabaseAnonKey } from '@/supabase/client';
import { logDbg } from '../lib/logger';

/**
 * 语音转文字前端封装。
 *
 * 调用承载层 `asr` 函数（百度 / OpenAI 兼容 ASR 的 Key 全在服务端环境变量里，
 * 前端永不接触）。
 *
 * ⚠️ Task #8/#9 切换：优先走 `VITE_CLOUD_FN_BASE_URL + /asr`（TCB 承载层）；
 *    未配置承载层 URL 时回落旧的 `supabaseUrl + /functions/v1/ai-chat`（asr 分支）。
 *
 * 与 ai-chat 文本通道的区别：识别是一次性 JSON 请求（不是 SSE 流），所以走普通 Taro.request；
 * 也**不能**复用 sseRequest —— 那条链路为流式解码设计，对单包 JSON 反而更容易出问题。
 */

// 承载层函数名 = asr；旧入口复用 ai-chat（asr 分支曾合并其中）。resolveCloudFnUrl
// 会自动判定「已配置承载层 → 承载层 URL；未配置 → 回落旧 ai-chat」。
const FUNCTION_URL = resolveCloudFnUrl('asr', 'ai-chat');

/** 识别超时：函数侧下载音频 20s + 上游识别，前端整体留到 45s */
const REQUEST_TIMEOUT_MS = 45_000;

/** 把各种失败形态翻译成用户能看懂的中文（不暴露内部状态码/第三方信息） */
function toFriendlyMessage(statusCode: number, rawError?: string): string {
  if (statusCode === 503) {
    return '云端识别还没开通：需要在密钥管理里配置语音识别服务的密钥后重新启用。这条语音暂时转不了。';
  }
  if (statusCode === 415) return '这条语音是旧格式录的，识别服务不支持；新发送的语音可以转文字';
  if (statusCode === 404) return '这条语音的文件已经不在了，无法识别';
  if (statusCode === 429) return '识别请求太频繁，稍等一会儿再试';
  if (statusCode === 413) return '这段语音太长了，暂时识别不了';
  if (statusCode === 400) return rawError || '这条语音没法识别';
  if (statusCode === 401 || statusCode === 403) return '登录状态已失效，请重新进入后再试';
  if (statusCode >= 500) return '识别服务繁忙，请稍后重试';
  return rawError || '识别失败，请重试';
}

/**
 * 识别一条语音消息。
 * @param mediaUrl messages.media_url（本项目 chat-media 桶的公开地址）
 * @returns 识别出的文字；空串表示「没听清内容」
 * @throws Error 携带中文可读文案，页面直接 toast 即可
 */
export async function transcribeVoice(mediaUrl: string): Promise<string> {
  if (!mediaUrl) throw new Error('这条语音还没有上传完成，稍后再试');

  // ai-chat 是 verify_jwt=false，函数内部不校验 token；这里仍带 session token（有则带）
  // 与 apikey，保持与其他调用点一致的鉴权头形态。
  const session = (await supabase.auth.getSession()).data.session;
  const token = session?.access_token || supabaseAnonKey;

  let res: Taro.request.SuccessCallbackResult<{ text?: string; error?: string }>;
  try {
    res = await Taro.request({
      url: FUNCTION_URL,
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnonKey,
        'OneDay-App-Id': projectUrlId,
      },
      // asr:true 是分流开关——ai-chat 靠它把请求路由到语音识别分支（该分支不要求 messages）
      data: { asr: true, audioUrl: mediaUrl },
      timeout: REQUEST_TIMEOUT_MS,
    });
  } catch (e) {
    const errMsg = (e as { errMsg?: string })?.errMsg || '';
    console.warn('[asr] ⚠️ 请求发出后失败:', errMsg || e);
    throw new Error(/timeout/i.test(errMsg) ? '识别超时了，请重试' : '网络不太顺畅，识别失败，请重试');
  }

  const status = res.statusCode;
  const payload = res.data ?? {};
  if (status < 200 || status >= 300) {
    console.warn(`[asr] ⚠️ 识别未成功 status=${status} error=${String(payload.error ?? '')}`);
    throw new Error(toFriendlyMessage(status, typeof payload.error === 'string' ? payload.error : undefined));
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  logDbg(`[asr] ✅ 识别完成 textLength=${text.length}`);
  return text;
}
