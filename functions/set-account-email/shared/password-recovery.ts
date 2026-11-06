/**
 * 「忘记密码 / 重置密码」共享实现
 *
 * 为什么放在 functions/shared/ 而不是单独一个 Edge Function：
 * 平台对云函数数量有额度限制，本应用线上已占用 3 个（net-diagnose / ai-chat /
 * set-account-email）。重置密码与「修改登录邮箱」同属账号凭据维护，天然同源，
 * 因此把这套逻辑作为模块挂到已有的 set-account-email 函数里，**不新增函数数量**。
 *
 * ⚠️ 目录约定：每个 Edge Function 都是**独立部署包**，不会复用项目根目录或其他函数目录的
 *    文件（跨目录相对引用会在部署前类型检查报 TS2307）。因此本模块必须放在
 *    `functions/set-account-email/shared/` 内、由同目录的 index.ts 以 `./shared/...` 引用。
 *
 * 双通道设计（由请求体形态区分，调用方无需登录态）：
 *   - send   ：{ email }                → 按真实邮箱定位账号、自签 6 位数字验证码、SMTP 投递
 *   - verify ：{ token, username, password } → 比对 sha256(验证码) 哈希，命中则改写密码并销毁验证码
 *
 * 为什么不能用前端 supabase.auth.verifyOtp：账密登录的 email 可能是 `{username}@meoo.local`
 * 占位邮箱，而 recovery 令牌按**真实邮箱**生成，两者对不上必然失败；所以必须由服务端直接
 * 比对哈希并用 service_role 改写密码（该 key 只在服务端，绝不下发前端）。
 *
 * ⚠️【本实例硬约束】PostgREST 网关只放行 public / storage / graphql_public，任何
 * `.schema('auth')` 读写都会返回 406 PGRST106（实测）。因此验证码一律**自签**并把
 * sha256 哈希存进 `public.profiles.recovery_token_hash`，全链路不碰 auth schema。
 *
 * 环境变量（外部 SMTP；平台内置发信通道实测不可用，必须配置才能真的收到邮件）：
 * - RECOVERY_SMTP_HOST / RECOVERY_SMTP_PORT(默认 587) / RECOVERY_SMTP_USER / RECOVERY_SMTP_PASS
 * - RECOVERY_MAIL_FROM（发件地址，缺省回落 RECOVERY_SMTP_USER）
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/** 平台内置邮件服务（Edge Functions 运行时同机回环，免认证） */
const BUILTIN_SMTP = { hostname: '127.0.0.1', port: 54324 };

const TOKEN_TTL_MS = 10 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,64}$/;

/**
 * 系统内部占位邮箱后缀：`{username}@meoo.local`（账密注册）、`{openid}@wx.local`（微信登录）。
 * 这类地址只用于 Supabase Auth 登录，绝不能作为重置密码入口——否则任何知道用户名规则的人
 * 都能对他人账号发起改密码流程。
 */
const PLACEHOLDER_SUFFIXES = ['@meoo.local', '@wx.local'];

function isPlaceholderSuffix(email: string): boolean {
  return PLACEHOLDER_SUFFIXES.some((suffix) => email.endsWith(suffix));
}

// 限频窗口（实例级内存，重启即清零；作为「随手连点」的闸门足够，不是风控方案）
const RATE_WINDOW_MS = 60_000;
const MAX_PER_IP = 5;
const MAX_PER_ACCOUNT = 2;
const MAX_VERIFY_PER_ACCOUNT = 8;

const ipHits = new Map<string, number[]>();
const accountHits = new Map<string, number[]>();
const verifyHits = new Map<string, number[]>();

/** 收件地址脱敏：a******@example.com，避免响应/日志完整暴露邮箱 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(local.length - 1, 3))}${email.slice(at)}`;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 滑动窗口限频：命中则记录并返回 true */
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

interface MailOptions {
  to: string;
  from: string;
  code: string;
}

const CRLF = '\r\n';

class SmtpError extends Error {}

function buildMime(opts: MailOptions): string {
  const minutes = Math.round(TOKEN_TTL_MS / 60000);
  const subject = '你的登录密码重置验证码';
  const boundary = `meoo-${crypto.randomUUID()}`;
  const plain = [
    '你正在重置查看网络的登录密码。',
    '',
    `本次验证码：${opts.code}，请在应用内的「重置密码」页面输入这 ${opts.code.length} 位数字，${minutes} 分钟内有效。`,
  ].join('\n');
  const html = [
    '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:15px;color:#1f2937;line-height:1.7">',
    '<p>你正在重置查看网络的登录密码。</p>',
    `<p>本次验证码：<b style="font-size:20px;letter-spacing:3px">${opts.code}</b>，请在应用内的「重置密码」页面输入这 ${opts.code.length} 位数字，<b>${minutes} 分钟内有效</b>。</p>`,
    '</div>',
  ].join('');
  return [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@meoo>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(b64(plain.replace(/\n/g, CRLF))),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(b64(html.replace(/\n/g, CRLF))),
    '',
    `--${boundary}--`,
    '',
  ].join(CRLF);
}

// ------------------------------------------------------------------
// 极简 SMTP 客户端
// Deno 新版标准库没有邮件模块，Edge Functions 也不便引入第三方运行时依赖，
// 因此直接用 Deno 自带的 TCP/TLS API 手写协议交互。
// 支持两种通道：465（隐式 TLS）、其余端口（明文握手后 STARTTLS 升级）。
//
// ⚠️ 类型约束（本实例运行时实测）：新版 Deno **没有** `Deno.Reader` 类型，
//    `Deno.Conn` **没有** `.reader` 属性（只有 read(p)/write()）；
//    `deno.land/std@0.220.1/tls/connect.ts` 拉不到（TS2307）。
//    因此只用内置 Deno.connect / Deno.connectTls，且各分支内以非 null 局部变量传递 conn，
//    避免 `conn: Deno.Conn | null` 触发 TS18047 / TS2345。
// ------------------------------------------------------------------

/** 读取一条（可能多行的）SMTP 回复；sink 收集协议原文供失败排查 */
async function readReply(conn: Deno.Conn, sink: string[]): Promise<string> {
  const buf = new Uint8Array(512);
  let text = '';
  while (true) {
    const n = await conn.read(buf);
    if (n === null) break;
    text += new TextDecoder().decode(buf.subarray(0, n));
    const lines = text.split(CRLF);
    // 多行回复形如 "250-xxx"，出现 "250 xxx"（第 4 字符为空格）即结束
    const penultimate = lines[lines.length - 2];
    if (penultimate !== undefined && /^\d{3} /.test(penultimate)) break;
  }
  for (const line of text.split(CRLF)) {
    if (line.trim()) sink.push(line);
  }
  if (!text.trim()) throw new SmtpError('邮件服务器未返回任何响应');
  return text.trim();
}

async function writeLine(conn: Deno.Conn, line: string): Promise<void> {
  await conn.write(new TextEncoder().encode(line + CRLF));
}

function expect(reply: string, codes: number[], step: string, sink: string[]): void {
  const code = Number(reply.slice(0, 3));
  if (!codes.includes(code)) {
    throw new SmtpError(`${step}失败（SMTP ${code || '?'}）：${reply.slice(0, 160) || sink.slice(-2).join(' | ')}`);
  }
}

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function wrapBase64(s: string): string {
  return s.match(/.{1,76}/g)?.join(CRLF) ?? s;
}

/** 已建立连接后的投递流程；带 user/pass 时先做 AUTH LOGIN（内置通道免认证） */
async function deliver(
  conn: Deno.Conn,
  opts: MailOptions & { user?: string; pass?: string },
  sink: string[],
): Promise<void> {
  expect(await readReply(conn, sink), [220], '连接邮件服务器', sink);
  await writeLine(conn, 'EHLO meoo.edge');
  expect(await readReply(conn, sink), [250], 'EHLO', sink);

  if (opts.user && opts.pass) {
    await writeLine(conn, 'AUTH LOGIN');
    expect(await readReply(conn, sink), [334], '开始身份验证', sink);
    await writeLine(conn, b64(opts.user));
    expect(await readReply(conn, sink), [334], '校验发信账号', sink);
    await writeLine(conn, b64(opts.pass));
    expect(await readReply(conn, sink), [235], '身份验证', sink);
  }

  await writeLine(conn, `MAIL FROM:<${opts.from}>`);
  expect(await readReply(conn, sink), [250], '指定发件人', sink);
  await writeLine(conn, `RCPT TO:<${opts.to}>`);
  expect(await readReply(conn, sink), [250, 251], '指定收件人', sink);
  await writeLine(conn, 'DATA');
  expect(await readReply(conn, sink), [354], '开始写信', sink);
  // 透传编码需转义以 . 开头的行，否则会被当作消息结束
  const body = buildMime(opts)
    .split(CRLF)
    .map((l) => (l.startsWith('.') ? '..' + l : l))
    .join(CRLF);
  await conn.write(new TextEncoder().encode(body + CRLF + '.' + CRLF));
  expect(await readReply(conn, sink), [250], '投递邮件', sink);
  await writeLine(conn, 'QUIT');
  try {
    await readReply(conn, sink);
  } catch {
    /* 服务器可能直接断开，不影响投递结果 */
  }
}

/** 通道 1：平台内置 SMTP（同机回环，明文、免认证） */
async function sendViaBuiltin(opts: MailOptions): Promise<void> {
  const sink: string[] = [];
  const conn = await Deno.connect(BUILTIN_SMTP);
  try {
    await deliver(conn, opts, sink);
  } catch (err) {
    console.error(`[recovery] builtin smtp failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`[recovery] builtin transcript: ${sanitizeTranscript(sink)}`);
    throw err;
  } finally {
    try {
      conn.close();
    } catch {
      /* 忽略关闭异常 */
    }
  }
}

/** 通道 2：外部 SMTP（465 隐式 TLS / 其它端口 STARTTLS 升级） */
async function sendViaExternal(
  opts: MailOptions & { host: string; port: number; user: string; pass: string },
): Promise<void> {
  const sink: string[] = [];
  try {
    if (opts.port === 465) {
      const conn = await Deno.connectTls({ hostname: opts.host, port: opts.port });
      try {
        await deliver(conn, opts, sink);
      } finally {
        try {
          conn.close();
        } catch {
          /* 忽略 */
        }
      }
      return;
    }

    // STARTTLS：明文握手升级到 TLS，再重新建 TLS 连接走完整流程
    const plain = await Deno.connect({ hostname: opts.host, port: opts.port });
    try {
      expect(await readReply(plain, sink), [220], '连接邮件服务器', sink);
      await writeLine(plain, 'EHLO meoo.edge');
      expect(await readReply(plain, sink), [250], 'EHLO', sink);
      await writeLine(plain, 'STARTTLS');
      expect(await readReply(plain, sink), [220], 'STARTTLS', sink);
    } finally {
      try {
        plain.close();
      } catch {
        /* 忽略 */
      }
    }
    const secure = await Deno.connectTls({ hostname: opts.host, port: opts.port });
    try {
      await deliver(secure, opts, sink);
    } finally {
      try {
        secure.close();
      } catch {
        /* 忽略 */
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[recovery] external smtp failed: ${msg}`);
    console.error(`[recovery] external transcript: ${sanitizeTranscript(sink)}`);
    throw err;
  }
}

/** 协议日志脱敏：AUTH 阶段的 base64 凭据一律抹掉，且只在失败时输出 */
function sanitizeTranscript(sink: string[]): string {
  return sink
    .slice(-8)
    .join(' | ')
    .replace(/[A-Za-z0-9+/=]{10,}/g, '***')
    .slice(0, 400);
}

/**
 * 按「注册邮箱」定位账号。
 *
 * 为什么以邮箱而不是用户名为入口：本应用除账密注册（占位地址 `{username}@meoo.local`）外，
 * 还有微信登录账号（占位地址 `{openid}@wx.local`），后者无法从用户名反推。用户在登录页
 * 「忘记密码」里填的正是自己绑定的真实邮箱，因此直接按 email 定位账号。
 *
 * ⚠️【本实例硬约束】PostgREST 网关**只放行 public / storage / graphql_public**，
 * 任何 `.schema('auth')` 读取都会返回 HTTP 406 + PGRST106（实测两次，anon 与 service_role
 * 都一样被拒）。因此这里**绝不查 auth.users**，改为用 `public.profiles.email` 定位账号——
 * 该列由「修改登录邮箱」功能双写维护，是真实邮箱的可靠副本。
 *
 * 同理，verify 通道也**不去读 auth.one_time_tokens / auth.users.recovery_token**，
 * 而是自己签发一枚随机验证码、把 sha256 哈希存在 public.profiles 上自行比对。
 *
 * client 必须写成**函数体内的局部变量**（`const x = createClient(...)`）：
 * - 把 client 作为参数跨函数传递 → Deno 对 SupabaseClient 深层泛型做结构比对，TS2589
 * - 包一层返回 client 的工厂函数 → Schema 被推成 never，`.schema(...)` 报 TS2345
 */
async function findAccountByEmail(
  email: string,
  requestId: string,
): Promise<{ uid: string; email: string; username: string } | null> {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: row, error: rowErr } = await admin
    .from('profiles')
    .select('id, username, email')
    .eq('email', email)
    .maybeSingle();
  if (rowErr) {
    console.error(`[recovery] profiles read failed ${requestId}: ${String(rowErr.message)}`);
    throw new Error('暂时无法处理请求，请稍后再试');
  }
  // 占位后缀理论上不会写入 profiles.email，这里再挡一道，避免历史脏数据成为重置入口
  if (!row?.id || isPlaceholderSuffix(email)) return null;

  return {
    uid: String(row.id),
    email,
    username: String(row.username ?? '').trim(),
  };
}

export interface RecoveryResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * 忘记密码主入口：由 set-account-email 在检测到请求体含 email/token 时调用。
 * 返回待输出的 status + body，由调用方统一包成 Response（沿用同一份 CORS 头）。
 */
export async function handlePasswordRecovery(
  req: Request,
  requestId: string,
): Promise<RecoveryResult> {
  // 统一成功响应：不区分「邮箱没有对应账号」「已发送」，避免枚举账号
  const genericOk = (): RecoveryResult => ({
    status: 200,
    body: {
      ok: true,
      sent: true,
      hint: '如果该邮箱已绑定账号，重置验证码邮件已经发出，请查收（含垃圾邮件箱）',
    },
  });

  const body = (await req.json().catch(() => ({}))) as {
    email?: unknown;
    username?: unknown;
    token?: unknown;
    password?: unknown;
  };
  const inputEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const inputUsername = typeof body.username === 'string' ? body.username.trim() : '';
  const inputToken = typeof body.token === 'string' ? body.token.trim() : '';
  const newPassword = typeof body.password === 'string' ? body.password : '';
  const ip = (req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown')
    .split(',')[0]
    .trim();

  // 带 token 即为「校验验证码并改密码」，否则为「发送验证码」
  const isVerify = Boolean(inputToken);
  console.info(
    `[recovery] request ${requestId} action=${isVerify ? 'verify' : 'send'} hasEmail=${Boolean(inputEmail)} hasToken=${isVerify}`,
  );

  if (!allow(ipHits, ip, MAX_PER_IP)) {
    console.warn(`[recovery] ip rate limited ${requestId}`);
    return { status: 429, body: { error: '操作过于频繁，请稍后再试' } };
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ------------------------------------------------------------------
  // 通道 B：校验令牌并改写密码
  // 本通道**故意不做防枚举**：必须能区分「账号不存在」与「验证码错误」，
  // 否则用户输错验证码时会以为邮箱写错了，对着一个不存在的账号反复重试。
  // ------------------------------------------------------------------
  if (isVerify) {
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

    // 令牌只按 user_id 存储、不带邮箱信息，因此先用 username 反查出 uid，再比哈希。
    const { data: profRow, error: profErr } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('username', inputUsername)
      .maybeSingle();
    if (profErr) {
      console.error(`[recovery] profiles lookup failed ${requestId}: ${String(profErr.message)}`);
      return { status: 502, body: { error: '暂时无法处理请求，请稍后再试' } };
    }
    if (!profRow?.id) {
      return { status: 404, body: { error: '该账号不存在，请检查注册邮箱后重试' } };
    }
    const verifyUid = String(profRow.id);

    if (!allow(verifyHits, verifyUid, MAX_VERIFY_PER_ACCOUNT)) {
      console.warn(`[recovery] verify rate limited ${requestId} uid=${verifyUid.slice(0, 8)}`);
      return { status: 429, body: { error: '验证码尝试次数过多，请重新获取验证码' } };
    }

    // 令牌由本函数自行签发（见通道 A），哈希存在 public.profiles.recovery_token_hash。
    // ⚠️ 不能读 GoTrue 的 auth.one_time_tokens / auth.users.recovery_token：
    // 本实例 PostgREST 网关只放行 public/storage/graphql_public，auth schema 一律 406。
    const wantHash = await sha256Hex(inputToken);
    const { data: tokenRow, error: tokenErr } = await supabaseAdmin
      .from('profiles')
      .select('recovery_token_hash, recovery_sent_at')
      .eq('id', verifyUid)
      .maybeSingle();
    if (tokenErr) {
      console.error(`[recovery] token read failed ${requestId}: ${String(tokenErr.message)}`);
      return { status: 502, body: { error: '暂时无法处理请求，请稍后再试' } };
    }

    let hit = false;
    let expired = false;
    const stored = String(tokenRow?.recovery_token_hash ?? '');
    if (stored) {
      hit = stored.toLowerCase() === wantHash;
      const sentAt = tokenRow?.recovery_sent_at ? new Date(String(tokenRow.recovery_sent_at)).getTime() : 0;
      if (hit && (!sentAt || Date.now() - sentAt > TOKEN_TTL_MS)) {
        hit = false;
        expired = true;
      }
    }

    if (!hit) {
      console.warn(`[recovery] token mismatch ${requestId} expired=${expired}`);
      return {
        status: 400,
        body: { error: expired ? '验证码已过期，请重新获取' : '验证码不正确，请核对邮件后重试' },
      };
    }

    // 改写密码并确认邮箱状态，同时清掉这枚一次性令牌（防重放）
    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(verifyUid, {
      password: newPassword,
      email_confirm: true,
      user_metadata: { password_reset_at: new Date().toISOString() },
    });
    if (updateErr) {
      console.error(`[recovery] update password failed ${requestId}: ${String(updateErr.message)}`);
      return { status: 500, body: { error: `设置新密码失败: ${updateErr.message || '未知错误'}` } };
    }

    // 清掉这枚一次性验证码，防重放（自签令牌存 public.profiles，同样走 public schema）
    const { error: clearErr } = await supabaseAdmin
      .from('profiles')
      .update({ recovery_token_hash: null, recovery_sent_at: null })
      .eq('id', verifyUid);
    if (clearErr) {
      console.warn(`[recovery] clear token failed ${requestId}: ${String(clearErr.message)}`);
    }

    console.info(`[recovery] verified ${requestId} uid=${verifyUid.slice(0, 8)}`);
    return { status: 200, body: { ok: true, reset: true } };
  }

  // ------------------------------------------------------------------
  // 通道 A：发送重置验证码邮件
  // ------------------------------------------------------------------
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

  const account = await findAccountByEmail(inputEmail, requestId);
  if (!account) {
    // 邮箱没有对应账号也返回成功，防枚举
    console.info(`[recovery] no account for email ${requestId}, respond generically`);
    return genericOk();
  }
  if (!allow(accountHits, account.uid, MAX_PER_ACCOUNT)) {
    console.warn(`[recovery] account rate limited ${requestId}`);
    return { status: 429, body: { error: '该账号请求过于频繁，请一分钟后再试' } };
  }
  const uid = account.uid;
  const email = account.email;

  // 自签一枚 6 位数字验证码。
  // ⚠️ 不能用 GoTrue generateLink 的令牌：本实例 PostgREST 网关只放行 public/storage/
  // graphql_public，既读不到 auth.one_time_tokens / auth.users.recovery_token（406 PGRST106），
  // 也就无法在 verify 通道复核它。改为自己签发 + 把 sha256 哈希存进 public.profiles，
  // 整条链路全部走 public schema。
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  const tokenHash = await sha256Hex(code);
  const { error: saveErr } = await supabaseAdmin
    .from('profiles')
    .update({ recovery_token_hash: tokenHash, recovery_sent_at: new Date().toISOString() })
    .eq('id', uid);
  if (saveErr) {
    console.error(`[recovery] save token failed ${requestId}: ${String(saveErr.message)}`);
    return { status: 500, body: { error: '生成重置验证码失败，请稍后再试' } };
  }

  // 发信：先试平台内置 SMTP，失败再回落外部 SMTP（若已配置）
  const externalHost = Deno.env.get('RECOVERY_SMTP_HOST');
  const externalUser = Deno.env.get('RECOVERY_SMTP_USER');
  const externalPass = Deno.env.get('RECOVERY_SMTP_PASS');
  const externalFrom = Deno.env.get('RECOVERY_MAIL_FROM') || externalUser;
  const canUseExternal = Boolean(externalHost && externalUser && externalPass && externalFrom);

  let sentBy = '';
  try {
    await sendViaBuiltin({ to: email, from: externalFrom || email, code });
    sentBy = 'builtin';
  } catch (builtinErr) {
    const builtinMsg = builtinErr instanceof Error ? builtinErr.message : String(builtinErr);
    if (!canUseExternal) {
      console.error(`[recovery] builtin unavailable, no external config ${requestId}: ${builtinMsg}`);
      return {
        status: 503,
        body: {
          code: 'RESET_CONFIG_MISSING',
          error: '重置密码邮件发送通道尚未就绪，请联系应用管理员补齐发信配置',
        },
      };
    }
    console.warn(`[recovery] builtin failed, trying external ${requestId}: ${builtinMsg}`);
    const portRaw = Number(Deno.env.get('RECOVERY_SMTP_PORT') || 587);
    await sendViaExternal({
      to: email,
      from: externalFrom!,
      code,
      host: externalHost!,
      port: Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 587,
      user: externalUser!,
      pass: externalPass!,
    });
    sentBy = 'external';
  }

  console.info(`[recovery] success ${requestId} via=${sentBy} masked=${maskEmail(email)}`);
  // 把 username 一并带回：verify 步骤要靠它定位令牌归属（令牌只按 user_id 存储），
  // 用户无需再手输一遍账号名。username 本身不是秘密——登录页就用它做凭据之一。
  return {
    status: 200,
    body: {
      ok: true,
      sent: true,
      masked_email: maskEmail(email),
      expires_in_seconds: TOKEN_TTL_MS / 1000,
      username: account.username,
    },
  };
}
