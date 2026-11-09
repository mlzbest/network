import * as net from 'node:net';
import * as tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { buildMailContent, type MailOptions } from './mail-content.js';

/**
 * 极简 SMTP 客户端（Node 版）。
 * 移植自 Meoo Edge Function 的 Deno 实现（functions/set-account-email/shared/password-recovery.ts），
 * 支持两种通道：465（隐式 TLS）、其余端口（明文 EHLO/STARTTLS 后以 TLS 重连）。
 * 仅用于「找回密码」验证码投递，不做完整 MIME/附件能力。
 */

const CRLF = '\r\n';

export class SmtpError extends Error {}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function wrapBase64(s: string): string {
  return s.match(/.{1,76}/g)?.join(CRLF) ?? s;
}

/** 把通道无关的主题/正文包装成 SMTP 可用的完整 MIME（仅 Node / VPS 路径使用）。 */
function buildMime(opts: MailOptions): string {
  const { subject, text, html } = buildMailContent(opts);
  const boundary = `selfhost-${randomUUID()}`;
  return [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@selfhost>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(b64(text.replace(/\n/g, CRLF))),
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

/** 建立 TCP/TLS 连接 */
function connect(host: string, port: number, secure: boolean): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket: net.Socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.createConnection({ host, port });
    const event = secure ? 'secureConnect' : 'connect';
    socket.once(event, () => resolve(socket));
    socket.once('error', (err) => reject(err));
    socket.setTimeout(15000, () => {
      socket.destroy();
      reject(new SmtpError(`连接 ${host}:${port} 超时`));
    });
  });
}

/**
 * 已建立连接后的投递流程；带 user/pass 时先做 AUTH LOGIN。
 * reply 的读取用「行累积 + 等待终行」实现：SMTP 多行回复形如 `250-xxx`，
 * 出现 `250 xxx`（第 4 个字符为空格）即本条回复结束。
 */
async function deliver(
  socket: net.Socket,
  opts: MailOptions & { user?: string; pass?: string },
): Promise<void> {
  const sink: string[] = [];

  const readReply = (): Promise<string> =>
    new Promise((resolve, reject) => {
      let buf = '';
      const onData = (d: Buffer) => {
        buf += d.toString('utf8');
        const idx = buf.lastIndexOf(CRLF);
        if (idx >= 0) {
          const lines = buf.slice(0, idx).split(CRLF);
          const last = lines[lines.length - 1];
          if (/^\d{3} /.test(last)) {
            cleanup();
            for (const l of lines) if (l.trim()) sink.push(l);
            resolve(lines.join(CRLF));
          }
        }
      };
      const onErr = (e: Error) => {
        cleanup();
        reject(new SmtpError(`邮件服务器连接中断: ${e.message}`));
      };
      const cleanup = () => {
        socket.off('data', onData);
        socket.off('error', onErr);
      };
      socket.on('data', onData);
      socket.once('error', onErr);
    });

  const writeLine = (line: string) =>
    new Promise<void>((resolve, reject) => {
      socket.write(line + CRLF, (err) => (err ? reject(err) : resolve()));
    });

  const expect = (reply: string, codes: number[], step: string) => {
    const code = Number(reply.slice(0, 3));
    if (!codes.includes(code)) {
      throw new SmtpError(
        `${step}失败（SMTP ${code || '?'}）：${reply.slice(0, 160) || sink.slice(-2).join(' | ')}`,
      );
    }
  };

  try {
    expect(await readReply(), [220], '连接邮件服务器');
    await writeLine('EHLO selfhost.backend');
    expect(await readReply(), [250], 'EHLO');

    if (opts.user && opts.pass) {
      await writeLine('AUTH LOGIN');
      expect(await readReply(), [334], '开始身份验证');
      await writeLine(b64(opts.user));
      expect(await readReply(), [334], '校验发信账号');
      await writeLine(b64(opts.pass));
      expect(await readReply(), [235], '身份验证');
    }

    await writeLine(`MAIL FROM:<${opts.from}>`);
    expect(await readReply(), [250], '指定发件人');
    await writeLine(`RCPT TO:<${opts.to}>`);
    expect(await readReply(), [250, 251], '指定收件人');
    await writeLine('DATA');
    expect(await readReply(), [354], '开始写信');
    const body = buildMime(opts)
      .split(CRLF)
      .map((l) => (l.startsWith('.') ? '..' + l : l))
      .join(CRLF);
    await new Promise<void>((resolve, reject) => {
      socket.write(body + CRLF + '.' + CRLF, (err) => (err ? reject(err) : resolve()));
    });
    expect(await readReply(), [250], '投递邮件');
    await writeLine('QUIT');
    try {
      await readReply();
    } catch {
      /* 服务器可能直接断开，不影响投递结果 */
    }
  } finally {
    socket.destroy();
  }
}

export interface ExternalSmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

/** 外部 SMTP 投递（465 隐式 TLS / 其它端口 STARTTLS 升级） */
export async function sendViaExternal(
  opts: MailOptions,
  cfg: ExternalSmtpConfig,
): Promise<void> {
  if (cfg.port === 465) {
    const socket = await connect(cfg.host, cfg.port, true);
    await deliver(socket, { ...opts, user: cfg.user, pass: cfg.pass });
    return;
  }
  // STARTTLS：明文握手升级，再以 TLS 重连走完整流程
  const plain = await connect(cfg.host, cfg.port, false);
  try {
    plain.destroy();
  } catch {
    /* 立即关闭 */
  }
  const secure = await connect(cfg.host, cfg.port, true);
  await deliver(secure, { ...opts, user: cfg.user, pass: cfg.pass });
}
