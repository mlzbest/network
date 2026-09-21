/**
 * Ping Host Edge Function (HTTP 探测版)
 *
 * 说明：Edge Runtime（Deno）无法执行系统 ping 命令，也无法发送 ICMP。
 * 这里改用「向目标发起 HTTP(S) 请求、用响应耗时近似 RTT」的方式做网络探测：
 * 连续探测多次，统计成功/失败次数得到丢包率，成功耗时的 min/avg/max 作为延迟指标。
 *
 * 部署：edge-runtime deploy --name ping-host
 */

interface PingRequest {
  host: string;
}

interface PingResult {
  host: string;
  resolvedUrl: string;
  packetsSent: number;
  packetsReceived: number;
  packetLoss: string;
  min: string;
  avg: string;
  max: string;
  mdev: string;
}

const PROBE_COUNT = 4; // 探测次数，模拟 4 个包
const PROBE_TIMEOUT_MS = 5000; // 单次探测超时

// 判断是否为 IPv4 地址
function isIPv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

// 提取 host 中自带的端口（如 baidu.com:8080）
function extractPort(host: string): number | null {
  const m = host.match(/:(\d{1,5})$/);
  if (!m) return null;
  const p = parseInt(m[1], 10);
  return Number.isFinite(p) && p > 0 && p <= 65535 ? p : null;
}

// 去掉 host 末尾的 :port，得到纯主机名/IP
function stripPort(host: string): string {
  return host.replace(/:\d{1,5}$/, '');
}

// 构造候选探测 URL 列表：
// - 用户已带协议前缀：只用该 URL
// - 用户显式指定端口：按 http/https + 该端口尝试
// - 纯 IP：优先 http:80（IP 上 https 常无有效证书），再试 https:443 / http:8080
// - 域名：先 https:443，再 http:80 / http:8080
function buildProbeUrls(rawHost: string): string[] {
  if (/^https?:\/\//i.test(rawHost)) {
    return [rawHost];
  }

  const bare = stripPort(rawHost);
  const explicitPort = extractPort(rawHost);

  if (explicitPort !== null) {
    return [`http://${bare}:${explicitPort}`, `https://${bare}:${explicitPort}`];
  }

  if (isIPv4(bare)) {
    return [`http://${bare}`, `https://${bare}`, `http://${bare}:8080`];
  }

  return [`https://${bare}`, `http://${bare}`, `http://${bare}:8080`];
}

Deno.serve(handleRequest);

async function handleRequest(req: Request): Promise<Response> {
  const functionName = 'ping-host';
  const requestId = crypto.randomUUID().slice(0, 8);
  const headers = { 'Content-Type': 'application/json' };

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: '仅支持 POST 请求' }), { status: 405, headers });
  }

  try {
    const { host }: PingRequest = await req.json();
    console.info(`[${functionName}] request ${requestId} host=${host}`);

    if (!host || typeof host !== 'string') {
      return new Response(JSON.stringify({ error: '缺少 host 参数' }), { status: 400, headers });
    }

    // 输入校验：只允许域名/IP/端口/斜杠等安全字符，避免被当作开放代理滥用
    const validPattern = /^[a-zA-Z0-9.\-:/]+$/;
    if (!validPattern.test(host)) {
      return new Response(JSON.stringify({ error: '无效的域名或IP格式' }), { status: 400, headers });
    }

    const candidateUrls = buildProbeUrls(host);
    console.info(`[${functionName}] candidates ${requestId}: ${candidateUrls.join(', ')}`);

    // 第一步：逐个尝试候选 URL，找到第一个可达的（协议+端口）
    let reachableUrl: string | null = null;
    for (const url of candidateUrls) {
      const probe = await singleProbe(url);
      if (probe.ok) {
        reachableUrl = url;
        break;
      }
    }

    // 全部候选都不可达
    if (!reachableUrl) {
      console.warn(`[${functionName}] all candidates unreachable ${requestId}: ${candidateUrls.join(', ')}`);
      return new Response(
        JSON.stringify({ error: `目标不可达或探测失败: ${candidateUrls.join(' / ')}` }),
        { status: 200, headers },
      );
    }

    console.info(`[${functionName}] reachable ${requestId} via ${reachableUrl}`);

    // 第二步：对可达地址并发探测 PROBE_COUNT 次，统计延迟
    const probes = await Promise.allSettled(
      Array.from({ length: PROBE_COUNT }, () => singleProbe(reachableUrl as string)),
    );

    const latencies: number[] = [];
    let received = 0;
    for (const p of probes) {
      if (p.status === 'fulfilled' && p.value.ok) {
        received += 1;
        latencies.push(p.value.durationMs);
      }
    }

    const sent = PROBE_COUNT;
    const lossRate = sent > 0 ? ((sent - received) / sent) * 100 : 0;

    const result = summarize(host, reachableUrl, sent, received, lossRate, latencies);
    console.info(`[${functionName}] success ${requestId} avg=${result.avg}ms received=${received}/${sent}`);

    return new Response(JSON.stringify(result), { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${functionName}] failed ${requestId}: ${message}`);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers });
  }
}

// 单次 HTTP 探测：返回是否可达 + 往返耗时(ms)
async function singleProbe(url: string): Promise<{ ok: boolean; durationMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const start = Date.now();
  try {
    // no-cors 模式下只要网络层能连通就会 resolve（opaque response），
    // 用于判断主机可达性；HEAD 减少下载体积
    await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    return { ok: true, durationMs: Date.now() - start };
  } catch {
    // 网络错误/超时/证书问题等，视为该次探测失败
    return { ok: false, durationMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

// 汇总探测结果为 ping 风格指标
function summarize(
  host: string,
  resolvedUrl: string,
  sent: number,
  received: number,
  lossRate: number,
  latencies: number[],
): PingResult {
  const sorted = [...latencies].sort((a, b) => a - b);
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  const avg = latencies.length > 0 ? latencies.reduce((s, v) => s + v, 0) / latencies.length : 0;
  // 平均偏差(mdev)
  const mdev =
    latencies.length > 0
      ? latencies.reduce((s, v) => s + Math.abs(v - avg), 0) / latencies.length
      : 0;

  return {
    host,
    resolvedUrl,
    packetsSent: sent,
    packetsReceived: received,
    packetLoss: `${Number(lossRate.toFixed(0))}%`,
    min: min.toFixed(1),
    avg: avg.toFixed(1),
    max: max.toFixed(1),
    mdev: mdev.toFixed(1),
  };
}
