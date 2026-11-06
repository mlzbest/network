/**
 * 修改账号登录邮箱 Edge Function
 *
 * 背景：本项目注册时用 `{username}@meoo.local`（微信登录为 `{openid}@wx.local`）
 * 占位邮箱兼容 Supabase 邮箱认证。用户从未填过真实邮箱，一旦需要「重置密码」
 * 就无处接收邮件。本函数让已登录用户把自己的 auth.users.email 换成真实邮箱。
 *
 * 关键约束：Supabase 的 email 是唯一登录标识，直接改掉会导致原来的
 * 「用户名 + 密码」登录通道失效（前端拼的是 `{username}@meoo.local`）。
 * 因此这里在改 email 的同时，把原占位邮箱写入
 * `raw_user_meta_data.placeholder_email`，前端 signInWithUsername 会先按
 * 用户名占位尝试、失败再按 placeholder_email 回落，保证两条通道都可用。
 *
 * 为什么必须走 Edge Function：改他人/自己以外的 auth.users 记录需要
 * service_role key，绝不能下发到小程序前端。
 *
 * ── 本函数同时承载「忘记密码 / 重置密码」──
 * 平台对云函数数量有额度限制，而重置密码与修改邮箱同属账号凭据维护，天然同源，
 * 因此把找回逻辑作为共享模块挂进本函数，**不新增函数数量**。实现见
 * `functions/shared/password-recovery.ts`（shared/ 不是部署入口，仅被相对引用）。
 *
 * 路由判据（按请求体形态区分，互不冲突）：
 *   - 含 token            → 重置密码·校验通道（无登录态）
 *   - 含 email 且无 Authorization → 重置密码·发信通道（无登录态）
 *   - 其余                → 原有的「修改登录邮箱」（必须有登录态）
 * ⚠️ 为什么不能只看 email：原通道与发信通道都以 email 为入参。区别在于原通道是
 *    **已登录**用户改自己的邮箱、必须带 Bearer token；发信通道是**登不进去**的用户
 *    找回密码、必然没有 token。用 Authorization 的有无来分流正好贴合两种身份前提。
 *
 * 鉴权：修改邮箱通道必须携带当前用户的有效 access_token，函数用该 token 调 getUser()
 * 拿到真实 uid，只允许改自己的账号，不接受前端传入 user_id —— 避免越权改他人邮箱。
 * 找回通道靠「真实邮箱 + 一次性数字令牌 + 限频」自证，无需登录态。
 *
 * 部署：meoo-cli cloud deploy-function -n set-account-email -j false
 *      （⚠️ 必须关闭 JWT 校验：忘记密码的用户本来就没有 token。
 *        修改邮箱通道的登录态由函数内部自行校验 Bearer token，不依赖网关。）
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handlePasswordRecovery } from './shared/password-recovery.ts';

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// 宽松但够用的邮箱校验：本地部分 + @ + 至少一个点的域名。
// 不做 DNS/MX 校验——那会让改邮箱变成慢操作且依赖外部服务。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

Deno.serve(async (req) => {
  const functionName = 'set-account-email';
  const requestId = crypto.randomUUID().slice(0, 8);
  const startTime = Date.now();

  if (req.method === 'OPTIONS') {
    console.info(`[${functionName}] CORS preflight ${requestId}`);
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');

    // ── 路由分发：忘记密码通道（无登录态）──────────────────────────
    // 判据必须同时看请求体与 Authorization，因为「修改邮箱」与「发送重置验证码」
    // 都以 email 为入参，唯一可靠区别是：改邮箱的人已登录、找回密码的人登不进去。
    if (req.method === 'POST') {
      const probe = await req.clone().json().catch(() => ({}));
      const isRecoveryVerify = typeof (probe as { token?: unknown }).token === 'string'
        && String((probe as { token?: unknown }).token).trim() !== '';
      const isRecoverySend = typeof (probe as { email?: unknown }).email === 'string' && !token;
      if (isRecoveryVerify || isRecoverySend) {
        const result = await handlePasswordRecovery(req, requestId);
        console.info(
          `[${functionName}] recovery routed ${requestId} status=${result.status} durationMs=${Date.now() - startTime}`,
        );
        return json(result.body, result.status);
      }
    }

    if (!token) {
      console.warn(`[${functionName}] missing token ${requestId}`);
      return json({ error: '未登录，请先登录后再修改邮箱' }, 401);
    }

    // 用前端带来的用户 token 换真实身份：这是唯一可信的 uid 来源
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      console.warn(`[${functionName}] invalid token ${requestId}: ${String(userErr?.message ?? 'no user')}`);
      return json({ error: '登录态已失效，请重新登录后再试' }, 401);
    }

    const uid = userData.user.id;
    const currentEmail = (userData.user.email || '').trim();

    const body = (await req.json().catch(() => ({}))) as { email?: unknown };
    const rawInput = typeof body.email === 'string' ? body.email.trim() : '';
    const newEmail = rawInput.toLowerCase();

    console.info(`[${functionName}] request ${requestId} uid=${uid.slice(0, 8)} hasNewEmail=${Boolean(newEmail)}`);

    if (!newEmail) {
      return json({ error: '请输入新的邮箱地址' }, 400);
    }
    if (newEmail.length > 254) {
      return json({ error: '邮箱地址过长（最多 254 个字符）' }, 400);
    }
    if (!EMAIL_RE.test(newEmail)) {
      return json({ error: '邮箱格式不正确，请检查是否形如 name@example.com' }, 400);
    }
    // 占位邮箱后缀不允许被手动填成真实邮箱（改了也收不到信）
    if (newEmail.endsWith('@meoo.local') || newEmail.endsWith('@wx.local')) {
      return json({ error: '请填写你自己的真实邮箱，不要用系统内部地址' }, 400);
    }
    if (newEmail === currentEmail.toLowerCase()) {
      return json({ error: '新邮箱与当前邮箱相同，无需修改' }, 400);
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 记下原占位邮箱：只有原本确实是系统占位才需要保留，
    // 若用户已是真实邮箱（第二次改），继续沿用已有的 placeholder_email。
    const meta = (userData.user.user_metadata ?? {}) as Record<string, unknown>;
    const existingPlaceholder = typeof meta.placeholder_email === 'string' ? meta.placeholder_email : '';
    const isCurrentPlaceholder = currentEmail.endsWith('@meoo.local') || currentEmail.endsWith('@wx.local');
    let placeholderEmail = existingPlaceholder || (isCurrentPlaceholder ? currentEmail : '');

    // 兜底补齐：历史版本注册时未单独存占位邮箱，只能按 profiles.username / meta.username
    // 反推 `{username}@meoo.local`。缺了它，改完邮箱后「用户名 + 密码」通道会彻底登不进去。
    if (!placeholderEmail && !isCurrentPlaceholder) {
      const metaUsername = typeof meta.username === 'string' ? meta.username.trim() : '';
      if (metaUsername) {
        placeholderEmail = `${metaUsername}@meoo.local`;
        console.info(`[${functionName}] recovered placeholder ${requestId} from meta.username`);
      } else {
        const { data: profRow } = await supabaseAdmin
          .from('profiles')
          .select('username')
          .eq('id', uid)
          .maybeSingle();
        if (profRow?.username) {
          placeholderEmail = `${String(profRow.username).trim()}@meoo.local`;
          console.info(`[${functionName}] recovered placeholder ${requestId} from profiles.username`);
        }
      }
    }

    const newMetadata: Record<string, unknown> = {
      ...meta,
      email_updated_at: new Date().toISOString(),
    };
    // 仅在确实拿到占位邮箱时写入；写 undefined 会被序列化成 null，反而覆盖掉已有值
    if (placeholderEmail) newMetadata.placeholder_email = placeholderEmail;

    const { data: updated, error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(uid, {
      email: newEmail,
      email_confirm: true, // 直接确认：应用内改邮箱不引入邮件验证基础设施
      user_metadata: newMetadata,
    });

    if (updateErr) {
      const msg = String(updateErr.message ?? '');
      const low = msg.toLowerCase();
      // Supabase 对已被其他账号占用的邮箱返回 unique_violation / already exists
      if (low.includes('already') || low.includes('unique') || low.includes('exists')) {
        console.warn(`[${functionName}] email taken ${requestId}: ${msg.slice(0, 160)}`);
        return json({ error: '该邮箱已被其他账号使用，请换一个邮箱' }, 409);
      }
      console.error(`[${functionName}] admin update failed ${requestId}: ${msg.slice(0, 200)}`);
      return json({ error: `修改邮箱失败: ${msg || '未知错误'}` }, 500);
    }

    console.info(
      `[${functionName}] success ${requestId} uid=${uid.slice(0, 8)} keptPlaceholder=${Boolean(placeholderEmail)} durationMs=${Date.now() - startTime}`,
    );

    return json({
      ok: true,
      email: updated?.user?.email ?? newEmail,
      placeholder_email: placeholderEmail || null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${functionName}] failed ${requestId}: ${message}`);
    return json({ error: `修改邮箱失败: ${message}` }, 500);
  }
});
