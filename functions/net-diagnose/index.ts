/**
 * Net Diagnose Edge Function（分层网络诊断）
 *
 * 参照《网络不通别只会 ping，这 10 个命令帮你定位》的思路，把常见命令行诊断
 * 映射为 Deno Edge Runtime 可执行的等价探测。每次调用只跑一个「检测项」，
 * 由前端并行发起、独立渲染。
 *
 * 支持 items:
 * - dns        : nslookup/dig 等价 → Deno.resolveDns(A/AAAA/CNAME/MX/TXT) + 耗时
 * - dnscompare : resolvectl/hosts 覆盖排查 → 系统 DNS vs 公共 DoH(dns.google) 交叉比对
 * - ports      : netstat/ss 的连通侧写 → HTTP(S) 多端口探测 open/closed/filtered
 * - http       : curl 等价 → 状态码/响应头/跳转链/TLS版本/总耗时
 * - tls        : openssl s_client 等价 → 证书链/有效期/SNI 匹配（best-effort）
 * - throughput : 带宽估算 → 拉取固定大小资源计时（服务器侧视角）
 * - route      : traceroute/mtr 近似 → 逐跳能力不可得，输出可达路径与出口信息（标注近似）
 * - ping       : 沿用 HTTP HEAD 多次探测统计 RTT/丢包（与旧 ping-host 算法一致）
 *
 * 已知平台限制（如实降级，不伪造数据）：
 * - Deno Edge Runtime 无原始套接字 / 无法发 ICMP → ping/route 均为 HTTP 近似
 * - 无法读取用户局域网 → arp 类检测不在服务端提供（前端标为不支持）
 *
 * ── 本函数同时承载「微信运动步数对比」──
 * 平台对云函数数量有额度限制，因此步数的解密/落库/查询作为共享模块挂进本函数，
 * **不新增函数数量**（与 set-account-email 承载密码找回同构）。实现见
 * `functions/net-diagnose/shared/we-run-steps.ts`（shared/ 不是部署入口，仅被相对引用）。
 *
 * 路由判据（按请求体形态区分，互不冲突）：
 *   - action === 'steps-query' / 'steps-sync' → 步数通道（诊断项永远不会带 action）
 *   - action === 'geocode-reverse'            → 逆地理编码通道（坐标 → 地名/地址）
 *   - 其余                                     → 原有的分层网络诊断（必须带 host + item）
 *
 * 部署：meoo-cli cloud deploy-function -n net-diagnose -j false
 *      （⚠️ 必须关闭 JWT 校验：auth-store 过渡态下前端没有合法 access token，
 *        步数通道的身份靠 code→openid→profiles.id 反查自证，不依赖网关。）
 */

import { handleWeRunSteps } from './shared/we-run-steps.ts';
import { handleReverseGeocode } from './shared/reverse-geocode.ts';

interface DiagnoseRequest {
  host: string;
  item: string;
  /** 步数通道动作标识；诊断请求不会携带该字段 */
  action?: unknown;
}

type ItemStatus = 'pass' | 'warn' | 'fail' | 'na';

interface ItemResult {
  item: string;
  status: ItemStatus;
  summary: string; // 一句话结论
  detail: Record<string, unknown>; // 明细数据（IP列表/响应头/端口矩阵等）
  durationMs: number;
}

const ITEM_TIMEOUT_MS = 8000; // 单项最长 8s
const PROBE_COUNT = 4; // ping 项探测次数

// ---------- 通用工具 ----------

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

// ---------- dns 项（nslookup/dig 等价） ----------

async function runDns(host: string): Promise<ItemResult> {
  const bare = stripProtocol(stripPort(host));
  if (isIPv4(bare)) {
    return ok('dns', 'na', '输入为 IP 地址，无需域名解析', { host: bare }, 0);
  }
  const start = Date.now();
  const detail: Record<string, unknown> = { host: bare };
  try {
    const [a, aaaa, cname] = await Promise.all([
      Deno.resolveDns(bare, 'A').catch(() => [] as string[]),
      Deno.resolveDns(bare, 'AAAA').catch(() => [] as string[]),
      Deno.resolveDns(bare, 'CNAME').catch(() => [] as string[]),
    ]);
    const durationMs = Date.now() - start;
    detail.a = a;
    detail.aaaa = aaaa;
    detail.cname = cname;
    detail.multiIp = a.length > 1; // 多 IP 通常意味着负载均衡/CDN
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
    const systemPromise = Deno.resolveDns(bare, 'A').catch(() => [] as string[]);
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
        const json = await res.json() as { Status?: number; Answer?: Array<{ data: string }> };
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
    // 证书错误说明 TLS 握手已完成 → 端口实际是开的
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
  const target = isIPv4(bare) ? `https://${bare}` : `https://${bare}`;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ITEM_TIMEOUT_MS);
  try {
    const res = await fetch(target, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
    clearTimeout(timer);
    const durationMs = Date.now() - start;
    // Deno fetch 对自签/过期证书直接抛错，能走到这里说明握手成功且证书链被信任
    const hsts = res.headers.get('strict-transport-security');
    return ok('tls', 'pass', 'TLS 握手成功，证书链受信任', {
      note: 'Edge Runtime 不透出证书明细；如需查看颁发者/到期时间，可在本机执行 openssl s_client -connect 主机:443 -servername 主机',
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
    limitation: 'Deno Edge Runtime 无原始套接字，不能发送 ICMP TTL 超时探测；真实 traceroute 请在本机执行',
    reachable,
    hops,
  }, durationMs);
}

// ---------- multiprobe 项（多点拨测对比：第三方拨测 API + 多公共递归 DNS 兜底） ----------
//
// 数据源优先级：
// 1. 第三方真实多地拨测 API：主源 Globalping（jsDelivr 公益项目，完全免费、
//    无需任何 key）；备源 17CE（境内覆盖更细，需配置 Secret `PROBE_17CE_TOKEN`）。
//    两者均失败时如实标注，绝不伪造数据。
// 2. 多公共递归 DNS（DoH）地理调度视角作为兜底：各节点按自身地理位置返回
//    被调度的 IP（CDN/GSLB 场景下不同地区结果不同），并对解析出的 IP 追加
//    第三方 IP 地理归属查询（api.ip.sb / geojs.io 双源），得到「节点 → IP → 地域」链路。
// Google DoH 在境内不可达，故不纳入。

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
  ipGeo?: Record<string, IpGeo>; // 每个解析 IP 的地理归属（第三方 API 查询结果）
  latencyMs: number;
  error?: string;
}

/** 查询单个 IP 的地理归属：ip.sb 主源，geojs.io 备源；均失败返回 null（不伪造） */
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
// 主源：Globalping（jsDelivr 公益项目，https://github.com/jsdelivr/globalping）
//   —— 完全免费、无需任何 key/token，全球探测节点，REST 契约：
//      POST /v1/measurements 创建 → GET /v1/measurements/{id} 轮询。沙箱实测可达（HTTP 202）。
// 备源：17CE 云监测（境内省市运营商覆盖更细，但需注册 token；
//   实测匿名请求被其 WAF 拦截，仅作为配置 PROBE_17CE_TOKEN 后的可选增强）。

interface ThirdPartyProbe {
  country: string;
  region: string; // 省份/州
  city: string;
  isp: string;
  dnsIp?: string; // 该节点解析到的 IP
  pingTime?: number; // 平均延迟 ms
  lostRate?: number; // 丢包率 %
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
      // 实测契约：stats 为 { min, max, avg, total, loss: { min, max, avg, total, percentage } }（数值直挂，非 {value} 包装）
      stats?: { avg?: number; loss?: { percentage?: number } };
    };
  }>;
}

/**
 * Globalping 免费多地 Ping（jsDelivr 公益项目，无需任何鉴权）。
 * locations 用 [{ magic: 'Europe', limit: N }]（limit 单独使用会被 API 校验拒绝；
 * worldwide 会命中纯 IPv6 节点报 no_probes_found）。
 * 预算约 6s：创建 → 轮询至 finished/failed，超时如实报错，不伪造。
 */
async function probeViaGlobalping(target: string, probeCount: number): Promise<ThirdPartyResult> {
  const start = Date.now();
  try {
    const createRes = await withTimeout(
      fetch('https://api.globalping.io/v1/measurements', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // locations 必须含至少一个选择字段（magic），limit 单独使用会被 API 拒绝；
        // worldwide 会命中纯 IPv6 节点导致 no_probes_found，改用 Europe 池（境内访问延迟仍具参考性）
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
    const created = await createRes.json() as { id?: string };
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
      const json = await res.json() as GpMeasurement;
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
 * 17CE 云监测 Ping API（v4，需注册 token）。实测匿名调用被其 WAF 拦截返回 HTML，
 * 仅在配置 PROBE_17CE_TOKEN 后启用；失败一律如实上报。
 */
async function probeVia17Ce(hostname: string): Promise<ThirdPartyResult> {
  const token = Deno.env.get('PROBE_17CE_TOKEN') || '';
  if (!token) {
    return { ok: false, provider: '17CE', probes: [], error: '未配置 PROBE_17CE_TOKEN 密钥（17CE 为可选增强源，需注册获取 token）' };
  }
  const start = Date.now();
  try {
    // 1. 创建任务（用户提供的凭证名为 api_pwd，历史文档亦见 token，双写提高通过率）
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
      // 非 JSON 响应（如 WAF 拦截页）如实上报，不伪造
      const snippet = createText.slice(0, 80).replace(/\s+/g, ' ');
      return { ok: false, provider: '17CE', probes: [], error: `创建任务返回非JSON(HTTP ${createRes.status}): ${snippet}` };
    }
    if (created.retCode !== 0 || !created.data?.taskid) {
      return { ok: false, provider: '17CE', probes: [], error: `创建任务失败: ${created.retMsg ?? '未知错误'}(retCode=${created.retCode})` };
    }
    const taskId = created.data.taskid;
    // 2. 轮询结果（最多约 6s，未完成则如实报超时，不伪造）
    let result: { retCode?: number; data?: unknown } | null = null;
    while (Date.now() - start < 6000) {
      await new Promise((r) => setTimeout(r, 1500));
      const res = await withTimeout(
        fetch(`https://api.17ce.com/v4/result/ping?task_id=${taskId}&main_frame=1&sub_frame=1`),
        2500, '17ce-result',
      );
      const json = await res.json() as { retCode?: number; data?: unknown };
      if (json.retCode === 0) { result = json; break; }
      if (json.retCode !== 5) { // 5 = 任务进行中
        return { ok: false, provider: '17CE', probes: [], error: `查询结果失败: ${(json as { retMsg?: string }).retMsg ?? '未知错误'}(retCode=${json.retCode})` };
      }
    }
    if (!result) {
      return { ok: false, provider: '17CE', probes: [], error: `任务 ${taskId} 在时限内未完成（免费账户限频时常见），请稍后重试` };
    }
    // data 结构：{ "省份-运营商": [ {country,region,city,isp,dns_ip,ping_time,lost_rate,...} ] } 或数组，做宽松归一化
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
    const json = await res.json() as {
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
    // type=1 为 A 记录；过滤 CNAME 链上的中间记录
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

  // 并行：免费 Globalping 多地拨测（主源，无需 key） + 17CE（可选增强，需 token） + DoH 多节点解析
  const [gpResult, ceResult, dohResults] = await Promise.all([
    probeViaGlobalping(bare, 4),
    probeVia17Ce(bare),
    Promise.all(DOH_NODES.map((n) => probeDohNode(n, bare))),
  ]);
  // 优先 Globalping（免费直连）；若配置了 17CE token 且成功则合并展示境内更细的探测点
  let thirdParty: ThirdPartyResult;
  if (ceResult.ok && !gpResult.ok) {
    thirdParty = ceResult;
  } else if (gpResult.ok && ceResult.ok) {
    thirdParty = { ok: true, provider: 'Globalping + 17CE', probes: [...gpResult.probes, ...ceResult.probes] };
  } else {
    thirdParty = gpResult.ok ? gpResult : ceResult.ok ? ceResult : gpResult;
  }

  // DoH 兜底链路：为成功节点解析出的唯一 IP 补充地理归属（限 6 个，避免超时）
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

  // 17CE 为可选增强源：配置了密钥仍失败时，把真实原因透出到明细（不阻断 Globalping 主源）
  const ceNote = !ceResult.ok && (Deno.env.get('PROBE_17CE_TOKEN') || '') !== ''
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

  // 降级：DoH 地理调度视角 + IP 归属
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

// ---------- 入口 ----------

Deno.serve(handleRequest);

async function handleRequest(req: Request): Promise<Response> {
  const functionName = 'net-diagnose';
  const requestId = crypto.randomUUID().slice(0, 8);
  const headers = { 'Content-Type': 'application/json' };

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: '仅支持 POST 请求' }), { status: 405, headers });
  }

  try {
    // ⚠️ 必须用 clone() 探测请求体：Request 的 body 是**一次性流**，读一次即 consumed。
    //    若这里先 await req.json() 再把同一个 req 交给步数模块，模块内再次 req.json()
    //    会抛 `Body already consumed`（实测 HTTP 500）。与 set-account-email 同构。
    const probe = (await req.clone().json().catch(() => ({}))) as Partial<DiagnoseRequest>;

    // ── 路由分发：微信运动步数通道（请求体带 action，诊断项只带 host + item）──
    const action = typeof probe.action === 'string' ? probe.action : '';
    if (action === 'steps-query' || action === 'steps-sync') {
      console.info(`[${functionName}] steps routed ${requestId} action=${action}`);
      return await handleWeRunSteps(req, requestId);
    }

    // ── 路由分发：逆地理编码通道（坐标 → 地名/地址）──
    // 与步数通道同构：靠请求体 action 区分，诊断项永远不会带 action。
    if (action === 'geocode-reverse') {
      console.info(`[${functionName}] geocode routed ${requestId}`);
      return await handleReverseGeocode(req, requestId);
    }

    const body = (await req.json()) as DiagnoseRequest;
    const { host, item } = body;
    console.info(`[${functionName}] request ${requestId} item=${item} host=${host}`);

    if (!host || typeof host !== 'string') {
      return new Response(JSON.stringify({ error: '缺少 host 参数' }), { status: 400, headers });
    }
    const validPattern = /^[a-zA-Z0-9.\-:/]+$/;
    if (!validPattern.test(host)) {
      return new Response(JSON.stringify({ error: '无效的域名或IP格式' }), { status: 400, headers });
    }

    const runners: Record<string, (h: string) => Promise<ItemResult>> = {
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
    const runner = runners[item];
    if (!runner) {
      return new Response(JSON.stringify({ error: `不支持的检测项: ${item}` }), { status: 400, headers });
    }

    const result = await withTimeout(runner(host), ITEM_TIMEOUT_MS + 2000, item);
    console.info(`[${functionName}] success ${requestId} item=${item} status=${result.status} ${result.durationMs}ms`);
    return new Response(JSON.stringify(result), { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${functionName}] failed ${requestId}: ${message}`);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers });
  }
}
