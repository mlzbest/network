/**
 * ai-relay — 承载层：自定义第三方模型接口中转（Cloudflare Workers 版）
 *
 * 替代旧 `functions/ai-chat` 的 `relay:true` 分支（原 `ai-relay` 已合并至 ai-chat，
 * 现拆出独立承载层函数）。Cloudflare Workers 国际出站稳定，白名单校验 +
 * 服务端密钥注入，前端零接触第三方 API Key。
 *
 * 部署：Cloudflare Workers（`wrangler deploy`），注入 `RELAY_WHITELIST`（JSON 字符串）。
 *
 * 请求：POST { baseUrl, apiKey?, model, messages }
 * 响应：透传上游 SSE 流（text/event-stream）；上游错误时转发状态码 + 脱敏摘要。
 *
 * 安全约束（与旧 ai-chat relay 分支一致）：
 * - baseUrl 必须 https、无凭据、host 命中 RELAY_WHITELIST 且非裸 IP/内网
 * - apiKey 客户端传入（单次请求内存使用，不落库不打日志）
 * - 白名单未命中直接 400，不给「免费代理」机会
 */

interface ChatMessage {
  role: string;
  content: string;
}

interface RelayRequest {
  baseUrl: unknown;
  apiKey?: unknown;
  model: unknown;
  messages: unknown;
}

const CLOUDFLARE_HOST = 'cloudflare.com';

/** 白名单 host 后缀（与旧 ai-chat 的 ALLOWED_HOST_SUFFIXES 对齐，可经 RELAY_WHITELIST 扩展） */
const DEFAULT_WHITELIST: string[] = [
  'deepseek.com',
  'moonshot.cn',
  'moonshotai.com',
  'moonshot.ai',
  'bigmodel.cn',
  'dashscope.aliyuncs.com',
  'aliyuncs.com',
  'openai.com',
  'chatgpt.com',
  'volces.com',
  'siliconflow.cn',
  'minimaxi.com',
  'minimax.io',
  'xaminim.com',
  'apiyi.com',
  'together.ai',
  'fireworks.ai',
  'groq.com',
  'mistral.ai',
  'openrouter.ai',
  'zenmux.ai',
  'aicoder.com.cn',
  'agnes-ai.com',
  'agnes.ai',
  'agnesai.com',
  'agnes-ai.cn',
];

/** 解析 RELAY_WHITELIST 环境变量（JSON 数组字符串）；未配置时回落到内置默认白名单 */
function resolveWhitelist(): string[] {
  const raw = (globalThis as unknown as { RELAY_WHITELIST?: string }).RELAY_WHITELIST;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
        return parsed as string[];
      }
    } catch {
      // 非合法 JSON，回落到默认白名单（不抛错中断请求）
    }
  }
  return DEFAULT_WHITELIST;
}

/** 校验目标地址：必须 https、无凭据、host 命中白名单后缀且非 IP 内网段 */
function validateBaseUrl(raw: unknown, whitelist: string[]): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  // 拒绝裸 IP（防内网/元数据探测）
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost' || host.endsWith('.local')) return null;
  const allowed = whitelist.some((s) => host === s || host.endsWith(`.${s}`));
  if (!allowed) return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/** 把上游 SSE 流透传给客户端，统计块数与字节数便于排障 */
function passthroughStream(upstream: Response, requestId: string, startTime: number): Response {
  const reader = upstream.body!.getReader();
  let chunkCount = 0;
  let totalBytes = 0;
  let clientGone = false;
  const readable = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (clientGone) break;
          chunkCount++;
          totalBytes += value.byteLength;
          controller.enqueue(value);
        }
        if (!clientGone) controller.close();
        console.info(
          `[ai-relay] stream done ${requestId} chunks=${chunkCount} bytes=${totalBytes} durationMs=${Date.now() - startTime} clientGone=${clientGone}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (clientGone) {
          console.info(`[ai-relay] stream aborted by client ${requestId} chunks=${chunkCount} bytes=${totalBytes}`);
          return;
        }
        console.error(`[ai-relay] stream failed ${requestId}: ${message}`);
        try {
          controller.error(err);
        } catch {
          /* controller 已失效，忽略 */
        }
      }
    },
    cancel(reason) {
      clientGone = true;
      console.info(
        `[ai-relay] stream cancelled by client ${requestId} chunks=${chunkCount} bytes=${totalBytes} reason=${String(reason ?? '')}`,
      );
      reader.cancel(reason).catch(() => {
        /* 上游已关闭，忽略 */
      });
    },
  });
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
}

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    const functionName = 'ai-relay';
    const requestId = (crypto as { randomUUID(): string }).randomUUID().slice(0, 8);
    const startTime = Date.now();
    const headers = { 'Content-Type': 'application/json' };
    const jsonError = (message: string, status: number): Response =>
      new Response(JSON.stringify({ error: message }), { status, headers });

    if (request.method === 'OPTIONS') {
      // CORS 预检（前端跨域调用承载层时需要）
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'POST') {
      return jsonError('Method Not Allowed', 405);
    }

    try {
      const body = (await request.json()) as RelayRequest;
      const whitelist = resolveWhitelist();

      const baseUrl = validateBaseUrl(body.baseUrl, whitelist);
      if (!baseUrl) {
        return jsonError('接口地址不合法：需为 https 且属于白名单域名', 400);
      }

      const apiKey: string = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!apiKey) return jsonError('缺少 API Key', 400);

      const relayModel: string = typeof body.model === 'string' ? body.model.trim() : '';
      if (!relayModel) return jsonError('缺少模型名', 400);

      const messages: ChatMessage[] = Array.isArray(body.messages)
        ? body.messages.filter((m) => m && typeof m === 'object' && typeof (m as ChatMessage).role === 'string')
        : [];
      if (messages.length === 0) return jsonError('messages 不能为空', 400);

      console.info(`[${functionName}] relay ${requestId} target=${baseUrl} model=${relayModel} messages=${messages.length}`);

      const upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: relayModel, messages, stream: true }),
      });

      console.info(`[${functionName}] upstream ${requestId} status=${upstream.status} durationMs=${Date.now() - startTime}`);

      if (!upstream.ok) {
        const errorBody = await upstream.text();
        console.error(`[${functionName}] upstream failed ${requestId} status=${upstream.status}: ${errorBody.slice(0, 300)}`);
        return new Response(
          errorBody,
          {
            status: upstream.status,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          },
        );
      }

      // 透传 SSE 流，补 CORS 头（Worker 响应需显式声明，否则浏览器跨域拒绝）
      const readable = (passthroughStream(upstream, requestId, startTime) as Response).body!;
      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${functionName}] failed ${requestId}: ${message}`);
      return new Response(
        JSON.stringify({ error: message }),
        { status: 500, headers: { ...headers, 'Access-Control-Allow-Origin': '*' } },
      );
    }
  },
};

export const config = {
  name: 'ai-relay',
  description: '自定义第三方模型接口中转（relay）承载层',
};
