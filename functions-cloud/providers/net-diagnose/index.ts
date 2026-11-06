/**
 * net-diagnose — 承载层：分层网络诊断（TCB Node.js 版）
 *
 * 替代旧 `functions/net-diagnose`（Deno Edge Runtime）。把 Deno API 等价迁移到
 * Node.js：
 *   - Deno.resolveDns(host, 'A'|'AAAA'|'CNAME') → dns.promises.resolve4/resolve6/resolveCname
 *   - Deno.env.get('PROBE_17CE_TOKEN')           → process.env.PROBE_17CE_TOKEN
 *   - crypto.randomUUID()                         → Node crypto.randomUUID()
 *   - Deno.serve(requestHandler)                  → TCB 事件函数 mainHandler(event, context)
 *
 * 支持 items（与旧函数一致）：
 * - ping / dns / dnscompare / ports / http / tls / throughput / route / multiprobe
 *
 * 平台限制（如实降级，不伪造数据）：
 * - Node.js 运行时同样无原始套接字 / 无法发 ICMP → ping/route 均为 HTTP 近似
 * - multiprobe 的 17CE 拨测需配置 PROBE_17CE_TOKEN，Globalping 免费无需 key
 *
 * 环境变量（可选）：
 * - PROBE_17CE_TOKEN（17CE 云监测拨测，未配置时该增强源如实标注未生效）
 *
 * TCB 入口：mainHandler(event, context)
 * 请求（event 或 event.body）：{ host, item }
 * 响应：ItemResult { item, status, summary, detail, durationMs }
 */

import dns from 'node:dns/promises';
import crypto from 'node:crypto';

interface DiagnoseRequest {
  host: string;
  item: string;
}

type ItemStatus = 'pass' | 'warn' | 'fail' | 'na';

interface ItemResult {
  item: string;
  status: ItemStatus;
  summary: string;
  detail: Record<string, unknown>;
  durationMs: number;
}

const ITEM_TIMEOUT_MS = 8000;
const PROBE_COUNT = 4;

// ---------- 通用工具（与旧 Deno 版一致） ----------

function isIPv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function extractPort(host: string): number | null {
  const m = host.match(/:(\d{1,5})$/);
  if (!m) return null;
  const p = parseInt(m[1], 10);
  return Number.isFinite(p) && p > 0 && p <= 65535 ? p : null;
}

function stripPort(host: string): string {
  return host.replace(/:\d{1,5}$/, '');
}

function stripProtocol(host: string): string {
  return host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

function buildProbeUrls(rawHost: string): string[] {
  if (/^https?:\/\//i.test(rawHost)) return [rawHost];
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

function ok(item: string, status: ItemStatus, summary: string, detail: Record<string, unknown>, durationMs: number): ItemResult {
  return { item, status, summary, detail, durationMs };
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------- ping 项（HTTP HEAD 多次探测） ----------

async function singleProbe(url: string): Promise<{ ok: boolean; durationMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const start = Date.now();
  try {
    await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    return { ok: true, durationMs: Date.now() - start };
  } catch {
    return { ok: false, durationMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

async function runPing(host: string): Promise<ItemResult> {
  const start = Date.now();
  const candidates = buildProbeUrls(host);
  let reachable: string | null = null;
  for (const url of candidates) {
    const p = await singleProbe(url);
    if (p.ok) { reachable = url; break; }
  }
  if (!reachable) {
    return ok('ping', 'fail', '目标不可达或探测失败', { candidates }, Date.now() - start);
  }
  const probes = await Promise.allSettled(
    Array.from({ length: PROBE_COUNT }, () => singleProbe(reachable as string)),
  );
  const latencies: number[] = [];
  let received = 0;
  for (const p of probes) {
    if (p.status === 'fulfilled' && p.value.ok) {
      received += 1;
      latencies.push(p.value.durationMs);
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = latencies.length > 0 ? latencies.reduce((s, v) => s + v, 0) / latencies.length : 0;
  const lossRate = ((PROBE_COUNT - received) / PROBE_COUNT) * 100;
  const status: ItemStatus = received === 0 ? 'fail' : lossRate > 0 ? 'warn' : 'pass';
  return ok('ping', status, `平均延迟 ${avg.toFixed(1)}ms，丢包率 ${lossRate.toFixed(0)}%`, {
    resolvedUrl: reachable,
    packetsSent: PROBE_COUNT,
    packetsReceived: received,
    packetLoss: `${Number(lossRate.toFixed(0))}%`,
    min: (sorted[0] ?? 0).toFixed(1),
    avg: avg.toFixed(1),
    max: (sorted[sorted.length - 1] ?? 0).toFixed(1),
  }, Date.now() - start);
}

// ---------- dns 项（nslookup/dig 等价，Node.js 版用 dns.promises） ----------

async function runDns(host: string): Promise<ItemResult> {
  const bare = stripProtocol(stripPort(host));
  if (isIPv4(bare)) {
    return ok('dns', 'na', '输入为 IP 地址，无需域名解析', { host: bare }, 0);
  }
  const start = Date.now();
  const detail: Record<string, unknown> = { host: bare };
  try {
    // Deno.resolveDns(host, 'A') 等价 dns.promises.resolve4；CNAME/AAAA 同理
    const [a, aaaa, cname] = await Promise.all([
      dns.resolve4(bare).catch(() => [] as string[]),
      dns.resolve6(bare).catch(() => [] as string[]),
      dns.resolveCname(bare).catch(() => [] as string[]),
    ]);
    const durationMs = Date.now() - start;
    detail.a = a;
    detail.aaaa = aaaa;
    detail.cname = cname;
    detail.multiIp = a.length > 1;
    if (a.length === 0 && aaaa.length === 0) {
      return ok('dns', 'fail', '未解析到任何 A/AAAA 记录，域名可能不存在或已过期', detail, durationMs);
    }
    return ok('dns', 'pass', `解析成功：A 记录 ${a.length} 条 / AAAA 记录 ${aaaa.length} 条`, detail, durationMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return ok('dns', 'fail', `DNS 解析异常: ${message}`, detail, Date.now() - start);
  }
}

// ---------- dnscompare 项（多 DNS 源交叉比对） ----------

async function runDnsCompare(host: string): Promise<ItemResult> {
  const bare = stripProtocol(stripPort(host));
  if (isIPv4(bare)) {
    return ok('dnscompare', 'na', '输入为 IP 地址，无需 DNS 比对', {}, 0);
  }
  const start = Date.now();
  try {
    const systemPromise = dns.resolve4(bare).catch(() => [] as string[]);
    const dohSources = [
      { name: 'Google DoH', url: `https://dns.google/resolve?name=${encodeURIComponent(bare)}&type=A` },
      { name: '阿里 DoH', url: `https://dns.alidns.com/resolve?name=${encodeURIComponent(bare)}&type=A` },
    ];
    let dohIps: string[] = [];
    let dohSource = '';
    let dohError: string | null = null;
    for (const src of dohSources) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        const res = await fetch(src.url, { signal: controller.signal });
        const json = (await res.json()) as { Status?: number; Answer?: Array<{ data: string }> };
        if (json.Status === 0 && Array.isArray(json.Answer)) {
          dohIps = json.Answer.map((x) => x.data).filter((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
          dohSource = src.name;
          dohError = null;
          break;
        } else if (json.Status === 3) {
          dohError = `${src.name}: NXDOMAIN（判定域名不存在）`;
        } else {
          dohError = `${src.name}: Status=${json.Status}`;
        }
      } catch (e) {
        dohError = `${src.name}: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        clearTimeout(timer);
      }
    }
    const systemIps = await systemPromise;
    const durationMs = Date.now() - start;
    const detail = { systemDns: systemIps, publicDns: dohIps, publicDnsSource: dohSource, dohError };
    if (systemIps.length === 0 && dohIps.length === 0) {
      return ok('dnscompare', 'fail', '两个 DNS 源均无结果，域名大概率不存在', detail, durationMs);
    }
    if (dohError && systemIps.length > 0) {
      return ok('dnscompare', 'warn', `公共 DNS 查询受阻（${dohError}），本地解析结果仅供参考`, detail, durationMs);
    }
    const same = systemIps.slice().sort().join(',') === dohIps.slice().sort().join(',');
    if (same) {
      return ok('dnscompare', 'pass', '系统 DNS 与公共 DNS 解析结果一致，未见劫持迹象', detail, durationMs);
    }
    return ok('dnscompare', 'warn', '系统 DNS 与公共 DNS 结果不一致，可能存在本地 hosts 覆盖或运营商 DNS 调度差异', detail, durationMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return ok('dnscompare', 'fail', `DNS 比对异常: ${message}`, {}, Date.now() - start);
  }
}

// ---------- ports 项（端口连通性矩阵） ----------

interface PortProbe {
  port: number;
  protocol: 'http' | 'https';
  state: 'open' | 'closed' | 'filtered';
  latencyMs: number;
}

async function probePort(host: string, port: number, protocol: 'http' | 'https'): Promise<PortProbe> {
  const url = `${protocol}://${host}${port === 80 || port === 443 ? '' : `:${port}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  const start = Date.now();
  try {
    await fetch(url, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
    return { port, protocol, state: 'open', latencyMs: Date.now() - start };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const certRelated = /certificate|ssl|tls/i.test(msg);
    return { port, protocol, state: certRelated ? 'open' : 'closed', latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

async function runPorts(host: string): Promise<ItemResult> {
  const bare = stripProtocol(stripPort(host));
  const explicit = extractPort(host);
  const targets: Array<{ port: number; protocol: 'http' | 'https' }> = explicit !== null
    ? [{ port: explicit, protocol: 'http' }, { port: explicit, protocol: 'https' }]
    : [
        { port: 80, protocol: 'http' },
        { port: 443, protocol: 'https' },
        { port: 8080, protocol: 'http' },
        { port: 8443, protocol: 'https' },
      ];
  const start = Date.now();
  const probes = await Promise.all(targets.map((t) => probePort(bare, t.port, t.protocol)));
  const durationMs = Date.now() - start;
  const openCount = probes.filter((p) => p.state === 'open').length;
  const anyFiltered = probes.some((p) => p.state === 'filtered');
  const detail = { probes };
  if (openCount === 0) {
    return ok('ports', 'fail', '常见端口均不可达：服务未监听或被防火墙拦截', detail, durationMs);
  }
  const status: ItemStatus = anyFiltered || openCount < 2 ? 'warn' : 'pass';
  return ok('ports', status, `开放端口 ${openCount}/${probes.length} 个`, detail, durationMs);
}

// ---------- http 项（curl 等价） ----------

async function runHttp(host: string): Promise<ItemResult> {
  const start = Date.now();
  const candidates = buildProbeUrls(host);
  let lastError = '';
  for (const url of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ITEM_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
      const totalMs = Date.now() - t0;
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      clearTimeout(timer);
      const finalUrl = res.url || url;
      const redirected = finalUrl.replace(/\/$/, '') !== url.replace(/\/$/, '');
      const status: ItemStatus = res.status >= 500 ? 'warn' : res.status >= 400 ? 'warn' : 'pass';
      const note = res.status >= 400 ? '（可达但返回客户端/服务端错误，不算链路故障）' : '';
      return ok('http', status, `HTTP ${res.status} ${res.statusText}${note}，总耗时 ${totalMs}ms`, {
        requestUrl: url,
        finalUrl,
        redirected,
        httpVersion: res.headers.get('server') || '',
        statusText: res.statusText,
        timing: { totalMs },
        headers,
      }, Date.now() - start);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      clearTimeout(timer);
    }
  }
  return ok('http', 'fail', `HTTP 请求失败: ${lastError}`, { candidates }, Date.now() - start);
}

// ---------- tls 项（证书检查，best-effort） ----------

async function runTls(host: string): Promise<ItemResult> {
  const bare = stripProtocol(stripPort(host));
  const target = `https://${bare}`;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ITEM_TIMEOUT_MS);
  try {
    const res = await fetch(target, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
    clearTimeout(timer);
    const durationMs = Date.now() - start;
    const hsts = res.headers.get('strict-transport-security');
    return ok('tls', 'pass', 'TLS 握手成功，证书链受信任', {
      note: 'Node 运行时不透出证书明细；如需查看颁发者/到期时间，可在本机执行 openssl s_client -connect 主机:443 -servername 主机',
      hsts: hsts || '(未启用)',
      protocolHint: 'TLS1.2+',
    }, durationMs);
  } catch (error) {
    clearTimeout(timer);
    const msg = error instanceof Error ? error.message : String(error);
    if (/certificate|ssl|tls|handshake/i.test(msg)) {
      return ok('tls', 'warn', `TLS 证书校验未通过: ${msg}`, { error: msg }, Date.now() - start);
    }
    return ok('tls', 'na', '未能建立 TLS 连接以检查证书（端口不可达或非 HTTPS 服务）', { error: msg }, Date.now() - start);
  }
}

// ---------- throughput 项（下载速率估算） ----------

async function runThroughput(host: string): Promise<ItemResult> {
  const candidates = buildProbeUrls(host);
  const start = Date.now();
  for (const base of candidates) {
    const url = `${base.replace(/\/$/, '')}/favicon.ico`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ITEM_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const res = await fetch(url, { signal: controller.signal });
      const buf = await res.arrayBuffer();
      const ms = Date.now() - t0;
      clearTimeout(timer);
      const bytes = buf.byteLength;
      if (bytes === 0 || ms === 0) continue;
      const kbPerSec = (bytes / 1024) / (ms / 1000);
      return ok('throughput', 'pass', `下行吞吐估算约 ${kbPerSec.toFixed(0)} KB/s（服务器侧视角，样本 ${bytes} 字节）`, {
        sampleUrl: url,
        bytes,
        ms,
        kbPerSec: kbPerSec.toFixed(1),
      }, Date.now() - start);
    } catch {
      clearTimeout(timer);
    }
  }
  return ok('throughput', 'fail', '目标不可达，无法估算下载速率', {}, Date.now() - start);
}

// ---------- route 项（traceroute 近似） ----------

async function runRoute(host: string): Promise<ItemResult> {
  const start = Date.now();
  const candidates = buildProbeUrls(host);
  const hops: Array<{ url: string; reachable: boolean; latencyMs: number }> = [];
  let reachable: string | null = null;
  for (const url of candidates) {
    const p = await singleProbe(url);
    hops.push({ url, reachable: p.ok, latencyMs: p.durationMs });
    if (p.ok && !reachable) reachable = url;
  }
  const durationMs = Date.now() - start;
  if (!reachable) {
    return ok('route', 'fail', '所有候选协议/端口均不可达，无法形成路由路径', { hops }, durationMs);
  }
  return ok('route', 'warn', '近似路径（平台无法获取真实逐跳 IP，此处为各候选入口可达性与延迟）', {
    limitation: 'Node 运行时无原始套接字，不能发送 ICMP TTL 超时探测；真实 traceroute 请在本机执行',
    reachable,
    hops,
  }, durationMs);
}

// ---------- multiprobe 项（多点拨测对比：第三方拨测 API + 多公共递归 DNS 兜底） ----------

interface DohNode {
  name: string;
  region: string;
  url: string;
}

const DOH_NODES: DohNode[] = [
  { name: 'AliDNS', region: '中国·杭州', url: 'https://dns.alidns.com/resolve?name={host}&type=A' },
  { name: 'DNSPod (腾讯)', region: '中国·深圳', url: 'https://doh.pub/dns-query?name={host}&type=A' },
  { name: 'Cloudflare', region: '全球任播', url: 'https://cloudflare-dns.com/dns-query?name={host}&type=A' },
];

interface IpGeo {
  country?: string;
  region?: string;
  city?: string;
  isp?: string;
  source: string;
}

interface NodeProbeResult {
  node: string;
  region: string;
  ips: string[];
  ipGeo?: Record<string, IpGeo>;
  latencyMs: number;
  error?: string;
}

async function lookupIpGeo(ip: string): Promise<IpGeo | null> {
  const sources: Array<{ name: string; url: string; parse: (j: any) => IpGeo | null }> = [
    {
      name: 'ip.sb',
      url: `https://api.ip.sb/geoip/${ip}`,
      parse: (j) => (j && (j.country || j.city)
        ? { country: j.country, region: j.region, city: j.city, isp: j.isp || j.organization, source: 'ip.sb' }
        : null),
    },
    {
      name: 'geojs.io',
      url: `https://get.geojs.io/v1/ip/geo/${ip}.json`,
      parse: (j) => (j && (j.country || j.ip)
        ? { country: j.country, region: j.region, city: j.city, isp: j.organization, source: 'geojs.io' }
        : null),
    },
  ];
  for (const src of sources) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const res = await fetch(src.url, { signal: controller.signal });
      if (!res.ok) continue;
      const geo = src.parse(await res.json());
      if (geo) return geo;
    } catch {
      // 单源失败继续下一源
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// ---------- 第三方拨测 API ----------

interface ThirdPartyProbe {
  country: string;
  region: string;
  city: string;
  isp: string;
  dnsIp?: string;
  pingTime?: number;
  lostRate?: number;
  error?: string;
}

interface ThirdPartyResult {
  ok: boolean;
  provider: string;
  probes: ThirdPartyProbe[];
  error?: string;
}

interface GpMeasurement {
  status?: string;
  results?: Array<{
    probe?: { city?: string; country?: string; network?: string };
    result?: {
      resolvedAddress?: string;
      stats?: { avg?: number; loss?: { percentage?: number } };
    };
  }>;
}

async function probeViaGlobalping(target: string, probeCount: number): Promise<ThirdPartyResult> {
  const start = Date.now();
  try {
    const createRes = await withTimeout(
      fetch('https://api.globalping.io/v1/measurements', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'ping',
          target,
          locations: [{ magic: 'Europe', limit: probeCount }],
          measurementOptions: { packets: 4 },
        }),
      }),
      3500, 'globalping-create',
    );
    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => '');
      return { ok: false, provider: 'Globalping', probes: [], error: `创建测量失败 HTTP ${createRes.status} ${errText.slice(0, 120)}` };
    }
    const created = (await createRes.json()) as { id?: string };
    if (!created.id) {
      return { ok: false, provider: 'Globalping', probes: [], error: '创建测量未返回 id' };
    }
    let meas: GpMeasurement | null = null;
    while (Date.now() - start < 6000) {
      await new Promise((r) => setTimeout(r, 1200));
      const res = await withTimeout(
        fetch(`https://api.globalping.io/v1/measurements/${created.id}?finish=true`),
        2500, 'globalping-poll',
      );
      const json = (await res.json()) as GpMeasurement;
      if (json.status === 'finished' || json.status === 'failed') { meas = json; break; }
    }
    if (!meas || !Array.isArray(meas.results) || meas.results.length === 0) {
      return { ok: false, provider: 'Globalping', probes: [], error: `测量 ${created.id} 在时限内未完成，请稍后重试` };
    }
    const probes: ThirdPartyProbe[] = [];
    for (const r of meas.results) {
      const stats = r.result?.stats;
      const avg = stats?.avg;
      const lossPct = stats?.loss?.percentage;
      probes.push({
        country: r.probe?.country ?? '',
        region: '',
        city: r.probe?.city ?? '',
        isp: r.probe?.network ?? '',
        dnsIp: r.result?.resolvedAddress,
        pingTime: typeof avg === 'number' ? avg : undefined,
        lostRate: typeof lossPct === 'number' ? lossPct : undefined,
      });
    }
    return { ok: true, provider: 'Globalping', probes };
  } catch (e) {
    return { ok: false, provider: 'Globalping', probes: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 17CE 云监测 Ping API（v4，需注册 token）。
 * Node.js 版：Deno.env.get → process.env；URLSearchParams 同标准。
 */
async function probeVia17Ce(hostname: string): Promise<ThirdPartyResult> {
  const token = process.env.PROBE_17CE_TOKEN || '';
  if (!token) {
    return { ok: false, provider: '17CE', probes: [], error: '未配置 PROBE_17CE_TOKEN 密钥（17CE 为可选增强源，需注册获取 token）' };
  }
  const start = Date.now();
  try {
    const form = new URLSearchParams({ token, api_pwd: token, domain: hostname, count: '9', type: '1' });
    const createRes = await withTimeout(
      fetch('https://api.17ce.com/v4/task/ping', {
        method: 'POST',
        body: form,
        headers: { accept: 'application/json' },
      }),
      4000, '17ce-create',
    );
    const createText = await createRes.text();
    let created: { retCode?: number; retMsg?: string; data?: { taskid?: string } };
    try {
      created = JSON.parse(createText);
    } catch {
      const snippet = createText.slice(0, 80).replace(/\s+/g, ' ');
      return { ok: false, provider: '17CE', probes: [], error: `创建任务返回非JSON(HTTP ${createRes.status}): ${snippet}` };
    }
    if (created.retCode !== 0 || !created.data?.taskid) {
      return { ok: false, provider: '17CE', probes: [], error: `创建任务失败: ${created.retMsg ?? '未知错误'}(retCode=${created.retCode})` };
    }
    const taskId = created.data.taskid;
    let result: { retCode?: number; data?: unknown } | null = null;
    while (Date.now() - start < 6000) {
      await new Promise((r) => setTimeout(r, 1500));
      const res = await withTimeout(
        fetch(`https://api.17ce.com/v4/result/ping?task_id=${taskId}&main_frame=1&sub_frame=1`),
        2500, '17ce-result',
      );
      const json = (await res.json()) as { retCode?: number; data?: unknown };
      if (json.retCode === 0) { result = json; break; }
      if (json.retCode !== 5) {
        return { ok: false, provider: '17CE', probes: [], error: `查询结果失败: ${(json as { retMsg?: string }).retMsg ?? '未知错误'}(retCode=${json.retCode})` };
      }
    }
    if (!result) {
      return { ok: false, provider: '17CE', probes: [], error: `任务 ${taskId} 在时限内未完成（免费账户限频时常见），请稍后重试` };
    }
    const raw = result.data;
    const rows: unknown[] = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? Object.values(raw as Record<string, unknown>).flat()
        : [];
    const probes: ThirdPartyProbe[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const num = (v: unknown): number | undefined => {
        const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
        return Number.isFinite(n) ? n : undefined;
      };
      probes.push({
        country: String(r.country ?? ''),
        region: String(r.region ?? r.province ?? ''),
        city: String(r.city ?? ''),
        isp: String(r.isp ?? ''),
        dnsIp: r.dns_ip ? String(r.dns_ip) : undefined,
        pingTime: num(r.ping_time ?? r.avg_time),
        lostRate: num(r.lost_rate),
      });
    }
    if (probes.length === 0) {
      return { ok: false, provider: '17CE', probes: [], error: '任务完成但未解析到探测明细（接口结构可能变更）' };
    }
    return { ok: true, provider: '17CE', probes };
  } catch (e) {
    return { ok: false, provider: '17CE', probes: [], error: e instanceof Error ? e.message : String(e) };
  }
}

async function probeDohNode(node: DohNode, hostname: string): Promise<NodeProbeResult> {
  const url = node.url.replace('{host}', encodeURIComponent(hostname));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/dns-json' },
    });
    const json = (await res.json()) as {
      Status?: number;
      Answer?: Array<{ type: number; data: string }>;
    };
    const ms = Date.now() - start;
    if (json.Status === 3) {
      return { node: node.name, region: node.region, ips: [], latencyMs: ms, error: 'NXDOMAIN（域名不存在）' };
    }
    if (json.Status !== 0) {
      return { node: node.name, region: node.region, ips: [], latencyMs: ms, error: `Status=${json.Status}` };
    }
    const ips = (json.Answer ?? [])
      .filter((x) => x.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(x.data))
      .map((x) => x.data);
    return { node: node.name, region: node.region, ips, latencyMs: ms };
  } catch (e) {
    return {
      node: node.name,
      region: node.region,
      ips: [],
      latencyMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

function ipPrefix2(ip: string): string {
  return ip.split('.').slice(0, 2).join('.');
}

async function runMultiProbe(host: string): Promise<ItemResult> {
  const bare = stripProtocol(stripPort(host));
  if (isIPv4(bare)) {
    return ok('multiprobe', 'na', '输入为 IP 地址，多点拨测不适用（可直接看端口/HTTP 项）', {}, 0);
  }
  const start = Date.now();

  const [gpResult, ceResult, dohResults] = await Promise.all([
    probeViaGlobalping(bare, 4),
    probeVia17Ce(bare),
    Promise.all(DOH_NODES.map((n) => probeDohNode(n, bare))),
  ]);
  let thirdParty: ThirdPartyResult;
  if (ceResult.ok && !gpResult.ok) {
    thirdParty = ceResult;
  } else if (gpResult.ok && ceResult.ok) {
    thirdParty = { ok: true, provider: 'Globalping + 17CE', probes: [...gpResult.probes, ...ceResult.probes] };
  } else {
    thirdParty = gpResult.ok ? gpResult : ceResult.ok ? ceResult : gpResult;
  }

  const success = dohResults.filter((r) => !r.error);
  const allIps = [...new Set(success.flatMap((r) => r.ips))];
  const geoTargets = allIps.slice(0, 6);
  const geos = await Promise.all(geoTargets.map(async (ip) => [ip, await lookupIpGeo(ip)] as const));
  const geoMap: Record<string, IpGeo> = {};
  for (const [ip, geo] of geos) {
    if (geo) geoMap[ip] = geo;
  }
  const nodesWithGeo = dohResults.map((r) => {
    const ipGeo: Record<string, IpGeo> = {};
    for (const ip of r.ips) {
      if (geoMap[ip]) ipGeo[ip] = geoMap[ip];
    }
    return Object.keys(ipGeo).length > 0 ? { ...r, ipGeo } : r;
  });

  const durationMs = Date.now() - start;
  const distinctSegments = [...new Set(allIps.map(ipPrefix2))];
  const failedNodes = dohResults.filter((r) => r.error);
  const geoFailedIps = geoTargets.filter((ip) => !geoMap[ip]);

  const ceNote = !ceResult.ok && (process.env.PROBE_17CE_TOKEN || '') !== ''
    ? `17CE 增强源未生效：${ceResult.error ?? '未知错误'}`
    : null;

  const detail: Record<string, unknown> = {
    source: thirdParty.ok ? (thirdParty.provider.indexOf('17CE') >= 0 ? '17ce' : 'globalping') : 'doh',
    thirdParty,
    nodes: nodesWithGeo,
    uniqueIps: allIps,
    distinctSegments,
    failedNodes: failedNodes.map((r) => `${r.node}: ${r.error}`),
    geoFailedIps,
    ceNote,
  };

  if (thirdParty.ok) {
    const probes = thirdParty.probes;
    const withLatency = probes.filter((p) => p.pingTime !== undefined);
    const lossy = probes.filter((p) => (p.lostRate ?? 0) > 0);
    const regions = [...new Set(probes.map((p) => `${p.region}${p.city ? `·${p.city}` : ''}-${p.isp}`).filter((s) => s.replace(/[-]/g, '') !== ''))];
    const avgAll = withLatency.length > 0
      ? withLatency.reduce((s, p) => s + (p.pingTime as number), 0) / withLatency.length
      : null;
    const summaryParts: string[] = [`${thirdParty.provider} 真实多地拨测：${probes.length} 个探测点`];
    if (avgAll !== null) summaryParts.push(`平均延迟 ${avgAll.toFixed(1)}ms`);
    if (lossy.length > 0) summaryParts.push(`${lossy.length} 个节点有丢包`);
    const status: ItemStatus = lossy.length > 0 || withLatency.length < probes.length ? 'warn' : 'pass';
    detail.regions = regions;
    return ok('multiprobe', status, summaryParts.join('，'), detail, durationMs);
  }

  detail.limitation = `第三方拨测 API 未启用（${thirdParty.error}），以下为公共递归 DNS 地理调度视角`;
  if (success.length === 0) {
    return ok('multiprobe', 'fail', '所有拨测节点均查询失败', detail, durationMs);
  }
  if (failedNodes.length > 0 && success.length === 1) {
    return ok('multiprobe', 'warn', `仅 ${success[0].node} 节点可用，其余节点查询失败，对比结论不完整`, detail, durationMs);
  }
  const geoHint = Object.keys(geoMap).length > 0 ? '（含 IP 地理归属）' : '';
  if (distinctSegments.length <= 1) {
    return ok('multiprobe', 'pass', `${success.length} 个拨测节点返回同一网段 IP，目标未做分区域调度（或为单点服务）${geoHint}`, detail, durationMs);
  }
  return ok('multiprobe', 'pass', `${success.length} 个拨测节点返回 ${distinctSegments.length} 个不同网段，目标存在 CDN/GSLB 分区域调度${geoHint}`, detail, durationMs);
}

// ---------- TCB 事件函数入口 ----------

const RUNNERS: Record<string, (h: string) => Promise<ItemResult>> = {
  ping: runPing,
  dns: runDns,
  dnscompare: runDnsCompare,
  ports: runPorts,
  http: runHttp,
  tls: runTls,
  throughput: runThroughput,
  route: runRoute,
  multiprobe: runMultiProbe,
};

/**
 * TCB 云函数入口。event 兼容三种形态：
 *  - TCB 事件函数：event 直接是 { host, item }
 *  - 网关 HTTP 触发：event.body 是 JSON 字符串
 *  - 网关 HTTP 触发（已解析）：event.body 是对象
 */
export const mainHandler = async (event: Record<string, unknown>): Promise<ItemResult> => {
  const functionName = 'net-diagnose';
  const requestId = crypto.randomUUID().slice(0, 8);

  const rawBody = event?.body ?? event;
  const body = typeof rawBody === 'string'
    ? (JSON.parse(rawBody) as Partial<DiagnoseRequest>)
    : (rawBody as Partial<DiagnoseRequest>);

  const host = typeof body?.host === 'string' ? body.host : '';
  const item = typeof body?.item === 'string' ? body.item : '';

  console.info(`[${functionName}] request ${requestId} item=${item} host=${host}`);

  if (!host) {
    return { item, status: 'fail', summary: '缺少 host 参数', detail: {}, durationMs: 0 };
  }
  const validPattern = /^[a-zA-Z0-9.\-:/]+$/;
  if (!validPattern.test(host)) {
    return { item, status: 'fail', summary: '无效的域名或IP格式', detail: {}, durationMs: 0 };
  }

  const runner = RUNNERS[item];
  if (!runner) {
    return { item, status: 'fail', summary: `不支持的检测项: ${item}`, detail: {}, durationMs: 0 };
  }

  try {
    const result = await withTimeout(runner(host), ITEM_TIMEOUT_MS + 2000, item);
    console.info(`[${functionName}] success ${requestId} item=${item} status=${result.status} ${result.durationMs}ms`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${functionName}] failed ${requestId} item=${item}: ${message}`);
    return { item, status: 'fail', summary: `检测异常: ${message}`, detail: {}, durationMs: Date.now() };
  }
};
