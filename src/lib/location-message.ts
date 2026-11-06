import Taro from '@tarojs/taro';
import { setNativePreviewGrace } from '@/lib/shield-state';
import { logDbg } from './logger';

/**
 * 位置消息（content_type = 'location'）的编解码与选点封装。
 *
 * 【为什么复用 content 字段而不加数据库列】
 * messages.content 是裸 TEXT 列，位置消息把 `{lat,lng,name,address}` 序列化成 JSON 存进去，
 * 与「语音消息 content 存时长串 [12s]」「文件消息 content 存文件名」是同一套约定。
 * 好处：不需要新增迁移、不需要改 RLS，历史消息与实时消息走完全相同的读写路径。
 * 代价：content 不再是「给人看的文本」，所以**所有展示位置都必须走本模块的解析函数**，
 * 绝不能把原始 JSON 直接渲染到气泡或会话列表里。
 *
 * 【为什么用短键名】JSON 要进 content 列并随消息列表整体传输，短键能省下可观体积。
 */
export interface LocationPayload {
  /** 纬度（-90 ~ 90） */
  lat: number;
  /** 经度（-180 ~ 180） */
  lng: number;
  /** 地点名称，如「星巴克(国贸店)」；用户手选时可能为空 */
  name: string;
  /** 详细地址，如「北京市朝阳区建国门外大街1号」 */
  address: string;
}

/** 会话列表 / 引用摘要里位置消息的占位文案（与 [图片]/[语音] 同款口径） */
export const LOCATION_LABEL = '[位置]';

/** 位置气泡里地点名的兜底文案（用户选点未填名称时） */
const FALLBACK_NAME = '位置';

/**
 * 把位置数据序列化成可落库的 content 字符串。
 * 数值统一保留 6 位小数（约 0.1 米精度，远超微信定位精度），避免浮点尾数把 JSON 撑长。
 */
export function encodeLocation(payload: LocationPayload): string {
  const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
  return JSON.stringify({
    lat: round6(payload.lat),
    lng: round6(payload.lng),
    name: payload.name || '',
    address: payload.address || '',
  });
}

/**
 * 解析位置消息的 content。
 * ⚠️ 必须容错：content 是裸 TEXT 列，任何脏数据（手工改库、旧版本格式、被截断的 JSON）
 * 都可能出现在这里。解析失败一律返回 null，由调用方降级成「位置信息不可用」占位块，
 * **绝不能让 JSON.parse 的异常冒到渲染层**——那会让整条消息列表白屏。
 */
export function decodeLocation(content: string | null | undefined): LocationPayload | null {
  if (!content) return null;
  try {
    const raw = JSON.parse(content) as Partial<LocationPayload> | null;
    if (!raw || typeof raw !== 'object') return null;
    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    // 经纬度必须都是有限数且在合法区间内，否则视为脏数据
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return {
      lat,
      lng,
      name: typeof raw.name === 'string' ? raw.name : '',
      address: typeof raw.address === 'string' ? raw.address : '',
    };
  } catch (e) {
    console.warn('[location] ⚠️ 位置消息 content 解析失败，按不可用处理:', e);
    return null;
  }
}

/** 位置气泡的标题行文案：优先地点名，缺失时退回「位置」 */
export function locationTitle(payload: LocationPayload): string {
  return payload.name || FALLBACK_NAME;
}

/** 位置气泡的副标题：优先详细地址，缺失时退回经纬度（保留 4 位小数，够定位到街区） */
export function locationSubtitle(payload: LocationPayload): string {
  if (payload.address) return payload.address;
  return `${payload.lat.toFixed(4)}, ${payload.lng.toFixed(4)}`;
}

/**
 * 拉起微信地图选点。
 *
 * ⚠️ 只在微信小程序端可用：H5 预览没有 chooseLocation，调用会 reject。
 * 调用方（chat 页）必须先做环境门控，本函数只负责把「用户取消」与「真实失败」区分开：
 * - 返回 null = 用户主动取消（不提示，静默返回）
 * - 抛错 = 真实失败（隐私未声明 / 定位失败等），由调用方决定提示文案
 */
export async function pickLocation(): Promise<LocationPayload | null> {
  try {
    const res = await Taro.chooseLocation({});
    const lat = Number(res?.latitude);
    const lng = Number(res?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error('未能获取到有效的位置坐标');
    }
    const payload: LocationPayload = {
      lat,
      lng,
      name: typeof res?.name === 'string' ? res.name : '',
      address: typeof res?.address === 'string' ? res.address : '',
    };
    logDbg(`[location] 📍 选点完成: ${payload.name || '(无名)'} ${payload.address || ''} (${lat}, ${lng})`);
    return payload;
  } catch (e: any) {
    const errMsg = String(e?.errMsg || e?.message || e || '');
    // 用户点左上角返回 / 取消按钮：微信回包形如 "chooseLocation:fail cancel"
    if (/cancel/i.test(errMsg)) {
      logDbg('[location] 用户取消选点');
      return null;
    }
    console.error('[location] ❌ 选点失败:', errMsg);
    throw new Error(errMsg || '打开地图失败');
  }
}

/**
 * 获取当前所在位置（进入聊天页时自动调用，用于「发送我的位置」）。
 *
 * ⚠️ 与 pickLocation 的语义差别：pickLocation 是**用户在地图上挑一个点**（可以挑任意地方），
 * 本函数是**读取设备当前坐标**，两者走的是完全不同的微信接口（chooseLocation vs getLocation），
 * 因此 app.config.ts 的 requiredPrivateInfos 里两个都要声明。
 *
 * ⚠️ 返回 null 表示「拿不到」，**不抛错**——调用方是页面生命周期里的自动调用，
 * 用户没主动点任何按钮，弹错误提示属于打扰。失败原因只打日志，由用户点按钮时再提示。
 * 常见失败：用户拒绝授权（auth deny）、系统定位服务关闭、H5 预览无此能力。
 */
export async function getCurrentLocation(): Promise<LocationPayload | null> {
  if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP) {
    logDbg('[location] 非微信小程序环境，跳过自动定位');
    return null;
  }
  try {
    const res = await Taro.getLocation({ type: 'gcj02', isHighAccuracy: true });
    const lat = Number(res?.latitude);
    const lng = Number(res?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.warn('[location] ⚠️ getLocation 未返回有效坐标');
      return null;
    }
    // getLocation 只给坐标、不给地名，故 name/address 留空，
    // 由 locationTitle/locationSubtitle 的兜底逻辑显示成「我的位置」+ 坐标。
    logDbg(`[location] 📡 已获取当前位置: (${lat}, ${lng})`);
    return { lat, lng, name: '', address: '' };
  } catch (e: any) {
    const errMsg = String(e?.errMsg || e?.message || e || '');
    console.warn('[location] 自动定位失败（静默处理）:', errMsg);
    return null;
  }
}

/**
 * 「最近一次位置」的本地存储 key。
 *
 * 【为什么需要它】暗号链路里 B 不在线时，B 下次进聊天页要补发位置。
 * 但 getCurrentLocation 的结果原先只存内存 state，退出页面即丢，
 * 补发时拿不到「最近一次进入聊天页面时自动获取的位置」。
 *
 * ⚠️ 只存本机、不落数据库：位置是敏感信息，落库会扩大隐私面（且需要额外的 RLS 设计）。
 *    代价是换设备后不可用——补发时若本机无记录，退回「重新定位一次」。
 * ⚠️ 登出时必须清除（见 clearLastLocation），避免换账号后串号。
 */
const LAST_LOCATION_KEY = 'chat_last_location_v1';

/** 本地存储的位置记录：位置数据 + 记录时刻（用于判断新鲜度与展示） */
export interface StoredLocation extends LocationPayload {
  /** 记录时刻（ISO 串），供调用方判断「多久前的位置」 */
  at: string;
}

/**
 * 写入「最近一次位置」。失败静默（存储配额满/隐私限制），不影响主流程。
 */
export function saveLastLocation(payload: LocationPayload): void {
  try {
    const record: StoredLocation = {
      lat: payload.lat,
      lng: payload.lng,
      name: payload.name || '',
      address: payload.address || '',
      at: new Date().toISOString(),
    };
    Taro.setStorageSync(LAST_LOCATION_KEY, record);
    logDbg(`[location] 💾 已记录最近一次位置: (${payload.lat}, ${payload.lng})`);
  } catch (e: any) {
    console.warn('[location] ⚠️ 记录最近一次位置失败（静默）:', e?.errMsg || e);
  }
}

/**
 * 读取「最近一次位置」。无记录 / 格式非法一律返回 null（绝不抛错）。
 * ⚠️ 必须容错：存储里的值可能来自旧版本或被手工改坏，脏数据不能冒到调用方。
 */
export function readLastLocation(): StoredLocation | null {
  try {
    const raw = Taro.getStorageSync(LAST_LOCATION_KEY) as Partial<StoredLocation> | '' | null;
    if (!raw || typeof raw !== 'object') return null;
    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return {
      lat,
      lng,
      name: typeof raw.name === 'string' ? raw.name : '',
      address: typeof raw.address === 'string' ? raw.address : '',
      at: typeof raw.at === 'string' ? raw.at : '',
    };
  } catch (e: any) {
    console.warn('[location] ⚠️ 读取最近一次位置失败，按无记录处理:', e?.errMsg || e);
    return null;
  }
}

/** 清除「最近一次位置」（登出时调用，防换账号串号） */
export function clearLastLocation(): void {
  try {
    Taro.removeStorageSync(LAST_LOCATION_KEY);
    logDbg('[location] 🧹 已清除最近一次位置记录');
  } catch (e: any) {
    console.warn('[location] ⚠️ 清除最近一次位置失败（静默）:', e?.errMsg || e);
  }
}

/**
 * 打开地图查看某个位置（点位置气泡时调用）。
 * 微信端用 openLocation 拉起原生地图（可导航）；H5 端无此能力，返回 false 由调用方降级。
 *
 * ⚠️ 必须开「原生全屏页豁免」，且**必须用计数型（setNativePreviewGrace）而不是批次级**：
 *    微信原生地图是独立全屏页面，拉起时会触发一次 App 级 onAppHide，与 previewImage 同款。
 *
 * ❌ 试过批次级豁免（setMediaPickerGrace + finally 里 endMediaPickerGrace）：**实测仍弹罩**。
 *    根因是 openLocation 的 Promise 在**地图页面被拉起后很快就 resolve**（不是等用户关闭地图），
 *    于是 finally 立刻释放豁免；而 onHide 里那次 hide 已经排上了 800ms 延时确认定时器，
 *    定时器到点照样 doArm() 亮罩——批次级豁免只影响 onHide 的判定，管不到已排队的定时器。
 *
 * ✅ 计数型豁免的释放点在 PrivacyShield 的 onAppShow：consumeNativePreviewGrace() 返回 true 时
 *    会**主动清掉 pendingTimer** 并跳过遮挡，从根上掐断「延时确认后亮罩」这条路径。
 *    这里只置位、不设释放点（与 chat 页 openImageViewer 完全一致）。
 *
 * ⚠️ 不要改成固定时长窗口：用户可能在地图里查路线停留很久，窗口过期就会误弹。
 */
export async function openLocationOnMap(payload: LocationPayload): Promise<boolean> {
  if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP) return false;
  logDbg('[location] 🗺️ 拉起原生地图前置位原生全屏页豁免（openLocation 会触发 App 级 onAppHide）');
  setNativePreviewGrace();
  try {
    await Taro.openLocation({
      latitude: payload.lat,
      longitude: payload.lng,
      name: locationTitle(payload),
      address: payload.address || '',
      scale: 18,
    });
    logDbg('[location] 🗺️ 已拉起原生地图查看位置（豁免额度由 onAppShow 消费归零）');
    return true;
  } catch (e: any) {
    console.warn('[location] openLocation 失败:', e?.errMsg || e);
    return false;
  }
}
