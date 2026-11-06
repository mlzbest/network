/**
 * 登录时间点格式化：**统一 MM-DD HH:mm:ss**（月-日-具体时间）。
 * 用户明确要求最后的登录时间带日期，不再按「今天/昨天」省略日期。
 * 抽到公共模块的原因：chat 页顶栏统计行、chats 列表统计行、登录明细弹层、
 * 以及区间文案四处要用完全一致的口径，此前在两页各自内联复制过一份，改动容易漏同步。
 */
export function formatLoginDetailTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 时间戳（ms）→ ISO 串；无效值返回 null，供统计窗口边界统一转换 */
export function toIso(ms: number | null): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 统计区间文案：「上次离开 HH:mm:ss ～ 本次进入 HH:mm:ss」。
 * 任一端缺失时降级为可读的开放式描述——首次使用没有退场打点属正常，不能显示空白或 null。
 */
export function formatLoginRange(fromIso: string | null, toIsoValue: string | null): string {
  const from = fromIso ? formatLoginDetailTime(fromIso) : '';
  const to = toIsoValue ? formatLoginDetailTime(toIsoValue) : '';
  if (from && to) return `上次离开 ${from} ～ 本次进入 ${to}`;
  if (to) return `本次进入 ${to} 之前（首次记录，含全部历史）`;
  if (from) return `${from} 之后`;
  return '全部历史登录';
}
