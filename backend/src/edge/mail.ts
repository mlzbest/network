import { env } from '../env.js';
import { buildMailContent, type MailOptions } from './mail-content.js';

/**
 * 找回密码验证码的统一投递入口。
 *
 * 背景：Cloudflare Workers Free 没有 TCP socket，node:net / node:tls 直连 SMTP
 * 不可用；原实现只有 SMTP 一条路，导致 Workers 下「忘记密码」必然返回
 * RESET_CONFIG_MISSING。这里增加两条纯 fetch 的 HTTP 通道：
 *
 *   - resend：POST https://api.resend.com/emails（或 RESEND_API_URL 覆盖）
 *   - http  ：POST 自定义 RECOVERY_MAIL_API_URL（自建 relay / 企业邮件网关）
 *   - smtp  ：Node / VPS 路径，由 launch.ts 注入 __DETECT_SMTP_SEND__；
 *            Workers 不注入，因此 bundle 完全不含 node:net / node:tls
 *
 * 选路由 MAIL_DRIVER 控制，默认 auto：有 Resend key 用 Resend，
 * 否则有自定义 URL 用通用 HTTP，最后才回落 SMTP。
 *
 * 配置从参数注入（默认读 env）是为了让测试无需伪造进程环境变量。
 */

export type MailDriver = 'resend' | 'http' | 'smtp';

export type MailEnv = Pick<
  typeof env,
  | 'MAIL_DRIVER'
  | 'RESEND_API_KEY'
  | 'RESEND_API_URL'
  | 'RECOVERY_MAIL_API_URL'
  | 'RECOVERY_MAIL_API_KEY'
  | 'RECOVERY_MAIL_FROM'
  | 'RECOVERY_MAIL_TIMEOUT_MS'
  | 'RECOVERY_SMTP_HOST'
  | 'RECOVERY_SMTP_PORT'
  | 'RECOVERY_SMTP_USER'
  | 'RECOVERY_SMTP_PASS'
>;

export interface MailConfig {
  driver: MailDriver;
  from: string;
  endpoint?: string;
  apiKey?: string;
  timeoutMs: number;
  smtp?: { host: string; port: number; user: string; pass: string; from: string };
}

export type SendResult =
  | { ok: true; driver: MailDriver }
  | { ok: false; driver: MailDriver; message: string };

const DEFAULT_RESEND_URL = 'https://api.resend.com/emails';

/** Node 入口注入的 SMTP 投递器；Workers 下为 undefined（且不会打包 node:net）。 */
type SmtpSender = (
  opts: MailOptions,
  cfg: { host: string; port: number; user: string; pass: string; from: string },
) => Promise<void>;

function getSmtpSender(): SmtpSender | undefined {
  return (globalThis as Record<string, unknown>).__DETECT_SMTP_SEND__ as SmtpSender | undefined;
}

const has = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/** 返回可用的发信配置；缺配置返回 null，调用方据此提前返回 RESET_CONFIG_MISSING。 */
export function getMailConfig(source: MailEnv = env): MailConfig | null {
  const from = (source.RECOVERY_MAIL_FROM || source.RECOVERY_SMTP_USER || '').trim();
  const timeoutMs = source.RECOVERY_MAIL_TIMEOUT_MS || 15_000;
  const smtpReady =
    has(source.RECOVERY_SMTP_HOST) &&
    has(source.RECOVERY_SMTP_USER) &&
    has(source.RECOVERY_SMTP_PASS) &&
    has(from);

  const mode = source.MAIL_DRIVER || 'auto';
  if (mode === 'smtp') {
    if (!smtpReady) return null;
    return {
      driver: 'smtp',
      from,
      timeoutMs,
      smtp: {
        host: source.RECOVERY_SMTP_HOST!,
        port: source.RECOVERY_SMTP_PORT ?? 587,
        user: source.RECOVERY_SMTP_USER!,
        pass: source.RECOVERY_SMTP_PASS!,
        from,
      },
    };
  }

  if (mode === 'http') {
    if (!has(source.RECOVERY_MAIL_API_URL) || !has(from)) return null;
    return {
      driver: 'http',
      from,
      endpoint: source.RECOVERY_MAIL_API_URL!.trim(),
      apiKey: has(source.RECOVERY_MAIL_API_KEY) ? source.RECOVERY_MAIL_API_KEY!.trim() : undefined,
      timeoutMs,
    };
  }

  // auto
  if (has(source.RESEND_API_KEY) && has(from)) {
    return {
      driver: 'resend',
      from,
      endpoint: (has(source.RESEND_API_URL) ? source.RESEND_API_URL!.trim() : DEFAULT_RESEND_URL),
      apiKey: source.RESEND_API_KEY!.trim(),
      timeoutMs,
    };
  }
  if (has(source.RECOVERY_MAIL_API_URL) && has(from)) {
    return {
      driver: 'http',
      from,
      endpoint: source.RECOVERY_MAIL_API_URL!.trim(),
      apiKey: has(source.RECOVERY_MAIL_API_KEY) ? source.RECOVERY_MAIL_API_KEY!.trim() : undefined,
      timeoutMs,
    };
  }
  if (smtpReady) {
    return {
      driver: 'smtp',
      from,
      timeoutMs,
      smtp: {
        host: source.RECOVERY_SMTP_HOST!,
        port: source.RECOVERY_SMTP_PORT ?? 587,
        user: source.RECOVERY_SMTP_USER!,
        pass: source.RECOVERY_SMTP_PASS!,
        from,
      },
    };
  }
  return null;
}

function redact(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 240);
}

/** 投递验证码；任何失败都以结构化结果返回，不抛异常（调用方负责回滚验证码哈希）。 */
export async function sendRecoveryCode(
  opts: MailOptions,
  cfg: MailConfig,
): Promise<SendResult> {
  const content = buildMailContent(opts);
  try {
    if (cfg.driver === 'smtp') {
      const sender = getSmtpSender();
      if (!sender) {
        return {
          ok: false,
          driver: 'smtp',
          message: 'SMTP 通道未注入：仅 Node / VPS 入口可用，Workers 请配置 HTTP 邮件 API',
        };
      }
      await sender(opts, cfg.smtp!);
      return { ok: true, driver: 'smtp' };
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

    const body =
      cfg.driver === 'resend'
        ? {
            from: cfg.from,
            to: [opts.to],
            subject: content.subject,
            text: content.text,
            html: content.html,
          }
        : {
            from: cfg.from,
            to: opts.to,
            subject: content.subject,
            text: content.text,
            html: content.html,
            code: opts.code,
            ttl_minutes: opts.ttlMinutes,
          };

    const res = await fetch(cfg.endpoint!, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        driver: cfg.driver,
        message: `邮件 API 返回 HTTP ${res.status}${detail ? `：${redact(detail)}` : ''}`,
      };
    }
    return { ok: true, driver: cfg.driver };
  } catch (err: any) {
    return {
      ok: false,
      driver: cfg.driver,
      message: redact(err?.message || String(err)),
    };
  }
}
