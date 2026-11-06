/**
 * AI 请求层：
 * - fetchModelCatalog：GET ai-chat 拉运行时模型目录（失败返回 null，前端保留旧列表）
 * - requestLLMStream：流式对话。平台模型与自定义第三方模型均走 ai-chat；
 *   自定义通道以 body.relay=true + baseUrl/apiKey 触发函数内的中转分支（原 ai-relay 已合并）。
 * 统一用 @/lib/sse 的 sseRequest()，禁止手写 chunked 解析。
 */
import Taro from '@tarojs/taro';
import { sseRequest, isAbortError, isTimeoutError } from '@/lib/sse';
import type { ChatMessage, CustomModel } from '@/lib/ai-store';
import { DEFAULT_MODEL } from '@/lib/ai-store';
import { projectUrlId, resolveRelayUrl } from '@/supabase/client';
import { cloudLlmStream, fetchCloudModelCatalog } from '@/cloud-fn-adapter/ai-chat.cloud';
import { logDbg } from '../lib/logger';

/**
 * ⚠️ Task #8/#9 过渡形态：
 * - 平台 LLM 主通道已切到 WorkBuddy Cloud（`cloudLlmStream` / `fetchCloudModelCatalog`），
 *   不再依赖 `MEOO_PROJECT_API_KEY` 注入的 `supabaseUrl + /functions/v1/ai-chat` 平台分支。
 * - 自定义 relay 通道：优先走承载层 `VITE_CLOUD_FN_RELAY_URL`（Cloudflare Workers），
 *   未配置时回落旧的 `supabaseUrl + /functions/v1/ai-chat`（relay 分支）。
 * - ASR 通道已拆到 `src/api/asr.ts`（承载层 `asr` 函数）。
 */
// relay 通道：承载层 Cloudflare Workers URL（resolveRelayUrl 自动回落旧 ai-chat relay 分支）
const AI_CHAT_URL = resolveRelayUrl();

function baseHeaders(): Record<string, string> {
  return { 'OneDay-App-Id': projectUrlId };
}

/**
 * 预热云端 LLM 网关：WorkBuddy Cloud 没有 Edge Function 冷启动概念，但 SDK 首次
 * 建立 fetch / SSE 流仍有 TLS 握手开销。这里发一个 1 token 最小请求让连接建立。
 * 任何失败静默吞掉——纯加速通道，不参与业务判定。
 */
export function warmupAiChat(): void {
  try {
    const handle = cloudLlmStream(
      [{ role: 'user', content: 'ok' }],
      DEFAULT_MODEL,
      () => {
        /* 丢弃 */
      },
      { signal: { aborted: false } },
    );
    void handle.done.catch(() => {
      /* 预热失败静默吞掉 */
    });
    logDbg('[ai] 🔥 云端 LLM 预热已发起');
  } catch (e) {
    logDbg('[ai] 预热异常(忽略):', e);
  }
}

/**
 * 拉取云端模型目录（`cloudLlm.models.list`）。
 * 任何失败返回 null，调用方保留缓存/兜底列表。
 */
export async function fetchModelCatalog(): Promise<string[] | null> {
  const ids = await fetchCloudModelCatalog();
  if (ids && ids.length > 0) {
    logDbg('[ai] 云端模型目录拉取成功:', ids.length, '条');
  } else {
    logDbg('[ai] 云端模型目录不可用，使用兜底列表');
  }
  return ids;
}

export interface StreamOptions {
  /** 传入则走 ai-chat 的 relay 分支直连第三方 */
  custom?: CustomModel;
  signal?: { aborted: boolean };
}

/** 流式请求句柄：`abort()` 主动中断，`done` 是本次补全的 Promise */
export interface LlmStreamHandle {
  abort: () => void;
  done: Promise<string>;
}

/**
 * 发起一次流式补全。onChunk 收增量文本；`done` resolve 全文、reject 错误。
 *
 * ⚠️ 必须返回 handle（含 abort），不能只返回 Promise：调用方（AI 聊天页）需要
 *    在「用户点停止 / 切页 / 连续发送」时真正中断底层请求。早期只返回 Promise，
 *    页面拿不到 abort 句柄 → 停止按钮是空操作、切页后请求仍在飞，微信底层中断时
 *    回 `request:fail interrupted` 冒成「请求失败」toast（用户实测报过）。
 */
export function requestLLMStream(
  messages: ChatMessage[],
  model: string,
  onChunk: (text: string) => void,
  options: StreamOptions = {},
): LlmStreamHandle {
  const { custom } = options;
  const url = AI_CHAT_URL;
  const body: Record<string, unknown> = custom
    ? { relay: true, baseUrl: custom.baseUrl, apiKey: custom.apiKey, model: custom.modelId, messages, stream: true }
    : { model, messages, stream: true };

  let handle: { abort: () => void } | null = null;
  let aborted = false;

  const done = new Promise<string>((resolve, reject) => {
    let fullText = '';
    let errorMessage = '';
    handle = sseRequest({
      url,
      method: 'POST',
      headers: baseHeaders(),
      body,
      onMessage: (ev) => {
        if (ev.data === '[DONE]') return;
        try {
          const parsed = JSON.parse(ev.data);
          const content = parsed?.choices?.[0]?.delta?.content;
          // reasoning 模型（如 qwen3.8 系列）会先推 reasoning_content，仅静默跳过，不算错误
          if (typeof content === 'string' && content) {
            fullText += content;
            onChunk(content);
          } else if (parsed?.error) {
            errorMessage = typeof parsed.error === 'string' ? parsed.error : parsed.error.message || '上游返回错误';
          }
        } catch {
          // 非 SSE JSON 行（如错误体整体），留待 onDone/onError 处理
          if (ev.data.includes('"error"')) {
            try {
              errorMessage = JSON.parse(ev.data).error || errorMessage;
            } catch {
              /* ignore */
            }
          }
        }
      },
      onDone: () => {
        if (fullText) resolve(fullText);
        else reject(new Error(errorMessage || '未收到模型回复，请稍后重试'));
      },
      onError: (err: unknown) => {
        // 主动中断不是失败：已收内容照常 resolve，让调用方保留气泡而不是弹「请求失败」。
        // ⚠️ 微信中断回的是 `{ errMsg: 'request:fail interrupted' }`（非 Error 实例），
        //    必须走 isAbortError 判断，只判 `aborted` 会漏掉底层先中断的竞态。
        if (aborted || isAbortError(err)) {
          logDbg('[ai] 流式请求已中断(预期行为), 已收长度:', fullText.length);
          if (fullText) resolve(fullText);
          else reject(new Error('__ABORTED__'));
          return;
        }
        // 超时：已收内容必须保留（上层据此「保留气泡 + 提示超时」而不是整条丢弃）。
        // 服务端日志会同时出现 `stream failed: The stream controller cannot close or
        // enqueue`——那是客户端断开后服务端仍在写，属同一事件的另一端，不是独立故障。
        const e = err as { message?: string; errMsg?: string };
        const raw = e?.message || e?.errMsg || '';
        if (raw === '__TIMEOUT__' || isTimeoutError(err)) {
          logDbg('[ai] 流式请求超时, 已收长度:', fullText.length);
          if (fullText) resolve(fullText);
          else reject(new Error('__TIMEOUT__'));
          return;
        }
        reject(new Error(raw || errorMessage || '请求失败'));
      },
    });
  });

  return {
    abort: () => {
      aborted = true;
      handle?.abort();
    },
    done,
  };
}
