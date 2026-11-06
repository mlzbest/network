/**
 * 网络分层诊断 API 封装
 *
 * 对应 Edge Function `net-diagnose`：每次调用只跑一个检测项，前端并行发起、独立返回。
 * 另含两个纯客户端本地项（本机信息 / ARP），不经过服务端。
 */
import Taro from '@tarojs/taro';
import { projectUrlId, resolveCloudFnUrl, supabase, supabaseAnonKey } from '@/supabase/client';
import { getDeviceInfo, getAppBaseInfo } from '@/lib/system-info';
import { logDbg } from '../lib/logger';

export type ItemStatus = 'pass' | 'warn' | 'fail' | 'na' | 'pending' | 'unsupported';

/** 服务端检测项 key（与 net-diagnose function 的 runners 一一对应） */
export type ServerItemKey =
  | 'local'
  | 'ping'
  | 'dns'
  | 'dnscompare'
  | 'ports'
  | 'http'
  | 'tls'
  | 'throughput'
  | 'route'
  | 'multiprobe'
  | 'arp';

export interface DiagnoseResult {
  item: string;
  status: ItemStatus;
  summary: string;
  detail: Record<string, unknown>;
  durationMs: number;
}

export interface ItemMeta {
  key: ServerItemKey;
  title: string;
  command: string; // 对应文章里的命令行命令
  group: 'link' | 'dns' | 'transport' | 'app' | 'throughput';
  serverSide: boolean; // true=走 Edge Function；false=客户端本地/不支持
}

export const DIAGNOSE_ITEMS: ItemMeta[] = [
  { key: 'local', title: '本机网络与环境', command: 'ipconfig / ifconfig', group: 'link', serverSide: false },
  { key: 'ping', title: '连通性与延迟', command: 'ping', group: 'link', serverSide: true },
  { key: 'dns', title: '域名解析记录', command: 'nslookup / dig', group: 'dns', serverSide: true },
  { key: 'dnscompare', title: '多 DNS 源比对', command: 'resolvectl / hosts 排查', group: 'dns', serverSide: true },
  { key: 'ports', title: '端口连通矩阵', command: 'netstat / ss / nc', group: 'transport', serverSide: true },
  { key: 'route', title: '路由路径（近似）', command: 'traceroute / mtr', group: 'transport', serverSide: true },
  { key: 'arp', title: '局域网邻居表', command: 'arp -a', group: 'transport', serverSide: false },
  { key: 'http', title: 'HTTP 端到端请求', command: 'curl -v', group: 'app', serverSide: true },
  { key: 'tls', title: 'TLS 证书检查', command: 'openssl s_client', group: 'app', serverSide: true },
  { key: 'multiprobe', title: '多点拨测对比', command: 'Globalping免费拨测 / dig @多公共DNS节点', group: 'dns', serverSide: true },
  { key: 'throughput', title: '下行吞吐估算', command: 'wget / speedtest', group: 'throughput', serverSide: true },
];

/**
 * 网络检测层级（5 层）：与 full-diag-panel 的分组标题同源，供「单步测试」下拉选择。
 *
 * 【为什么把定义放在 api 层而不是组件里】层级是**诊断能力的划分**，不是展示细节：
 * 批量诊断页要按层跑、全量面板要按层分组渲染、将来历史面板也可能按层对比。
 * 定义散在组件里就会出现「两处各写一份、改一处漏一处」的漂移。
 *
 * 【为什么 key 用 string 而不是 ServerItemKey】层级 key（link/dns/...）与检测项 key
 * （ping/dns/...）是两个不同维度的枚举，虽然字面有重叠（dns 既是层也是项），
 * 但语义不同，混用同一个类型会让 `DIAG_LAYERS.find(l => l.key === itemKey)` 这类
 * 错误写法通过类型检查。
 */
export interface DiagLayer {
  key: string;
  /** 下拉里显示的短名（受宽度限制，不带序号） */
  label: string;
  /** 结果区标题用的全名（带序号，与全量面板一致） */
  title: string;
  /** 该层包含的检测项 key，按执行顺序 */
  items: ServerItemKey[];
}

export const DIAG_LAYERS: DiagLayer[] = [
  { key: 'link', label: '本机与链路层', title: '① 本机与链路层', items: ['local', 'ping'] },
  { key: 'dns', label: '域名解析层', title: '② 域名解析层', items: ['dns', 'dnscompare', 'multiprobe'] },
  { key: 'transport', label: '传输层', title: '③ 传输层', items: ['ports', 'route', 'arp'] },
  { key: 'app', label: '应用层', title: '④ 应用层', items: ['http', 'tls'] },
  { key: 'throughput', label: '吞吐层', title: '⑤ 吞吐层', items: ['throughput'] },
];

/** 按 key 取层级定义；未知 key 返回 null（调用方据此提示而不是静默跑空） */
export function findDiagLayer(key: string): DiagLayer | null {
  return DIAG_LAYERS.find((l) => l.key === key) ?? null;
}

/**
 * 单步测试的**具体指令**清单：一条指令 = 一个检测项，下拉里直接显示指令名。
 *
 * 【为什么用指令名而不是层级名】层级（「域名解析层」）是给人看的归类，
 * 但排查时真正要跑的是**某一个具体动作**（`ping` 还是 `dns`）。用指令名做选项，
 * 选什么就跑什么，一步到位；层级只作为副标题帮助理解这条指令属于哪一层。
 *
 * 【为什么从 DIAGNOSE_ITEMS 派生而不是另写一份】指令清单必须与检测项一一对应，
 * 另写一份就会出现「下拉里有、实际跑不了」或反之的漂移。这里只做「取哪些项 + 排序」，
 * 名称/所属层全部来自 DIAGNOSE_ITEMS 单一真源。
 *
 * 顺序按网络分层由下往上（链路 → 解析 → 传输 → 应用 → 吞吐），与排查思路一致。
 */
const COMMAND_ORDER: ServerItemKey[] = [
  'local',
  'ping',
  'dns',
  'dnscompare',
  'multiprobe',
  'ports',
  'route',
  'arp',
  'http',
  'tls',
  'throughput',
];

export interface DiagCommand {
  /** 指令名（= 检测项 key），下拉里显示的就是它 */
  key: ServerItemKey;
  /** 中文说明（下拉副标题 / 结果区标题用） */
  title: string;
  /** 所属层级 key，用于取层级标题 */
  group: string;
}

export const DIAG_COMMANDS: DiagCommand[] = COMMAND_ORDER.map((key) => {
  const meta = DIAGNOSE_ITEMS.find((i) => i.key === key);
  return { key, title: meta?.title ?? key, group: meta?.group ?? '' };
});

/** 按指令名取定义；未知指令返回 null */
export function findDiagCommand(key: string): DiagCommand | null {
  return DIAG_COMMANDS.find((c) => c.key === key) ?? null;
}

const ITEM_TIMEOUT_MS = 12000; // 前端侧单项超时（函数内部 8s+ 余量）

// ---------- 结果缓存（同一目标 60s 内复用） ----------

const cache = new Map<string, { at: number; data: DiagnoseResult }>();
const CACHE_TTL = 60_000;

export function clearDiagnoseCache(): void {
  cache.clear();
}

// ---------- 诊断中止（代次令牌） ----------
// Taro.request 本身不可取消，且函数侧无 abort 处理；采用与页面 runIdRef 同源的
// 「代次令牌」方案：abortActiveRun() 递增代数，在途请求返回后由发起方校验并丢弃。

let activeRunId = 0;

/** 使当前批次失效：后续所有在途结果都会被调用方丢弃 */
export function abortActiveRun(): number {
  activeRunId += 1;
  logDbg(`[net-diagnose] 🛑 中止当前诊断批次 → runId=${activeRunId}`);
  return activeRunId;
}

export function currentRunId(): number {
  return activeRunId;
}

// ---------- 服务端单项请求 ----------

export async function runServerItem(host: string, item: ServerItemKey, force = false): Promise<DiagnoseResult> {
  const cacheKey = `${host}::${item}`;
  if (!force) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;
  }

  const session = (await supabase.auth.getSession()).data.session;
  const token = session?.access_token || supabaseAnonKey;

  try {
    const res = await Taro.request({
      url: resolveCloudFnUrl('net-diagnose', 'net-diagnose'),
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnonKey,
        'OneDay-App-Id': projectUrlId,
      },
      data: { host, item },
      timeout: ITEM_TIMEOUT_MS,
    });

    if (res.statusCode === 200 && res.data && !res.data.error) {
      const data = res.data as DiagnoseResult;
      cache.set(cacheKey, { at: Date.now(), data });
      return data;
    }
    const msg = res.data?.error || `请求失败: ${res.statusCode}`;
    return { item, status: 'fail', summary: String(msg), detail: {}, durationMs: 0 };
  } catch (e: unknown) {
    const err = e as { message?: string; errMsg?: string };
    const msg = err.message || err.errMsg || '网络请求异常';
    const isH5 = Taro.getEnv() === Taro.ENV_TYPE.WEB;
    const isNetErr = msg.includes('Failed to fetch') || msg.includes('fail');
    return {
      item,
      status: 'fail',
      summary: isH5 && isNetErr ? 'H5预览环境无法访问云服务，请在真机小程序中测试' : msg,
      detail: {},
      durationMs: 0,
    };
  }
}

// ---------- 客户端本地项 ----------

export async function runLocalItem(): Promise<DiagnoseResult> {
  try {
    const netRes = await Taro.getNetworkType();
    // 拆分后的新 API（getDeviceInfo/getAppBaseInfo），避免废弃的 getSystemInfoSync 警告
    const device = getDeviceInfo();
    const appBase = getAppBaseInfo();
    const online = (netRes as { networkType?: string }).networkType !== 'none';
    return {
      item: 'local',
      status: online ? 'pass' : 'fail',
      summary: online
        ? `网络类型 ${(netRes as { networkType?: string }).networkType} · ${device.platform} ${device.system}`
        : '设备当前未联网',
      detail: {
        networkType: (netRes as { networkType?: string }).networkType,
        platform: device.platform,
        system: device.system,
        brand: device.brand,
        model: device.model,
        SDKVersion: appBase.SDKVersion,
        env: Taro.getEnv(),
      },
      durationMs: 0,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { item: 'local', status: 'warn', summary: `获取本机信息失败: ${msg}`, detail: {}, durationMs: 0 };
  }
}

// ---------- ARP 项（平台不支持，如实标注） ----------

export function buildArpResult(): DiagnoseResult {
  return {
    item: 'arp',
    status: 'unsupported',
    summary: '小程序与云端均无法读取你的局域网邻居表，需在本机终端执行 arp -a',
    detail: { hint: 'Windows/macOS: arp -a；Linux: ip neigh' },
    durationMs: 0,
  };
}

// ---------- 输入归一化与校验 ----------

/** 主机名字符集：ASCII 字母数字连字符、点 + 中文字符（IDN 中文域名）。
 * ⚠️ 云函数入口白名单不含中文，故中文域名必须在前端转 punycode 后再送服务端。 */
const HOSTNAME_RE = /^[a-zA-Z0-9\u4e00-\u9fa5.-]+$/;
/** IPv6（含 :: 缩写与 v4 映射尾段），不含方括号 */
const IPV6_RE = /^([0-9a-fA-F]{1,4}:){1,7}[0-9a-fA-F]{1,4}$|^(::[0-9a-fA-F:]+|[0-9a-fA-F:]+::)$/;

/**
 * 把用户输入归一化为「host[:port]」，容忍真实粘贴场景：
 * - 完整 URL（https://example.com/path?a=1 → example.com；带端口保留）
 * - 大写、首尾空格、末尾点（FQDN 根点）
 * - 包裹 http(s):// 的 host 若省略端口，按协议补 :80/:443——否则服务端
 *   buildProbeUrls 会先猜 https，对纯 http 站点产生假失败
 * - IPv6 保留方括号形式（[::1]:8080），服务端 stripPort 正则可正确剥离
 * 无法识别时返回 null。
 */
export function normalizeTarget(raw: string): string | null {
  let v = raw.trim();
  if (!v) return null;
  let defaultedPort = '';
  const m = /^(https?):\/\/([^/?#]*)(?:[/?#].*)?$/i.exec(v);
  if (m) {
    v = m[2];
    defaultedPort = m[1].toLowerCase() === 'http' ? ':80' : ':443';
  } else {
    // 无协议的 path-like 输入（example.com/foo）截断路径
    v = v.replace(/\/.*$/, '');
  }
  if (v.startsWith('[')) {
    // [ipv6](:port)?
    const mm = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(v);
    if (!mm || !IPV6_RE.test(mm[1])) return null;
    return `[${mm[1].toLowerCase()}]${mm[2] ? `:${mm[2]}` : ''}`;
  }
  // 裸 ipv6（含多个冒号且无端口歧义无法区分，要求至少出现一次 :: 或 ≥3 段 hex）
  const colonCount = (v.match(/:/g) || []).length;
  if (colonCount >= 2 && IPV6_RE.test(v)) return v.toLowerCase();
  const pm = /^(.*?):(\d{1,5})$/.exec(v);
  let host = v;
  let port = '';
  if (pm && pm[1]) {
    host = pm[1];
    const p = parseInt(pm[2], 10);
    if (!(p > 0 && p <= 65535)) return null;
    port = `:${pm[2]}`;
  } else if (defaultedPort) {
    port = defaultedPort;
  }
  host = host.replace(/\.+$/, ''); // FQDN 根点
  if (!host || !HOSTNAME_RE.test(host)) return null;
  return toAsciiHost(host.toLowerCase()) + port;
}

/** 中文（IDN）域名转 punycode。小程序无 URL 构造器可靠可用，手写 xn-- 前缀：
 * 逐标签检测非 ASCII → 按 RFC3492 编码为 base36。失败时原样返回
 * （云函数白名单会拒，错误信息对用户仍然可读）。 */
export function toAsciiHost(host: string): string {
  if (!/[^\x00-\x7F]/.test(host)) return host;
  try {
    return host
      .split('.')
      .map((label) => (/[^\x00-\x7F]/.test(label) ? `xn--${punycodeEncode(label)}` : label))
      .join('.');
  } catch (e) {
    console.warn('[net-diagnose] punycode 转换失败，按原样送服务端:', e);
    return host;
  }
}

// ---------- punycode（RFC3492 极简实现，仅用于 IDN 主机名） ----------

const PUNY_BASE = 36;
const PUNY_TMIN = 1;
const PUNY_TMAX = 26;
const PUNY_SKEW = 38;
const PUNY_DAMP = 700;
const PUNY_INITIAL_BIAS = 72;
const PUNY_INITIAL_N = 128;
const DELIM = '-';

function adaptBias(delta: number, n: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / PUNY_DAMP) : delta >> 1;
  d += Math.floor(d / n);
  let k = 0;
  while (d > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) >> 1) {
    d = Math.floor(d / (PUNY_BASE - PUNY_TMIN));
    k += PUNY_BASE;
  }
  return k + Math.floor(((PUNY_BASE - PUNY_TMIN + 1) * d) / (d + PUNY_SKEW));
}

function encodeDigit(digit: number): string {
  return String.fromCharCode(digit + 22 + (digit < 26 ? 75 : 0)); // 0-25→a-z, 26-35→0-9
}

/** 单个 Unicode 码点在「当前已插入集合」下的相对位置（generalized variable-length） */
function punycodeEncode(input: string): string {
  const codePoints: number[] = Array.from(input).map((ch) => ch.codePointAt(0) as number);
  const output: string[] = [];
  let n = PUNY_INITIAL_N;
  let delta = 0;
  let bias = PUNY_INITIAL_BIAS;
  for (const cp of codePoints) if (cp < 0x80) output.push(String.fromCodePoint(cp));
  const basic = output.length;
  let h = basic;
  if (basic > 0) output.push(DELIM);
  while (h < codePoints.length) {
    let m = Number.MAX_SAFE_INTEGER;
    for (const cp of codePoints) if (cp >= n && cp < m) m = cp;
    if (m - n > Math.floor((Number.MAX_SAFE_INTEGER - delta) / (h + 1))) throw new Error('overflow');
    delta += (m - n) * (h + 1);
    n = m;
    for (const cp of codePoints) {
      if (cp < n) {
        if (++delta === 0) throw new Error('overflow');
      } else if (cp === n) {
        let q = delta;
        for (let k = PUNY_BASE; ; k += PUNY_BASE) {
          const t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
          if (q < t) break;
          output.push(encodeDigit(t + ((q - t) % (PUNY_BASE - t))));
          q = Math.floor((q - t) / (PUNY_BASE - t));
        }
        output.push(encodeDigit(q));
        bias = adaptBias(delta, h + 1, h === basic);
        delta = 0;
        h++;
      }
    }
    delta++;
    n++;
  }
  return output.join('');
}

export function isValidTarget(raw: string): boolean {
  return normalizeTarget(raw) !== null;
}

/**
 * 多目标输入解析：按换行、逗号、分号、空格拆出多个地址，逐个归一化。
 * 用于「批量诊断」——一次测多个网站，排查是不是只有某个打不开。
 * 返回有效目标（去重保序）与无效原始片段（供 UI 提示跳过项）。
 */
export function parseTargets(raw: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const seg of raw.split(/[\s,，;；\n]+/)) {
    const t = seg.trim();
    if (!t) continue;
    const n = normalizeTarget(t);
    if (n) {
      if (!valid.includes(n)) valid.push(n);
    } else {
      invalid.push(t);
    }
  }
  return { valid, invalid };
}

// ---------- 单条指令执行（批量诊断页「单步测试」用） ----------

/**
 * 只跑**一条指令**（一个检测项），返回该项结果。
 *
 * 【为什么不用 Promise.allSettled 批量返回】单步测试的语义就是「一次跑一个动作」，
 * 逐条跑才能看清是哪一步出的问题；且 multiprobe/throughput 单项就要好几秒，
 * 批量等齐会让用户盯着空白。
 *
 * 【代次令牌】Taro.request 不可取消，中止只能靠调用方递增令牌后丢弃回包。
 * 这里不做令牌判断，由调用方在拿到结果后自行校验。
 */
export async function runSingleItem(host: string, key: ServerItemKey, force = false): Promise<DiagnoseResult> {
  const meta = DIAGNOSE_ITEMS.find((i) => i.key === key);
  if (!meta) {
    return { item: key, status: 'na', summary: `未知指令 ${key}`, detail: {}, durationMs: 0 };
  }
  if (meta.serverSide) return runServerItem(host, key, force);
  if (key === 'local') return runLocalItem();
  return buildArpResult();
}

// ---------- 批量快速拨测（每个目标只跑 dns + ping 两项） ----------

export interface QuickProbeOutcome {
  status: ItemStatus;
  summary: string;
  avgMs?: number;
}

/**
 * 对一个目标做轻量探测：并行 dns + ping，dns 失败直接判失败（ping 结果仅参考），
 * 否则以 ping 的延迟/丢包定级。调用方自行控制并发数与代次丢弃。
 */
export async function runQuickProbe(host: string, force = false): Promise<QuickProbeOutcome> {
  const [dnsR, pingR] = await Promise.all([
    runServerItem(host, 'dns', force),
    runServerItem(host, 'ping', force),
  ]);
  const metrics = extractPingMetrics(pingR);
  if (dnsR.status === 'fail') {
    return { status: 'fail', summary: `域名解析失败：${dnsR.summary}`, ...metrics };
  }
  if (pingR.status === 'fail') {
    return { status: 'fail', summary: `无法连通：${pingR.summary}`, ...metrics };
  }
  const status: ItemStatus =
    dnsR.status === 'warn' || pingR.status === 'warn' ? 'warn' : pingR.status === 'pass' ? 'pass' : 'warn';
  return { status, summary: pingR.summary || dnsR.summary, ...metrics };
}

// ---------- 历史指标提取（供 diag-history 留存与对比） ----------

/** 从 ping 项 detail 里取平均延迟/丢包率，用于走势对比。取不到返回 undefined。 */
export function extractPingMetrics(result?: DiagnoseResult): { avgMs?: number; lossPct?: number } {
  if (!result || result.status === 'pending') return {};
  const d = result.detail as Record<string, unknown>;
  const out: { avgMs?: number; lossPct?: number } = {};
  const avg = Number(d.avg);
  if (Number.isFinite(avg) && avg > 0) out.avgMs = Math.round(avg);
  const loss = parseFloat(String(d.packetLoss ?? ''));
  if (Number.isFinite(loss)) out.lossPct = loss;
  return out;
}

// ---------- 结论推导 ----------

export interface Conclusion {
  /** 一句话主结论（根因候选/告警层） */
  rootCause: string;
  /** 主建议动作 */
  suggestion: string;
  /** 所有异常项（fail 优先，其次 warn）逐条明细 */
  issues: Array<{ label: string; status: 'fail' | 'warn'; summary: string; suggestion: string }>;
  /** 正常完成检测的层级说明（用于「已排除」清单） */
  passedNotes: string[];
}

const LAYER_ORDER: ServerItemKey[] = ['local', 'dns', 'dnscompare', 'multiprobe', 'route', 'ports', 'tls', 'http', 'throughput'];

const LAYER_LABEL: Partial<Record<ServerItemKey, string>> = {
  local: '本机联网',
  dns: '域名解析',
  dnscompare: 'DNS 一致性',
  multiprobe: '多点拨测',
  route: '路由可达',
  ports: '端口连通',
  tls: 'TLS 证书',
  http: 'HTTP 服务',
  throughput: '下载吞吐',
};

const PASS_NOTE: Partial<Record<ServerItemKey, string>> = {
  local: '设备网络已连接，本机环境正常',
  dns: '域名解析成功，记录指向有效 IP',
  dnscompare: '多 DNS 源解析结果一致，无本地劫持迹象',
  multiprobe: '多地拨测节点均可达，目标服务全网可用',
  route: '路由路径完整，中间无中断节点',
  ports: '目标端口开放且可建立连接',
  tls: 'HTTPS 证书有效、链路可信',
  http: 'HTTP 请求端到端成功，服务响应正常',
  throughput: '下行带宽达标，网速无明显瓶颈',
};

export function deriveConclusion(results: Partial<Record<ServerItemKey, DiagnoseResult>>): Conclusion | null {
  const issues: Conclusion['issues'] = [];
  const passedNotes: string[] = [];
  for (const key of LAYER_ORDER) {
    const r = results[key];
    if (!r || r.status === 'pending' || r.status === 'na' || r.status === 'unsupported') continue;
    const label = LAYER_LABEL[key] ?? key;
    if (r.status === 'fail') {
      issues.push({ label, status: 'fail', summary: r.summary, suggestion: FAIL_SUGGESTION[key] ?? '请结合该项明细进一步排查' });
    } else if (r.status === 'warn') {
      issues.push({ label, status: 'warn', summary: r.summary, suggestion: WARN_SUGGESTION[key] ?? '建议关注该项明细' });
    } else {
      passedNotes.push(PASS_NOTE[key] ?? `${label}正常`);
    }
  }
  if (issues.length === 0) return null;
  // fail 排在 warn 前；首条作为主结论
  issues.sort((a, b) => (a.status === b.status ? 0 : a.status === 'fail' ? -1 : 1));
  const first = issues[0];
  const failCount = issues.filter((i) => i.status === 'fail').length;
  const warnCount = issues.length - failCount;
  const headline = failCount > 0
    ? `检测到 ${failCount} 项失败${warnCount > 0 ? `、${warnCount} 项告警` : ''}，最可能根因在「${first.label}」层`
    : `未发现失败项，但有 ${warnCount} 项告警，建议关注「${first.label}」层`;
  return {
    rootCause: `${headline}：${first.summary}`,
    suggestion: first.suggestion,
    issues,
    passedNotes,
  };
}

const FAIL_SUGGESTION: Partial<Record<ServerItemKey, string>> = {
  local: '请先确认设备 Wi-Fi/蜂窝网络已连接，再重新诊断',
  dns: '域名可能不存在或过期；检查拼写，或更换 DNS 后重试',
  dnscompare: '两源解析均失败，优先怀疑域名注册状态或运营商 DNS 故障',
  route: '所有候选入口不可达，检查目标服务是否宕机或防火墙拦截',
  ports: '常见端口全部关闭：服务未监听或被安全组/防火墙拦截',
  tls: '证书校验失败：检查目标 HTTPS 证书有效期与域名匹配',
  http: 'HTTP 层失败：目标服务未响应，查看上游端口与进程状态',
  throughput: '无法建立下载通道：先解决上层连通性问题',
};

const WARN_SUGGESTION: Partial<Record<ServerItemKey, string>> = {
  dnscompare: '不同 DNS 源结果不一致：可能存在本地 hosts 覆盖或运营商调度差异',
  multiprobe: '部分拨测节点不可用：对比结论不完整，可稍后重试或更换目标',
  route: '部分候选入口不可达：检查备用端口协议是否被拦截',
  ports: '仅少数端口开放：确认业务端口是否符合预期',
  tls: '证书链存在风险：建议尽快更新证书或修正 SNI 配置',
  http: '服务可达但返回错误码：属于应用层问题而非链路问题',
};

// ---------- AI 解读 prompt 构建 ----------

const STATUS_CN: Record<ItemStatus, string> = {
  pass: '通过',
  warn: '告警',
  fail: '失败',
  na: '不适用',
  pending: '未完成',
  unsupported: '平台不支持',
};

/**
 * 把诊断数据包拼成给 AI 的用户消息。入参用结构化摘要（不含 detail），
 * 控制长度在模型上下文内；输出为纯文本列表，便于模型逐项引用分析。
 */
export function buildDiagPrompt(p: {
  target: string;
  at: number;
  items: Array<{ title: string; status: ItemStatus; summary: string }>;
  avgMs?: number;
  lossPct?: number;
  rootCause?: string;
  suggestion?: string;
  passedNotes?: string[];
}): string {
  const time = new Date(p.at);
  const timeStr = `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
  const lines: string[] = [];
  lines.push('请帮我解读这次网络诊断结果。我不是技术人员，请按下面的要求回答：');
  lines.push('1. 先用一两句话讲人话结论：现在能不能正常访问、问题大概出在哪一环（避免专业术语，必须用时打个比方解释）。');
  lines.push('2. 再给分步骤操作指引：用 ①②③ 编号，每步一个具体动作，按"先易后难"排序——优先是我在手机/电脑上马上能做的（比如切换 Wi-Fi 和流量、开关飞行模式、重启路由器、换个浏览器或 App 试、清除 DNS 缓存的具体做法），其次才是需要找别人处理的（联系网站管理员、找宽带客服），并说清楚该找谁、怎么描述问题。');
  lines.push('3. 如果各项都正常，就别硬找问题，直接告诉我链路没问题，卡顿感可能来自哪里，以及观察建议。');
  lines.push('4. 总字数控制在 300 字以内，不要复述原始检测数据。');
  lines.push('');
  lines.push('以下是本次诊断数据：');
  lines.push(`【诊断目标】${p.target}`);
  lines.push(`【检测时间】${timeStr}`);
  if (p.avgMs !== undefined) lines.push(`【关键指标】平均延迟 ${p.avgMs}ms${p.lossPct !== undefined ? `，丢包率 ${p.lossPct}%` : ''}`);
  if (p.rootCause) {
    lines.push('');
    lines.push(`【规则引擎初判】${p.rootCause}`);
    if (p.suggestion) lines.push(`初判建议：${p.suggestion}`);
  }
  lines.push('');
  lines.push('【逐项结果】');
  for (const it of p.items) {
    lines.push(`- [${STATUS_CN[it.status]}] ${it.title}：${it.summary}`);
  }
  if (p.passedNotes && p.passedNotes.length > 0) {
    lines.push('');
    lines.push('【已排除的层级】');
    for (const n of p.passedNotes) lines.push(`✓ ${n}`);
  }
  return lines.join('\n');
}
