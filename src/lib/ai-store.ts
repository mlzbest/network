/**
 * AI 会话与模型配置的本地持久化（仅本机，不进云端）。
 * key 设计：ai-sessions / ai-models / ai-active-model / ai-catalog-cache
 */
import Taro from '@tarojs/taro';
import { logDbg } from './logger';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiSession {
  id: string;
  title: string;
  /** 会话锁定的模型名；为空则跟随全局当前模型 */
  model: string;
  /** 是否使用自定义模型配置（true 时 modelId 指向 ai-models 里的 id） */
  customModelId?: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface CustomModel {
  id: string;
  name: string;
  /** OpenAI 兼容接口根地址，如 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** 模型 ID，原样透传 */
  modelId: string;
}

const SESSIONS_KEY = '***';
const MODELS_KEY = '***';
const ACTIVE_MODEL_KEY = 'ai-a…l-v1';
const CATALOG_KEY = '***';

/** 供「清除本地数据」等外部场景引用：清空全部 AI 会话与模型配置的本机存储 */
export function clearAllAiStorage(): void {
  try { Taro.removeStorageSync(SESSIONS_KEY); } catch { /* 忽略 */ }
  try { Taro.removeStorageSync(MODELS_KEY); } catch { /* 忽略 */ }
  try { Taro.removeStorageSync(ACTIVE_MODEL_KEY); } catch { /* 忽略 */ }
  try { Taro.removeStorageSync(CATALOG_KEY); } catch { /* 忽略 */ }
}

/** 启动兜底目录（非平台白名单，仅目录接口失败时使用） */
export const FALLBACK_CATALOG = [
  'qwen3.6-plus',
  'kimi-k2.5',
  'deepseek-v3.2',
  'glm-5',
  'MiniMax-M2.5',
];
export const DEFAULT_MODEL = 'qwen3.6-plus';

function safeGet<T>(key: string, fallback: T): T {
  try {
    const v = Taro.getStorageSync(key);
    return v === '' || v == null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

function safeSet(key: string, value: unknown): void {
  try {
    Taro.setStorageSync(key, value);
  } catch (e) {
    logDbg('[ai-store] 存储写入失败:', e);
  }
}

export function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ===== 会话 =====
export function loadSessions(): AiSession[] {
  const list = safeGet<AiSession[]>(SESSIONS_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function saveSessions(sessions: AiSession[]): void {
  // 只保留最近 50 个会话，防超 storage 限额
  safeSet(SESSIONS_KEY, sessions.slice(0, 50));
}

export function newSession(model: string): AiSession {
  return {
    id: genId(),
    title: '新对话',
    model,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ===== 自定义模型 =====
export function loadCustomModels(): CustomModel[] {
  const list = safeGet<CustomModel[]>(MODELS_KEY, []);
  if (!Array.isArray(list)) return [];
  // 防御：历史脏数据里可能存在缺字段的条目，渲染期 cm.name/cm.modelId 为 undefined 会抛 TypeError
  const valid = list.filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string');
  if (valid.length !== list.length) {
    logDbg('[ai-store] 自定义模型存储存在脏数据，已过滤', list.length - valid.length, '条');
    try { Taro.setStorageSync(MODELS_KEY, valid); } catch { /* 忽略回写失败 */ }
  }
  return valid;
}

export function saveCustomModels(models: CustomModel[]): void {
  safeSet(MODELS_KEY, models.slice(0, 20));
}

// ===== 当前模型选择 =====
export function loadActiveModel(): string {
  return safeGet<string>(ACTIVE_MODEL_KEY, '') || DEFAULT_MODEL;
}

export function saveActiveModel(model: string): void {
  safeSet(ACTIVE_MODEL_KEY, model);
}

// ===== 模型目录缓存 =====
export function loadCatalogCache(): string[] | null {
  const v = safeGet<string[] | null>(CATALOG_KEY, null);
  return Array.isArray(v) && v.length > 0 ? v : null;
}

export function saveCatalogCache(models: string[]): void {
  if (models.length > 0) safeSet(CATALOG_KEY, models);
}
