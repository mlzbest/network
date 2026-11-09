import type { FastifyInstance } from 'fastify';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';
import { env } from '../env.js';
import { requireAuth, parseAuth } from '../auth/guard.js';
import { hashPassword } from '../auth/password.js';
import { signToken } from '../auth/jwt.js';
import { sendViaExternal } from './smtp.js';

/**
 * 原 Meoo Edge Functions 的自建后端等价实现。
 *
 * 挂在与旧网关相同的路径 `/functions/v1/<name>`：前端在 selfhost 模式下
 * `supabaseUrl = VITE_SELFHOST_API_BASE`，原有 `${supabaseUrl}/functions/v1/set-account-email`
 * 等调用 URL 一字不改即可命中本路由（net-diagnose / ai-chat 仍走 TCB/Workers 承载层）。
 *
 * 迁移的两个函数：
 * - set-account-email：改登录邮箱 + 找回密码（发验证码 / 校验改密）双通道
 * - wx-mp-login：微信小程序 code → openid → 自建账号 + JWT 会话
 */

const TOKEN_TTL_MS = 10 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,64}$/;
const PLACEHOLDER_SUFFIXES = ['@meoo.local', '@wx.local'];

function isPlaceholderSuffix(email: string): boolean {
  return PLACEHOLDER_SUFFIXES.some((s) => email.endsWith(s));
}

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(local.length - 1, 3))}${email.slice(at)}`;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// 限频（实例级内存，重启清零；与原 Edge Function 同口径）
const RATE_WINDOW_MS = 60_000;
const MAX_PER_IP = 5;
const MAX_PER_ACCOUNT = 2;
const MAX_VERIFY_PER_ACCOUNT = 8;
const ipHits = new Map<string, number[]>();
const accountHits = new Map<string, number[]>();
const verifyHits = new Map<string, number[]>();

function allow(bucket: Map<string, number[]>, key: string, max: number): boolean {
  const now = Date.now();
  const list = (bucket.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= max) {
    bucket.set(key, list);
    return false;
  }
  list.push(now);
  bucket.set(key, list);
  return true;
}

interface ProfileRow {
  id: string;
  username: string | null;
  email: string | null;
  recovery_token_hash: string | null;
  recovery_sent_at: string | null;
}

// ─── 找回密码：发送验证码 ─────────────────────────────────────────────────────
async function recoverySend(
  inputEmail: string,
  ip: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const genericOk = () => ({
    status: 200,
    body: {
      ok: true,
      sent: true,
      hint: '如果该邮箱已绑定账号，重置验证码邮件已经发出，请查收（含垃圾邮件箱）',
    },
  });

  if (!inputEmail || !EMAIL_RE.test(inputEmail)) {
    return { status: 400, body: { error: '请输入正确的注册邮箱' } };
  }
  if (isPlaceholderSuffix(inputEmail)) {
    return {
      status: 400,
      body: {
        code: 'NO_REAL_EMAIL',
        error: '这个地址是系统内部占位邮箱，不是你的真实邮箱。请填写你注册时绑定的自己的邮箱',
      },
    };
  }
  if (!allow(ipHits, ip, MAX_PER_IP)) {
    return { status: 429, body: { error: '操作过于频繁，请稍后再试' } };
  }

  const { rows } = await query<ProfileRow>(
    'SELECT id, username, email, recovery_token_hash, recovery_sent_at FROM profiles WHERE email = $1 LIMIT 1',
    [inputEmail],
  );
  const account = rows[0];
  if (!account) {
    return genericOk(); // 防枚举：不存在也报成功
  }
  if (!allow(accountHits, account.id, MAX_PER_ACCOUNT)) {
    return { status: 429, body: { error: '该账号请求过于频繁，请一分钟后再试' } };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const tokenHash = sha256Hex(code);
  await query(
    'UPDATE profiles SET recovery_token_hash = $1, recovery_sent_at = now() WHERE id = $2',
    [tokenHash, account.id],
  );

  // 发信：自建后端只有外部 SMTP 通道（无平台内置回环邮件服务）
  const host = env.RECOVERY_SMTP_HOST;
  const user = env.RECOVERY_SMTP_USER;
  const pass = env.RECOVERY_SMTP_PASS;
  const from = env.RECOVERY_MAIL_FROM || user;
  if (!host || !user || !pass || !from) {
    return {
      status: 503,
      body: {
        code: 'RESET_CONFIG_MISSING',
        error: '重置密码邮件发送通道尚未就绪，请联系应用管理员补齐发信配置',
      },
    };
  }

  try {
    await sendViaExternal(
      { to: inputEmail, from, code, ttlMinutes: Math.round(TOKEN_TTL_MS / 60000) },
      {
        host,
        port: env.RECOVERY_SMTP_PORT ?? 587,
        user,
        pass,
        from,
      },
    );
  } catch (err: any) {
    console.error('[recovery] external smtp failed:', err?.message ?? String(err));
    return { status: 502, body: { error: '邮件发送失败，请稍后重试或联系管理员' } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      sent: true,
      masked_email: maskEmail(inputEmail),
      expires_in_seconds: TOKEN_TTL_MS / 1000,
      username: String(account.username ?? '').trim(),
    },
  };
}

// ─── 找回密码：校验验证码并改密 ──────────────────────────────────────────────
async function recoveryVerify(
  inputToken: string,
  inputUsername: string,
  newPassword: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!/^\d{4,10}$/.test(inputToken)) {
    return { status: 400, body: { error: '验证码格式不正确，请输入邮件中的数字验证码' } };
  }
  if (newPassword.length < 6) {
    return { status: 400, body: { error: '新密码至少 6 位' } };
  }
  if (newPassword.length > 72) {
    return { status: 400, body: { error: '新密码过长（最多 72 个字符）' } };
  }
  if (!inputUsername || !USERNAME_RE.test(inputUsername)) {
    return { status: 400, body: { error: '会话信息已失效，请重新获取验证码' } };
  }

  const { rows } = await query<ProfileRow>(
    'SELECT id, username, email, recovery_token_hash, recovery_sent_at FROM profiles WHERE username = $1 LIMIT 1',
    [inputUsername],
  );
  const prof = rows[0];
  if (!prof) {
    return { status: 404, body: { error: '该账号不存在，请检查注册邮箱后重试' } };
  }
  if (!allow(verifyHits, prof.id, MAX_VERIFY_PER_ACCOUNT)) {
    return { status: 429, body: { error: '验证码尝试次数过多，请重新获取验证码' } };
  }

  const wantHash = sha256Hex(inputToken);
  let hit = false;
  let expired = false;
  if (prof.recovery_token_hash) {
    hit = prof.recovery_token_hash.toLowerCase() === wantHash;
    const sentAt = prof.recovery_sent_at ? new Date(prof.recovery_sent_at).getTime() : 0;
    if (hit && (!sentAt || Date.now() - sentAt > TOKEN_TTL_MS)) {
      hit = false;
      expired = true;
    }
  }
  if (!hit) {
    return {
      status: 400,
      body: {
        error: expired ? '验证码已过期，请重新获取' : '验证码不正确，请核对邮件后重试',
      },
    };
  }

  const hash = await hashPassword(newPassword);
  await query(
    'UPDATE profiles SET password_hash = $1, recovery_token_hash = NULL, recovery_sent_at = NULL WHERE id = $2',
    [hash, prof.id],
  );
  return { status: 200, body: { ok: true, reset: true } };
}

// ─── 修改登录邮箱（Bearer）────────────────────────────────────────────────────
async function updateEmail(
  uid: string,
  newEmail: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!newEmail) return { status: 400, body: { error: '请输入新的邮箱地址' } };
  if (newEmail.length > 254) return { status: 400, body: { error: '邮箱地址过长（最多 254 个字符）' } };
  if (!EMAIL_RE.test(newEmail)) {
    return { status: 400, body: { error: '邮箱格式不正确，请检查是否形如 name@example.com' } };
  }
  if (isPlaceholderSuffix(newEmail)) {
    return { status: 400, body: { error: '请填写你自己的真实邮箱，不要用系统内部地址' } };
  }

  const { rows } = await query('SELECT email FROM profiles WHERE id = $1', [uid]);
  const current = (rows[0]?.email || '').trim().toLowerCase();
  if (newEmail === current) {
    return { status: 400, body: { error: '新邮箱与当前邮箱相同，无需修改' } };
  }

  const taken = await query('SELECT id FROM profiles WHERE email = $1 AND id <> $2', [newEmail, uid]);
  if (taken.rowCount && taken.rowCount > 0) {
    return { status: 409, body: { error: '该邮箱已被其他账号使用，请换一个邮箱' } };
  }

  await query('UPDATE profiles SET email = $1 WHERE id = $2', [newEmail, uid]);
  return { status: 200, body: { ok: true, email: newEmail, placeholder_email: null } };
}

// ─── 路由挂载 ────────────────────────────────────────────────────────────────
export async function edgeRouter(app: FastifyInstance) {
  // 等价原 set-account-email Edge Function（路径与响应形状兼容）
  app.post('/functions/v1/set-account-email', async (req, reply) => {
    const requestId = randomUUID().slice(0, 8);
    try {
      const body = (req.body ?? {}) as {
        email?: unknown;
        username?: unknown;
        token?: unknown;
        password?: unknown;
      };
      const inputEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const inputUsername = typeof body.username === 'string' ? body.username.trim() : '';
      const inputToken = typeof body.token === 'string' ? body.token.trim() : '';
      const newPassword = typeof body.password === 'string' ? body.password : '';

      const bearer = parseAuth(req);
      const isRecoveryVerify = inputToken !== '';
      const isRecoverySend = inputEmail !== '' && !bearer;

      if (isRecoveryVerify) {
        const result = await recoveryVerify(inputToken, inputUsername, newPassword);
        return reply.code(result.status).send(result.body);
      }
      if (isRecoverySend) {
        const ip = String(req.headers['x-forwarded-for'] || req.ip || 'unknown')
          .split(',')[0]
          .trim();
        const result = await recoverySend(inputEmail, ip);
        return reply.code(result.status).send(result.body);
      }

      const user = await requireAuth(req, reply);
      if (!user) return;
      const result = await updateEmail(user.uid, inputEmail);
      console.info(
        `[set-account-email] ${requestId} uid=${user.uid.slice(0, 8)} status=${result.status}`,
      );
      return reply.code(result.status).send(result.body);
    } catch (error: any) {
      console.error(`[set-account-email] failed ${requestId}:`, error?.message ?? String(error));
      return reply.code(500).send({ error: `修改邮箱失败: ${error?.message || '未知错误'}` });
    }
  });

  // 等价原 wx-mp-login Edge Function（selfhost：直接签发 JWT，无需 verifyOtp）
  app.post('/functions/v1/wx-mp-login', async (req, reply) => {
    const requestId = randomUUID().slice(0, 8);
    try {
      const appid = env.WX_APP_ID;
      const secret = env.WX_APP_SECRET;
      if (!appid || !secret) {
        return reply.code(503).send({
          code: 'WX_CONFIG_MISSING',
          error: '微信登录尚未配置：请在后端 .env 配置 WX_APP_ID 和 WX_APP_SECRET',
        });
      }

      const { code } = (req.body ?? {}) as { code?: string };
      if (!code || typeof code !== 'string') {
        return reply.code(400).send({ error: '缺少 wx.login 返回的 code 参数' });
      }

      // 1) code → openid（jscode2session）
      const wxUrl =
        `https://api.weixin.qq.com/sns/jscode2session` +
        `?appid=${encodeURIComponent(appid)}` +
        `&secret=${encodeURIComponent(secret)}` +
        `&js_code=${encodeURIComponent(code)}` +
        `&grant_type=authorization_code`;
      const wxRes = await fetch(wxUrl);
      const wxData = (await wxRes.json()) as {
        openid?: string;
        unionid?: string;
        errcode?: number;
        errmsg?: string;
      };
      if (wxData.errcode || !wxData.openid) {
        console.warn(
          `[wx-mp-login] wechat failed ${requestId} errcode=${wxData.errcode ?? 'missing_openid'} errmsg=${String(wxData.errmsg ?? '').slice(0, 120)}`,
        );
        return reply.code(400).send({
          error: `微信登录失败: ${wxData.errmsg || 'unknown'}`,
          errcode: wxData.errcode,
        });
      }
      const { openid, unionid } = wxData;

      // 2) 按 openid 找账号；没有则建（email 用 {openid}@wx.local 占位，与原体系一致）
      const { rows } = await query<ProfileRow>(
        'SELECT id, username, email, recovery_token_hash, recovery_sent_at FROM profiles WHERE openid = $1 LIMIT 1',
        [openid],
      );
      let profile = rows[0];
      if (!profile) {
        const id = randomUUID();
        const email = `${openid}@wx.local`;
        const username = `wx_${openid.slice(0, 10)}`;
        await query(
          'INSERT INTO profiles (id, username, email, openid, unionid, created_at) VALUES ($1, $2, $3, $4, $5, now())',
          [id, username, email, openid, unionid ?? null],
        );
        profile = {
          id,
          username,
          email,
          recovery_token_hash: null,
          recovery_sent_at: null,
        };
      } else if (unionid && !profile.email?.includes('@wx.local')) {
        // 已有账号补充 unionid（非必须）
        await query('UPDATE profiles SET unionid = $1 WHERE id = $2', [unionid, profile.id]).catch(() => {});
      }

      // 3) 直接签发会话（自建后端无 magiclink/verifyOtp 环节）
      const token = signToken(profile.id, profile.username ?? profile.email ?? profile.id);
      console.info(
        `[wx-mp-login] success ${requestId} uid=${profile.id.slice(0, 8)} created=${!rows[0]} durationMs=ok`,
      );
      return reply.send({
        session: {
          access_token: token,
          token_type: 'bearer',
          user: { id: profile.id, email: profile.email, username: profile.username },
        },
        user_id: profile.id,
        openid,
        unionid: unionid ?? null,
      });
    } catch (error: any) {
      console.error(`[wx-mp-login] failed ${requestId}:`, error?.message ?? String(error));
      return reply.code(500).send({ error: error?.message || 'Unknown error' });
    }
  });
}
