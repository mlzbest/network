/**
 * 页面级「120 秒无操作自动返回 ping 页」守护（chats / chat / profile 共用）。
 *
 * 为什么不用各页原来那套 `useRef 起点 + setInterval` 写法：
 * 微信小程序切后台会**冻结 JS 定时器**，于是出现两类必现故障——
 *  1. 用户停在页面不操作，回前台瞬间挂起的 tick 先于 didShow 补跑，此刻若 tick 内
 *     去读「当前活跃页」「页面切换标记」这类依赖生命周期的状态，读到的是旧值 →
 *     误判为「已离开本页」而 clear 掉计时器 → **永远不跳转**（本次用户报的 bug）；
 *  2. 计时起点存在组件 useRef 里，reLaunch 销毁重建后归零，跨实例的「后台放置时长」丢失。
 *
 * 本模块的三条硬约束：
 *  - 起点/代次等状态全部**模块级**保存，跨组件实例存活；
 *  - tick 只做纯时间比较 `Date.now() - startAt >= 120s`，绝不读任何页面归属状态；
 *  - 「是否仍有权跳转」用自增**代次令牌**判定，旧实例补跑的 tick 一律静默忽略。
 *
 * 与 lib/inactivity-guard.ts（AI 页专用、含隐私遮挡联动）语义一致，但按 pageRoute
 * 区分归属，避免多页共享一个全局起点互相踩写。
 */
import Taro from '@tarojs/taro';
import { logDbg } from './logger';

const TIMEOUT_MS = 120000;

/** 全局自增代次计数器 */
let generationCounter = 0;
/** 当前最新代次：只有持有它的实例才能发起跳转 */
let latestGeneration = 0;
/** 代次归属的页面 route（空串表示尚无代次） */
let generationRoute = '';
/** 计时起点时间戳（0 表示无起点） */
let startAt = 0;
/** 最近一次 App 级切后台时刻（0 表示从未） */
let backgroundedAt = 0;
/** 最近一次页面 didHide 时刻（0 表示从未） */
let hiddenAt = 0;
/** 上一次 didHide 是否由切后台引起（≤1500ms 内伴随 onAppHide 即判定为是） */
let hideWasForBackground = false;
/** 定时器句柄 */
let timer: ReturnType<typeof setInterval> | null = null;
/** 超时回调（跳转动作在页面侧完成） */
let onTimeoutCb: (() => void) | null = null;

const log = (...args: unknown[]) => logDbg('[page-guard]', ...args);

/**
 * 真·重新进入（首次进入 / 从别的页面导航过来）：领新代次 + 作废旧起点。
 * ⚠️ 后台切回的重复 didShow 绝不能走这里，否则计时起点被重置、后台放置时长丢失。
 */
export function claimFreshEntry(pageRoute: string): number {
  generationCounter += 1;
  latestGeneration = generationCounter;
  generationRoute = pageRoute;
  if (startAt > 0) {
    log(`🎫 [FRESH] ${pageRoute} 真·重新进入, 作废旧起点`, new Date(startAt).toLocaleTimeString(), '新代次:', latestGeneration);
    stopGuard();
    startAt = 0;
  } else {
    log(`🎫 [FRESH] ${pageRoute} claim 代次:`, latestGeneration);
  }
  // 消费掉本次进入前遗留的 hide/后台配对信号，避免下次误读
  hiddenAt = 0;
  hideWasForBackground = false;
  return latestGeneration;
}

/** 后台切回路径：沿用当前代次（不清起点、不换代）；代次缺失时补领但不触碰起点 */
export function retainGeneration(pageRoute: string): number {
  if (latestGeneration === 0 || generationRoute !== pageRoute) {
    generationCounter += 1;
    latestGeneration = generationCounter;
    generationRoute = pageRoute;
    log(`🔁 [RETAIN] ${pageRoute} 无可沿用代次, 补领:`, latestGeneration, '(不动起点)');
  } else {
    log(`🔁 [RETAIN] ${pageRoute} 后台切回, 沿用代次:`, latestGeneration, ', 起点保留');
  }
  hiddenAt = 0;
  hideWasForBackground = false;
  return latestGeneration;
}

/** 当前最新代次号（页面侧校验自己是否仍有权发起跳转） */
export function getLatestGeneration(): number {
  return latestGeneration;
}

/** 停表（只清 interval，绝不清起点——「停表」与「清起点」必须区分） */
export function stopGuard(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function armInterval(gen: number): void {
  stopGuard();
  timer = setInterval(() => {
    // ⚠️ tick 内绝不读 getCurrentPages / 存储里的页面标记等依赖生命周期的状态：
    // 微信切后台冻结定时器，回前台瞬间挂起的 tick 可能先于 didShow 补跑，
    // 此刻任何页面归属状态都可能是旧值，读了就会误清计时器导致永不跳转。
    if (!startAt) return;
    if (Date.now() - startAt >= TIMEOUT_MS) {
      if (gen !== latestGeneration) {
        log('🛑 [GUARD_STALE] 到点但代次已过期(', gen, '!=', latestGeneration, ') 忽略, 不发第二次跳转');
        stopGuard();
        return;
      }
      log('⏰ 计时到点(120秒), 交还页面执行跳转, 代次:', gen);
      stopGuard();
      startAt = 0;
      onTimeoutCb?.();
    }
  }, 1000);
}

/** 全新起表：设置新起点并启动计时（导航进入 / 首次进入 / 用户操作重置均可用） */
export function startGuard(opts: { pageRoute: string; generation: number; onTimeout: () => void }): void {
  onTimeoutCb = opts.onTimeout;
  startAt = Date.now();
  log('🔥 全新起表 120s', opts.pageRoute, '起点:', new Date(startAt).toLocaleTimeString(), '代次:', opts.generation);
  armInterval(opts.generation);
}

/** 续跑原起点（不清零）：用于「后台切回但未超时」 */
export function resumeGuard(generation: number): void {
  if (!startAt) {
    log('⚠️ resume 但无起点(异常路径), 退回不计时, 等下次 didShow 全新起表');
    return;
  }
  const elapsed = Date.now() - startAt;
  log('▶️ 续跑原起点, 已流逝', Math.floor(elapsed / 1000), '秒, 剩余', Math.ceil((TIMEOUT_MS - elapsed) / 1000), '秒, 代次:', generation);
  armInterval(generation);
}

/** 用户有操作（点击/输入/发送/下拉刷新）时重置起点 */
export function bumpGuard(generation: number): void {
  if (!startAt) {
    if (onTimeoutCb) startGuard({ pageRoute: generationRoute, generation, onTimeout: onTimeoutCb });
    return;
  }
  startAt = Date.now();
  log('♻️ 用户操作, 重置起点:', new Date(startAt).toLocaleTimeString());
}

/** 彻底放弃计时并清空起点（页面主动跳转出口使用） */
export function abandonGuard(): void {
  stopGuard();
  startAt = 0;
  log('🗑️ 计时已废弃并清起点');
}

/** 距起点已流逝的毫秒数（无起点返回 0） */
export function elapsedSinceStart(): number {
  return startAt ? Date.now() - startAt : 0;
}

/** 页面 didHide 时调用：记录 hide 时刻，与随后的 App onAppHide 配对判定「离开原因」 */
export function notePageHidden(pageRoute: string): void {
  hiddenAt = Date.now();
  // 默认先判为「导航离开」；若随后真的广播 onAppHide，noteBackground() 会改判为切后台
  hideWasForBackground = false;
  log('😴 记录 didHide 时刻', pageRoute, new Date(hiddenAt).toLocaleTimeString());
}

/**
 * App onAppHide 时调用：记录切后台时刻。
 * 若与最近一次 didHide 间隔 ≤1500ms，判定本次 hide 是切后台而非导航离开。
 * 兼容「onAppHide 早于页面 didHide」的机型：反向间隔同样视为配对。
 */
export function noteBackground(): void {
  backgroundedAt = Date.now();
  const gap = hiddenAt > 0 ? Math.abs(backgroundedAt - hiddenAt) : Number.POSITIVE_INFINITY;
  if (gap <= 1500) {
    hideWasForBackground = true;
    log('🌙 记录切后台时刻', new Date(backgroundedAt).toLocaleTimeString(), `(与 didHide 间隔 ${Math.round(gap)}ms → 判定 hide 为切后台)`);
  } else {
    log('🌙 记录切后台时刻', new Date(backgroundedAt).toLocaleTimeString(), '(无近期 didHide 配对)');
  }
}

/**
 * 本页是否真的在前台可见（栈顶 route 比对）。
 * 被销毁的旧实例补触发生命周期时，栈顶必然不是自己 → 直接忽略。
 */
export function isSelfForeground(pageRoute: string): boolean {
  const pages = Taro.getCurrentPages();
  if (!pages.length) return true; // 极端兜底：拿不到栈时不误伤
  const top = pages[pages.length - 1];
  const route = (top as { route?: string })?.route ?? '';
  const self = route === pageRoute || `/${route}` === `/${pageRoute}`.replace(/^\//, '');
  if (!self) log('👀 栈顶非本页(', route, '!=', pageRoute, ') — 疑似旧实例补触发');
  return self;
}

/**
 * didShow 一次性拿到入口模式（内部完成「前台校验 + hide/onAppHide 配对判定」）：
 *  - 'stale'  → 栈顶非本页（旧实例补触发），页面应忽略本次生命周期；
 *  - 'resume' → 上次 hide 由切后台引起且起点仍在 → 后台切回，保留起点续跑/补判；
 *  - 'fresh'  → 真导航离开过 / 首次进入 → 应 claimFreshEntry 后全新起表。
 * ⚠️ 会消费 hide/后台配对信号，每个 didShow 只准调一次。
 */
export function resolveEntryMode(pageRoute: string): { mode: 'stale' | 'resume' | 'fresh'; elapsedMs: number } {
  if (!isSelfForeground(pageRoute)) return { mode: 'stale', elapsedMs: 0 };
  const hideWasBg = hideWasForBackground;
  const elapsed = elapsedSinceStart();
  const returning = hideWasBg && elapsed > 0;
  hiddenAt = 0;
  hideWasForBackground = false;
  log('🧭 resolveEntryMode', pageRoute, '— 上次hide是切后台?', hideWasBg, '| 起点已流逝(s):', Math.floor(elapsed / 1000), '→ mode:', returning ? 'resume' : 'fresh');
  return { mode: returning ? 'resume' : 'fresh', elapsedMs: elapsed };
}

/** 消费掉后台标记（避免同一次切后台被重复判定为切回） */
export function clearBackgroundNote(): void {
  backgroundedAt = 0;
}

/** 距最近一次切后台已流逝的毫秒数（从未切过返回 0） */
export function sinceBackground(): number {
  return backgroundedAt > 0 ? Date.now() - backgroundedAt : 0;
}
