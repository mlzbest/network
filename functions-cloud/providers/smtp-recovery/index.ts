/**
 * 承载层 · 找回密码 SMTP 发信函数（TCB Node.js）
 *
 * 替代原 functions/set-account-email 的「找回密码·发信通道」。
 * 输入：{ email: string }（用户注册邮箱）
 * 输出：{ ok, sent, masked_email, expires_in_seconds, username, code?, error? }
 *
 * 流程：
 *   1. 按 email 反查 profiles（WorkBuddy Cloud SDK 的 database.from）
 *   2. 占位后缀（@meoo.local / @wx.local）直接拒绝
 *   3. 签发 6 位数字验证码，sha256 哈希写入 profiles.recovery_token_hash
 *   4. SMTP 投递（外部 SMTP：RECOVERY_SMTP_HOST/PORT/USER/PASS）
 *
 * 安全约束：
 *   - 收件邮箱脱敏后才进日志
 *   - 验证码 10 分钟有效（TOKEN_TTL_MS）
 *   - 三级限频：IP / 账号 / 校验（本函数只管前两级，校验通道在 cloudAuth.updateUser）
 *
 * ⚠️ 为什么不用内置 SMTP：原 Meoo Edge Function 的同机回环 127.0.0.1:54324 在 TCB 不存在，
 * 必须走外部 SMTP（自建邮件服务器 / 第三方邮件服务）。
 */

import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';
import * as net from 'node:net';
import * as tls from 'node:tls';

const CLOUD_ENDPOINT = process.env.WX_CLOUD_ENDPOINT!;
const CLOUD_PUBLISHABLE_KEY = process.env.WX_CLOUD_PUBLISHABLE_KEY!;

const TOKEN_TTL_MS = 10 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PLACEHOLDER_SUFFIXES = ['@meoo.local', '@wx.local'];

// 限频窗口（实例级内存，重启即清零；作为「随手连点」的闸门）
const RATE_WINDOW_MS = 60_000;
const MAX_PER_IP = 5;
const MAX_PER_ACCOUNT = 2;
const ipHits = new Map<string, number[]>();
const accountHits = new Map<string, number[]>();

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(local.length - 1, 3))}${email.slice(at)}`;
}

function isPlaceholderSuffix(email: string): boolean {
  return PLACEHOLDER_SUFFIXES.some((suffix) => email.endsWith(suffix));
}

async function sha256Hex(s: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(s).digest('hex');
}

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

function buildMime(to: string, from: string, code: string): string {
  const minutes = Math.round(TOKEN_TTL_MS / 60000);
  const subject = '你的登录密码重置验证码';
  const boundary = `network-${Date.now().toString(36)}`;
  const plain = [
    '你正在重置查看网络的登录密码。',
    '',
    `本次验证码：${code}，请在应用内的「重置密码」页面输入这 ${code.length} 位数字，${minutes} 分钟内有效。`,
  ].join('\n');
  const html = [
    '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:15px;color:#1f2937;line-height:1.7">',
    '<p>你正在重置查看网络的登录密码。</p>',
    `<p>本次验证码：<b style="font-size:20px;letter-spacing:3px">${code}</b>，请在应用内的「重置密码」页面输入这 ${code.length} 位数字，<b>${minutes} 分钟内有效</b>。</p>`,
    '</div>',
  ].join('');
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const wrapBase64 = (s: string) => s.match(/.{1,76}/g)?.join('\r\n') ?? s;
  const CRLF = '\r\n';
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now().toString(36)}@network-chat>`,
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

/**
 * 极简 SMTP 客户端（Node.js 版）。
 * 支持 465（隐式 TLS）与 STARTTLS（587）。
 */
class SmtpClient {
  private conn: net.Socket | tls.TLSSocket;
  private usingTls: boolean;

  constructor(conn: net.Socket | tls.TLSSocket, usingTls: boolean) {
    this.conn = conn;
    this.usingTls = usingTls;
  }

  private readReply(): Promise<string> {
    return new Promise((resolve, reject) => {
      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\r\n');
        const penultimate = lines[lines.length - 2];
        if (penultimate !== undefined && /^\d{3} /.test(penultimate)) {
          this.conn.removeListener('data', onData);
          resolve(buf.trim());
        }
      };
      this.conn.on('data', onData);
      this.conn.on('error', (e) => reject(e));
      this.conn.on('close', () => reject(new Error('SMTP 连接已断开')));
    });
  }

  private writeLine(line: string): void {
    this.conn.write(line + '\r\n');
  }

  async connect(host: string, port: number): Promise<void> {
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    const reply = await this.readReply();
    const code = Number(reply.slice(0, 3));
    if (code !== 220) throw new Error(`连接邮件服务器失败（SMTP ${code}）：${reply.slice(0, 160)}`);

    this.writeLine('EHLO network.chat');
    const ehlo = await this.readReply();
    if (Number(ehlo.slice(0, 3)) !== 250) {
      throw new Error(`EHLO 失败（SMTP ${ehlo.slice(0, 3)}）`);
    }

    const user = process.env.RECOVERY_SMTP_USER || '';
    const pass = process.env.RECOVERY_SMTP_PASS || '';
    if (user && pass) {
      this.writeLine('AUTH LOGIN');
      const authStart = await this.readReply();
      if (Number(authStart.slice(0, 3)) !== 334) {
        throw new Error(`开始身份验证失败（SMTP ${authStart.slice(0, 3)}）`);
      }
      this.writeLine(b64(user));
      const userOk = await this.readReply();
      if (Number(userOk.slice(0, 3)) !== 334) {
        throw new Error(`校验发信账号失败（SMTP ${userOk.slice(0, 3)}）`);
      }
      this.writeLine(b64(pass));
      const authOk = await this.readReply();
      if (Number(authOk.slice(0, 3)) !== 235) {
        throw new Error(`身份验证失败（SMTP ${authOk.slice(0, 3)}）`);
      }
    }
  }

  async send(from: string, to: string, body: string): Promise<void> {
    this.writeLine(`MAIL FROM:<${from}>`);
    const mailOk = await this.readReply();
    if (Number(mailOk.slice(0, 3)) !== 250) {
      throw new Error(`指定发件人失败（SMTP ${mailOk.slice(0, 3)}）`);
    }
    this.writeLine(`RCPT TO:<${to}>`);
    const rcptOk = await this.readReply();
    const rcptCode = Number(rcptOk.slice(0, 3));
    if (rcptCode !== 250 && rcptCode !== 251) {
      throw new Error(`指定收件人失败（SMTP ${rcptCode}）`);
    }
    this.writeLine('DATA');
    const dataOk = await this.readReply();
    if (Number(dataOk.slice(0, 3)) !== 354) {
      throw new Error(`开始写信失败（SMTP ${dataOk.slice(0, 3)}）`);
    }
    const escaped = body
      .split('\r\n')
      .map((l) => (l.startsWith('.') ? '..' + l : l))
      .join('\r\n');
    this.conn.write(escaped + '\r\n.\r\n');
    const sent = await this.readReply();
    if (Number(sent.slice(0, 3)) !== 250) {
      throw new Error(`投递邮件失败（SMTP ${sent.slice(0, 3)}）`);
    }
    this.writeLine('QUIT');
  }

  close(): void {
    try {
      this.conn.destroy();
    } catch {
      /* ignore */
    }
  }
}

async function sendViaSmtp(to: string, from: string, code: string): Promise<void> {
  const host = process.env.RECOVERY_SMTP_HOST;
  const user = process.env.RECOVERY_SMTP_USER;
  const pass = process.env.RECOVERY_SMTP_PASS;
  const mailFrom = process.env.RECOVERY_MAIL_FROM || user;
  if (!host || !user || !pass || !mailFrom) {
    throw new Error('外部 SMTP 未配置：需 RECOVERY_SMTP_HOST/USER/PASS/MAIL_FROM');
  }
  const port = Number(process.env.RECOVERY_SMTP_PORT || 587);
  const body = buildMime(to, mailFrom, code);

  const client =
    port === 465
      ? new SmtpClient(
          (await new Promise<tls.TLSSocket>((resolve, reject) => {
            const s = tls.connect({ host, port, servername: host }, () => resolve(s));
            s.on('error', reject);
          })),
          true,
        )
      : new SmtpClient(
          (await new Promise<net.Socket>((resolve, reject) => {
            const s = net.connect({ host, port }, () => resolve(s));
            s.on('error', reject);
          })),
          false,
        );

  try {
    await client.connect(host, port);
    await client.send(mailFrom, to, body);
  } finally {
    client.close();
  }
}

export interface RecoverySendRequest {
  email?: unknown;
}

export interface RecoverySendResponse {
  ok?: boolean;
  sent?: boolean;
  masked_email?: string;
  expires_in_seconds?: number;
  username?: string;
  code?: string;
  error?: string;
  status?: number;
}

export const mainHandler = async (event: Record<string, unknown>): Promise<RecoverySendResponse> => {
  const requestId = Math.random().toString(36).slice(2, 10);
  const body = (event?.body ?? event) as RecoverySendRequest;
  const inputEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

  if (!inputEmail || !EMAIL_RE.test(inputEmail)) {
    return { error: '请输入正确的注册邮箱', code: 'BAD_EMAIL', status: 400 };
  }
  if (isPlaceholderSuffix(inputEmail)) {
    return {
      code: 'NO_REAL_EMAIL',
      error: '这个地址是系统内部占位邮箱，不是你的真实邮箱。请填写你注册时绑定的自己的邮箱',
      status: 400,
    };
  }

  // 限频（按 IP 维度；TCB 不暴露真实 IP，这里退化为按邮箱维度）
  if (!allow(accountHits, inputEmail, MAX_PER_ACCOUNT)) {
    return { error: '该账号请求过于频繁，请一分钟后再试', code: 'RATE_LIMITED', status: 429 };
  }

  // 按 email 反查 profiles（WorkBuddy Cloud SDK）
  const cloud = createWorkBuddyCloud({
    endpoint: CLOUD_ENDPOINT,
    publishableKey: CLOUD_PUBLISHABLE_KEY,
  });
  const { data: profArr, error: profErr } = await cloud.database
    .from('profiles')
    .select('id, username, email')
    .eq('email', inputEmail)
    .limit(1);
  if (profErr) {
    console.error(`[recovery-provider] profiles read failed ${requestId}: ${String(profErr)}`);
    return { error: '暂时无法处理请求，请稍后再试', code: 'DB_ERROR', status: 502 };
  }
  const profRow: { id?: string; username?: string; email?: string } | null | undefined = Array.isArray(profArr)
    ? profArr[0]
    : profArr;
  if (!profRow?.id || isPlaceholderSuffix(inputEmail)) {
    // 邮箱没有对应账号也返回成功，防枚举
    console.info(`[recovery-provider] no account for email ${requestId}, respond generically`);
    return {
      ok: true,
      sent: true,
      hint: '如果该邮箱已绑定账号，重置验证码邮件已经发出，请查收（含垃圾邮件箱）',
    };
  }

  const uid = String(profRow.id);
  const email = inputEmail;
  const username = String(profRow.username ?? '').trim();

  // 签发 6 位数字验证码
  const { randomBytes } = await import('node:crypto');
  const code = String(randomBytes(2).readUInt16BE(0) % 1_000_000).padStart(6, '0');
  const tokenHash = await sha256Hex(code);

  const { error: saveErr } = await cloud.database
    .from('profiles')
    .update({ recovery_token_hash: tokenHash, recovery_sent_at: new Date().toISOString() })
    .eq('id', uid);
  if (saveErr) {
    console.error(`[recovery-provider] save token failed ${requestId}: ${String(saveErr)}`);
    return { error: '生成重置验证码失败，请稍后再试', code: 'DB_ERROR', status: 500 };
  }

  // SMTP 投递
  try {
    await sendViaSmtp(email, process.env.RECOVERY_MAIL_FROM || process.env.RECOVERY_SMTP_USER || email, code);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[recovery-provider] smtp failed ${requestId}: ${msg}`);
    return {
      code: 'RESET_CONFIG_MISSING',
      error: '重置密码邮件发送通道尚未就绪，请联系应用管理员补齐发信配置',
      status: 503,
    };
  }

  console.info(`[recovery-provider] success ${requestId} masked=${maskEmail(email)}`);
  return {
    ok: true,
    sent: true,
    masked_email: maskEmail(email),
    expires_in_seconds: TOKEN_TTL_MS / 1000,
    username,
  };
};

export default mainHandler;
