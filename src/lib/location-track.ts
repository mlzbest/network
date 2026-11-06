import type { CheckTrackPoint } from '@/lib/check-command';

/**
 * 轨迹抽稀上限：超过这个点数就等间隔降采样。
 *
 * 【为什么是 200】手机屏上一条折线超过 200 个拐点后，肉眼已经分辨不出新增的细节，
 * 但地图渲染引擎仍要为每个点做投影与绘制。500 个点（`listLocationHistoryBetween`
 * 的上限）虽然不至于卡死，但纯属浪费——降采样到 200 观感完全一致。
 */
export const TRACK_MAX_POINTS = 200;

/**
 * 轨迹抽稀：点数超过 `max` 时等间隔取点，**强制保留首尾**。
 *
 * 【为什么必须保留首尾】首点是「从哪出发」、尾点是「最后停在哪」，这两个点是用户
 * 最关心的信息。纯等间隔取点时，若步长不能整除，尾点很容易被跳过，地图上就会
 * 出现「路线没走到最后位置」的错觉。
 *
 * 【为什么不用 Douglas-Peucker】DP 需要算点到线段的垂距，实现与测试成本都高；
 * 而定位点本身受 GPS 抖动影响、形状并不平滑，DP 保留下来的「拐点」很多是噪声。
 * 等间隔采样对「看个大概路线」这个诉求已经足够。
 */
export function thinTrack(points: CheckTrackPoint[], max: number = TRACK_MAX_POINTS): CheckTrackPoint[] {
  if (points.length <= max) return points;
  if (max < 2) return points.slice(0, Math.max(1, max));
  const step = (points.length - 1) / (max - 1);
  const out: CheckTrackPoint[] = [];
  for (let i = 0; i < max; i += 1) {
    out.push(points[Math.round(i * step)]);
  }
  // 浮点取整可能让末项落在倒数第二个点上，显式补上真正的尾点
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out[out.length - 1] = last;
  return out;
}

/** 轨迹的地理范围与中心点（地图初始视角兜底用） */
export interface TrackBounds {
  center: { lat: number; lng: number };
  /** 经纬度跨度（度），用于判断「点是否几乎重合」 */
  spanLat: number;
  spanLng: number;
}

/**
 * 算轨迹的中心点与跨度。
 *
 * 【为什么需要它】`<Map>` 的 `includePoints` 在**只有一个点**时不生效（没有范围可
 * 缩放），此时必须靠 `latitude` / `longitude` / `scale` 手动定位，否则地图会停在
 * 微信默认的北京天安门。空数组返回 null，由调用方渲染空态。
 */
export function trackBounds(points: CheckTrackPoint[]): TrackBounds | null {
  if (points.length === 0) return null;
  let minLat = points[0].lat;
  let maxLat = points[0].lat;
  let minLng = points[0].lng;
  let maxLng = points[0].lng;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return {
    center: { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 },
    spanLat: maxLat - minLat,
    spanLng: maxLng - minLng,
  };
}

/**
 * 把轨迹点转成微信 `<Map>` 的 `polyline.points` 格式。
 *
 * ⚠️ 字段名是 `latitude` / `longitude`（全称），不是 `lat` / `lng`——写错不会报错，
 * 只会画不出线，是这类功能最常见的静默失败。
 */
export function toMapPoints(points: CheckTrackPoint[]): Array<{ latitude: number; longitude: number }> {
  return points.map((p) => ({ latitude: p.lat, longitude: p.lng }));
}

/**
 * 按天分段用的调色板（8 色循环）。
 *
 * 【为什么是这 8 个色】相邻两色在色相环上间隔 ≥ 45°，且都压在中高明度区间——
 * 地图底图本身有大量浅灰/浅绿/浅蓝，低明度色（深蓝、深紫）会糊进底图看不清。
 * 8 色足够覆盖「一个周期最多 7 天（last7）」的常见场景，month 档超过 8 天时循环复用，
 * 此时靠下方图例的日期文字区分，不靠颜色唯一性。
 */
export const DAY_COLORS = [
  '#0ea5e9', // 天蓝
  '#f97316', // 橙
  '#8b5cf6', // 紫
  '#10b981', // 翠绿
  '#ef4444', // 红
  '#eab308', // 黄
  '#ec4899', // 粉
  '#14b8a6', // 青
] as const;

/** 一天的分段：同一天的点 + 该天在调色板里的颜色 */
export interface TrackDaySegment {
  /** 日期键 `YYYY-MM-DD`（东八区） */
  day: string;
  /** 该天的点（按时间升序） */
  points: CheckTrackPoint[];
  /** 折线颜色（`DAY_COLORS` 循环取） */
  color: string;
}

/**
 * 取东八区日期键 `YYYY-MM-DD`。
 *
 * 【为什么固定 +8h 而不是 `toLocaleDateString`】与 `statsPeriodRange` 同口径：
 * 中国单一时区无夏令时，`+8h` 是常量；而部分低版本微信基础库的 `Intl` / `toLocaleDateString`
 * 时区支持不全，会按设备本地时区切日，导致「同一天的点被拆成两段」。
 */
export function cstDayKey(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const shifted = new Date(t + 8 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 把轨迹点按「东八区自然日」切成若干段，每段一个颜色。
 *
 * 【为什么按天分段而不是一条线画到底】一条线画到底只能看出「走了多远」，看不出
 * 「哪天走的」；按天分段后，同一天的活动是一条同色折线，跨天处断开，配合图例就能
 * 一眼看出「今天只在家附近、昨天跑了一整天」。
 *
 * ⚠️ **跨天处必须断开，不能把「昨天最后一个点」和「今天第一个点」连起来**：那两个点
 * 之间隔着整夜，连起来会画出一条根本不存在的「夜间移动轨迹」，是这类功能最容易犯的错。
 * 所以每段只包含自己那天的点，段与段之间不共享端点。
 *
 * ⚠️ 输入必须已按时间升序（`listLocationHistoryBetween` 保证），否则同一天的点会被
 * 拆成多段、颜色也会错位。
 */
export function splitTrackByDay(points: CheckTrackPoint[]): TrackDaySegment[] {
  const segments: TrackDaySegment[] = [];
  let current: TrackDaySegment | null = null;
  for (const p of points) {
    const day = cstDayKey(p.recordedAt);
    if (!day) continue;
    if (!current || current.day !== day) {
      current = { day, points: [], color: DAY_COLORS[segments.length % DAY_COLORS.length] };
      segments.push(current);
    }
    current.points.push(p);
  }
  return segments;
}

/** 图例项：日期 + 颜色 + 点数（渲染层直接遍历） */
export interface TrackLegendItem {
  day: string;
  color: string;
  count: number;
}

/** 从分段结果派生图例（顺序与分段一致，即时间升序） */
export function trackLegend(segments: TrackDaySegment[]): TrackLegendItem[] {
  return segments.map((s) => ({ day: s.day, color: s.color, count: s.points.length }));
}

/**
 * 把 `YYYY-MM-DD` 显示成 `M月D日`（图例用，省掉年份与补零）。
 *
 * 解析失败时原样返回，绝不抛错——图例是附属信息，不该让整页崩掉。
 */
export function formatDayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return `${Number(m[2])}月${Number(m[3])}日`;
}
