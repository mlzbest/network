/**
 * net-diagnose — WorkBuddy Cloud 版「网络诊断 / 微信步数 / 逆地理编码」适配层
 *
 * 替代原 `functions/net-diagnose/index.ts` 的三组通道：
 *   - 8 项网络诊断（ping/dns/dnscompare/ports/http/tls/throughput/route/multiprobe）
 *       → 依赖 Deno.resolveDns / Deno.connect / 第三方拨测 API，WorkBuddy 无等价面，
 *         保留外部承载（TCB / 阿里云函数 / Cloudflare Workers），调用路径不变。
 *   - 微信步数（steps-query / steps-sync）
 *       → 走 SDK `cloudSupabase.from`，本文件提供 `cloudWeRunStepsQuery` / `cloudWeRunStepsSync`。
 *   - 逆地理编码（geocode-reverse）
 *       → 依赖高德 Web Key 外部 API，保留外部承载；若走云端可改用 LLM 兜底（不推荐）。
 *
 * 不再需要的环境变量（外部承载时仍需）：
 *   - AMAP_WEB_KEY（逆地理）
 *   - PROBE_17CE_TOKEN（17CE 拨测）
 *   - WX_MOTION_AES_KEY（步数解密）
 */

import { cloudSupabase } from '@/supabase/cloud-adapter';

/**
 * 网络诊断外部承载标记。
 *
 * 8 项诊断全部依赖 Deno API（resolveDns / connect / connectTls / 第三方拨测 API），
 * WorkBuddy Cloud SDK 没有等价面。正式切换外部承载前，
 * `src/api/net-diagnose.ts` 仍走原 `functions/net-diagnose`，调用侧在此显式标注。
 */
export const NET_DIAGNOSE_EXTERNAL_REQUIRED = true;

/**
 * 微信步数·查询（云端版）。
 * 走 `cloudSupabase.from('we_run_steps')` 查询当前用户最近 7 天步数。
 * 与原函数的差异：不再走 service_role，RLS 由数据库侧控制（仅本人可读）。
 */
export async function cloudWeRunStepsQuery(openid: string) {
  const { data, error } = await cloudSupabase
    .from('we_run_steps')
    .select('date, total_steps, sync_source')
    .eq('openid', openid)
    .order('date', { ascending: false })
    .limit(7);
  if (error) {
    return { ok: false, error: String(error) };
  }
  return {
    ok: true,
    data: Array.isArray(data) ? data : [],
  };
}

/**
 * 微信步数·同步（云端版）。
 * 入参 stepRows 是解密后的 `{ date, total_steps }` 数组，本函数仅做 upsert。
 * 解密逻辑保留在调用侧（原 functions/net-diagnose/shared/we-run-steps.ts 的 decrypt 分支）。
 */
export async function cloudWeRunStepsSync(openid: string, stepRows: Array<{ date: string; total_steps: number }>) {
  if (!Array.isArray(stepRows) || stepRows.length === 0) {
    return { ok: false, error: 'stepRows 不能为空' };
  }
  const { data, error } = await cloudSupabase
    .from('we_run_steps')
    .upsert(
      stepRows.map((r) => ({
        openid,
        date: r.date,
        total_steps: r.total_steps,
        sync_source: 'manual',
      })),
      { onConflict: 'openid,date' },
    );
  if (error) {
    return { ok: false, error: String(error) };
  }
  return { ok: true, written: data?.length ?? stepRows.length };
}

/**
 * 逆地理编码外部承载标记。
 *
 * 走高德 Web API（AMAP_WEB_KEY），WorkBuddy 无等价面。
 * 正式切换外部承载前，`src/api/geocode.ts` 仍走原 `functions/net-diagnose` 的 `action='geocode-reverse'` 分支。
 */
export const GEOCODE_EXTERNAL_REQUIRED = true;
