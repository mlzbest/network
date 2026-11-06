/**
 * 批量诊断页的一次性交接数据（ping 页 → batch-diag 页）。
 *
 * 为什么走 Storage 而不是 URL query：navigateTo 的 query 需自行 encodeURIComponent，
 * 中文域名/长文本容易踩长度与转义问题；这里只传「主输入框当前值」这一小段文本，
 * 用 Storage 更稳，且与 AI 解读中转（net_diag_ai_payload_v1）保持同一套模式。
 *
 * take 后即焚：避免下次正常进入批量诊断页时误带旧输入。
 */
import Taro from '@tarojs/taro';
import { logDbg } from './logger';

const HANDOFF_KEY = 'net_diag_batch_input_v1';
/** 批量页「详情」下钻要全量诊断的目标，由 ping 页在 useDidShow 时取走 */
const DEEP_TARGET_KEY = 'net_diag_deep_target_v1';

export function saveBatchInput(text: string): void {
  try {
    Taro.setStorageSync(HANDOFF_KEY, text);
    logDbg(`[batch-handoff] 📦 已暂存批量诊断初始输入，长度 ${text.length}`);
  } catch (e) {
    console.warn('[batch-handoff] 暂存失败（批量页将回退空输入）:', e);
  }
}

/** 读取并焚毁；无数据返回空串 */
export function takeBatchInput(): string {
  try {
    const raw = Taro.getStorageSync(HANDOFF_KEY);
    if (typeof raw !== 'string' || raw === '') return '';
    Taro.removeStorageSync(HANDOFF_KEY);
    logDbg(`[batch-handoff] 📥 取出批量诊断初始输入并焚毁，长度 ${raw.length}`);
    return raw;
  } catch (e) {
    console.warn('[batch-handoff] 读取失败:', e);
    return '';
  }
}

/** 批量页写入「待全量诊断」目标（take 后即焚，防下次误触发） */
export function saveDeepDiagnoseTarget(target: string): void {
  try {
    Taro.setStorageSync(DEEP_TARGET_KEY, target);
    logDbg(`[batch-handoff] 🔬 已暂存下钻全量诊断目标: ${target}`);
  } catch (e) {
    console.warn('[batch-handoff] 下钻目标暂存失败:', e);
  }
}

/** ping 页取走下钻目标；无则返回空串 */
export function takeDeepDiagnoseTarget(): string {
  try {
    const raw = Taro.getStorageSync(DEEP_TARGET_KEY);
    if (typeof raw !== 'string' || raw === '') return '';
    Taro.removeStorageSync(DEEP_TARGET_KEY);
    logDbg(`[batch-handoff] 🎯 取出下钻全量诊断目标并焚毁: ${raw}`);
    return raw;
  } catch (e) {
    console.warn('[batch-handoff] 下钻目标读取失败:', e);
    return '';
  }
}
