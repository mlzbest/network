/**
 * 无操作计时协调器（inactivity guard）
 *
 * 背景：AI 助手页通过 reLaunch 进入/离开，旧页面实例的销毁时机与新实例 didShow
 * 之间没有确定顺序；此前用「组件内 useRef 起点 + 共享页面名字符串」判定导航/切后台，
 * 存在两类竞态：
 *  1. 旧实例残留 tick 在新实例已进入后再次触发跳转（把新页面踢走）；
 *  2. 共享字符串标记被生命周期回写时序污染，新实例误判为「后台切回」并用陈旧起点立刻弹回。
 *
 * 本模块用三个手段结构性消除歧义：
 *  - 代次令牌（generation）：每次页面 didShow claim 一个自增代次，只有最新代次实例
 *    有权执行超时跳转；旧实例补跑一律静默忽略（打 GUARD_STALE 日志）。
 *  - 纯时间判定：interval tick 只做 Date.now() - startAt >= timeoutMs，绝不读任何
 *    页面归属状态（微信切后台会冻结 setInterval，回前台补跑的 tick 不能依赖易变状态）。
 *  - 真实来源校验：isSelfForeground 以 Taro.getCurrentPages() 栈顶 route 为唯一事实
 *    来源判断「本页是否真的在前台可见」；前后台时刻由 App 级 onAppHide/onAppShow 记录，
 *    didShow 据此区分「导航进入」（全新起表）vs「后台切回」（按时间戳补判/续跑）。
 */
import Taro from '@tarojs/taro';
import { logDbg } from './logger';

const TIMEOUT_MS = 120000;

/** 全局自增代次计数器，claim 返回本次进入的代次号 */
let generationCounter = 0;
/** 当前最新代次（只有等于它的实例可跳转） */
let latestGeneration = 0;
/** 计时起点时间戳（模块级，跨组件实例存活；0 表示无起点） */
let startAt = 0;
/** 最近一次 App 级切后台的时刻（0 表示从未切过后台） */
let backgroundedAt = 0;
/** 最近一次页面 didHide 的时刻（0 表示从未 hide 过） */
let hiddenAt = 0;
/** 上一次 didHide 是否由 App 级切后台引起（≤1500ms 内伴随 onAppHide 即判定为是） */
let hideWasForBackground = false;
/** 定时器句柄 */
let timer: ReturnType<typeof setInterval> | null = null;
/** 超时回调（由页面注册，跳转动作在页面侧完成） */
let onTimeoutCb: (() => void) | null = null;

const log = (...args: unknown[]) => logDbg('[inactivity-guard]', ...args);

/**
 * 真·重新进入时领取本实例代次号：领新代次 + 作废上一代计时起点。
 * ⚠️ 仅在确认「上次离开本页是真导航/reLaunch（didHide 未伴随切后台），或首次进入」
 * 时调用——后台切回的重复 didShow 绝不能走这里，否则计时起点被重置、
 * 后台放置时长丢失（用户明确要求前台10s+后台30s→回前台应剩80s续跑）。
 * reLaunch 销毁重建后组件 useRef 归零但模块级 startAt 残留陈旧时间戳，
 * 换代时必须清掉，防新实例误补判「刚进页就弹回」。
 */
export function claimFreshEntry(): number {
  generationCounter += 1;
  latestGeneration = generationCounter;
  if (startAt > 0) {
    log('🎫 [FRESH] 真·重新进入, 作废旧起点:', new Date(startAt).toLocaleTimeString(), '新代次:', latestGeneration);
    stopGuard();
    startAt = 0;
  } else {
    log('🎫 [FRESH] claim 代次:', latestGeneration);
  }
  // 消费掉本次进入前遗留的 hide/后台配对信号，避免下次误读
  hiddenAt = 0;
  hideWasForBackground = false;
  return latestGeneration;
}

/**
 * 后台切回路径：沿用当前代次（不清起点、不换代）。
 * 若代次为 0（异常：实例重建但被判为切回），补领一个但不触碰起点。
 */
export function retainGeneration(): number {
  if (latestGeneration === 0) {
    generationCounter += 1;
    latestGeneration = generationCounter;
    log('🔁 [RETAIN] 无历史代次, 补领:', latestGeneration, '(不动起点)');
  } else {
    log('🔁 [RETAIN] 后台切回, 沿用代次:', latestGeneration, ', 起点保留');
  }
  hiddenAt = 0;
  hideWasForBackground = false;
  return latestGeneration;
}

/** 当前最新代次号（页面侧校验自己是否仍有权发起跳转时使用） */
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
    // ⚠️ tick 内绝不读 getCurrentPage / getCurrentPages 等依赖页面生命周期的状态：
    // 微信切后台冻结 JS 定时器，回前台瞬间挂起的 tick 可能先于 didShow 补跑，
    // 此刻任何页面归属状态都可能是旧值，读了就会误判废弃计时（历史第三轮根因）。
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

/**
 * 全新起表：设置新起点并启动计时。
 * 用于「导航进入本页」「用户有操作重置」「首次进入」等场景。
 */
export function startGuard(opts: { generation: number; onTimeout: () => void }): void {
  onTimeoutCb = opts.onTimeout;
  startAt = Date.now();
  log('🔥 全新起表 120s, 起点:', new Date(startAt).toLocaleTimeString(), '代次:', opts.generation);
  armInterval(opts.generation);
}

/**
 * 续跑原起点（不清零）：用于「后台切回但未超时」。
 * 若起点已被清空（异常路径），退回全新起表。
 */
export function resumeGuard(generation: number): void {
  if (!startAt) {
    log('⚠️ resume 但无起点(异常路径), 改为全新起表');
    if (onTimeoutCb) startGuard({ generation, onTimeout: onTimeoutCb });
    return;
  }
  const elapsed = Date.now() - startAt;
  log('▶️ 续跑原起点, 已流逝', Math.floor(elapsed / 1000), '秒, 剩余', Math.ceil((TIMEOUT_MS - elapsed) / 1000), '秒, 代次:', generation);
  armInterval(generation);
}

/** 用户有操作（输入/发送）时重置起点，语义与原 resetInactivityTimer 一致 */
export function bumpGuard(generation: number): void {
  if (!startAt) {
    // 计时已终结（如刚跳转后残留回调），重新起表
    if (onTimeoutCb) startGuard({ generation, onTimeout: onTimeoutCb });
    return;
  }
  startAt = Date.now();
  log('♻️ 用户操作, 重置起点:', new Date(startAt).toLocaleTimeString());
}

/** 彻底放弃计时并清空起点（页面主动退出/跳转出口使用） */
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
export function notePageHidden(): void {
  hiddenAt = Date.now();
  // 默认先判为「导航离开」；若随后真的广播 onAppHide，noteBackground() 会改判为切后台
  hideWasForBackground = false;
  log('😴 记录页面 didHide 时刻:', new Date(hiddenAt).toLocaleTimeString());
}

/** App onAppHide 时调用：记录切后台时刻；若在页面 hide 后 1500ms 内到达，判定本次 hide 是切后台而非导航离开 */
export function noteBackground(): void {
  backgroundedAt = Date.now();
  if (hiddenAt > 0 && backgroundedAt - hiddenAt <= 1500) {
    hideWasForBackground = true;
    log('🌙 记录切后台时刻:', new Date(backgroundedAt).toLocaleTimeString(), '(距 didHide', backgroundedAt - hiddenAt, 'ms → 判定 hide 为切后台)');
  } else {
    log('🌙 记录切后台时刻:', new Date(backgroundedAt).toLocaleTimeString(), '(无近期 didHide 配对)');
  }
}

/**
 * didShow 用：最近一次离开本页是否为「切后台」而非「导航离开」。
 * 读取即消费（复位），防止同一次信号被重复使用。
 * 从未 hide 过（首次进入）返回 false → 走全新起表。
 */
export function lastHideWasBackground(): boolean {
  const v = hideWasForBackground;
  log('🧭 lastHideWasBackground 查询:', v, '| 有计时起点?', startAt > 0);
  hiddenAt = 0;
  hideWasForBackground = false;
  return v;
}

/**
 * 是否处于「刚从后台回来」的语境：曾记录过切后台，且发生在最近一次起表之后
 * （起表晚于切后台说明中间发生过导航/reLaunch，不算后台切回）。
 */
export function isReturningFromBackground(): boolean {
  return backgroundedAt > 0 && startAt > 0 && backgroundedAt >= startAt;
}

/** 消费掉后台标记（避免同一次切后台被重复判定为切回） */
export function clearBackgroundNote(): void {
  backgroundedAt = 0;
}

/**
 * 本页是否真的在前台可见（栈顶 route 比对）。
 * 用于 didShow 防御：被销毁的旧实例补触发生命周期时，栈顶必然不是自己 → 直接忽略。
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
 * 前台校验 + 后台切回识别的组合判定（供页面 didShow 一次性调用）。
 * 返回 'stale'   → 栈顶非本页(旧实例补触发)，页面应直接忽略本次生命周期；
 * 返回 'resume' → 上次 hide 由切后台引起且计时起点仍在 → 后台切回，保留起点续跑/补判；
 * 返回 'fresh'  → 真·重新进入或首次进入 → 页面应 claimFreshEntry 全新起表。
 * ⚠️ 本函数会消费 hide/后台配对信号（lastHideWasBackground 读取即复位），每个 didShow 只准调一次。
 */
export function resolveEntryMode(pageRoute: string): { mode: 'stale' | 'resume' | 'fresh'; elapsedMs: number } {
  if (!isSelfForeground(pageRoute)) return { mode: 'stale', elapsedMs: 0 };
  const hideWasBg = lastHideWasBackground();
  const elapsed = elapsedSinceStart();
  const returning = hideWasBg && elapsed > 0;
  log('🧭 resolveEntryMode — 上次hide是切后台?', hideWasBg, '| 起点已流逝(s):', Math.floor(elapsed / 1000), '→ mode:', returning ? 'resume' : 'fresh');
  return { mode: returning ? 'resume' : 'fresh', elapsedMs: elapsed };
}
