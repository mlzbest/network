/**
 * ai-chat — WorkBuddy Cloud 版 LLM 适配层
 *
 * 替代原 `functions/ai-chat/index.ts` 的「平台 Meoo AI 通道」与「模型目录」：
 *   - 流式对话  → cloudLlm.chat（WorkBuddy LLM 网关）
 *   - 模型目录  → cloudLlm.models
 *
 * 不再需要的环境变量：
 *   - MEOO_PROJECT_API_KEY / MEOO_PROJECT_API_KEY_{urlId}
 *   - MEOO_AI_BASE_URL（https://api.meoo.host）
 *
 * 仍需外部承载（保留旧 functions/ai-chat 入口，调用侧显式降级）：
 *   - ASR 通道（百度 / OpenAI 兼容 /audio/transcriptions）—— 依赖 Deno env + 第三方密钥
 *   - relay 通道（自定义 baseUrl + apiKey 直连）—— 白名单校验 + Key 服务端注入
 *   - 预热通道（warmupAiChat）—— 纯加速，云端 SDK 直接走 LLM 网关，无需预热
 *
 * 本文件是「适配层」，不是完整 Edge Function。
 * 业务侧 `src/api/ai.ts` 在正式切换外部承载前，调用路径保持不变（仍打 `functions/ai-chat`），
 * 等外部承载部署完成后再切到本文件导出的 `cloudLlm` 面。
 */

import { cloudLlm } from '@/supabase/cloud-adapter';

export interface CloudChatMessage {
  role: string;
  content: string;
}

export interface CloudChatStreamOptions {
  /** 目标模型 id；缺省走云端默认 */
  model?: string;
  /** 客户端中断信号（与 src/lib/sse 的 signal 同构） */
  signal?: { aborted: boolean };
  /** 接收增量文本 */
  onChunk: (text: string) => void;
}

/**
 * 发起一次云端流式补全。
 * 返回 handle（含 abort + done），与 `src/api/ai.ts` 的 `LlmStreamHandle` 契约对齐。
 */
export function cloudLlmStream(
  messages: CloudChatMessage[],
  model: string,
  onChunk: (text: string) => void,
  options: { signal?: { aborted: boolean } } = {},
) {
  let aborted = false;
  let stopSignal: { aborted: boolean } | undefined = options.signal;

  const done = new Promise<string>((resolve, reject) => {
    let fullText = '';

    // 云端 LLM 网关：cloudLlm.chat.completions.create() 返回 AsyncIterable<ChatCompletionChunk>
    // chunk.choices[0].delta.content 即增量文本
    (async () => {
      const stream = cloudLlm.chat.completions.create({
        model: model || 'qwen3.6-plus',
        messages: messages as any,
        stream: true,
      } as any);

      try {
        for await (const chunk of stream) {
          if (aborted || stopSignal?.aborted) {
            if (fullText) resolve(fullText);
            else reject(new Error('__ABORTED__'));
            return;
          }
          const content = chunk?.choices?.[0]?.delta?.content;
          if (typeof content === 'string' && content) {
            fullText += content;
            onChunk(content);
          }
        }
        if (fullText) resolve(fullText);
        else reject(new Error('未收到模型回复，请稍后重试'));
      } catch (e) {
        if (aborted || stopSignal?.aborted) {
          if (fullText) resolve(fullText);
          else reject(new Error('__ABORTED__'));
          return;
        }
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });

  return {
    abort: () => {
      aborted = true;
      // 标记式中断：异步迭代器在下次 yield 时检测 aborted 并退出
    },
    done,
  };
}

/** 拉取云端模型目录；任何失败返回 null（调用方保留缓存/兜底列表）。 */
export async function fetchCloudModelCatalog(): Promise<string[] | null> {
  try {
    // cloudLlm.models.list() 返回 PublicLLMModel[]，取 id 即可
    const models = await (cloudLlm.models as unknown as { list: () => Promise<Array<{ id?: string; enabled?: boolean }>> }).list();
    if (Array.isArray(models) && models.length > 0) {
      return models.map((x) => x.id ?? '').filter(Boolean);
    }
    return null;
  } catch (e) {
    console.warn('[cloudLlm] 模型目录拉取失败:', e);
    return null;
  }
}

/**
 * ASR / relay 外部承载标记。
 *
 * 这两个通道在 WorkBuddy Cloud SDK 里没有直接等价面：
 * - ASR：依赖百度 OAuth 密钥 / OpenAI 兼容 /audio/transcriptions
 * - relay：白名单 + 第三方密钥注入
 *
 * 正式切换外部承载（TCB / 阿里云函数 / Cloudflare Workers）前，
 * `src/api/asr.ts` 与 `src/api/ai.ts` 的 relay 分支仍走原 `functions/ai-chat`，
 * 调用侧在此显式标注「需外部承载」，避免本地测试期被误当可用能力。
 */
export const ASR_EXTERNAL_REQUIRED = true;
export const RELAY_EXTERNAL_REQUIRED = true;
