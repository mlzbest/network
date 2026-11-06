var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// C:/Users/MAOLIZHENG/.workbuddy/binaries/node/workspace/tcb-cli-tmp/asr-build/index.ts
var asr_build_exports = {};
__export(asr_build_exports, {
  default: () => asr_build_default,
  main: () => main,
  mainHandler: () => mainHandler
});
module.exports = __toCommonJS(asr_build_exports);
var baiduTokenCache = null;
var BAIDU_TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
var BAIDU_ASR_URL = "https://vop.baidu.com/server_api";
var OWNED_STORAGE_SUFFIXES = [
  ".cloud.workbuddy.link",
  ".workbuddy.cn"
];
var ALLOWED_BUCKETS = ["chat-media"];
var BUCKET_MARKER = "/storage/object/public/";
function validateAudioUrl(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (!OWNED_STORAGE_SUFFIXES.some((s) => host.endsWith(s))) return null;
  const markerIdx = u.pathname.indexOf(BUCKET_MARKER);
  if (markerIdx < 0) return null;
  const bucket = u.pathname.slice(markerIdx + BUCKET_MARKER.length).split("/")[0];
  if (!bucket || !ALLOWED_BUCKETS.includes(bucket)) return null;
  return u.toString();
}
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK))
    );
  }
  return Buffer.from(binary, "binary").toString("base64");
}
function baiduAudioFormat(container) {
  const c = (container || "").toLowerCase().replace(/^\./, "");
  return ["pcm", "wav", "amr", "m4a"].includes(c) ? c : null;
}
function sniffAudioFormat(buf, fileName) {
  const b = new Uint8Array(buf.byteLength >= 12 ? buf.slice(0, 12) : buf);
  const ascii = (from, len) => Array.from(b.subarray(from, from + len)).map((x) => String.fromCharCode(x)).join("");
  if (b.length >= 12 && ascii(4, 4) === "ftyp") return { fmt: "m4a", by: "sniff" };
  if (b.length >= 4 && ascii(0, 4) === "RIFF") return { fmt: "wav", by: "sniff" };
  if (b.length >= 6 && ascii(0, 6) === "#!AMR\n") return { fmt: "amr", by: "sniff" };
  if (b.length >= 3 && ascii(0, 3) === "ID3") return { fmt: "mp3", by: "sniff" };
  if (b.length >= 2 && b[0] === 255 && (b[1] & 224) === 224) return { fmt: "mp3", by: "sniff" };
  const ext = fileName.toLowerCase().match(/\.(pcm|wav|amr|m4a|mp3)$/)?.[1];
  return { fmt: ext ?? "", by: "extension" };
}
function storageFileName(audioUrl) {
  try {
    const p = new URL(audioUrl).pathname;
    const base = decodeURIComponent(p.slice(p.lastIndexOf("/") + 1)) || "voice.m4a";
    return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.m4a`;
  } catch {
    return "voice.m4a";
  }
}
async function getBaiduAccessToken(apiKey, secretKey, requestId) {
  const now = Date.now();
  if (baiduTokenCache && baiduTokenCache.expireAtMs > now) return baiduTokenCache.token;
  const url = `${BAIDU_TOKEN_URL}?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8e3);
  try {
    const resp = await fetch(url, { method: "POST", signal: controller.signal });
    const data = await resp.json();
    if (!resp.ok || !data.access_token) {
      console.error(`[asr-provider] baidu token failed ${requestId} status=${resp.status} error=${String(data.error ?? "")}`);
      return null;
    }
    const ttlSec = typeof data.expires_in === "number" ? data.expires_in : 2592e3;
    baiduTokenCache = { token: data.access_token, expireAtMs: now + Math.max(60, ttlSec - 3600) * 1e3 };
    console.info(`[asr-provider] baidu token ok ${requestId} ttlSec=${ttlSec}`);
    return baiduTokenCache.token;
  } catch {
    console.error(`[asr-provider] baidu token request error ${requestId}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function handleAsr(body, requestId, startTime) {
  const audioUrl = validateAudioUrl(body?.audioUrl);
  if (!audioUrl) {
    let echo = "unparsable";
    try {
      const u = new URL(String(body?.audioUrl ?? ""));
      echo = `${u.hostname}${u.pathname.slice(-48)}`;
    } catch {
    }
    console.warn(`[asr-provider] rejected audioUrl ${requestId} target=${echo}`);
    return { error: "\u97F3\u9891\u5730\u5740\u4E0D\u5408\u6CD5\uFF1A\u4EC5\u652F\u6301\u8BC6\u522B\u672C\u5E94\u7528\u804A\u5929\u4E2D\u5DF2\u53D1\u9001\u7684\u8BED\u97F3", code: "BAD_AUDIO_URL", status: 400 };
  }
  const baiduAk = (process.env.BAIDU_API_KEY || "").trim();
  const baiduSk = (process.env.BAIDU_SECRET_KEY || "").trim();
  const useBaidu = Boolean(baiduAk && baiduSk);
  const openaiKey = (process.env.ASR_API_KEY || "").trim();
  const model = (process.env.ASR_MODEL || "").trim();
  const asrBaseUrl = (process.env.ASR_BASE_URL || "").trim();
  if (!useBaidu && (!asrBaseUrl || !openaiKey || !model)) {
    console.warn(`[asr-provider] not configured ${requestId} hasBaidu=${useBaidu} hasOpenai=${Boolean(asrBaseUrl && openaiKey && model)}`);
    return {
      error: "\u8BED\u97F3\u8BC6\u522B\u670D\u52A1\u5C1A\u672A\u914D\u7F6E\uFF0C\u6682\u65F6\u65E0\u6CD5\u8F6C\u6587\u5B57",
      code: "ASR_NOT_CONFIGURED",
      status: 503
    };
  }
  const MAX_BYTES = 8 * 1024 * 1024;
  const dlController = new AbortController();
  const dlTimer = setTimeout(() => dlController.abort(), 2e4);
  let audioBuf = null;
  try {
    const dl = await fetch(audioUrl, { signal: dlController.signal });
    if (!dl.ok) {
      if (dl.status === 404 || dl.status === 403 || dl.status === 400) {
        return { error: "\u8FD9\u6761\u8BED\u97F3\u7684\u6587\u4EF6\u5DF2\u7ECF\u4E0D\u5728\u4E86\uFF0C\u65E0\u6CD5\u8BC6\u522B", code: "AUDIO_NOT_FOUND", status: 404 };
      }
      return { error: "\u8BED\u97F3\u6587\u4EF6\u8BFB\u53D6\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5", code: "DOWNLOAD_FAILED", status: 502 };
    }
    audioBuf = await dl.arrayBuffer();
  } catch {
    return { error: "\u8BED\u97F3\u6587\u4EF6\u8BFB\u53D6\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5", code: "DOWNLOAD_FAILED", status: 502 };
  } finally {
    clearTimeout(dlTimer);
  }
  if (!audioBuf || audioBuf.byteLength === 0) {
    return { error: "\u8BED\u97F3\u5185\u5BB9\u4E3A\u7A7A", code: "EMPTY_AUDIO", status: 400 };
  }
  if (audioBuf.byteLength > MAX_BYTES) {
    return { error: "\u8FD9\u6BB5\u8BED\u97F3\u592A\u957F\u4E86\uFF0C\u6682\u65F6\u8BC6\u522B\u4E0D\u4E86", code: "AUDIO_TOO_LONG", status: 413 };
  }
  const fileName = storageFileName(audioUrl);
  const sniffed = sniffAudioFormat(audioBuf, fileName);
  console.info(
    `[asr-provider] audio resolved ${requestId} name=${fileName} realFmt=${sniffed.fmt || "unknown"} by=${sniffed.by}`
  );
  let text = "";
  if (useBaidu) {
    const fmt = baiduAudioFormat(sniffed.fmt);
    if (!fmt) {
      return {
        error: "\u8FD9\u6761\u8BED\u97F3\u662F\u65E7\u683C\u5F0F\u5F55\u7684\uFF0C\u6682\u65F6\u8BC6\u522B\u4E0D\u4E86\uFF1B\u65B0\u53D1\u9001\u7684\u8BED\u97F3\u652F\u6301\u8F6C\u6587\u5B57",
        code: "UNSUPPORTED_FORMAT",
        status: 415
      };
    }
    const token = await getBaiduAccessToken(baiduAk, baiduSk, requestId);
    if (!token) {
      return { error: "\u8BC6\u522B\u670D\u52A1\u9274\u6743\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u8BED\u97F3\u8BC6\u522B\u5BC6\u94A5\u914D\u7F6E", code: "AUTH_FAILED", status: 502 };
    }
    const payload = JSON.stringify({
      format: fmt,
      rate: 16e3,
      channel: 1,
      cuid: "network-chat-app",
      token,
      dev_pid: 1537,
      len: audioBuf.byteLength,
      speech: arrayBufferToBase64(audioBuf)
    });
    const upstream = await fetch(BAIDU_ASR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });
    const upstreamText = await upstream.text();
    let parsed;
    try {
      parsed = JSON.parse(upstreamText);
    } catch {
      return { error: "\u8BC6\u522B\u7ED3\u679C\u683C\u5F0F\u5F02\u5E38\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5", code: "BAD_UPSTREAM", status: 502 };
    }
    if (parsed.err_no !== 0) {
      if (parsed.err_no === 4 || parsed.err_no === 110 || parsed.err_no === 111) baiduTokenCache = null;
      if (parsed.err_no === 4) {
        return { error: "\u8BC6\u522B\u989D\u5EA6\u7528\u5B8C\u4E86\uFF0C\u8BF7\u8054\u7CFB\u5F00\u53D1\u8005\u5145\u503C\u540E\u91CD\u8BD5", code: "QUOTA_EXHAUSTED", status: 429 };
      }
      return { error: "\u8BED\u97F3\u8BC6\u522B\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5", code: "UPSTREAM_FAILED", status: 502 };
    }
    const arr = Array.isArray(parsed.result) ? parsed.result : [];
    text = arr.filter((x) => typeof x === "string").join("").trim();
  } else {
    const form = new FormData();
    form.append("file", new Blob([audioBuf]), fileName);
    form.append("model", model);
    const upstream = await fetch(`${asrBaseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: form
    });
    if (!upstream.ok) {
      return {
        error: "\u8BED\u97F3\u8BC6\u522B\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
        code: upstream.status === 429 ? "RATE_LIMITED" : "UPSTREAM_FAILED",
        status: upstream.status === 429 ? 429 : 502
      };
    }
    try {
      const parsed = await upstream.json();
      text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    } catch {
      return { error: "\u8BC6\u522B\u7ED3\u679C\u683C\u5F0F\u5F02\u5E38\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5", code: "BAD_UPSTREAM", status: 502 };
    }
  }
  console.info(
    `[asr-provider] success ${requestId} via=${useBaidu ? "baidu" : "openai"} textLength=${text.length} durationMs=${Date.now() - startTime}`
  );
  return { text };
}
var mainHandler = async (event) => {
  const requestId = Math.random().toString(36).slice(2, 10);
  const startTime = Date.now();
  const body = event?.body ?? event;
  return handleAsr(body, requestId, startTime);
};
var main = mainHandler;
var asr_build_default = mainHandler;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  main,
  mainHandler
});
