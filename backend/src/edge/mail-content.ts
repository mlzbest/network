/**
 * 找回密码邮件的「内容」层：与投递通道无关。
 *
 * SMTP 通道（smtp.ts）与 HTTP 邮件 API 通道（mail.ts）共用这里的主题/正文，
 * 保证换通道后用户看到的验证码邮件完全一致。本模块只做纯字符串处理，
 * 不引入 node:net / node:tls / Buffer，因此可以安全打进 Cloudflare Workers bundle。
 */

export interface MailOptions {
  to: string;
  from: string;
  code: string;
  ttlMinutes: number;
}

export interface MailContent {
  subject: string;
  text: string;
  html: string;
}

export function buildMailContent(opts: MailOptions): MailContent {
  const subject = '你的登录密码重置验证码';
  const text = [
    '你正在重置「检测网络」的登录密码。',
    '',
    `本次验证码：${opts.code}，请在应用内的「重置密码」页面输入这 ${opts.code.length} 位数字，${opts.ttlMinutes} 分钟内有效。`,
  ].join('\n');
  const html = [
    '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:15px;color:#1f2937;line-height:1.7">',
    '<p>你正在重置「检测网络」的登录密码。</p>',
    `<p>本次验证码：<b style="font-size:20px;letter-spacing:3px">${opts.code}</b>，请在应用内的「重置密码」页面输入这 ${opts.code.length} 位数字，<b>${opts.ttlMinutes} 分钟内有效</b>。</p>`,
    '</div>',
  ].join('');
  return { subject, text, html };
}
