/**
 * set-account-email — WorkBuddy Cloud 版「修改邮箱 / 找回密码」适配层
 *
 * 替代原 `functions/set-account-email/index.ts` 的三条通道：
 *   - 修改登录邮箱  → cloudAuth.updateUser({ email, password })
 *   - 找回密码·校验 → cloudAuth.updateUser({ password })（需先有验证码令牌）
 *   - 找回密码·发信 → 外部 SMTP 承载（WorkBuddy SDK 无 SMTP 面）
 *
 * 不再需要的环境变量：
 *   - SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY
 *   - RECOVERY_SMTP_HOST / PORT / USER / PASS / FROM（外部承载时仍需要）
 *
 * ⚠️ 外部承载（保留旧 functions/set-account-email 入口）：
 *   - 找回密码·发信通道 —— SMTP 投递在 WorkBuddy 没有等价面，
 *     需要 TCB / 阿里云函数 / Cloudflare Workers 承载，调用路径不变。
 *   - 找回密码·校验通道 —— 需要服务端的 service_role 改写 auth.users.password，
 *     WorkBuddy 的 `cloudAuth.updateUser` 已做最小桥接（见 cloud-adapter.ts），
 *     若桥接不够用仍走外部承载。
 *
 * 本文件是「适配层」，不是完整 Edge Function。
 * 业务侧 `src/api/auth.ts` 的 `updateEmail` / `resetPasswordWithCode` 在正式切换外部承载前，
 * 调用路径保持不变（仍打 `functions/set-account-email`），等外部承载部署完成后再切到本文件导出的面。
 */

import { cloudAuth, cloudSupabase } from '@/supabase/cloud-adapter';

export interface UpdateEmailResult {
  ok: boolean;
  email?: string;
  error?: string;
}

/**
 * 修改当前账号的登录邮箱（已登录态）。
 *
 * 流程：
 *   1. 校验邮箱格式
 *   2. cloudAuth.updateUser({ email }) 改 auth.users.email
 *   3. 双写 profiles.email（登录回落的唯一依据）
 *   4. 刷新本地会话
 */
export async function cloudUpdateEmail(newEmail: string): Promise<UpdateEmailResult> {
  const trimmed = newEmail.trim().toLowerCase();
  if (!trimmed) {
    return { ok: false, error: '请输入新的邮箱地址' };
  }
  if (trimmed.length > 254) {
    return { ok: false, error: '邮箱地址过长（最多 254 个字符）' };
  }
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!EMAIL_RE.test(trimmed)) {
    return { ok: false, error: '邮箱格式不正确，请检查是否形如 name@example.com' };
  }
  if (trimmed.endsWith('@meoo.local') || trimmed.endsWith('@wx.local')) {
    return { ok: false, error: '请填写你自己的真实邮箱，不要用系统内部地址' };
  }

  const { data, error } = await cloudAuth.updateUser({ email: trimmed });
  if (error) {
    return { ok: false, error: `修改邮箱失败: ${error.message}` };
  }
  const saved = (data?.user as { email?: string } | null)?.email || trimmed;

  // 双写 profiles.email：auth.users 侧已由云端改好，这里补一份给登录回落与展示
  try {
    const session = await cloudAuth.getSession();
    const uid = session.data.session?.user?.id;
    if (uid) {
      const { error: dbErr } = await cloudSupabase
        .from('profiles')
        .update({ email: saved })
        .eq('id', uid);
      if (dbErr) console.warn('[cloudAuth] 邮箱已改但同步 profiles.email 失败:', dbErr);
    }
  } catch (e) {
    console.warn('[cloudAuth] 同步 profiles.email 异常:', e);
  }

  return { ok: true, email: saved };
}

/**
 * 用数字验证码完成密码重置（已校验过码值的场景）。
 *
 * 流程：
 *   1. 前端拿到云端校验通过的 token（见 password-recovery.bridge.md 的外部承载说明）
 *   2. cloudAuth.updateUser({ password }) 改写密码
 *   3. 清掉一次性 token（防重放）
 */
export async function cloudResetPasswordWithCode(
  _token: string,
  newPassword: string,
  username: string,
): Promise<UpdateEmailResult> {
  if (!/^\d{4,10}$/.test(_token)) {
    return { ok: false, error: '验证码格式不正确，请输入邮件中的数字验证码' };
  }
  if (newPassword.length < 6) {
    return { ok: false, error: '新密码至少 6 位' };
  }
  if (newPassword.length > 72) {
    return { ok: false, error: '新密码过长（最多 72 个字符）' };
  }

  // 1) 用 username 反查 profiles.id（recovery_token_hash 存 public.profiles）
  const { data: profArr, error: profErr } = await cloudSupabase
    .from('profiles')
    .select('id, recovery_token_hash, recovery_sent_at')
    .eq('username', username)
    .limit(1);
  if (profErr) {
    return { ok: false, error: '暂时无法处理请求，请稍后再试' };
  }
  const profRow: { id: string; recovery_token_hash?: string; recovery_sent_at?: string } | null | undefined =
    Array.isArray(profArr) ? profArr[0] : profArr;
  if (!profRow?.id) {
    return { ok: false, error: '该账号不存在，请检查注册邮箱后重试' };
  }

  // 2) 比对 sha256(验证码) 与库中哈希
  const wantHash = await sha256Hex(_token);
  const stored = String(profRow.recovery_token_hash ?? '');
  let hit = false;
  let expired = false;
  if (stored) {
    hit = stored.toLowerCase() === wantHash;
    const sentAt = profRow.recovery_sent_at
      ? new Date(profRow.recovery_sent_at).getTime()
      : 0;
    if (hit && (!sentAt || Date.now() - sentAt > 10 * 60 * 1000)) {
      hit = false;
      expired = true;
    }
  }
  if (!hit) {
    return {
      ok: false,
      error: expired ? '验证码已过期，请重新获取' : '验证码不正确，请核对邮件后重试',
    };
  }

  // 3) 改写密码（cloudAuth.updateUser 已桥接到 resetPasswordForOld）
  const { data, error } = await cloudAuth.updateUser({ password: newPassword });
  if (error) {
    return { ok: false, error: `设置新密码失败: ${error.message || '未知错误'}` };
  }
  if (!data?.user) {
    return { ok: false, error: '设置新密码失败: 会话已失效，请重新登录' };
  }

  // 4) 清掉这枚一次性验证码，防重放
  try {
    await cloudSupabase
      .from('profiles')
      .update({ recovery_token_hash: null, recovery_sent_at: null })
      .eq('id', String(profRow.id));
  } catch (e) {
    console.warn('[cloudAuth] 重置后清 token 失败（不影响密码已生效）:', e);
  }

  return { ok: true, email: (data.user as { email?: string })?.email };
}

/** SHA-256 哈希（Web Crypto，浏览器/小程序均支持）。 */
async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 找回密码·发信通道 —— 外部承载标记。
 *
 * 本通道需要 SMTP 投递，WorkBuddy Cloud SDK 没有等价面。
 * 正式切换外部承载（TCB / 阿里云函数 / Cloudflare Workers）前，
 * `src/api/auth.ts` 的 `sendPasswordRecoveryCode` 仍走原 `functions/set-account-email`，
 * 调用侧在此显式标注「需外部承载」，避免本地测试期被误当可用能力。
 */
export const PASSWORD_RECOVERY_MAIL_EXTERNAL_REQUIRED = true;
