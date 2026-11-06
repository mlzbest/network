/**
 * 诊断历史纯持久层：把每次全量诊断的「摘要快照」按目标主机存进本地存储，
 * 用于回答「刚才还好、现在不行了」——展示延迟/丢包走势与首次异常项。
 *
 * 设计约束：
 * - 只存摘要（每项 status + summary + ping 指标），不存完整 detail，避免撑爆
 *   Taro 单 key 1MB 限制；每个目标最多保留 MAX_PER_TARGET 条。
 * - 全局最多 MAX_TARGETS 个目标，超出按最近使用时间淘汰。
 * - 任何读写异常都静默降级（返回空/放弃写入），绝不阻塞诊断主流程。
 */
import Taro from '@tarojs/taro';
import type { DiagnoseResult, ItemStatus, ServerItemKey } from '@/api/net-diagnose';
import { logDbg } from './logger';

const STORE_KEY = 'net_diag_history_v1';
const MAX_PER_TARGET = 20;
const MAX_TARGETS = 30;

export interface ItemSnapshot {
  status: ItemStatus;
  summary: string;
}

export interface DiagSnapshot {
  /** 归一化后的目标 host[:port] */
  target: string;
  /** 落盘时间戳（ms） */
  at: number;
  items: Partial<Record<ServerItemKey, ItemSnapshot>>;
  /** ping 项提取的关键指标（无则缺省） */
  avgMs?: number;
  lossPct?: number;
}

type HistoryMap = Record<string, DiagSnapshot[]>;

function readAll(): HistoryMap {
  try {
    const raw = Taro.getStorageSync(STORE_KEY);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as HistoryMap;
  } catch (e) {
    console.warn('[diag-history] 读取失败:', e);
    return {};
  }
}

function writeAll(map: HistoryMap): void {
  try {
    // 容量控制：目标数超限时淘汰「最后一条最旧」的目标
    const keys = Object.keys(map);
    if (keys.length > MAX_TARGETS) {
      keys.sort((a, b) => {
        const la = map[a][map[a].length - 1]?.at ?? 0;
        const lb = map[b][map[b].length - 1]?.at ?? 0;
        return la - lb;
      });
      for (const k of keys.slice(0, keys.length - MAX_TARGETS)) delete map[k];
    }
    Taro.setStorageSync(STORE_KEY, map);
  } catch (e) {
    console.warn('[diag-history] 写入失败（不影响本次诊断结果）:', e);
  }
}

/**
 * 保存一次全量诊断结果。调用方需保证 results 已收敛（非 running）。
 * 全 pending / 空结果不落盘，避免误触产生垃圾记录。
 */
export function saveDiagSnapshot(target: string, results: Partial<Record<ServerItemKey, DiagnoseResult>>, metrics: { avgMs?: number; lossPct?: number }): void {
  const items: DiagSnapshot['items'] = {};
  let count = 0;
  for (const [key, r] of Object.entries(results) as Array<[ServerItemKey, DiagnoseResult]>) {
    if (!r || r.status === 'pending') continue;
    items[key] = { status: r.status, summary: r.summary };
    count += 1;
  }
  if (count === 0) {
    logDbg('[diag-history] 无有效结果，跳过留存');
    return;
  }
  const map = readAll();
  const list = map[target] ? [...map[target]] : [];
  list.push({ target, at: Date.now(), items, avgMs: metrics.avgMs, lossPct: metrics.lossPct });
  map[target] = list.slice(-MAX_PER_TARGET);
  writeAll(map);
  logDbg(`[diag-history] 💾 ${target} 已留存第 ${map[target].length} 条快照`);
}

/** 取某目标的历史快照，按时间倒序（最新在前） */
export function getDiagHistory(target: string): DiagSnapshot[] {
  const map = readAll();
  const list = map[target];
  if (!Array.isArray(list)) return [];
  return [...list].sort((a, b) => b.at - a.at);
}

/** 任意两条快照逐项比对（供历史面板自选对比项使用） */
export interface DiffEntry {
  key: ServerItemKey;
  from: ItemStatus | 'none';
  to: ItemStatus;
}

export function diffSnapshots(curr: DiagSnapshot, prev: DiagSnapshot): DiffEntry[] {
  const diff: DiffEntry[] = [];
  for (const [key, snap] of Object.entries(curr.items) as Array<[ServerItemKey, ItemSnapshot]>) {
    const old = prev.items[key];
    if (!old || old.status !== snap.status) {
      diff.push({ key, from: old?.status ?? 'none', to: snap.status });
    }
  }
  return diff;
}

/** 相对时间描述（用于历史列表展示） */
export function relTimeLabel(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/** 清空某目标或全部历史 */
export function clearDiagHistory(target?: string): void {
  const map = readAll();
  if (target) delete map[target];
  else for (const k of Object.keys(map)) delete map[k];
  writeAll(map);
}

// ---------- AI 解读中转（一次性：take 后即焚） ----------
// ping 页「AI 解读」→ reLaunch 会销毁页面栈，诊断数据无法随 state 传递；
// URL query 又有约 2KB 限制且中文需转义，故走 Storage 中转。
// takeDiagForAi 读取后立即删除，防止下次正常进入 AI 页误触发重复发送。

const AI_PAYLOAD_KEY = 'net_diag_ai_payload_v1';

export interface DiagAiItem {
  title: string;
  status: ItemStatus;
  summary: string;
}

export interface DiagAiPayload {
  /** 归一化后的目标 host[:port] */
  target: string;
  /** 检测时间戳（ms） */
  at: number;
  items: DiagAiItem[];
  avgMs?: number;
  lossPct?: number;
  /** 规则引擎主结论（全通过时缺省） */
  rootCause?: string;
  suggestion?: string;
  passedNotes?: string[];
}

export function saveDiagForAi(payload: DiagAiPayload): void {
  try {
    Taro.setStorageSync(AI_PAYLOAD_KEY, payload);
    logDbg(`[diag-history] 🤖 AI 解读数据已暂存: ${payload.target}（${payload.items.length} 项）`);
  } catch (e) {
    console.warn('[diag-history] AI 中转写入失败:', e);
  }
}

/** 读取并焚毁 AI 中转数据；无有效数据返回 null */
export function takeDiagForAi(): DiagAiPayload | null {
  try {
    const raw = Taro.getStorageSync(AI_PAYLOAD_KEY);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items) || raw.items.length === 0) return null;
    Taro.removeStorageSync(AI_PAYLOAD_KEY);
    logDbg('[diag-history] 🤖 取出 AI 中转数据并焚毁:', String(raw.target ?? ''));
    return raw as DiagAiPayload;
  } catch (e) {
    console.warn('[diag-history] AI 中转读取失败:', e);
    return null;
  }
}
