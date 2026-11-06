import Taro from '@tarojs/taro';
import { logDbg } from './logger';

/**
 * 小程序端图片缩放（canvas 方案）。
 *
 * 为什么不用 Taro.resizeImage：真机日志实测部分基础库不提供该 API
 * （`当前基础库不支持 resizeImage`），而 canvas 2d + canvasToTempFilePath
 * 是小程序一直存在的能力，且只能在「页面内」使用 —— 因此需要一个离屏 canvas
 * 宿主页（pages/canvas-host/index）配合：本模块负责跨页调度与结果回传。
 *
 * 通信方式：调用方把**一整批**任务写入 globalThis 上的共享槽位，拉起宿主页一次；
 * 宿主页在同一页面内逐张绘制导出、每完成一张就增量回写结果，最后 navigateBack。
 * ⚠️ 「一次导航压完一批」是批量提速的关键：旧版每张图各拉起一轮
 * navigateTo → navigateBack，9 张图光页面跳转就要好几秒，且连续导航会被微信拒绝。
 */

const CANVAS_ID = 'resizer-canvas';

export interface ResizeTask {
  /** 稳定 id：宿主页按 id 回写单项结果，调用方按 id 取用 */
  id: string;
  src: string;
  maxSide: number;
  quality: number;
}

export interface ResizeItemResult {
  ok: boolean;
  tempFilePath?: string;
  error?: string;
}

interface ResizeSlot {
  /** 待处理批次：由调用方写入，宿主页整批认领后清空 */
  batch: ResizeTask[] | null;
  /** 逐项结果（按任务 id 归位）：宿主页边做边写，调用方轮询读取 */
  results: Record<string, ResizeItemResult>;
  /** 宿主页已认领的批次标记：防「navigateTo 实际成功却回 fail」后补拉的重复页面二次劳动 */
  claimedMark: string;
  /** 【取消】当前批次的归属标记：调用方中止时置为该批次首项 id，宿主页逐张校验后提前退出 */
  abortMark: string;
}

function getSlot(): ResizeSlot {
  const g = globalThis as unknown as { __imageResizerSlot?: ResizeSlot };
  if (!g.__imageResizerSlot) {
    g.__imageResizerSlot = { batch: null, results: {}, claimedMark: '', abortMark: '' };
  }
  return g.__imageResizerSlot;
}

/**
 * 调用方用：中止**当前正在进行的批量压缩**。
 *
 * ⚠️ 小程序端压缩在宿主页里逐张串行跑，无法从外部中断单张 canvas 导出，
 * 只能让宿主页在「下一张开始前」发现中止标记后立刻 navigateBack —— 即
 * 「已完成的不撤回、未开始的不再做」。已在途的那一张仍会跑完并回写结果，
 * 但调用方轮询循环同样会因中止标记提前退出并丢弃回包（与 ping 页代次令牌同思路）。
 * @param batchFirstId 该批次首项 task.id（resizeImagesByCanvas 的返回值不暴露 id，故由内部记录）
 */
export function abortResizeBatch(): void {
  const slot = getSlot();
  // 未认领时批次还在槽位里：直接摘除，宿主页若随后进入会发现无批次而自行退出
  const mark = slot.claimedMark || (slot.batch?.[0]?.id ?? '');
  slot.abortMark = mark;
  slot.batch = null;
  logDbg(`[resizer] 🛑 批量压缩已请求中止 mark=${mark || '(空)'}`);
}

/** 宿主页 canvas id */
export const RESIZER_CANVAS_ID = CANVAS_ID;

/**
 * 宿主页用：整批认领当前任务。
 * 返回 null 表示「没有待处理批次」或「这一批已被上一层宿主页认领」——
 * 后者发生在 `navigateTo` 实际成功却回 fail（微信侧误报）时补拉的重复页面层，
 * 那一层直接退出即可，避免重复导出与多退一层栈。
 */
export function claimResizeBatch(): ResizeTask[] | null {
  const slot = getSlot();
  const batch = slot.batch;
  if (!batch || batch.length === 0) return null;
  // 批次归属标记取自首项 id（同批共享时间戳前缀），无需额外全局变量
  const mark = batch[0].id;
  if (slot.claimedMark === mark) return null; // 同一批的重复进入，不再处理
  slot.claimedMark = mark;
  // 【认领即摘除】调用方据此知道「宿主页确实开始干活了」，不会再补拉重复页面
  slot.batch = null;
  // 新批次开始时清掉上一批的中止标记，否则本批第一张就会被误判已取消
  if (slot.abortMark === mark) slot.abortMark = '';
  return batch;
}

/**
 * 宿主页用：判断「当前认领的这批任务是否已被调用方中止」。
 * 逐张处理前调用一次，为 true 时立刻 navigateBack，不再做剩余图片。
 */
export function isResizeBatchAborted(batchFirstId: string): boolean {
  return getSlot().abortMark === batchFirstId;
}

/**
 * 宿主页用：回写单项结果。
 * ⚠️ 必须**合并**而非覆盖 —— 调用方在等待期间会随时清理已完成项（见
 * resizeImagesByCanvas 的 onItem 消费逻辑），直接赋新对象会把别人刚写的项丢掉。
 */
export function putResizeItemResult(id: string, result: ResizeItemResult): void {
  const slot = getSlot();
  slot.results = { ...slot.results, [id]: result };
}

/**
 * 导航闸门：微信对「页面栈内正在发生的连续导航」会直接拒绝 navigateTo
 * （典型报错 `navigateTo:fail can not invoke navigateTo in background`）。
 * 记录最近一次导航完成时刻，下一次至少等 NAVIGATE_GAP_MS。
 */
let lastNavigateAt = 0;
const NAVIGATE_GAP_MS = 350;

async function openHostPage(): Promise<void> {
  const wait = NAVIGATE_GAP_MS - (Date.now() - lastNavigateAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  try {
    await Taro.navigateTo({ url: '/pages/canvas-host/index' });
  } finally {
    // 成功与失败都记时刻：失败说明栈更忙，更需要留够间隔
    lastNavigateAt = Date.now();
  }
}

/** 读取图片真实尺寸（小程序 getImageInfo） */
function getImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Taro.getImageInfo({
      src,
      success: (r) => resolve({ width: r.width, height: r.height }),
      fail: (e) => reject(new Error(`getImageInfo 失败: ${e?.errMsg || e}`)),
    });
  });
}

/** 批量压缩入参 */
export interface ResizeInput {
  src: string;
  maxSide: number;
  quality: number;
}

/**
 * 批量压缩：一次拉起宿主页处理完所有需要缩放的图片。
 *
 * @param inputs 每项 `{ src, maxSide, quality }`
 * @param onItem 可选回调：**每压完一张立刻通知**（下标 + 结果），用于「边压边传」流水线。
 *               已在目标边长内的原图会在函数开头同步回调一次。
 * @returns 与入参等长的结果数组（下标一一对应）；单张失败只影响自己，不拖垮整批
 *
 * 预筛：先 getImageInfo，最长边已 ≤ maxSide 的图直接原样返回，不进宿主页、不占 canvas 时间。
 */
export async function resizeImagesByCanvas(
  inputs: ResizeInput[],
  onItem?: (index: number, result: ResizeItemResult) => void,
): Promise<ResizeItemResult[]> {
  const slot = getSlot();
  if (slot.batch) throw new Error('已有图片压缩批次进行中，请稍后再试');

  const total = inputs.length;
  const outcomes: ResizeItemResult[] = new Array(total);
  const need: Array<{ index: number; task: ResizeTask }> = [];
  // 宿主页按此时间戳为整批命名任务 id，调用方据此识别「重复进入的页面层」
  const batchStamp = Date.now();

  for (let i = 0; i < total; i += 1) {
    const { src, maxSide, quality } = inputs[i];
    let longest = 0;
    try {
      const { width, height } = await getImageSize(src);
      longest = Math.max(width, height);
    } catch (e: any) {
      console.warn('[resizer] getImageInfo 失败，仍交给宿主页尝试:', e?.message || e);
    }
    if (longest && longest <= maxSide) {
      // 原图已在目标边长内：省掉一次 canvas 导出
      const r: ResizeItemResult = { ok: true, tempFilePath: src };
      outcomes[i] = r;
      onItem?.(i, r);
      continue;
    }
    need.push({ index: i, task: { id: `${batchStamp}_${i}`, src, maxSide, quality } });
  }

  if (need.length === 0) return outcomes;

  slot.results = {};
  slot.claimedMark = '';
  slot.abortMark = '';
  slot.batch = need.map((n) => n.task);
  const batchMark = need[0].task.id; // 中止判定与宿主页认领都以此为准
  logDbg(`[resizer] 🎨 一次导航批量压缩 ${need.length}/${total} 张（其余原图已达标）`);

  // 【拉起可能失败，也可能「实际成功却回 fail」】导航被拒时下一轮补拉起，而不是干等到超时。
  // ⚠️ 只在批次仍未被认领时补拉：已被认领说明宿主页正在逐张干活，重复拉起只会多压一层空转页面。
  let opened = false;
  let aborted = false;
  const started = Date.now();
  // 单张预算 6s + 固定余量：批量不能沿用单图的 15s 一刀切，否则 9 张必误判超时
  const deadlineMs = Math.min(90_000, need.length * 6_000 + 8_000);
  let consumed = 0;

  while (consumed < need.length) {
    if (Date.now() - started > deadlineMs) break;
    // 【取消】调用方中止后立刻退出轮询：剩余项统一按「已取消」收敛，不再消费宿主页回包
    if (slot.abortMark === batchMark) {
      aborted = true;
      logDbg(`[resizer] 🛑 轮询检测到中止标记，提前结束（已完成 ${consumed}/${need.length}）`);
      break;
    }
    // 每轮先等一拍再判定：宿主页 useLoad 在下一个宏任务里执行，
    // 刚 navigateTo 成功就查 slot.batch 必然还是「未认领」，会误补拉一层空转页面。
    await new Promise((r) => setTimeout(r, 200));

    // 取走已完成项并立即通知调用方（边压边传）。
    // ⚠️ 必须在读完后删除：宿主页用合并写法回写，这里若整体覆盖会丢并发写入的项。
    for (const { index, task } of need) {
      if (outcomes[index]) continue;
      const r = slot.results[task.id];
      if (!r) continue;
      delete slot.results[task.id];
      outcomes[index] = r;
      consumed += 1;
      onItem?.(index, r);
    }

    if (slot.batch) {
      try {
        await openHostPage();
        opened = true;
      } catch (e: any) {
        console.warn('[resizer] 拉起宿主页失败，稍后重试:', e?.errMsg || e);
      }
    }
  }

  const timeout = consumed < need.length && !aborted;
  slot.batch = null;
  slot.results = {};
  slot.claimedMark = '';
  // abortMark 不在这里清：宿主页可能仍在逐张处理，靠它发现中止并提前返回上一页

  for (const { index, task } of need) {
    if (outcomes[index]) continue;
    outcomes[index] = {
      ok: false,
      error: aborted
        ? '已取消图片压缩'
        : timeout
          ? opened
            ? '图片压缩超时（宿主页未返回该张结果）'
            : '图片压缩未能启动（页面跳转受阻），请重试'
          : '图片压缩结果缺失',
    };
  }
  const done = outcomes.filter((o) => o.ok).length;
  logDbg(
    `[resizer] ✅ 批量压缩结束 ${done}/${total} 张可用${aborted ? '（已取消）' : ''}，耗时 ${Date.now() - started}ms`,
  );
  return outcomes;
}

/**
 * 单图压缩（保留给头像等单张场景）。
 * 任何一步失败都会抛错，由调用方决定是否回退（绝不静默返回原图冒充压缩结果）。
 */
export async function resizeImageByCanvas(
  src: string,
  target: { maxSide: number; quality: number },
): Promise<string> {
  const [out] = await resizeImagesByCanvas([
    { src, maxSide: target.maxSide, quality: target.quality },
  ]);
  if (!out || !out.ok || !out.tempFilePath) throw new Error(out?.error || '图片压缩失败');
  // 原图本就达标时 out.tempFilePath === src，交由上层体积校验判定「压缩未生效」并决定回退
  return out.tempFilePath;
}
