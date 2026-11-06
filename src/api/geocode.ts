import Taro from '@tarojs/taro';
import { projectUrlId, resolveCloudFnUrl, supabase, supabaseAnonKey } from '@/supabase/client';
import { logDbg, logWarn } from '@/lib/logger';

/**
 * 「坐标 → 地名/地址」的唯一网络出口。
 *
 * 【为什么走云函数而不是前端直连高德地图】
 * 高德 Web 服务 Key 一旦打进小程序包，任何人反编译都能拿到并盗刷配额。
 * Key 只存在云函数 Secret（`AMAP_WEB_KEY`）里，前端只发坐标。
 *
 * ⚠️ Task #8/#9 切换：优先走 `VITE_CLOUD_FN_BASE_URL + /reverse-geo`（TCB 承载层独立函数）；
 *    未配置承载层 URL 时回落旧的 `supabaseUrl + /functions/v1/net-diagnose`（geocode-reverse 分支）。
 *    承载层里这是独立函数（不再靠 action 路由），请求体仍带 action 字段以便回落时旧函数识别。
 *
 * ⚠️ 本模块**只负责解析**，不负责落库。落库由 `api/profiles.ts` 的
 *    `appendLocationHistory` / `backfillLocationHistory` 在写入时顺带完成——
 *    地名写一次就能长期复用，不该每次渲染都现查（配额 + 延迟都受不了）。
 */

export interface ReverseGeocodeResult {
  /** 地点名（如「望京SOHO」）；空串表示该坐标查不到地名（海上/境外未覆盖） */
  name: string;
  /** 完整地址；空串同上 */
  address: string;
}

/** 云函数不可用时的错误分类，供调用方决定「静默降级」还是「提示用户」 */
export type GeocodeFailure = 'not-configured' | 'unreachable' | 'error';

export class GeocodeError extends Error {
  readonly kind: GeocodeFailure;
  constructor(kind: GeocodeFailure, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'GeocodeError';
  }
}

/**
 * 逆地理编码：坐标 → 地名/地址。
 *
 * 失败一律抛 `GeocodeError`（带 `kind`），**不静默返回空串**：
 * 「查不到地名」与「服务没配好」是两件事，前者应退回显示坐标，
 * 后者应提示用户去配置 Key。混成同一个空串会让排查无从下手。
 */
export async function reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new GeocodeError('error', '坐标无效');
  }
  const session = (await supabase.auth.getSession()).data.session;
  const token = session?.access_token || supabaseAnonKey;
  // ⚠️ 泛型必须显式给成 `Record<string, unknown>`：Taro 的 `request` 泛型约束是
  //    `string | IAnyObject | ArrayBuffer`，写 `unknown` 会直接 TS2344 编译失败。
  let res: Taro.request.SuccessCallbackResult<Record<string, unknown>>;
  try {
    res = await Taro.request({
      url: resolveCloudFnUrl('reverse-geo', 'net-diagnose'),
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnonKey,
        'OneDay-App-Id': projectUrlId,
      },
      // 承载层 reverse-geo 独立函数不读 action，但保留该字段让回落的旧 net-diagnose 仍能识别
      data: { action: 'geocode-reverse', lat, lng },
      timeout: 15000,
    });
  } catch (e) {
    // 网络层失败（超时/断网）：地名是附属信息，调用方应静默降级为坐标
    logWarn('[geocode] 逆地理请求失败:', e);
    throw new GeocodeError('unreachable', '地图服务不可达');
  }

  const body = (res.data ?? {}) as { ok?: boolean; name?: string; address?: string; error?: string };
  if (res.statusCode === 501) {
    // 501 = 云函数里没配 AMAP_WEB_KEY。这是「能力未配置」，不是「解析失败」。
    logWarn('[geocode] 云函数未配置 AMAP_WEB_KEY，逆地理不可用');
    throw new GeocodeError('not-configured', body.error || '未配置地图服务密钥');
  }
  if (res.statusCode < 200 || res.statusCode >= 300 || body.error) {
    if (res.statusCode === 404 || res.statusCode === 401) {
      logWarn(`[geocode] ⛔ net-diagnose 逆地理通道不可达 status=${res.statusCode}，判定为尚未部署`);
      throw new GeocodeError('unreachable', '地图服务尚未部署生效');
    }
    throw new GeocodeError('error', String(body.error || `地图服务异常(${res.statusCode})`));
  }

  const name = String(body.name ?? '').trim();
  const address = String(body.address ?? '').trim();
  logDbg(`[geocode] 📍 (${lat}, ${lng}) → ${name || '(无地名)'} / ${address || '(无地址)'}`);
  return { name, address };
}

/**
 * 批量逆地理（串行 + 失败跳过）。
 *
 * 【为什么串行而不是 Promise.all】高德 Web 服务个人 Key 有 QPS 限制，并发十几个请求
 * 会直接触发限流（返回 infocode=10021/10019 频率超限），表现为「大部分点都解析不出来」。
 * 串行慢一点，但结果稳定；且调用方只在「首次打开轨迹页、且历史里缺地名」时跑一次。
 *
 * ⚠️ 单个点失败不中断整批：某个坐标查不到地名不该让后面的点全部放弃。
 */
export async function reverseGeocodeBatch(
  points: Array<{ lat: number; lng: number }>,
): Promise<Array<ReverseGeocodeResult | null>> {
  const out: Array<ReverseGeocodeResult | null> = [];
  for (const p of points) {
    try {
      out.push(await reverseGeocode(p.lat, p.lng));
    } catch (e) {
      logWarn('[geocode] 批量解析中单点失败，跳过:', e);
      out.push(null);
    }
  }
  return out;
}
