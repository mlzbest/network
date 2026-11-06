/**
 * 应用错误记录纯持久层：把页面崩溃与未捕获异常落到本机存储，供「我的」页查看。
 *
 * 为什么需要它：小程序端页面渲染抛错时用户看到的是白屏，而错误信息只打到
 * console——用户手机上根本看不到，事后无法追溯。本模块把错误持久化下来，
 * 让「用户反馈页面白屏」这类问题有据可查。
 *
 * 设计约束（与 lib/diag-history.ts 同思路）：
 * - 只存摘要（时间 / 页面 / 错误信息 / 截断后的堆栈），不存完整对象，
 *   避免撑爆 Taro 单 key 1MB 限制；最多保留 MAX_ENTRIES 条，超出淘汰最旧的。
 * - 任何读写异常都静默降级（返回空 / 放弃写入），绝不向上抛——
 *   记录错误的过程本身再抛错，会把「一次崩溃」放大成「崩溃循环」。
 * - 不做网络上报：崩溃时发请求容易二次失败，且会占用云函数额度。
 */
import Taro from '@tarojs/taro';
import { logDbg, logWarn } from './logger';

const STORE_KEY = 'app_error_log_v1';

/** 最多保留的记录条数，超出淘汰最旧的 */
const MAX_ENTRIES = 20;

/** 单条堆栈的最大长度：超长堆栈会显著撑大存储，截断后仍足够定位问题 */
const MAX_STACK_LEN = 1200;

/** 单条错误信息的最大长度 */
const MAX_MESSAGE_LEN = 300;

export interface ErrorLogEntry {
  /** 落盘时间戳（ms） */
  at: number;
  /** 崩溃发生的页面路由（取不到时为空串） */
  route: string;
  /** 归一化后的错误信息 */
  message: string;
  /** 截断后的堆栈（可能缺省） */
  stack?: string;
}

/**
 * 把任意形态的错误值归一化成可读字符串。
 *
 * 需要兼容的形态（实测都会遇到）：
 * - `Error` 实例 → 取 message
 * - `string`（Taro.onError 在小程序端常回字符串）
 * - `ErrorEvent`（H5 端）→ 取 message
 * - 普通对象 / 数字 / null → 走 JSON.stringify 或 String()
 */
function normalizeMessage(error: unknown): string {
  if (error == null) return '(空错误)';
  if (typeof error === 'string') return error.slice(0, MAX_MESSAGE_LEN);
  if (error instanceof Error) return (error.message || error.name || 'Error').slice(0, MAX_MESSAGE_LEN);
  if (typeof error === 'object') {
    const obj = error as { message?: unknown; errMsg?: unknown; reason?: unknown };
    const msg = obj.message ?? obj.errMsg ?? obj.reason;
    if (typeof msg === 'string' && msg) return msg.slice(0, MAX_MESSAGE_LEN);
    try {
      return JSON.stringify(error).slice(0, MAX_MESSAGE_LEN);
    } catch {
      return '(无法序列化的错误对象)';
    }
  }
  return String(error).slice(0, MAX_MESSAGE_LEN);
}

/** 提取堆栈（仅 Error 实例有；其余形态返回 undefined） */
function normalizeStack(error: unknown): string | undefined {
  if (error instanceof Error && typeof error.stack === 'string' && error.stack) {
    return error.stack.slice(0, MAX_STACK_LEN);
  }
  return undefined;
}

function readAll(): ErrorLogEntry[] {
  try {
    const raw = Taro.getStorageSync(STORE_KEY);
    if (!Array.isArray(raw)) return [];
    // 逐条校验形态，防止历史脏数据（或手工改过的存储）导致渲染层崩溃
    return raw.filter(
      (e): e is ErrorLogEntry =>
        !!e && typeof e === 'object' && typeof (e as ErrorLogEntry).at === 'number' && typeof (e as ErrorLogEntry).message === 'string',
    );
  } catch (e) {
    logWarn('[error-log] 读取失败:', e);
    return [];
  }
}

function writeAll(list: ErrorLogEntry[]): void {
  try {
    Taro.setStorageSync(STORE_KEY, list.slice(-MAX_ENTRIES));
  } catch (e) {
    logWarn('[error-log] 写入失败（不影响页面恢复）:', e);
  }
}

/**
 * 记录一条错误。调用方可以是错误边界（渲染崩溃）或 App 级钩子（未捕获异常）。
 *
 * ⚠️ 本函数**永不抛错**：记录失败只打 warn。错误边界在 componentDidCatch 里调用它，
 *    若这里抛错会触发 React 的二次错误，反而把兜底 UI 也搞崩。
 */
export function recordError(input: { route?: string; error: unknown; extraStack?: string }): void {
  try {
    const entry: ErrorLogEntry = {
      at: Date.now(),
      route: (input.route ?? '').trim(),
      message: normalizeMessage(input.error),
      // 优先用 React 给的 componentStack（能定位到具体组件），其次用 Error.stack
      stack: (input.extraStack ? input.extraStack.slice(0, MAX_STACK_LEN) : undefined) ?? normalizeStack(input.error),
    };
    const list = readAll();
    list.push(entry);
    writeAll(list);
    logDbg(`[error-log] 🩹 已记录错误（共 ${Math.min(list.length, MAX_ENTRIES)} 条）: ${entry.route || '(未知页面)'} — ${entry.message}`);
  } catch (e) {
    logWarn('[error-log] 记录错误时发生异常（已忽略）:', e);
  }
}

/** 读取全部错误记录，按时间倒序（最新在前） */
export function readErrorLog(): ErrorLogEntry[] {
  return readAll().sort((a, b) => b.at - a.at);
}

/** 错误记录条数（供「我的」页显示角标，避免为了拿条数而全量排序） */
export function countErrorLog(): number {
  return readAll().length;
}

/** 清空全部错误记录 */
export function clearErrorLog(): void {
  try {
    Taro.removeStorageSync(STORE_KEY);
    logDbg('[error-log] 🧹 错误记录已清空');
  } catch (e) {
    logWarn('[error-log] 清空失败:', e);
  }
}

/** 把一条记录拼成可复制的纯文本（供「复制详情」使用） */
export function formatErrorEntry(entry: ErrorLogEntry): string {
  const time = new Date(entry.at).toLocaleString();
  const lines = [`时间：${time}`, `页面：${entry.route || '(未知)'}`, `错误：${entry.message}`];
  if (entry.stack) lines.push('', '堆栈：', entry.stack);
  return lines.join('\n');
}
