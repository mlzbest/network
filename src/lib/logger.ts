/**
 * 统一日志出口：生产构建静默 debug/info 级（降噪），error/warn 始终保留（线上排障必需）。
 * 用法与 console 完全一致：logDbg('[chats] xxx', obj) / logErr(...) / logWarn(...)
 */
// 编译期常量：APP_NODE_ENV 由 config/index.ts defineConstants 注入（src 禁用 process.env）。
// 生产构建为 "production"，开发/预览为 "development"；取不到时保守视为非生产（全量输出）。
const IS_PROD = typeof APP_NODE_ENV !== 'undefined' && APP_NODE_ENV === 'production';

export function logDbg(...args: unknown[]): void {
  if (!IS_PROD) console.log(...args);
}

export function logWarn(...args: unknown[]): void {
  console.warn(...args);
}

export function logErr(...args: unknown[]): void {
  console.error(...args);
}
