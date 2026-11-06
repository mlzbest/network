/**
 * 承载层 · ASR 语音识别函数（TCB Node.js）
 *
 * 替代原 functions/ai-chat 的 `asr:true` 分支。
 * 输入：{ audioUrl: string }（本应用 chat-media 桶的公开直链）
 * 输出：{ text: string }（识别结果；空串表示没听清）
 *
 * 双供应商路由：
 *   - BAIDU_API_KEY + BAIDU_SECRET_KEY 配置 → 百度短语音识别
 *   - ASR_BASE_URL + ASR_API_KEY + ASR_MODEL 配置 → OpenAI 兼容 /audio/transcriptions
 *
 * 安全约束：
 *   - audioUrl 必须命中「WorkBuddy Cloud 存储域名 + public/chat-media 路径」白名单
 *   - 第三方密钥（百度 / OpenAI 兼容）全部从服务端环境变量读取，前端零接触
 *   - 8MB 上限；百度格式白名单 pcm/wav/amr/m4a（不支持 mp3）
 *
 * 部署：腾讯云 TCB 云函数（Node.js 18+，纯 fetch + 标准库，无第三方 npm 依赖）
 */

// 本函数自包含：不依赖 WorkBuddy Cloud SDK，只做「下载公网音频 → 转发外部 ASR」。
// 第三方密钥（百度 / OpenAI 兼容）全在 TCB 环境变量，函数零外部 npm 依赖，部署包更轻。

// 百度 OAuth 令牌缓存（30 天有效期，提前 1h 视为过期）
let baiduTokenCache: { token: string; expireAtMs: number } | null = null;

const BAIDU_TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';
const BAIDU_ASR_URL = 'https://vop.baidu.com/server_api';

// 存储白名单：WorkBuddy Cloud 存储域名后缀 + 本应用桶
const OWNED_STORAGE_SUFFIXES = [
  '.cloud.workbuddy.link',
  '.workbuddy.cn',
];
const ALLOWED_BUCKETS = ['chat-media'];
const BUCKET_MARKER = '/storage/object/public/';

interface AsrRequest {
  audioUrl?: unknown;
}

interface AsrResponse {
  text?: string;
  error?: string;
  code?: string;
  status?: number;
}

/** 校验待识别音频地址：必须是「WorkBuddy 存储域名 + 本应用桶 + public 路径」。 */
function validateAudioUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  if (!OWNED_STORAGE_SUFFIXES.some((s) => host.endsWith(s))) return null;
  const markerIdx = u.pathname.indexOf(BUCKET_MARKER);
  if (markerIdx < 0) return null;
  const bucket = u.pathname.slice(markerIdx + BUCKET_MARKER.length).split('/')[0];
  if (!bucket || !ALLOWED_BUCKETS.includes(bucket)) return null;
  return u.toString();
}

/** ArrayBuffer → base64（分块避免 String.fromCharCode 对大数组爆栈） */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[],
    );
  }
  return Buffer.from(binary, 'binary').toString('base64');
}

function baiduAudioFormat(container: string): string | null {
  const c = (container || '').toLowerCase().replace(/^\./, '');
  return ['pcm', 'wav', 'amr', 'm4a'].includes(c) ? c : null;
}

/** 嗅探音频真实格式（按字节内容判定，不信任扩展名） */
function sniffAudioFormat(buf: ArrayBuffer, fileName: string): { fmt: string; by: string } {
  const b = new Uint8Array(buf.byteLength >= 12 ? buf.slice(0, 12) : buf);
  const ascii = (from: number, len: number) =>
    Array.from(b.subarray(from, from + len))
      .map((x) => String.fromCharCode(x))
      .join('');
  if (b.length >= 12 && ascii(4, 4) === 'ftyp') return { fmt: 'm4a', by: 'sniff' };
  if (b.length >= 4 && ascii(0, 4) === 'RIFF') return { fmt: 'wav', by: 'sniff' };
  if (b.length >= 6 && ascii(0, 6) === '#!AMR\n') return { fmt: 'amr', by: 'sniff' };
  if (b.length >= 3 && ascii(0, 3) === 'ID3') return { fmt: 'mp3', by: 'sniff' };
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { fmt: 'mp3', by: 'sniff' };
  const ext = fileName.toLowerCase().match(/\.(pcm|wav|amr|m4a|mp3)$/)?.[1];
  return { fmt: ext ?? '', by: 'extension' };
}

function storageFileName(audioUrl: string): string {
  try {
    const p = new URL(audioUrl).pathname;
    const base = decodeURIComponent(p.slice(p.lastIndexOf('/') + 1)) || 'voice.m4a';
    return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.m4a`;
  } catch {
    return 'voice.m4a';
  }
}

async function getBaiduAccessToken(apiKey: string, secretKey: string, requestId: string): Promise<string | null> {
  const now = Date.now();
  if (baiduTokenCache && baiduTokenCache.expireAtMs > now) return baiduTokenCache.token;
  const url = `${BAIDU_TOKEN_URL}?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, { method: 'POST', signal: controller.signal });
    const data = (await resp.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!resp.ok || !data.access_token) {
      console.error(`[asr-provider] baidu token failed ${requestId} status=${resp.status} error=${String(data.error ?? '')}`);
      return null;
    }
    const ttlSec = typeof data.expires_in === 'number' ? data.expires_in : 2592000;
    baiduTokenCache = { token: data.access_token, expireAtMs: now + Math.max(60, ttlSec - 3600) * 1000 };
    console.info(`[asr-provider] baidu token ok ${requestId} ttlSec=${ttlSec}`);
    return baiduTokenCache.token;
  } catch {
    console.error(`[asr-provider] baidu token request error ${requestId}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function handleAsr(body: AsrRequest, requestId: string, startTime: number): Promise<AsrResponse> {
  const audioUrl = validateAudioUrl(body?.audioUrl);
  if (!audioUrl) {
    let echo = 'unparsable';
    try {
      const u = new URL(String(body?.audioUrl ?? ''));
      echo = `${u.hostname}${u.pathname.slice(-48)}`;
    } catch {
      /* ignore */
    }
    console.warn(`[asr-provider] rejected audioUrl ${requestId} target=${echo}`);
    return { error: '音频地址不合法：仅支持识别本应用聊天中已发送的语音', code: 'BAD_AUDIO_URL', status: 400 };
  }

  const baiduAk = (process.env.BAIDU_API_KEY || '').trim();
  const baiduSk = (process.env.BAIDU_SECRET_KEY || '').trim();
  const useBaidu = Boolean(baiduAk && baiduSk);
  const openaiKey = (process.env.ASR_API_KEY || '').trim();
  const model = (process.env.ASR_MODEL || '').trim();
  const asrBaseUrl = (process.env.ASR_BASE_URL || '').trim();
  if (!useBaidu && (!asrBaseUrl || !openaiKey || !model)) {
    console.warn(`[asr-provider] not configured ${requestId} hasBaidu=${useBaidu} hasOpenai=${Boolean(asrBaseUrl && openaiKey && model)}`);
    return {
      error: '语音识别服务尚未配置，暂时无法转文字',
      code: 'ASR_NOT_CONFIGURED',
      status: 503,
    };
  }

  // 下载音频（公网直链，WorkBuddy Cloud 存储）
  const MAX_BYTES = 8 * 1024 * 1024;
  const dlController = new AbortController();
  const dlTimer = setTimeout(() => dlController.abort(), 20000);
  let audioBuf: ArrayBuffer | null = null;
  try {
    const dl = await fetch(audioUrl, { signal: dlController.signal });
    if (!dl.ok) {
      if (dl.status === 404 || dl.status === 403 || dl.status === 400) {
        return { error: '这条语音的文件已经不在了，无法识别', code: 'AUDIO_NOT_FOUND', status: 404 };
      }
      return { error: '语音文件读取失败，请稍后重试', code: 'DOWNLOAD_FAILED', status: 502 };
    }
    audioBuf = await dl.arrayBuffer();
  } catch {
    return { error: '语音文件读取失败，请稍后重试', code: 'DOWNLOAD_FAILED', status: 502 };
  } finally {
    clearTimeout(dlTimer);
  }

  if (!audioBuf || audioBuf.byteLength === 0) {
    return { error: '语音内容为空', code: 'EMPTY_AUDIO', status: 400 };
  }
  if (audioBuf.byteLength > MAX_BYTES) {
    return { error: '这段语音太长了，暂时识别不了', code: 'AUDIO_TOO_LONG', status: 413 };
  }

  const fileName = storageFileName(audioUrl);
  const sniffed = sniffAudioFormat(audioBuf, fileName);
  console.info(
    `[asr-provider] audio resolved ${requestId} name=${fileName} realFmt=${sniffed.fmt || 'unknown'} by=${sniffed.by}`,
  );

  let text = '';

  if (useBaidu) {
    const fmt = baiduAudioFormat(sniffed.fmt);
    if (!fmt) {
      return {
        error: '这条语音是旧格式录的，暂时识别不了；新发送的语音支持转文字',
        code: 'UNSUPPORTED_FORMAT',
        status: 415,
      };
    }
    const token = await getBaiduAccessToken(baiduAk, baiduSk, requestId);
    if (!token) {
      return { error: '识别服务鉴权失败，请检查语音识别密钥配置', code: 'AUTH_FAILED', status: 502 };
    }

    const payload = JSON.stringify({
      format: fmt,
      rate: 16000,
      channel: 1,
      cuid: 'network-chat-app',
      token,
      dev_pid: 1537,
      len: audioBuf.byteLength,
      speech: arrayBufferToBase64(audioBuf),
    });

    const upstream = await fetch(BAIDU_ASR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    const upstreamText = await upstream.text();
    let parsed: { err_no?: number; err_msg?: string; result?: unknown };
    try {
      parsed = JSON.parse(upstreamText);
    } catch {
      return { error: '识别结果格式异常，请稍后重试', code: 'BAD_UPSTREAM', status: 502 };
    }
    if (parsed.err_no !== 0) {
      if (parsed.err_no === 4 || parsed.err_no === 110 || parsed.err_no === 111) baiduTokenCache = null;
      if (parsed.err_no === 4) {
        return { error: '识别额度用完了，请联系开发者充值后重试', code: 'QUOTA_EXHAUSTED', status: 429 };
      }
      return { error: '语音识别失败，请稍后重试', code: 'UPSTREAM_FAILED', status: 502 };
    }
    const arr = Array.isArray(parsed.result) ? parsed.result : [];
    text = arr.filter((x) => typeof x === 'string').join('').trim();
  } else {
    // OpenAI 兼容 /audio/transcriptions
    const form = new FormData();
    form.append('file', new Blob([audioBuf]), fileName);
    form.append('model', model);

    const upstream = await fetch(`${asrBaseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: form,
    });
    if (!upstream.ok) {
      return {
        error: '语音识别失败，请稍后重试',
        code: upstream.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_FAILED',
        status: upstream.status === 429 ? 429 : 502,
      };
    }
    try {
      const parsed = (await upstream.json()) as { text?: unknown };
      text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    } catch {
      return { error: '识别结果格式异常，请稍后重试', code: 'BAD_UPSTREAM', status: 502 };
    }
  }

  console.info(
    `[asr-provider] success ${requestId} via=${useBaidu ? 'baidu' : 'openai'} textLength=${text.length} durationMs=${Date.now() - startTime}`,
  );
  return { text };
}

/**
 * TCB 云函数入口。
 * TCB 的 HTTP 触发器会传 (event, context)，POST 体在 event.body（已解析）。
 */
export const mainHandler = async (event: Record<string, unknown>): Promise<AsrResponse> => {
  const requestId = Math.random().toString(36).slice(2, 10);
  const startTime = Date.now();
  const body = (event?.body ?? event) as AsrRequest;
  return handleAsr(body, requestId, startTime);
};

// TCB Node.js 云函数的默认入口名是 index.main，与 mainHandler 指向同一实现。
export const main = mainHandler;

// 供 TCB 控制台部署：导出 mainHandler 作为 HTTP 触发器入口。
// TCB Node.js 运行时约定：导出 mainHandler 即可，无需额外 SDK 初始化。
export default mainHandler;
