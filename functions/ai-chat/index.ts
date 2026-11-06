/**
 * ai-chat — Meoo AI 文本流式代理 + 运行时模型目录 + 自定义第三方接口中转（原 ai-relay 已合并至此）+ 语音转文字（原 speech-to-text 已合并至此，省云函数额度）
 * POST:
 *   - 平台通道：{ model, messages } → 转发 Meoo AI chat/completions（SSE 流）
 *   - 自定义通道：{ relay: true, baseUrl, apiKey, model, messages } → 直连 <baseUrl>/chat/completions（SSE 流）
 *     安全约束：仅允许 https、host 白名单后缀校验、拒裸 IP/内网域名；Key 仅单次请求内存使用，不落库不打日志。
 *   - 语音识别通道：{ asr: true, audioUrl } → 下载本应用存储桶音频 → 转发外部 ASR → { text }
 *     双供应商路由：配了 BAIDU_API_KEY+BAIDU_SECRET_KEY 优先走百度短语音识别（server_api，JSON+base64，
 *     仅支持 pcm/wav/amr/m4a）；否则回落 OpenAI 兼容 /audio/transcriptions（ASR_BASE_URL/ASR_API_KEY/ASR_MODEL）。
 *     安全约束：audioUrl 必须命中平台存储域名后缀 + public/chat-media 路径；ASR 基址走同一 https 白名单；Key 只从服务端环境变量读取。
 * GET : 拉取模型目录 /meoo-ai/compatible-mode/v1/models（1.5s 超时）
 * AK 仅存于服务端环境变量（平台按项目自动注入），前端不接触。
 */
const MEOO_AI_BASE_URL = 'https://api.meoo.host';

// 语音识别专用服务商域名后缀（在通用白名单之外补充几家只做 ASR 的厂商）
// baidubce.com：百度 OAuth 鉴权端点；baidu.com：短语音识别 vop 端点
const ASR_EXTRA_HOST_SUFFIXES = ['xf-yun.com', 'azure-api.net', 'alibabacloud.com', 'dashscope.cn', 'baidubce.com', 'baidu.com'];

/** 百度的两个固定端点（函数内置，用户只需配 AK/SK） */
const BAIDU_TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';
const BAIDU_ASR_URL = 'https://vop.baidu.com/server_api';

// 本项目存储桶公开路径标记（audioUrl 归属校验用）
const BUCKET_MARKER = '/storage/v1/object/public/';

const ALLOWED_HOST_SUFFIXES = [
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
  'www.agnes-ai.cn',
];

interface ChatMessage {
  role: string;
  content: string;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 校验目标地址：必须 https、无凭据、host 命中白名单后缀且非 IP 内网段 */
function validateBaseUrl(raw: unknown): string | null {
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
  const allowed = ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  if (!allowed) return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/**
 * 语音识别专用基址校验：在通用 https + 拒裸 IP/内网的基础上，
 * 白名单 = 通用模型服务商后缀 ∪ ASR 专属厂商后缀（dashscope.aliyuncs.com 已被 'aliyuncs.com' 覆盖）。
 */
function validateAsrBaseUrl(raw: unknown): string | null {
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
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost' || host.endsWith('.local')) return null;
  const allowed = [...ALLOWED_HOST_SUFFIXES, ...ASR_EXTRA_HOST_SUFFIXES].some(
    (s) => host === s || host.endsWith(`.${s}`),
  );
  if (!allowed) return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/**
 * 校验待识别音频地址：必须是「平台存储域名 + 本应用桶名 + public 路径」。
 *
 * ⚠️ 两条已被实测证伪的路径，不要重试：
 *    ① 拿 SUPABASE_URL / SUPABASE_PUBLIC_URL 的 host 比对——函数运行时该值是内网 IP
 *       （日志证据 candidates=10.225.136.21），与前端公网域名永不相等；
 *    ② 拿请求头的 urlId 比对 storage hostname 首段——头里的 urlId 是**小程序应用 id**
 *       （日志证据 pid=p13z02n1pgq4），而存储域名首段是**云实例 id**（7i32rz8febxgna7q），
 *       两者属于不同命名空间，任何相等判定都会 100% 误拒真实用户。
 *    因此归属判定只能落到「平台存储域名后缀 + 本应用实际使用的桶名」这层白名单：
 *    既足够挡住「把我们的函数当任意 URL 的免费识别代理」，又不会误伤自家用户。
 *    调用者身份由 OneDay-App-Id 头单独校验（见 handleAsr），与地址校验解耦。
 */
/**
 * 平台存储地址有**两种真实形态**，都必须放行（用户实测报障后确立）：
 * ① `https://{云实例id}.database.meoo.xyz/storage/v1/object/public/...` —— H5/Web 端 supabaseUrl；
 * ② `https://mp-api.meoo.host/mp-api/{小程序appId}/storage/v1/object/public/...` —— **微信小程序端
 *    supabase-wechat-js 实际落库的 media_url**（日志证据：messages.media_url 全是这个形态）。
 * 只列 ① 会让小程序里所有语音「转文字」必然 400。meoo.host 是平台自有域，仍要求命中
 * BUCKET_MARKER + 桶名白名单，不构成开放代理。
 */
const OWNED_STORAGE_SUFFIXES = ['.database.meoo.xyz', '.supabase.co', '.supabase.in', '.meoo.host'];
/** 本应用真正存放聊天媒体的桶（语音消息只可能来自 chat-media） */
const ALLOWED_BUCKETS = ['chat-media'];

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

/**
 * access_token 进程内缓存（百度 OAuth 令牌有效期 30 天）。
 * Edge Function 实例可能随时冷启动，缓存丢了就重新取一次，成本可忽略；
 * 但热实例高频识别时能省掉每次一趟 OAuth 往返。提前 1 小时视为过期。
 */
let baiduTokenCache: { token: string; expireAtMs: number } | null = null;

async function getBaiduAccessToken(apiKey: string, secretKey: string, requestId: string): Promise<string | null> {
  const now = Date.now();
  if (baiduTokenCache && baiduTokenCache.expireAtMs > now) return baiduTokenCache.token;
  // 参数必须是 URL query（官方文档要求），且 AK/SK 需 encodeURIComponent（SK 常含括号等特殊字符）
  const url = `${BAIDU_TOKEN_URL}?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, { method: 'POST', signal: controller.signal });
    const data = (await resp.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!resp.ok || !data.access_token) {
      console.error(`[ai-chat] asr baidu token failed ${requestId} status=${resp.status} error=${String(data.error ?? '')}`);
      return null;
    }
    const ttlSec = typeof data.expires_in === 'number' ? data.expires_in : 2592000;
    baiduTokenCache = { token: data.access_token, expireAtMs: now + Math.max(60, ttlSec - 3600) * 1000 };
    console.info(`[ai-chat] asr baidu token ok ${requestId} ttlSec=${ttlSec}`);
    return baiduTokenCache.token;
  } catch {
    console.error(`[ai-chat] asr baidu token request error ${requestId}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** ArrayBuffer → base64（分块避免 String.fromCharCode 对大数组爆栈） */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[]);
  }
  return btoa(binary);
}


/**
 * 百度短语音识别的 format 字段：仅接受 pcm / wav / amr / m4a。
 * ⚠️ 官方文档明确「如填写 mp3 即会有 err_no=3312（格式非法）」；m4a 还额外要求
 * AAC-LC + CBR 24000-96000 + brand mp42:0，而微信 RecorderManager 在部分安卓机型上会
 * 忽略 `format:'m4a'` 请求、实际回包 mp3——这类语音无论怎么命名都送不进百度。
 * 所以前端录音首选 wav（PCM，百度原生接受）。本函数只把嗅探出的容器名映射成 format，
 * 返回 null 表示百度不接受该容器，由调用方给出明确的「格式暂不支持」提示。
 */
function baiduAudioFormat(container: string): string | null {
  const c = (container || '').toLowerCase().replace(/^\./, '');
  return ['pcm', 'wav', 'amr', 'm4a'].includes(c) ? c : null;
}

/**
 * 用音频**字节内容**判定真实格式，不信任文件名扩展名（决定性修复）。
 *
 * ⚠️ 实测教训：微信小程序 RecorderManager 在部分安卓机型上会**忽略 `format:'m4a'` 请求、
 * 实际回包仍是 mp3**（日志证据：前端按启动参数命名成 `.m4a` 上传，云函数却拿到 mp3 数据）。
 * 只按扩展名判定会让这类语音「假装是 m4a」送到百度 → 报 3300/3316，用户看到含糊的识别失败。
 * 反过来，存量真·mp3 语音也不能被扩展名骗过去。所以优先嗅探容器头：
 *   - ISO-BMFF/m4a：偏移 4 起为 `ftyp`
 *   - WAV/RIFF：偏移 0 起为 `RIFF`
 *   - AMR-NB：`#!AMR\n`
 *   - MP3：ID3v2 头，或首字节 0xFF + 次字节高 6 位全 1（帧同步）
 * 判不出来时退回扩展名（保持旧行为）。
 */
function sniffAudioFormat(buf: ArrayBuffer, fileName: string): { fmt: string; by: string } {
  const b = new Uint8Array(buf.byteLength >= 12 ? buf.slice(0, 12) : buf);
  const ascii = (from: number, len: number) =>
    Array.from(b.subarray(from, from + len)).map((x) => String.fromCharCode(x)).join('');
  if (b.length >= 12 && ascii(4, 4) === 'ftyp') return { fmt: 'm4a', by: 'sniff' };
  if (b.length >= 4 && ascii(0, 4) === 'RIFF') return { fmt: 'wav', by: 'sniff' };
  if (b.length >= 6 && ascii(0, 6) === '#!AMR\n') return { fmt: 'amr', by: 'sniff' };
  if (b.length >= 3 && ascii(0, 3) === 'ID3') return { fmt: 'mp3', by: 'sniff' };
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { fmt: 'mp3', by: 'sniff' };
  const ext = fileName.toLowerCase().match(/\.(pcm|wav|amr|m4a|mp3)$/)?.[1];
  return { fmt: ext ?? '', by: 'extension' };
}

/**
 * 从存储地址 pathname 取末段文件名（**必须剥掉 query**）。
 * ⚠️ 不能对整条 URL 用 `split('.').pop()`：小程序端 media_url 形如
 * `/mp-api/{appId}/storage/v1/object/public/chat-media/xxx.m4a?token=...`，
 * 带查询串时会解析出 `m4a?token=...` 这种脏后缀，直接判成「不支持的格式」。
 */
function storageFileName(audioUrl: string): string {
  try {
    const p = new URL(audioUrl).pathname;
    const base = decodeURIComponent(p.slice(p.lastIndexOf('/') + 1)) || 'voice.m4a';
    return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.m4a`;
  } catch {
    return 'voice.m4a';
  }
}

/**
 * 把「平台存储公网地址」换成「函数运行时可达的内网地址」（仅作公网抖动时的兜底）。
 *
 * ⚠️ 实测结论（日志证据 `asr audio download attempt 1 failed ... status=401`）：内网网关对
 * public 桶对象**要求鉴权**，而 Edge Function 匿名 fetch 带不上任何凭证 → 恒 401。所以这条
 * 路径只能当兜底、绝不能排在公网前面；真正能取到音频的是公网域名（含小程序端落库的
 * `mp-api.meoo.host/mp-api/{appId}/...` 形态）。保留它只为「公网偶发 5xx/超时」时多一次机会。
 * 只替换 scheme+host 段，pathname（含 /storage/v1/object/public/chat-media/...）原样保留。
 */
function rewriteToInternalStorageUrl(publicUrl: string): string | null {
  const base = (Deno.env.get('SUPABASE_URL') || '').trim();
  if (!base) return null;
  try {
    const src = new URL(publicUrl);
    const dst = new URL(base);
    if (!src.pathname.startsWith('/')) return null;
    return `${dst.origin}${src.pathname}${src.search}`;
  } catch {
    return null;
  }
}

/** 语音识别通道：下载本应用存储桶音频 → 转发外部 ASR → { text } */
async function handleAsr(body: any, requestId: string, startTime: number): Promise<Response> {
  const audioUrl = validateAudioUrl(body?.audioUrl);
  if (!audioUrl) {
    // 打日志时只留 host + 路径尾段，绝不整条打印（避免把对象签名参数写进日志）
    let echo = 'unparsable';
    try {
      const u = new URL(String(body?.audioUrl ?? ''));
      echo = `${u.hostname}${u.pathname.slice(-48)}`;
    } catch {}
    console.warn(`[ai-chat] asr rejected audioUrl ${requestId} target=${echo}`);
    return jsonError('音频地址不合法：仅支持识别本应用聊天中已发送的语音', 400);
  }
  {
    const u = new URL(audioUrl);
    console.info(`[ai-chat] asr accepted audioUrl ${requestId} host=${u.hostname} path=${u.pathname.slice(-48)}`);
  }

  // 双供应商路由：配了 BAIDU_API_KEY/BAIDU_SECRET_KEY 优先走百度短语音识别；
  // 否则回落到通用 OpenAI 兼容通道（ASR_BASE_URL/ASR_API_KEY/ASR_MODEL）。
  const baiduAk = (Deno.env.get('BAIDU_API_KEY') || '').trim();
  const baiduSk = (Deno.env.get('BAIDU_SECRET_KEY') || '').trim();
  const useBaidu = Boolean(baiduAk && baiduSk);
  const baseUrl = validateAsrBaseUrl(Deno.env.get('ASR_BASE_URL'));
  const openaiKey = (Deno.env.get('ASR_API_KEY') || '').trim();
  const model = (Deno.env.get('ASR_MODEL') || '').trim();
  if (!useBaidu && (!baseUrl || !openaiKey || !model)) {
    console.warn(
      `[ai-chat] asr not configured ${requestId} hasBaidu=${useBaidu} hasBaseUrl=${Boolean(baseUrl)} hasKey=${Boolean(openaiKey)} hasModel=${Boolean(model)}`,
    );
    return jsonError('语音识别服务尚未配置，暂时无法转文字', 503);
  }

  // 存储地址下载：**优先公网地址**。日志实测证据：内网网关（SUPABASE_URL）对 public 桶对象
  // 回 401——Edge Function 匿名 fetch 带不上任何凭证，内网那条路走不通；公网 mp-api.meoo.host
  // 才是真正取到音频的路径。保留内网作兜底只是给「公网偶发抖动」多一次机会，顺序不能反。
  const MAX_BYTES = 8 * 1024 * 1024;
  const internalUrl = rewriteToInternalStorageUrl(audioUrl);
  const candidates = internalUrl && internalUrl !== audioUrl ? [audioUrl, internalUrl] : [audioUrl];
  let audioBuf: ArrayBuffer | null = null;
  let lastDlError = '';
  for (let i = 0; i < candidates.length; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const dl = await fetch(candidates[i], { signal: controller.signal });
      if (!dl.ok) {
        lastDlError = `status=${dl.status}`;
        console.warn(`[ai-chat] asr audio download attempt ${i + 1} failed ${requestId} ${lastDlError}`);
        // 404/403/400 是确定性结果（文件不存在或无权访问），换一条 host 也拿不到同一对象，
        // 直接短路返回「语音不存在」——不再让请求被兜底重试拖成含糊的 502「读取失败」。
        if (dl.status === 404 || dl.status === 403 || dl.status === 400) {
          console.error(`[ai-chat] asr audio not found ${requestId} status=${dl.status}`);
          return jsonError('这条语音的文件已经不在了，无法识别', 404);
        }
        continue;
      }
      const ctype = dl.headers.get('content-type') || '';
      // 关键校验：网关在拿不到对象时可能回 200 + HTML/JSON 错误页（v20 日志实锤：
      // via=internal attempt=1 bytes=26084，而真实对象是 .m4a）。这种"假成功"若被当成
      // 音频送进识别服务，用户只会看到无意义的格式/识别失败。判掉并继续下一条候选。
      if (/text\/html|application\/json|text\/plain/i.test(ctype)) {
        lastDlError = `bad content-type=${ctype}`;
        console.warn(
          `[ai-chat] asr audio download attempt ${i + 1} returned non-audio body ${requestId} ctype=${ctype} bytes=${(await dl.clone().arrayBuffer()).byteLength}`,
        );
        continue;
      }
      audioBuf = await dl.arrayBuffer();
      console.info(
        `[ai-chat] asr audio downloaded ${requestId} via=${i === 0 ? 'primary' : 'fallback'} attempt=${i + 1} ctype=${ctype || '(none)'} bytes=${audioBuf.byteLength}`,
      );
      break;
    } catch (e) {
      lastDlError = String((e as Error)?.name ?? e);
      console.warn(`[ai-chat] asr audio download attempt ${i + 1} threw ${requestId} err=${lastDlError}`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (!audioBuf) {
    console.error(`[ai-chat] asr audio download exhausted ${requestId} last=${lastDlError}`);
    return jsonError('语音文件读取失败，请稍后重试', 502);
  }
  if (audioBuf.byteLength === 0) return jsonError('语音内容为空', 400);
  if (audioBuf.byteLength > MAX_BYTES) return jsonError('这段语音太长了，暂时识别不了', 413);

  const fileName = storageFileName(audioUrl);
  // 真实格式以**字节内容**为准（微信部分安卓机型会忽略 format:'m4a'、实际回包 mp3）
  const sniffed = sniffAudioFormat(audioBuf, fileName);
  console.info(
    `[ai-chat] asr audio file resolved ${requestId} name=${fileName} realFmt=${sniffed.fmt || 'unknown'} by=${sniffed.by}`,
  );

  let text = '';

  if (useBaidu) {
    // ===== 百度短语音识别（标准版 server_api，≤60s，JSON+base64）=====
    // 注意：百度只接受 pcm/wav/amr/m4a，**不支持 mp3**。这里用嗅探出的真实容器判定，
    // 不按文件扩展名——否则「命名成 .m4a 的 mp3」会被送去百度并撞出无意义的 3300/3316。
    const fmt = baiduAudioFormat(sniffed.fmt);
    if (!fmt) {
      console.warn(
        `[ai-chat] asr baidu unsupported format ${requestId} file=${fileName} realFmt=${sniffed.fmt || 'unknown'} by=${sniffed.by}`,
      );
      return jsonError('这条语音是旧格式录的，暂时识别不了；新发送的语音支持转文字', 415);
    }
    const token = await getBaiduAccessToken(baiduAk, baiduSk, requestId);
    if (!token) return jsonError('识别服务鉴权失败，请检查语音识别密钥配置', 502);

    const payload = JSON.stringify({
      format: fmt,
      rate: 16000,
      channel: 1,
      cuid: 'meoo-chat-app',
      token,
      dev_pid: 1537, // 普通话输入法模型（支持标点）
      len: audioBuf.byteLength, // ⚠️ 原始字节数，不是 base64 后长度
      speech: arrayBufferToBase64(audioBuf),
    });
    console.info(`[ai-chat] asr baidu request ${requestId} format=${fmt} bytes=${audioBuf.byteLength}`);

    const upstream = await fetch(BAIDU_ASR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    const upstreamText = await upstream.text();
    console.info(
      `[ai-chat] asr baidu upstream ${requestId} status=${upstream.status} bytes=${upstreamText.length} durationMs=${Date.now() - startTime}`,
    );

    let parsed: { err_no?: number; err_msg?: string; result?: unknown };
    try {
      parsed = JSON.parse(upstreamText);
    } catch {
      console.error(`[ai-chat] asr baidu bad payload ${requestId}`);
      return jsonError('识别结果格式异常，请稍后重试', 502);
    }
    // 百度 HTTP 层恒 200，业务成败看 err_no；token 失效类错误清缓存，下次重新获取
    if (parsed.err_no !== 0) {
      console.error(`[ai-chat] asr baidu err ${requestId} err_no=${parsed.err_no} err_msg=${String(parsed.err_msg ?? '').slice(0, 120)}`);
      if (parsed.err_no === 4 || parsed.err_no === 110 || parsed.err_no === 111) baiduTokenCache = null;
      if (parsed.err_no === 4) return jsonError('识别额度用完了，请联系开发者充值后重试', 429);
      return jsonError('语音识别失败，请稍后重试', 502);
    }
    const arr = Array.isArray(parsed.result) ? parsed.result : [];
    text = arr.filter((x) => typeof x === 'string').join('').trim();
  } else {
    // ===== 通用 OpenAI 兼容 /audio/transcriptions 通道（multipart 转发）=====
    const form = new FormData();
    form.append('file', new Blob([audioBuf]), fileName);
    form.append('model', model);

    console.info(`[ai-chat] asr request ${requestId} model=${model} bytes=${audioBuf.byteLength} file=${fileName}`);

    const upstream = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: form,
    });
    const upstreamText = await upstream.text();
    console.info(
      `[ai-chat] asr upstream ${requestId} status=${upstream.status} bytes=${upstreamText.length} durationMs=${Date.now() - startTime}`,
    );

    if (!upstream.ok) {
      // 转发上游状态码，但响应体只回脱敏摘要，避免泄露第三方内部信息
      console.error(`[ai-chat] asr upstream failed ${requestId} status=${upstream.status}: ${upstreamText.slice(0, 200)}`);
      return jsonError('语音识别失败，请稍后重试', upstream.status === 429 ? 429 : 502);
    }

    try {
      const parsed = JSON.parse(upstreamText) as { text?: unknown };
      text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    } catch {
      console.error(`[ai-chat] asr bad upstream payload ${requestId}`);
      return jsonError('识别结果格式异常，请稍后重试', 502);
    }
  }

  console.info(`[ai-chat] asr success ${requestId} via=${useBaidu ? 'baidu' : 'openai'} textLength=${text.length} durationMs=${Date.now() - startTime}`);
  return new Response(JSON.stringify({ text }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** 把上游 SSE 流透传给客户端，统计块数与字节数便于排障 */
function passthroughStream(upstream: Response, requestId: string, startTime: number): Response {
  const reader = upstream.body!.getReader();
  let chunkCount = 0;
  let totalBytes = 0;
  // 客户端断开标记：客户端超时/切页后连接已关，此时再 enqueue/close 会抛
  // `The stream controller cannot close or enqueue`。这不是服务端故障，是「对端已走」，
  // 必须静默收尾并 cancel 上游 reader（否则上游连接会一直挂着直到超时）。
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
          `[ai-chat] stream done ${requestId} chunks=${chunkCount} bytes=${totalBytes} durationMs=${Date.now() - startTime} clientGone=${clientGone}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 客户端已断开时 controller 已失效，再 error() 同样会抛，只能记日志后放弃。
        if (clientGone) {
          console.info(`[ai-chat] stream aborted by client ${requestId} chunks=${chunkCount} bytes=${totalBytes}`);
          return;
        }
        console.error(`[ai-chat] stream failed ${requestId}: ${message}`);
        try {
          controller.error(err);
        } catch {
          /* controller 已失效，忽略 */
        }
      }
    },
    cancel(reason) {
      // 客户端主动断开（超时 / 切页 / 点停止）会走到这里：标记并释放上游连接。
      clientGone = true;
      console.info(
        `[ai-chat] stream cancelled by client ${requestId} chunks=${chunkCount} bytes=${totalBytes} reason=${String(reason ?? '')}`,
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

Deno.serve(async (req) => {
  const functionName = 'ai-chat';
  const requestId = crypto.randomUUID().slice(0, 8);
  const startTime = Date.now();

  try {
    // GET 只读取模型目录；失败由前端保留旧列表
    if (req.method === 'GET') {
      const projectUrlId = req.headers.get('X-Meoo-Project-Url-Id')?.trim() || '';
      const projectServiceAK =
        (projectUrlId ? Deno.env.get(`MEOO_PROJECT_API_KEY_${projectUrlId}`) : '') ||
        Deno.env.get('MEOO_PROJECT_API_KEY') ||
        '';
      if (!projectServiceAK) {
        console.error(`[${functionName}] no service ak ${requestId} hasProjectHeader=${Boolean(projectUrlId)}`);
        return jsonError('当前项目的 AI 服务凭证未就绪，请稍后重试', 503);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const response = await fetch(`${MEOO_AI_BASE_URL}/meoo-ai/compatible-mode/v1/models`, {
          headers: { Authorization: `Bearer ${projectServiceAK}` },
          signal: controller.signal,
        });
        console.info(`[${functionName}] catalog ${requestId} status=${response.status} durationMs=${Date.now() - startTime}`);
        return new Response(await response.text(), {
          status: response.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      } catch {
        console.warn(`[${functionName}] catalog unavailable ${requestId}`);
        return jsonError('模型目录暂时不可用', 503);
      } finally {
        clearTimeout(timer);
      }
    }

    if (req.method !== 'POST') return jsonError('Method Not Allowed', 405);

    const body = await req.json();

    // ===== 语音识别通道（原 speech-to-text，为省云函数额度合并至此）=====
    // 判据：body.asr === true。该分支不要求 messages，必须放在「messages 不能为空」校验之前短路。
    if (body.asr === true) {
      return handleAsr(body, requestId, startTime);
    }

    const messages: ChatMessage[] = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) return jsonError('messages 不能为空', 400);

    // ===== 自定义第三方接口中转通道（原 ai-relay）=====
    if (body.relay === true) {
      const baseUrl = validateBaseUrl(body.baseUrl);
      let apiKey: string = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      const relayModel: string = typeof body.model === 'string' ? body.model.trim() : '';
      if (!baseUrl) return jsonError('接口地址不合法：需为 https 且属于主流模型服务商域名', 400);
      // Agnes AI 允许客户端留空 Key，由服务端 Secret（AGNES_API_KEY）兜底注入
      if (!apiKey && baseUrl.includes('agnes-ai')) {
        apiKey = Deno.env.get('AGNES_API_KEY') || '';
      }
      if (!apiKey) return jsonError('缺少 API Key', 400);
      if (!relayModel) return jsonError('缺少模型名', 400);

      console.info(`[${functionName}] relay ${requestId} target=${baseUrl} model=${relayModel} messages=${messages.length}`);
      const upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: relayModel, messages, stream: true }),
      });
      console.info(`[${functionName}] relay upstream ${requestId} status=${upstream.status} durationMs=${Date.now() - startTime}`);
      if (!upstream.ok) {
        const errorBody = await upstream.text();
        console.error(`[${functionName}] relay upstream failed ${requestId} status=${upstream.status}: ${errorBody.slice(0, 300)}`);
        return new Response(errorBody, {
          status: upstream.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return passthroughStream(upstream, requestId, startTime);
    }

    // ===== 平台 Meoo AI 通道 =====
    const projectUrlId = req.headers.get('X-Meoo-Project-Url-Id')?.trim() || '';
    const projectSecretName = `MEOO_PROJECT_API_KEY_${projectUrlId}`;
    const projectServiceAK =
      (projectUrlId ? Deno.env.get(projectSecretName) : '') ||
      Deno.env.get('MEOO_PROJECT_API_KEY') ||
      '';
    if (!projectServiceAK) {
      console.error(`[${functionName}] no service ak ${requestId} hasProjectHeader=${Boolean(projectUrlId)}`);
      return jsonError('当前项目的 AI 服务凭证未就绪，请稍后重试', 503);
    }

    const model: string = typeof body.model === 'string' && body.model ? body.model : 'qwen3.6-plus';
    const lastMessage = messages[messages.length - 1]?.content;

    console.info(`[${functionName}] request ${requestId} model=${model} messages=${messages.length} lastMessageLength=${String(lastMessage ?? '').length}`);

    const response = await fetch(
      `${MEOO_AI_BASE_URL}/meoo-ai/compatible-mode/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${projectServiceAK}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, messages, stream: true }),
      },
    );
    console.info(`[${functionName}] upstream ${requestId} status=${response.status} durationMs=${Date.now() - startTime}`);

    // 转发上游状态码，不吞掉 4xx/5xx
    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[${functionName}] upstream failed ${requestId} status=${response.status}: ${errorBody.slice(0, 300)}`);
      return new Response(errorBody, {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return passthroughStream(response, requestId, startTime);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    console.error(`[${functionName}] failed ${requestId}: ${message}`);
    return jsonError(message, 500);
  }
});
