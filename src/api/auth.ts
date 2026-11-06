import type { User } from '@supabase/supabase-js';
import Taro from '@tarojs/taro';
import { isCloudAuth, projectUrlId, resolveCloudFnUrl, supabase, supabaseAnonKey, supabaseUrl } from '@/supabase/client';
import { wxMpLogin } from '@/supabase/wx-mp-login';
import { recordLastLogin, recordLogout, reportPresenceState } from '@/api/profiles';
import { clearSecretEntry, markChatExit } from '@/lib/secret-entry';
import { logDbg } from '../lib/logger';

/** 登出时「最后一个已知 uid」的模块级镜像：由 subscribeAuthState 在每次拿到真实
 * user 时写入。SIGNED_OUT 事件里 session 通常已为 null，而 auth-store 会在 onChange(null)
 * 后清掉本地缓存，故不能依赖 store——用这个 api 层内部变量兜底，避免 import store 造成循环依赖。 */
let lastKnownUid = '';

/**
 * 「同一次登录只计一次」的进程内去重标记（记录已消费过暗号额度的 uid）。
 *
 * 为什么必须有它：冷启动恢复会话时 `getSession()` 与 `onAuthStateChange(INITIAL_SESSION)`
 * 会几乎同时各回调一次有效 user；若用户在 ping 页输暗号前 auth 尚未就绪，两路都会走到
 * recordLastLogin，第一路消费掉暗号额度、第二路因额度已被焚而不计数——但反过来（先到的
 * 是 INITIAL_SESSION、暗号点后到）就可能把同一笔进入算成两次。用这个 Set 做 uid 级一次性
 * 闸门：**本进程内只有第一个到达的真实登录态有资格消费暗号额度**，后续事件一律不计数。
 * 真正的「下次再算一次」必须来自下一次暗号进入（重新打点），符合用户语义。
 *
 * ⚠️ 但闸门**不能挡住「暗号进入」本身**：用户从 ping 页输暗号进入聊天区时，auth 往往
 *    早已就绪（冷启动时 getSession 先跑完、uid 已进 Set），此时若直接 return，这次暗号
 *    进入就永远不会被计数——表现为「我明明进了聊天区，上线次数一直是 0」（实测：对方
 *    69 条 login_events，自己 0 条）。所以命中闸门时仍要调一次 recordLastLogin，由它
 *    内部的 `takeSecretEntry()` 判断「本次是否真有暗号额度」：有额度就补记一条事件，
 *    没额度（纯 token 刷新/切后台）才真正跳过。
 *
 * ⚠️ 与 `api/profiles.ts` 的 `coldStartCountedUids` 是**两个不同维度**的闸门，不能合并：
 *    - 本闸门：防「同一次登录被 getSession + INITIAL_SESSION 双回调算两次」
 *    - `coldStartCountedUids`：防「同一进程内 token 刷新/切后台被算成多次上线」
 *    前者在 SIGNED_OUT 时清空，后者只在进程重启时自然清空。
 */
const countedUids = new Set<string>();

/**
 * 真实登录态到达的统一入口（getSession 与 onAuthStateChange 共用）。
 * @param label 日志标识，便于区分是哪一路触发的
 */
function handleRealUser(u: User, label: string): void {
  lastKnownUid = u.id; // 镜像最后一个真实 uid，供随后 SIGNED_OUT 取用
  // ⚠️ 必须**同步占位**再发起请求：冷启动 getSession 与 INITIAL_SESSION 是两路几乎同时
  // 触发的回调，若等 promise 回来再 add（旧写法），两路都会读到 has()=false，
  // 同一次暗号进入就会被插两条 login_events（实测已出现同一秒成对记录、计数虚高）。
  if (countedUids.has(u.id)) {
    // 已计过：仍交给 recordLastLogin 判定「本次是否带暗号额度」。
    // 带额度 → 补记一条（用户又暗号进了一次）；不带 → 内部直接跳过，不会重复计数。
    logDbg(`[api/auth] 🔁 ${label} → 本进程已计过该账号，仍交 recordLastLogin 判定暗号额度`);
    void recordLastLogin(u.id, true);
    return;
  }
  countedUids.add(u.id);
  // 关键证据日志：本进程内该账号第一次到达真实登录态 → 由 recordLastLogin 的
  // coldStartCountedUids 闸门判定是否计入「上线次数」（打开小程序即算一次）。
  logDbg(`[api/auth] 🔁 ${label} → 本进程首次到达真实登录态，交 recordLastLogin 判定冷启动/暗号计数`);
  void recordLastLogin(u.id, true);
}

/** 系统占位邮箱后缀：注册时由用户名/微信 openid 派生，不是用户真实邮箱，禁止展示给用户 */
const PLACEHOLDER_SUFFIXES = ['@meoo.local', '@wx.local'];

function isPlaceholderEmail(email: string): boolean {
  return PLACEHOLDER_SUFFIXES.some((s) => email.endsWith(s));
}

/**
 * 「忘记密码」流程本次会话对应的账号名。
 *
 * 为什么必须带着它：recovery 令牌在库里只按 user_id 存储、不含邮箱信息，服务端校验时必须
 * 先确定「这枚验证码属于谁」。而 verify 请求发生在用户尚未登录的状态下，拿不到 session，
 * 只能靠发送验证码时服务端返回的 username 做凭据。用模块级变量而非组件 state：重置成功后
 * 弹层即关闭，届时组件状态已不可用；同一时刻只有一个重置流程，不存在并发串号。
 */
let pendingRecoveryUsername = '';

export function setRecoveryUsername(username: string): void {
  pendingRecoveryUsername = username.trim();
}

export function getRecoveryUsername(): string {
  return pendingRecoveryUsername;
}

/** store 内部走 onAuthStateChange 不需要这个；业务侧主动取用 */
export async function getCurrentUser(): Promise<User | null> {
  const { data } = await supabase.auth.getSession();
  return (data.session?.user as User | null | undefined) ?? null;
}

export async function signInWithWeapp(): Promise<void> {
  await wxMpLogin();
}

async function trySignIn(email: string, password: string): Promise<{ data: any; error: any }> {
  const result = await supabase.auth.signInWithPassword({ email, password });
  // 两种后端的返回形状不同：
  //  - legacy（SupabaseClient）：{ data: { session: { access_token }, user } }
  //  - cloud（WorkBuddy SDK 桥接）：{ data: { accessToken, user } }
  // 统一收敛成 `{ data: { session }, error }`，避免上层分别判断。
  const raw: any = result.data;
  const user = raw?.user ?? raw?.session?.user ?? null;
  const data: any = user
    ? {
        session: {
          access_token: raw?.accessToken ?? raw?.session?.access_token,
          user: {
            id: user.id,
            email: user.email,
            phone: user.phone,
          },
        },
      }
    : { session: null };
  return { data, error: result.error };
}

/**
 * 用户名 + 密码登录。
 *
 * 历史实现只按 `{username}@meoo.local` 占位邮箱登录。但用户改过真实邮箱后，
 * auth.users.email 已变成真实邮箱，占位邮箱不再命中 → 会「明明密码没错却登不进去」。
 * 因此这里做两级回落：
 *   1) 先按 `{username}@meoo.local` 占位尝试（绝大多数未改邮箱的老账号一步命中）
 *   2) 失败则查该用户名对应账号保存的真实邮箱（profiles.email），再试一次
 * 只有第二次仍失败才报「账号或密码错误」，避免暴露账号是否存在。
 */
export async function signInWithUsername(username: string, password: string): Promise<void> {
  logDbg('[auth] 开始登录, username:', username);
  const placeholder = `${username}@meoo.local`;

  const first = await trySignIn(placeholder, password);
  if (!first.error && first.data.session) {
    logDbg('[auth] 占位邮箱登录成功, user:', first.data.user?.id);
    return;
  }

  // ⚠️ 凭据类错误（400 invalid_grant / 403 email_not_confirmed 等）是**预期内的业务失败**，
  // 绝不能 console.error——预览端会把 console.error 冒成 RUNTIME_ERROR 红条（用户实测看到
  // 「[auth] signInWithPassword 异常」）。只有非预期异常（网络层 reject）才留 error 级日志。
  const failMsg = first.error?.message || '账号或密码错误';
  console.warn('[auth] 占位邮箱登录未通过:', failMsg);

  // 占位不命中：可能是用户已改真实邮箱。按 username 反查 profiles.email
  const realEmail = await lookupSavedEmail(username);
  if (realEmail && !isPlaceholderEmail(realEmail)) {
    const second = await trySignIn(realEmail, password);
    if (!second.error && second.data.session) {
      logDbg('[auth] ✅ 真实邮箱回落登录成功, user:', second.data.user?.id);
      return;
    }
    console.warn('[auth] 真实邮箱回落仍失败:', second.error?.message);
  }

  // ⚠️ 这里**不再**把底层原文（形如 `Failed to fetch: https://xxx/auth/v1/token?... 状态码: 400`）
  // 拼进错误消息：它会把内部域名与接口路径暴露到 UI 上，用户也读不懂。
  // 统一收敛成一句可行动的提示；真正的技术细节留在上面的 console.warn 里供排障。
  throw new Error('账号或密码错误，请重新输入');
}

/**
 * 按用户名查该账号在 profiles 里保存的登录邮箱。
 * profiles.username 有唯一约束且 RLS 允许所有人读，用于登录回落；查不到返回空串。
 */
async function lookupSavedEmail(username: string): Promise<string> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('email')
      .eq('username', username)
      .limit(1);
    if (error) {
      console.warn('[auth] 查询已保存邮箱失败:', error.message);
      return '';
    }
    return (data?.[0]?.email as string) || '';
  } catch (e) {
    console.warn('[auth] 查询已保存邮箱异常:', e);
    return '';
  }
}

/**
 * 用户名 + 密码注册（现有账号体系，保持不变）。
 *
 * 邮箱仍用 `{username}@meoo.local` 占位地址，真实用户名放 `options.data.username`
 * 透传到 `raw_user_meta_data`，由 `handle_new_user` 触发器写入 `profiles.username`。
 * ⚠️ 不传 data 时网关虽能建号，但 profiles.username 为空，会让「改过真实邮箱后
 * 按用户名反查」的登录回落失效，所以这一项是用户名体系的一部分，不能省。
 *
 * 该链路只适用于 `VITE_AUTH_BACKEND=legacy`：WorkBuddy Cloud 的 signUp 强制
 * 要求 OTP 换来的 verificationToken，纯用户名密码会被上游拒绝。
 */
export async function signUpWithUsername(username: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signUp({
    email: `${username}@meoo.local`,
    password,
    options: { data: { username } },
  } as any);
  if (error) throw new Error(`注册失败: ${error.message}`);
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(`登出失败: ${error.message}`);
}

/**
 * 仅清本地会话（scope:'local'，不打服务端网络）。
 * 供「登录态已失效」这类被动出口使用：只清本地 session/storage，不跳页。
 */
export async function signOutLocal(): Promise<void> {
  try {
    await signOutLocalOnly();
  } catch (e) {
    console.warn('[auth] 本地登出失败(不影响后续登录):', e);
  }
}

/**
 * 「账号+密码」暗号的凭据解析。
 *
 * 语义：ping 页输入 `账号+密码` → 用这组凭据完成一次**真实登录**再进聊天列表，
 * 因此校验必须走 supabase 密码通道（profiles 表里没有密码列，网关也只放行 public schema）。
 *
 * 分隔符取**第一个** `+`：注册用户名本身不允许含 `+`（见 USERNAME_RE），而密码可以，
 * 所以从首个加号切开就能无歧义还原两段；若按最后一个加号切，密码里的 `+` 会被当成用户名的一部分。
 * 返回 null 表示「这不是凭据串」，调用方应继续按诊断目标处理。
 */
const CREDENTIAL_SEP = '+';

/** 与 login 页注册校验同口径的用户名字符集（不含 `+`，故首切安全） */
const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/;

export interface CredentialInput {
  username: string;
  password: string;
}

export function parseCredentialInput(raw: string): CredentialInput | null {
  const v = raw.trim();
  const at = v.indexOf(CREDENTIAL_SEP);
  // 没有分隔符 → 肯定不是凭据串（普通域名/IP 里不会出现 +）
  if (at <= 0) return null;
  const username = v.slice(0, at).trim();
  const password = v.slice(at + 1).trim();
  if (!username || !password) return null;
  // 用户名形态不符 → 不是凭据串。这一条同时挡掉「带 + 的怪输入被当成账号去撞库」。
  if (!USERNAME_RE.test(username)) return null;
  return { username, password };
}

/**
 * 修改密码：需已登录（携带有效会话）。Supabase updateUser 会校验新密码强度并直接生效，
 * 无需旧密码字段（auth-js 无独立"验旧密码"接口；未登录时 getSession 拿不到 user 即视为未授权）。
 * 成功后当前会话仍有效，返回是否成功。
 */
export async function updatePassword(newPassword: string): Promise<void> {
  const { data, error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    // 常见：密码过短(weak_password)、会话过期(invalid_grant / session_expired)
    const status = (error as { status?: number }).status;
    console.error('[auth] 修改密码失败:', error.message, status);
    throw new Error(`修改密码失败: ${error.message}`);
  }
  if (!data?.user) {
    throw new Error('修改密码失败: 会话已失效，请重新登录');
  }
}

/**
 * 仅清本地会话（不打服务端网络）。
 *
 * 两种后端的 signOut 参数形态不同：supabase-js v2 收 `{ scope: 'local' }`，
 * cloud 桥接层收位置参数 `'local'`。传错形状会退化成 global 登出并在弱网下
 * 抛错，因此这里按后端显式分流。
 */
async function signOutLocalOnly(): Promise<void> {
  await (supabase.auth.signOut as any)(isCloudAuth ? 'local' : { scope: 'local' });
}

/** 当前账号可用于「重置密码收信」的真实邮箱；仍是占位邮箱时返回空串 */
export function getAccountEmail(user: User | null): string {
  const email = (user?.email || '').trim();
  if (!email || isPlaceholderEmail(email)) return '';
  return email;
}

/**
 * 修改登录邮箱：必须走 set-account-email Edge Function（改 auth.users.email 需要
 * service_role key，不能下发到小程序前端）。函数会用当前 access_token 校验身份，
 * 只允许改自己的账号，并把原占位邮箱留在 meta.placeholder_email 供老通道使用。
 * 成功后把新邮箱同步写 profiles.email —— 这是「用户名 + 密码」登录回落的唯一依据。
 */
export async function updateEmail(newEmail: string): Promise<string> {
  const trimmed = newEmail.trim().toLowerCase();
  const { data, error } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const uid = data.session?.user?.id;
  if (!token || !uid) {
    throw new Error('修改邮箱失败: 登录态已失效，请重新登录');
  }

  const res = await Taro.request<{ ok?: boolean; email?: string; error?: string }>({
    url: `${supabaseUrl}/functions/v1/set-account-email`,
    method: 'POST',
    header: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: supabaseAnonKey,
      'OneDay-App-Id': projectUrlId,
    },
    data: { email: trimmed },
    timeout: 30000,
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const msg = res.data?.error || `服务端返回 ${res.statusCode}`;
    console.error('[auth] 修改邮箱失败:', res.statusCode, msg);
    throw new Error(`修改邮箱失败: ${msg}`);
  }

  const saved = res.data?.email || trimmed;
  logDbg('[auth] ✅ 登录邮箱已更新:', saved);

  // 双写 profiles.email：auth.users 侧已由函数改好，这里补一份给登录回落与展示
  try {
    const { error: dbErr } = await supabase.from('profiles').update({ email: saved }).eq('id', uid);
    if (dbErr) console.warn('[auth] 邮箱已改但同步 profiles.email 失败（不影响登录）:', dbErr.message);
  } catch (e) {
    console.warn('[auth] 同步 profiles.email 异常:', e);
  }

  // auth-js 本地缓存的 user 仍是旧邮箱，强制刷新会话让 UI 立刻反映新值
  try {
    await supabase.auth.getSession();
  } catch {
    /* 刷新失败不影响本次修改结果 */
  }
  return saved;
}

/** 忘记密码：发送重置验证码邮件的结果（收件地址已脱敏，绝不返回令牌本身） */
export interface RecoverySendResult {
  /** 实际投递到的脱敏地址，如 a******@example.com；账号不存在时服务端不透露，可能为空 */
  maskedEmail: string;
  /** 验证码有效期（秒），前端据此做倒计时提示 */
  expiresIn: number;
}

/** 「该邮箱没有对应账号 / 还没绑定可用邮箱」——函数侧返回 NO_REAL_EMAIL，调用方应给出对应引导 */
export class NoRealEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoRealEmailError';
  }
}

/** Edge Function 冷启动 + SMTP 投递耗时较长，前端超时给足 30 秒 */
const RECOVERY_TIMEOUT_MS = 30000;

/**
 * 按「注册邮箱」发送重置密码验证码邮件。
 *
 * 走 set-account-email Edge Function 的找回通道（部署为 -j false，无需登录态）：
 * 平台对云函数数量有额度限制，因此不单独开一个新函数，而是复用同属「账号凭据维护」的
 * 修改邮箱函数——函数内部按请求体形态分流（含 token → 校验通道；含 email 且无
 * Authorization → 发信通道；其余 → 原有改邮箱逻辑）。
 *
 * 为什么不能靠官方恢复邮件：GoTrue 把令牌放在 URL 里（?token=...&type=recovery），
 * 小程序没有网页回调承接，点进去只会是空白页；因此由服务端**自签**一枚 6 位数字验证码
 * （哈希存 public.profiles），用 SMTP 发一封「可抄验证码」的邮件。
 * ⚠️ 不能用 GoTrue generateLink 的令牌：本实例网关只放行 public schema，
 * auth 下的令牌列根本读不到，无法在校验步骤复核。
 *
 * ⚠️ 入参是用户输入的注册邮箱而不是用户名：本应用除账密注册外还有微信登录账号，其占位地址
 * 形如 `{openid}@wx.local`，无法从用户名反推。函数内部按 email 定位账号，并把用户名作为
 * verify 步骤的凭据一并返回，避免用户再手输一遍。
 * 服务端对「邮箱不存在」也返回成功以防枚举，前端统一提示「若已绑定请查收」。
 */
export async function sendPasswordRecoveryCode(email: string): Promise<RecoverySendResult> {
  const target = email.trim().toLowerCase();
  if (!target) {
    throw new Error('发送失败: 请输入注册邮箱');
  }

  const res = await Taro.request<{
    ok?: boolean;
    sent?: boolean;
    masked_email?: string;
    expires_in_seconds?: number;
    username?: string;
    code?: string;
    error?: string;
  }>({
    // ⚠️ 不带 Authorization：忘记密码的前提就是登不进去。承载层 smtp-recovery 函数内部据此把请求路由到发信通道。
    // Task #8/#9：优先走承载层 smtp-recovery（SMTP 发信）；未配置承载层 URL 时回落旧 set-account-email 发信通道。
    url: resolveCloudFnUrl('smtp-recovery', 'set-account-email'),
    method: 'POST',
    header: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      'OneDay-App-Id': projectUrlId,
    },
    data: { email: target },
    timeout: RECOVERY_TIMEOUT_MS,
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const msg = res.data?.error || `服务端返回 ${res.statusCode}`;
    console.error('[auth] 发送重置验证码失败:', res.statusCode, msg, res.data?.code);
    if (res.data?.code === 'NO_REAL_EMAIL') throw new NoRealEmailError(msg);
    throw new Error(`发送重置验证码失败: ${msg}`);
  }

  if (res.data?.username) {
    setRecoveryUsername(res.data.username);
  }
  logDbg('[auth] ✅ 重置验证码邮件请求已受理:', res.data?.masked_email || '(未透露)');
  return {
    maskedEmail: res.data?.masked_email || '',
    expiresIn: res.data?.expires_in_seconds || 600,
  };
}

/**
 * 用邮件里的数字令牌完成密码重置。
 *
 * ⚠️ 这里不能走 supabase.auth.verifyOtp：账密登录的 email 可能是 `{username}@meoo.local`
 * 占位邮箱，而 recovery 令牌是按**真实邮箱**生成的，两者对不上必然校验失败。
 * 因此把令牌与新密码交给同一个 Edge Function 的 verify 通道：服务端比对
 * sha256(令牌) 与库中哈希，命中后用 service_role 改写密码（密钥绝不下发到前端）。
 */
export async function resetPasswordWithCode(
  token: string,
  newPassword: string,
): Promise<void> {
  const trimmedToken = token.trim();
  if (!/^\d{4,10}$/.test(trimmedToken)) throw new Error('重置失败: 验证码格式不正确');
  if (newPassword.length < 6) throw new Error('重置失败: 新密码至少 6 位');

  const res = await Taro.request<{ ok?: boolean; error?: string }>({
    // ⚠️ 不带 Authorization：校验通道同样在无登录态下运行，函数按 token 字段路由。
    // Task #8/#9：优先走承载层 smtp-recovery（校验通道）；未配置承载层 URL 时回落旧 set-account-email 校验通道。
    url: resolveCloudFnUrl('smtp-recovery', 'set-account-email'),
    method: 'POST',
    header: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      'OneDay-App-Id': projectUrlId,
    },
    data: { token: trimmedToken, password: newPassword, username: pendingRecoveryUsername },
    timeout: RECOVERY_TIMEOUT_MS,
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const msg = res.data?.error || `服务端返回 ${res.statusCode}`;
    console.error('[auth] 重置密码失败:', res.statusCode, msg);
    throw new Error(`重置密码失败: ${msg}`);
  }
  pendingRecoveryUsername = '';
  logDbg('[auth] ✅ 密码已重置，请用新密码登录');
}

/** 会话失效后的统一处理:清掉本地过期session,避免auth-js反复自动刷新(预览态会刷"Failed to fetch") */
async function handleExpiredSession(reason: string): Promise<void> {
  console.warn(`[api/auth] ${reason}，已清除过期会话，准备跳转ping页重新进入`);
  try {
    // 静默登出:仅清本地session/storage,不请求服务端(signOut带网络调用,网络断时同样会失败)
    await signOutLocalOnly();
  } catch (e) {
    console.warn('[api/auth] 清除本地会话失败:', e);
  }
  // 登录过期后统一回到ping入口页(与120秒无操作超时同款机制),由暗号重新进入聊天
  // ⚠️ 这也是「离开聊天区」的出口之一：必须打退场点，否则下次进入的统计窗口起点会停在更早的时刻。
  markChatExit();
  // 会话失效跳回 ping = 离开聊天区。此处已 signOut(local) 清掉 token，reportPresence
  // 的 store 门控会拦下，故直接调落库函数（fire-and-forget，静默失败）。
  if (lastKnownUid) void reportPresenceState(lastKnownUid, 'offline', new Date().toISOString());
  try {
    await Taro.reLaunch({ url: '/pages/ping/index' });
    logDbg('[api/auth] 已跳转到ping页面');
  } catch (e) {
    console.warn('[api/auth] 跳转ping页面失败:', e);
  }
}

/** store 注入 setState 用；业务订阅 `useAuthStore` 即可。返回 unsubscribe。 */
export function subscribeAuthState(onChange: (user: User | null) => void): () => void {
  // 初始化时尝试获取 session，token 失效则静默清除
  supabase.auth
    .getSession()
    .then(({ data }) => {
      const u = (data.session?.user as User | null | undefined) ?? null;
      // getSession 与 onAuthStateChange(INITIAL_SESSION) 是两路独立回调，冷启动会几乎同时
      // 各触发一次；统一走 handleRealUser 的 uid 级闸门，避免同一次暗号进入被算成两次登录。
      if (u) handleRealUser(u, 'getSession');
      onChange(u);
    })
    .catch(async (e) => {
      const msg = (e as Error)?.message || '';
      // Refresh token 失效时静默处理，视为未登录
      if (msg.includes('Invalid Refresh Token') || msg.includes('Refresh Token Not Found')) {
        await handleExpiredSession('Refresh Token 已失效');
        onChange(null);
      } else {
        console.warn('[api/auth] getSession 失败：', e);
        onChange(null);
      }
    });

  const subscription = supabase.auth.onAuthStateChange((event, session) => {
    // 云端 SDK 的 CloudAuthStateCallback：(event, session: CloudSession | null) => void
    // Supabase 旧版返回 { data: { subscription } }，这里统一收敛为 unsubscribe 函数。
    // auth-js 自动刷新失败(TOKEN_REFRESH_FAILED/NETWORK_ERROR)时不会抛异常到这里,
    // 但事件可用于兜底;真正需要处理的是刷新后仍拿不到有效会话的INITIAL_SESSION场景
    if (event === 'SIGNED_OUT') {
      // 主动退出登录：在清空 onChange 前尽量取到 uid 写下线时间，供对方列表显示「离线」。
      // SIGNED_OUT 事件里 session 通常为 null，用 api 层维护的 lastKnownUid 兜底。
      const goneUid = (session?.user?.id as string | undefined) ?? lastKnownUid;
      if (goneUid) void recordLogout(goneUid);
      // 退出后作废暗号额度并清计数闸门：下次重新登录后再靠新的暗号进入才计一次
      clearSecretEntry();
      countedUids.clear();
      logDbg('[api/auth] 🚪 SIGNED_OUT，已作废暗号进入额度并清空登录计数闸门');
      onChange(null);
      return;
    }
    const u = (session?.user as User | null | undefined) ?? null;
    // 登录/恢复会话成功的最晚汇聚点（密码登录、微信一键登录、token 刷新都会经过这里）：
    // 异步记录本人最近登录时间，供聊天列表展示对方在线近况。内部有 60 秒节流，
    // 失败静默，绝不阻塞 onChange。过渡态 bootstrapped user 不走这里（无真实 session）。
    // ⚠️ 本回调**不再等价于「用户登录了一次」**：冷启动 INITIAL_SESSION、TOKEN_REFRESHED、
    // 切后台回前台都会走到这里。recordLastLogin 内部只认 ping 页暗号打点才写 login_events，
    // 所以这里保持无条件调用即可（用于刷新 last_login_at 活跃度），计数门控在 profiles 层。
    if (u) handleRealUser(u, `auth事件 ${event}`);
    onChange(u);
  });

  return () => {
    const s: any = subscription;
    // cloud 桥接层直接返回 unsubscribe 函数；SupabaseClient 返回
    // `{ data: { subscription: { unsubscribe() } } }`，两种都要能解绑。
    if (typeof s === 'function') {
      s();
      return;
    }
    s?.data?.subscription?.unsubscribe?.();
  };
}
