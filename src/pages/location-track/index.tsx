import { View, Text, Map } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import { useEffect, useMemo, useRef, useState } from 'react';
import ErrorBoundary from '@/components/error-boundary';
import PrivacyShield from '@/components/privacy-shield';
import {
  backfillLocationNames,
  listAllLocationHistory,
  listLocationHistoryBetween,
  resolvePlaceName,
  type LocationHistoryRow,
} from '@/api/profiles';
import { formatCheckTime, type CheckTrackPoint } from '@/lib/check-command';
import { cstDayKey, DAY_COLORS, toMapPoints, trackBounds } from '@/lib/location-track';
import { getWindowInfo } from '@/lib/system-info';
import { logDbg, logWarn } from '@/lib/logger';
import dotPin from '../../assets/track-dot.png';

/**
 * 位置对比页（隐藏命令 `check stats` 的「查看地点」入口）。
 *
 * 【为什么只做「地点对比」而不做轨迹折线】
 * 用户要回答的问题是「这段时间我们各自去过哪些地方、有没有重合」，而不是「怎么走的」。
 * 折线会把不相邻的地点串成一条根本不存在的路线（上午在 A、下午在 B，中间并没有走过去），
 * 反而误导；点阵 + 双方清单才是这个问题的正确表达。
 *
 * 【为什么双方画在同一张地图上】对比的意义就在于「同屏可见」：分成两个 tab 各看一半，
 * 用户得靠记忆比对，等于没做对比。用两种颜色区分双方，重合处自然叠在一起。
 *
 * 【为什么页面自己重新查一次库，而不是靠 URL 传点】
 * 一个周期最多 500 个点，序列化进 URL 会超长度上限（微信对页面 URL 有长度限制），
 * 且页面刷新/从后台恢复后数据就没了。URL 只传「查谁 + 哪段时间」几个短参数。
 *
 * 【H5 端为什么必须降级】`<Map>` 组件的 `@supported` 不含 h5（见
 * node_modules/@tarojs/components/types/Map.d.ts），H5 渲染会得到空节点；
 * 而定位历史本身也只在微信真机积累（H5 的 getLocation 直接返回 null）。
 * 所以 H5 端只渲染「双方地点清单」，绝不渲染 Map。
 */

type Side = 'mine' | 'peer';

/**
 * 普通定位点的圆点图标（32×32 白色实心圆，透明底）。
 *
 * 【为什么用白色而不是彩色】微信 `<Map>` 的 marker **不支持 tint / 着色**，
 * 图片是什么颜色就画什么颜色。而双方需要不同颜色——若用彩色图片，就得为每种颜色
 * 各生成一张 PNG。白色圆点 + `label` 的彩色背景，是唯一能「按人变色」且不依赖多张图片的做法。
 */
const DOT_PIN = dotPin as unknown as string;
/** 圆点尺寸（px）：比图钉小，避免盖住相邻地点 */
const DOT_SIZE = 12;

/** 我 / TA 的配色：与清单里的色块同源，保证「地图上的点」与「清单里的行」一眼对得上 */
const MINE_COLOR = '#2563eb';
const PEER_COLOR = '#f97316';

/**
 * 带地名的地点。
 *
 * 【为什么在 `CheckTrackPoint` 之外再包一层，而不是直接给它加字段】
 * `CheckTrackPoint` 是 `check` 命令通道的公共契约（`lib/check-command.ts`），
 * 那边只关心坐标与时间；地名是本页独有的展示需求，加进公共类型会让
 * 所有构造 `CheckTrackPoint` 的地方都被迫补两个空字段。
 */
interface PlacePoint extends CheckTrackPoint {
  /** 逆地理解析出的地点名，空串表示未解析或查不到 */
  name: string;
  /** 逆地理解析出的完整地址，空串语义同 `name` */
  address: string;
}

/**
 * 图钉气泡（点击圆点才显示）。
 *
 * ⚠️ 微信 `callout` 类型把**全部字段都声明为必填**（`anchorX` / `anchorY` /
 * `borderWidth` / `borderColor` / `bgColor` / `textAlign` 一个都不能少），少一个
 * TS 直接报「missing the following properties」。运行时这些字段其实都有默认值，
 * 但类型层面必须写全，所以抽成工厂函数避免多处重复。
 */
function pinCallout(content: string) {
  return {
    content,
    color: '#0f172a',
    fontSize: 11,
    anchorX: 0,
    anchorY: 0,
    borderRadius: 6,
    borderWidth: 0,
    borderColor: '#e2e8f0',
    bgColor: '#ffffff',
    padding: 4,
    display: 'BYCLICK' as const,
    textAlign: 'center' as const,
  };
}

/**
 * 把定位点按约 100 米网格去重，每个地点只留**最后一次**的坐标与时间，并估算停留时长。
 *
 * 【为什么需要】同一栋楼会被记十几次（GPS 抖动 + 每次进聊天页都上报），
 * 直接画点是「一坨」，看不出「去过几个地方」。
 *
 * ⚠️ 不能用 `new Map()`：本文件从 `@tarojs/components` 导入了 `<Map>` 组件，
 *    同名遮蔽了原生 Map 构造函数，`new Map()` 会被 TS 判成「组件不可构造」（TS2351）。
 *    这里用普通对象做「网格 key → 点」的字典，语义等价且无命名冲突。
 * ⚠️ 网格精度取 3 位小数（≈100 米），与 `summarizeLocationHistory` 的 `distinctCount`
 *    同口径——两处若用不同精度，会出现「统计说 5 个地方、地图上画了 12 个点」的矛盾。
 * ⚠️ 保留「最后一次」而不是「第一次」：用户更关心「最近一次去这个地方是什么时候」。
 * ⚠️ 排序改为**倒序**（最近去的排最前）：清单是「回顾去过哪」，最近的地点信息量最大；
 *    地图 marker 的绘制顺序不受影响（marker 由 `minePlaces` 顺序决定，与清单同源）。
 */
function dedupePlaces(points: PlacePoint[]): PlacePoint[] {
  const grid: Record<string, PlacePoint> = {};
  for (const p of points) {
    const key = `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;
    // 升序遍历，后到的覆盖先到的 → 最终留下的是该网格内最后一次
    grid[key] = p;
  }
  return Object.values(grid).sort(
    (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
  );
}

/**
 * 每个地点的停留跨度（key = `lat,lng` 网格键，value = 毫秒跨度）。
 *
 * 【为什么是估算而不是精确值】定位是**离散采样**（登录 / 进聊天页才上报），
 * 两次采样之间人在不在原地无从得知。所以这里只能给出「首次到末次之间的跨度」，
 * 语义是「这段时间内在这个地点被观测到的时长」，不是「实际停留时长」。
 * 文案必须写「约」，不能写成确定值。
 *
 * 【为什么单独算一遍而不是塞进 `dedupePlaces`】去重后每个地点只剩「最后一次」，
 * 首次时间已经丢了；要算跨度必须回到**原始点集**。所以这里接收原始点集，
 * 按同一套网格键聚合，产出「网格键 → 跨度」的字典，渲染时按点的网格键查。
 *
 * ⚠️ 网格键必须与 `dedupePlaces` 完全一致（`toFixed(3)`），否则查不到、全部显示「仅 1 次记录」。
 * ⚠️ 只有 1 次采样时不写入字典（渲染层据此显示「仅 1 次记录」），
 *    显示「停留 0 分钟」会让用户以为数据错了。
 * ⚠️ 采样间隔可能很长（比如早上在 A、晚上又在 A，中间去了别处），跨度会虚高。
 *    这是离散采样的固有局限，故文案用「约 X」并在页脚说明口径。
 */
function buildStaySpans(points: PlacePoint[]): Record<string, number> {
  const grid: Record<string, number[]> = {};
  for (const p of points) {
    const key = `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;
    (grid[key] ??= []).push(new Date(p.recordedAt).getTime());
  }
  const spans: Record<string, number> = {};
  for (const key of Object.keys(grid)) {
    const times = grid[key];
    if (times.length < 2) continue;
    const min = Math.min(...times);
    const max = Math.max(...times);
    if (max > min) spans[key] = max - min;
  }
  return spans;
}

/**
 * 把毫秒跨度格式化成人类可读的时长。
 *
 * 口径：< 1 分钟 → 「不到 1 分钟」；< 1 小时 → 「约 N 分钟」；
 * < 1 天 → 「约 N 小时 M 分钟」（M 为 0 时省略）；≥ 1 天 → 「约 N 天 M 小时」。
 * ⚠️ 不显示秒：定位采样间隔本身是分钟级，秒级精度是假精度。
 */
function formatStaySpan(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return '不到 1 分钟';
  if (min < 60) return `约 ${min} 分钟`;
  const hours = Math.floor(min / 60);
  const restMin = min % 60;
  if (hours < 24) {
    return restMin > 0 ? `约 ${hours} 小时 ${restMin} 分钟` : `约 ${hours} 小时`;
  }
  const days = Math.floor(hours / 24);
  const restHour = hours % 24;
  return restHour > 0 ? `约 ${days} 天 ${restHour} 小时` : `约 ${days} 天`;
}

export default function LocationTrackPage() {
  const router = useRouter();
  const sysInfo = getWindowInfo();
  const statusBarHeight = sysInfo.statusBarHeight ?? 20;
  const isWeappEnv = Taro.getEnv() === Taro.ENV_TYPE.WEAPP;

  // 胶囊右留白 = 屏宽 - 胶囊左缘 + 8px，保证标题不被胶囊压住。
  // getMenuButtonBoundingClientRect 在 H5 会 reject Promise（同步 try-catch 捕不到，
  // 会泄漏成 Uncaught），故仅微信端调用，H5 回退固定留白。
  const [capsuleRightPadding, setCapsuleRightPadding] = useState(96);
  useEffect(() => {
    if (!isWeappEnv) return;
    try {
      const rect = Taro.getMenuButtonBoundingClientRect();
      const winW = sysInfo.windowWidth;
      if (rect && typeof rect.left === 'number' && rect.left > 0 && winW > 0) {
        setCapsuleRightPadding(Math.round(winW - rect.left + 8));
      }
    } catch (e) {
      logDbg('[location-track] getMenuButtonBoundingClientRect 异常，回退固定留白', e);
    }
  }, [isWeappEnv, sysInfo]);

  // URL 参数：peerId / meId / start / end / peerName（全部 encodeURIComponent 过）
  const params = useMemo(() => {
    const q = (router.params ?? {}) as Record<string, string | undefined>;
    const dec = (v?: string) => {
      if (!v) return '';
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    };
    return {
      peerId: dec(q.peerId),
      meId: dec(q.meId),
      startIso: dec(q.start),
      endIso: dec(q.end),
      peerName: dec(q.peerName) || 'TA',
    };
  }, [router.params]);

  const [mineRows, setMineRows] = useState<LocationHistoryRow[] | null>(null);
  const [peerRows, setPeerRows] = useState<LocationHistoryRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  /**
   * 兜底坐标（`profiles.last_*`），由 `check stats` 通过 URL 带过来。
   *
   * 【为什么走 URL 而不是页面自己查】页面已经知道 peerId / meId，理论上可以自己查
   * profiles；但那样要再发两个请求，且「有没有兜底坐标」这个判断在结果区已经做过一次
   * （决定是否显示入口按钮）。URL 带过来保证「按钮出现」与「页面有东西可画」
   * 用的是同一份数据，不会出现「按钮在、页面空」的矛盾。
   *
   * ⚠️ 参数缺失/非法时降级成 null，不影响历史点渲染。
   */
  const fallback = useMemo(() => {
    const q = (router.params ?? {}) as Record<string, string | undefined>;
    const num = (v?: string) => {
      if (!v) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const dec = (v?: string) => {
      if (!v) return '';
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    };
    const mk = (lat?: string, lng?: string, at?: string) => {
      const la = num(lat);
      const ln = num(lng);
      if (la === null || ln === null) return null;
      return { lat: la, lng: ln, recordedAt: dec(at) || new Date().toISOString() };
    };
    return {
      mine: mk(q.fbMineLat, q.fbMineLng, q.fbMineAt),
      peer: mk(q.fbPeerLat, q.fbPeerLng, q.fbPeerAt),
    };
  }, [router.params]);

  /** 拉取双方定位历史：一次并行，切换 tab 不再请求 */
  const load = async () => {
    if (!params.startIso || !params.endIso) {
      setError('缺少时间区间参数，无法查询地点');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    logDbg(
      `[location-track] 📡 查询地点 ${params.startIso} ~ ${params.endIso} peer=${params.peerId || '无'} me=${params.meId || '无'}`,
    );
    try {
      const [mine, peer] = await Promise.all([
        params.meId
          ? listLocationHistoryBetween(params.meId, params.startIso, params.endIso)
          : Promise.resolve([]),
        params.peerId
          ? listLocationHistoryBetween(params.peerId, params.startIso, params.endIso)
          : Promise.resolve([]),
      ]);
      setMineRows(mine);
      setPeerRows(peer);
      logDbg(`[location-track] ✅ 地点已就绪: 我=${mine.length} 点, TA=${peer.length} 点`);
      // 兜底坐标是「历史点不足」时的唯一可画内容，必须留痕：
      // 排查「点进地点页什么都没有」时，先看这行有没有兜底坐标。
      logDbg(
        `[location-track] 📍 兜底坐标: 我=${fallback.mine ? `${fallback.mine.lat.toFixed(6)},${fallback.mine.lng.toFixed(6)}` : '无'} TA=${fallback.peer ? `${fallback.peer.lat.toFixed(6)},${fallback.peer.lng.toFixed(6)}` : '无'}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logDbg('[location-track] ❌ 查询地点失败:', msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // 只在参数变化时重查；load 内部只依赖 params，闭包安全
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.startIso, params.endIso, params.peerId, params.meId]);

  /** 把库里的行转成带地名的点（地名必须跟着点走，去重后要按点取地名） */
  const toPoints = (rows: LocationHistoryRow[] | null): PlacePoint[] =>
    (rows ?? []).map((r) => ({
      lat: r.lat,
      lng: r.lng,
      recordedAt: r.recordedAt,
      name: r.name,
      address: r.address,
    }));

  const minePoints = useMemo(() => toPoints(mineRows), [mineRows]);
  const peerPoints = useMemo(() => toPoints(peerRows), [peerRows]);

  /**
   * 兜底点：周期内没有历史点时，用 `profiles.last_*` 顶上。
   *
   * 【为什么需要】定位历史表是后加的，升级前的定位只写进了 `profiles.last_*`。
   * 没有兜底的话，用户点进来只会看到「这段时间没有定位记录」，而实际上
   * `profiles.last_lat` 是有值的（用户实测报过「没有看到位置轨迹地图」）。
   *
   * ⚠️ 兜底点来自 `profiles.last_*`，那里没有地名，只能留空（清单里显示「未知地点」）。
   */
  const mineDisplay = useMemo<PlacePoint[]>(() => {
    if (minePoints.length > 0) return minePoints;
    return fallback.mine
      ? [{ ...fallback.mine, name: '', address: '' }]
      : [];
  }, [minePoints, fallback.mine]);
  const peerDisplay = useMemo<PlacePoint[]>(() => {
    if (peerPoints.length > 0) return peerPoints;
    return fallback.peer ? [{ ...fallback.peer, name: '', address: '' }] : [];
  }, [peerPoints, fallback.peer]);

  /**
   * 兜底坐标的地名解析结果（key = `lat,lng`）。
   *
   * 【为什么兜底点也要解析】兜底点来自 `profiles.last_lat/lng`，那里只有坐标没有地名，
   * 不解析的话清单里永远显示「未知地点」——用户看到的正是这个问题。
   * 兜底点最多 2 个（我 + TA），一次解析成本极低，不必走批量补写。
   *
   * ⚠️ 只解析、不写库：兜底坐标不一定在 `user_location_history` 里有对应行，
   *    写库会凭空造出一条定位记录，污染「定位次数」统计。
   */
  const [fallbackNames, setFallbackNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const targets: { lat: number; lng: number }[] = [];
    if (minePoints.length === 0 && fallback.mine) targets.push(fallback.mine);
    if (peerPoints.length === 0 && fallback.peer) targets.push(fallback.peer);
    if (targets.length === 0) return;
    let alive = true;
    void (async () => {
      const next: Record<string, string> = {};
      for (const t of targets) {
        const key = `${t.lat.toFixed(6)},${t.lng.toFixed(6)}`;
        try {
          const place = await resolvePlaceName(t.lat, t.lng);
          if (place.name) next[key] = place.name;
        } catch (e) {
          logWarn('[location-track] 📍 兜底坐标解析地名失败(不影响展示):', e);
        }
      }
      if (alive && Object.keys(next).length > 0) {
        logDbg(
          `[location-track] 📍 兜底坐标地名解析完成: ${Object.entries(next)
            .map(([k, v]) => `${k}=${v}`)
            .join(' | ')}`,
        );
        setFallbackNames((prev) => ({ ...prev, ...next }));
      } else if (alive) {
        logWarn('[location-track] 📍 兜底坐标地名解析为空，清单将显示「未知地点」');
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minePoints.length, peerPoints.length, fallback.mine, fallback.peer]);

  /** 给兜底点补上解析出的地名（历史点自带地名，不受影响） */
  const withFallbackName = (p: PlacePoint): PlacePoint => {
    if (p.name) return p;
    const hit = fallbackNames[`${p.lat.toFixed(6)},${p.lng.toFixed(6)}`];
    return hit ? { ...p, name: hit } : p;
  };

  const minePlaces = useMemo(
    () => dedupePlaces(mineDisplay).map(withFallbackName),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mineDisplay, fallbackNames],
  );
  const peerPlaces = useMemo(
    () => dedupePlaces(peerDisplay).map(withFallbackName),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [peerDisplay, fallbackNames],
  );

  /**
   * 双方重合的地点（约 100 米内视为同一处）。
   *
   * 【为什么要算】「对比」的核心结论就是「有没有去过同一个地方」。
   * 让用户自己在两份清单里肉眼比对，等于把最该由程序回答的问题丢回去。
   */
  const sharedPlaces = useMemo(() => {
    const peerGrid: Record<string, PlacePoint> = {};
    for (const p of peerPlaces) peerGrid[`${p.lat.toFixed(3)},${p.lng.toFixed(3)}`] = p;
    return minePlaces.filter((p) => peerGrid[`${p.lat.toFixed(3)},${p.lng.toFixed(3)}`]);
  }, [minePlaces, peerPlaces]);

  /**
   * 双方各自的「地点 → 停留跨度」字典。
   *
   * ⚠️ 必须用**原始点集**（`mineDisplay` / `peerDisplay`）算，不能用去重后的
   *    `minePlaces`——去重后每个地点只剩最后一次，首次时间已丢，跨度恒为 0。
   */
  const mineSpans = useMemo(() => buildStaySpans(mineDisplay), [mineDisplay]);
  const peerSpans = useMemo(() => buildStaySpans(peerDisplay), [peerDisplay]);

  /**
   * 地名补解析：给「已存在但缺地名」的历史行补上地名（升级前的历史行 name 全是 NULL）。
   *
   * 【为什么放在页面里而不是写入时统一处理】写入时解析只覆盖「升级后新产生的定位」，
   * 升级前的存量行永远不会被补到，用户看到的仍是一堆坐标。
   *
   * 【为什么拉「全部历史」而不是当前时间窗】用户要求「一次性全部补齐」。
   * 时间窗内的行只是历史的一小部分，用窗口数据补等于永远补不全。
   *
   * ⚠️ 只在「当前查看的是自己」时补：`user_location_history` 的 UPDATE 策略是
   *    `auth.uid() = user_id`，补写对方的行必然被 RLS 静默拦掉（返回 0 行），
   *    白白消耗逆地理配额。
   * ⚠️ 用 ref 做一次性闸门：`mineRows` 每次刷新都会变，不加闸门会反复触发补解析。
   * ⚠️ 补完必须重新拉一次数据，否则界面上的地名不会更新（补写的是库里的行，
   *    内存里的 `mineRows` 还是旧值）。
   * ⚠️ 补解析可能跑几十秒（按坐标去重 + 分批限速），期间用户可能已经离开页面，
   *    故用 `aliveRef` 守卫，卸载后不再 setState。
   */
  const nameBackfillDoneRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (nameBackfillDoneRef.current) return;
    const meId = params.meId;
    if (!meId) return;
    nameBackfillDoneRef.current = true;
    void (async () => {
      try {
        const all = await listAllLocationHistory(meId);
        const missing = all.filter((r) => !r.name);
        if (missing.length === 0) {
          logDbg('[location-track] 📍 全部历史定位均已有地名，无需补解析');
          return;
        }
        logDbg(
          `[location-track] 📍 全部历史 ${all.length} 条，其中 ${missing.length} 条缺地名，开始一次性补解析`,
        );
        const updated = await backfillLocationNames(meId, all);
        logDbg(`[location-track] 📍 一次性补解析结束，更新 ${updated} 条`);
        if (updated > 0 && aliveRef.current) {
          await load();
        }
      } catch (e) {
        logWarn('[location-track] 📍 地名补解析失败(不影响地点展示):', e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.meId]);

  /**
   * 地图 marker：双方各一种颜色，重合地点用第三种颜色标出来。
   *
   * 【为什么用 `label` 上色而不是彩色图片】微信 marker 不支持 tint，图片什么色就画什么色。
   * 用白色圆点 + `label` 的彩色背景，就能让「点」与「清单里的色块」同色，
   * 且不需要为每种颜色各出一张图。
   *
   * ⚠️ `label` 的 `anchorX` / `anchorY` 必须写：不写时标签会盖在圆点正中央，
   *    把圆点完全遮住，看起来就像「没有点」。
   * ⚠️ marker id 必须全局唯一：双方各自从 0 开始编号会撞 id，微信只渲染其中一个。
   */
  const markers = useMemo(() => {
    const mk = (p: PlacePoint, id: number, color: string, who: string) => ({
      id,
      latitude: p.lat,
      longitude: p.lng,
      iconPath: DOT_PIN,
      width: DOT_SIZE + 4,
      height: DOT_SIZE + 4,
      anchor: { x: 0.5, y: 0.5 },
      label: {
        content: '',
        color: '#ffffff',
        fontSize: 1,
        anchorX: 0,
        anchorY: -(DOT_SIZE + 4) / 2 - 2,
        borderRadius: 6,
        borderWidth: 0,
        borderColor: color,
        bgColor: color,
        padding: 3,
        textAlign: 'center' as const,
      },
      // 气泡里带地名：地图上点开一个点，第一眼要看到「这是哪」，坐标只是补充
      callout: pinCallout(`${who} · ${p.name || '未知地点'}\n${formatCheckTime(p.recordedAt)}`),
    });

    const sharedKeys: Record<string, true> = {};
    for (const p of sharedPlaces) sharedKeys[`${p.lat.toFixed(3)},${p.lng.toFixed(3)}`] = true;

    const list: ReturnType<typeof mk>[] = [];
    minePlaces.forEach((p, i) => {
      const shared = sharedKeys[`${p.lat.toFixed(3)},${p.lng.toFixed(3)}`];
      list.push(mk(p, 1000 + i, shared ? '#16a34a' : MINE_COLOR, shared ? '共同' : '我'));
    });
    peerPlaces.forEach((p, i) => {
      const shared = sharedKeys[`${p.lat.toFixed(3)},${p.lng.toFixed(3)}`];
      // 重合地点只画一次（上面「我」那轮已画成绿色），避免两个点完全叠在一起
      if (shared) return;
      list.push(mk(p, 2000 + i, PEER_COLOR, params.peerName));
    });
    return list;
  }, [minePlaces, peerPlaces, sharedPlaces, params.peerName]);

  /** 地图范围：用双方去重后的点一起算，保证两边都在视野内 */
  const bounds = useMemo(
    () => trackBounds([...minePlaces, ...peerPlaces]),
    [minePlaces, peerPlaces],
  );
  const mapPoints = useMemo(
    () => toMapPoints([...minePlaces, ...peerPlaces]),
    [minePlaces, peerPlaces],
  );

  const hasAny = minePlaces.length > 0 || peerPlaces.length > 0;

  /**
   * 地点清单（双方共用一套渲染，避免两处样式漂移）。
   *
   * @param spans 该方的「网格键 → 停留跨度」字典；查不到说明该地点只有 1 次采样
   */
  const renderPlaceList = (
    places: PlacePoint[],
    color: string,
    who: string,
    spans: Record<string, number>,
  ) => (
    <View className="px-4 mt-3">
      <View className="flex flex-row items-center">
        <View className="w-3 h-3 rounded-sm mr-2" style={{ backgroundColor: color }} />
        <Text className="text-xs text-foreground leading-relaxed">
          {who}：{places.length} 处地点
        </Text>
      </View>
      {places.length === 0 && (
        <Text className="text-xs text-muted-foreground leading-relaxed mt-1">
          这段时间没有定位记录。
        </Text>
      )}
      {places.map((p, i) => {
        const span = spans[`${p.lat.toFixed(3)},${p.lng.toFixed(3)}`];
        return (
          <View key={`${p.lat}_${p.lng}_${i}`} className="flex flex-row items-start mt-2">
            <Text className="text-xs text-muted-foreground leading-relaxed w-6">{i + 1}.</Text>
            <View className="flex-1">
              <View className="flex flex-row items-center flex-wrap">
                <Text className="text-xs text-foreground leading-relaxed">
                  {p.name || '未知地点'}
                </Text>
                {/* 停留时长：只有 1 次采样时没有跨度可言，明确写「仅 1 次记录」而不是「0 分钟」 */}
                <View
                  className="ml-2 px-1 rounded-sm"
                  style={{ backgroundColor: 'rgba(100,116,139,0.12)' }}
                >
                  <Text className="text-xs text-muted-foreground leading-relaxed">
                    {span !== undefined ? `停留${formatStaySpan(span)}` : '仅 1 次记录'}
                  </Text>
                </View>
              </View>
              {/* 地址与地名重复时不重复显示（高德常把 POI 名直接拼进地址） */}
              {p.address && p.address !== p.name && (
                <Text className="text-xs text-muted-foreground leading-relaxed">{p.address}</Text>
              )}
              <Text className="text-xs text-muted-foreground leading-relaxed">
                {formatCheckTime(p.recordedAt)} · {p.lat.toFixed(6)}, {p.lng.toFixed(6)}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );

  return (
    <ErrorBoundary route="pages/location-track/index">
      <PrivacyShield>
        <View
          className="min-h-screen bg-background flex flex-col"
          style={{ paddingTop: `${statusBarHeight + 12}px` }}
        >
          {/* 顶栏：返回 + 标题（custom 导航栏自绘，右侧做胶囊避让） */}
          <View
            className="flex flex-row items-center px-4 mb-2"
            style={{ paddingRight: `${capsuleRightPadding}px` }}
          >
            <View
              className="mr-2"
              onClick={() => {
                logDbg('[location-track] 点击返回');
                Taro.navigateBack().catch(() => Taro.reLaunch({ url: '/pages/ping/index' }));
              }}
            >
              <View className="i-lucide-chevron-left w-6 h-6 text-foreground" />
            </View>
            <Text className="text-xl font-bold text-foreground flex-1">地点对比</Text>
          </View>

          {/* 区间说明 */}
          <View className="px-4 mb-3">
            <Text className="text-muted-foreground text-xs leading-relaxed">
              {params.startIso && params.endIso
                ? `${formatCheckTime(params.startIso)} ~ ${formatCheckTime(params.endIso)}`
                : '时间区间缺失'}
            </Text>
          </View>

          {/* 主体：加载 / 失败 / 空态 / 地图 + 清单 */}
          {loading && (
            <View className="px-4 py-10 flex items-center justify-center">
              <Text className="text-muted-foreground text-xs">正在查询地点…</Text>
            </View>
          )}

          {!loading && error !== '' && (
            <View className="mx-4 p-4 rounded-lg border border-border">
              <Text className="text-xs text-destructive leading-relaxed">{error}</Text>
              <View
                className="mt-3 flex flex-row items-center justify-center py-2 rounded-md border border-border"
                onClick={() => void load()}
              >
                <View className="i-lucide-refresh-cw w-3 h-3 text-muted-foreground mr-1" />
                <Text className="text-muted-foreground text-xs leading-none">重试</Text>
              </View>
            </View>
          )}

          {!loading && error === '' && !hasAny && (
            <View className="mx-4 p-4 rounded-lg border border-border">
              <Text className="text-xs text-foreground leading-relaxed">
                这段时间双方都没有定位记录。
              </Text>
              <Text className="text-xs text-muted-foreground leading-relaxed mt-2">
                定位只在微信真机上登录或进入详情页时自动上报；H5 预览端不产生记录。
              </Text>
            </View>
          )}

          {!loading && error === '' && hasAny && (
            <View className="flex-1">
              {/* 结论条：先给「有没有重合」，这是对比最想知道的答案 */}
              <View className="mx-4 mb-3 p-3 rounded-lg border border-border">
                <Text className="text-xs text-foreground leading-relaxed">
                  {sharedPlaces.length > 0
                    ? `双方有 ${sharedPlaces.length} 处地点重合（约 100 米内视为同一处）`
                    : '这段时间双方没有重合的地点'}
                </Text>
                <Text className="text-xs text-muted-foreground leading-relaxed mt-1">
                  我 {minePlaces.length} 处 · {params.peerName} {peerPlaces.length} 处
                </Text>
              </View>

              {isWeappEnv ? (
                <Map
                  className="w-full"
                  style={{ width: '100%', height: '420px' }}
                  latitude={bounds?.center.lat ?? 0}
                  longitude={bounds?.center.lng ?? 0}
                  scale={13}
                  markers={markers}
                  // 不画折线：点阵的意义是「去过哪几处」，连线会把不相邻的地点
                  // 串成一条根本不存在的路线（比如上午在 A、下午在 B，中间并没有走过去）。
                  polyline={[]}
                  includePoints={mapPoints}
                  includePadding={{ top: 60, right: 60, bottom: 60, left: 60 }}
                  showLocation={false}
                  onError={(e) => {
                    // 地图渲染失败（如基础库不支持、坐标非法）时不能静默白屏，
                    // 记日志并提示用户，避免「点了查看地点什么都没有」。
                    logDbg('[location-track] ❌ 地图渲染失败:', e);
                    Taro.showToast({ title: '地图加载失败', icon: 'none' });
                  }}
                />
              ) : (
                // H5 端 Map 组件不可用（@supported 不含 h5），只渲染清单作为可读替代
                <View className="mx-4 p-4 rounded-lg border border-border">
                  <Text className="text-xs text-foreground leading-relaxed">
                    地点地图需要在小程序内查看（H5 预览端无法渲染地图组件）。
                  </Text>
                  <Text className="text-xs text-muted-foreground leading-relaxed mt-2">
                    下方清单列出了双方去过的全部地点，可直接核对。
                  </Text>
                </View>
              )}

              {/* 图例：颜色 ↔ 谁。地图上两种颜色，靠它才能读懂 */}
              <View className="px-4 mt-3 flex flex-row flex-wrap">
                <View className="flex flex-row items-center mr-4">
                  <View className="w-3 h-3 rounded-sm mr-1" style={{ backgroundColor: MINE_COLOR }} />
                  <Text className="text-xs text-muted-foreground leading-none">我</Text>
                </View>
                <View className="flex flex-row items-center mr-4">
                  <View className="w-3 h-3 rounded-sm mr-1" style={{ backgroundColor: PEER_COLOR }} />
                  <Text className="text-xs text-muted-foreground leading-none">
                    {params.peerName}
                  </Text>
                </View>
                <View className="flex flex-row items-center">
                  <View className="w-3 h-3 rounded-sm mr-1" style={{ backgroundColor: '#16a34a' }} />
                  <Text className="text-xs text-muted-foreground leading-none">共同去过</Text>
                </View>
              </View>

              {/* 双方清单：地名优先、地址次之、坐标兜底；按最近一次时间倒序 */}
              {renderPlaceList(minePlaces, MINE_COLOR, '我', mineSpans)}
              {renderPlaceList(peerPlaces, PEER_COLOR, params.peerName, peerSpans)}

              <View className="px-4 mt-3 mb-6">
                <Text className="text-xs text-muted-foreground leading-relaxed">
                  约 100 米内合并为一处，按最近一次时间倒序排列；定位由双方登录或进入详情页时自动上报。
                </Text>
                <Text className="text-xs text-muted-foreground leading-relaxed mt-1">
                  停留时长为估算值：取该地点首次与末次定位之间的跨度，采样间隔越长误差越大。
                </Text>
              </View>
            </View>
          )}
        </View>
      </PrivacyShield>
    </ErrorBoundary>
  );
}
