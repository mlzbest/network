/**
 * reverse-geocode — 承载层：逆地理编码（高德 Web API 代理）（TCB Node.js 版）
 *
 * 替代旧 `functions/net-diagnose/shared/reverse-geocode.ts`（挂在 net-diagnose 下的
 * 逆地理通道，action='geocode-reverse'）。承载层拆成独立函数。
 *
 * 【为什么必须走服务端代理，不能前端直连】
 * 高德 Web 服务 Key 一旦写进小程序包，任何人反编译都能拿到并盗刷配额。
 * 因此 Key 只存在云函数 Secret 里（AMAP_WEB_KEY），前端只把坐标发过来。
 *
 * 环境变量（必需）：
 *   - AMAP_WEB_KEY：未配置时返回 { error: '未配置地图服务密钥（AMAP_WEB_KEY）' }，
 *     前端据此降级为「只显示坐标」，而不是让用户看到「解析失败」却不知要配什么。
 *
 * ⚠️ 坐标系：高德 Web 服务只接受 **GCJ-02（火星坐标）**。微信 `getLocation` 默认
 *    返回的正是 GCJ-02（`type: 'gcj02'`），因此**不做任何坐标转换**。
 *    若将来改成 `type: 'wgs84'` 取点，必须先转 GCJ-02，否则地名会整体偏移几百米。
 *
 * TCB 入口：mainHandler(event, context)
 * 请求（event 或 event.body）：{ lat: number, lng: number }
 * 响应：{ ok: true, name: string, address: string } | { error: string }
 */

type Json = Record<string, unknown>;

/** 高德 Web 服务逆地理回包（只声明用到的字段） */
interface AmapRegeoResponse {
  /** '1' 表示成功，'0' 表示失败 */
  status?: string;
  /** 失败时的错误说明 */
  info?: string;
  /** 失败时的错误码（10001=Key 无效，10003=日配额超限，10009=Key 与平台不匹配…） */
  infocode?: string;
  regeocode?: {
    /** 结构化地址，如「北京市朝阳区望京街道望京SOHO」 */
    formatted_address?: string;
    addressComponent?: {
      province?: string;
      city?: string | string[];
      district?: string;
      township?: string;
      street?: string;
      streetNumber?: { street?: string; number?: string };
      building?: { name?: string };
      neighborhood?: { name?: string };
    };
    /** 附近的 POI 列表，第一个通常是最贴近的地点名 */
    pois?: Array<{ name?: string; address?: string; distance?: string }>;
  };
}

const AMAP_REVERSE_URL = 'https://restapi.amap.com/v3/geocode/regeo';
const REQUEST_TIMEOUT_MS = 6000;

/** 高德在「直辖市」场景下 city 会返回空数组，统一压成字符串 */
function asText(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.length > 0 ? String(v[0] ?? '').trim() : '';
  return '';
}

/**
 * 把高德回包压成「地点名 + 地址」两个字段。
 *
 * 【为什么地点名优先取 POI 而不是 addressComponent】
 * 用户看轨迹时想知道的是「这是哪栋楼 / 哪个商场」，而不是「北京市朝阳区」。
 * POI 的 name 正是这个粒度（如「望京SOHO」）；没有 POI 时才退回楼栋/小区名，
 * 再退回街道，最后退回「市 + 区」。
 *
 * ⚠️ 四级兜底必须都写：郊区、高速、海上等位置高德经常不返回 pois，
 *    只取 pois[0] 会让这些点显示成空字符串，看起来像「解析失败」。
 */
function pickNameAndAddress(r: AmapRegeoResponse['regeocode']): { name: string; address: string } {
  const address = String(r?.formatted_address ?? '').trim();
  const comp = r?.addressComponent;
  const poiName = String(r?.pois?.[0]?.name ?? '').trim();
  const building = String(comp?.building?.name ?? '').trim();
  const neighborhood = String(comp?.neighborhood?.name ?? '').trim();
  const street = String(comp?.streetNumber?.street ?? comp?.street ?? '').trim();
  const streetNo = String(comp?.streetNumber?.number ?? '').trim();
  const district = String(comp?.district ?? '').trim();
  const city = asText(comp?.city);

  let name = poiName;
  if (!name) name = building;
  if (!name) name = neighborhood;
  if (!name && street) name = `${street}${streetNo}`;
  if (!name && district) name = `${city}${district}`;
  if (!name) name = address;

  return { name, address: address || name };
}

/** 统一形状：承载层函数返回对象（TCB 事件函数直接 return JSON） */
export type ReverseGeoResult =
  | { ok: true; name: string; address: string }
  | { ok: false; error: string };

/**
 * TCB 云函数入口。event 兼容三种形态：
 *  - TCB 事件函数：event 直接是 { lat, lng }
 *  - 网关 HTTP 触发：event.body 是 JSON 字符串
 *  - 网关 HTTP 触发（已解析）：event.body 是对象
 */
export const mainHandler = async (event: Record<string, unknown>): Promise<ReverseGeoResult> => {
  const functionName = 'reverse-geocode';
  const requestId = Math.random().toString(36).slice(2, 10);
  const startTime = Date.now();

  const rawBody = event?.body ?? event;
  const body = (typeof rawBody === 'string'
    ? JSON.parse(rawBody)
    : rawBody) as { lat?: unknown; lng?: unknown };

  const lat = Number(body?.lat);
  const lng = Number(body?.lng);

  // 坐标合法性必须严格校验：非法坐标发给高德会消耗一次配额并返回错误，
  // 而这类错误对排查毫无价值（前端 bug 应该在前端暴露）。
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: '缺少有效的 lat / lng 参数' };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, error: '坐标超出合法范围' };
  }

  const key = process.env.AMAP_WEB_KEY;
  if (!key) {
    // 501 语义：这是「能力未配置」，不是「服务出错」。
    // 前端据此把文案写成「未配置地图服务」，而不是「解析失败请重试」。
    console.warn(`[${functionName}] ${requestId} 未配置 AMAP_WEB_KEY，跳过解析`);
    return { ok: false, error: '未配置地图服务密钥（AMAP_WEB_KEY）' };
  }

  // ⚠️ 高德要求 location 参数顺序是「经度,纬度」（lng,lat），与腾讯地图相反。
  //    写反了不会报错，只会返回一个完全不相干的地名——极难从结果上发现。
  const url =
    `${AMAP_REVERSE_URL}?location=${lng},${lat}&key=${key}` +
    '&extensions=all&radius=200&batch=false';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let payload: AmapRegeoResponse;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.warn(`[${functionName}] ${requestId} 上游 HTTP ${res.status}`);
      return { ok: false, error: `地图服务返回 HTTP ${res.status}` };
    }
    payload = (await res.json()) as AmapRegeoResponse;
  } finally {
    clearTimeout(timer);
  }

  // 高德用 status='1' 表示成功（注意是字符串），其余为业务错误
  if (String(payload.status) !== '1') {
    const msg = String(payload.info ?? '未知错误');
    const code = String(payload.infocode ?? '');
    console.warn(`[${functionName}] ${requestId} 上游业务错误 infocode=${code} info=${msg}`);
    return { ok: false, error: `地图服务错误: ${msg}(${code})` };
  }

  const { name, address } = pickNameAndAddress(payload.regeocode);
  if (!name) {
    // 坐标合法但高德查不到任何地名（如海上、境外未覆盖区域）。
    // 这不是错误，返回空串让前端退回显示坐标。
    console.info(`[${functionName}] ${requestId} 无地名结果 (${lat}, ${lng})`);
    return { ok: true, name: '', address: '' };
  }

  console.info(
    `[${functionName}] success ${requestId} (${lat}, ${lng}) → ${name} durationMs=${Date.now() - startTime}`,
  );
  return { ok: true, name, address };
};
