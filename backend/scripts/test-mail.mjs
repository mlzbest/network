/**
 * 找回密码「HTTP 邮件 API」通道验证（无需真实邮箱服务 / 无需数据库）。
 *
 * 1) 本地 HTTP mock 记录 Resend / 自定义网关收到的请求；
 * 2) 验证 MAIL_DRIVER 选路（auto / http / smtp）与配置缺失判定；
 * 3) 验证请求体字段、Bearer 鉴权、邮件正文与 SMTP 通道内容一致；
 * 4) 验证 HTTP 5xx、端点不可达、超时均返回结构化失败而不抛异常。
 *
 * 依赖 dist：先 `pnpm build`（package.json 的 test:mail 已串联）。
 */
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// env.ts 支持 globalThis 注入；这里给最小必填项，避免依赖真实 .env。
globalThis.__DETECT_ENV__ = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
  JWT_SECRET: 'test-mail-jwt-secret-0123456789',
  STORAGE_DRIVER: 'local',
};

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');

// Windows 下动态 import 必须传 file:// URL，不能传盘符绝对路径。
const distUrl = (rel) => pathToFileURL(join(DIST, rel)).href;
const { getMailConfig, sendRecoveryCode } = await import(distUrl('edge/mail.js'));
const { buildMailContent } = await import(distUrl('edge/mail-content.js'));

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
};
const section = (name) => console.log(`\n=== ${name} ===`);

// ── 本地邮件网关 mock ────────────────────────────────────────────────────────
const requests = [];
let responseStatus = 200;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* 保留空对象 */ }
    requests.push({ url: req.url, method: req.method, headers: req.headers, body });
    const reply = () => {
      try {
        res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'mock-id', ok: responseStatus < 300 }));
      } catch { /* 客户端已因超时断开 */ }
    };
    if (req.url === '/slow') setTimeout(reply, 400);
    else reply();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const endpoint = `${base}/send`;

const BASE_ENV = {
  MAIL_DRIVER: 'auto',
  RESEND_API_KEY: undefined,
  RESEND_API_URL: undefined,
  RECOVERY_MAIL_API_URL: undefined,
  RECOVERY_MAIL_API_KEY: undefined,
  RECOVERY_MAIL_FROM: undefined,
  RECOVERY_MAIL_TIMEOUT_MS: 15_000,
  RECOVERY_SMTP_HOST: undefined,
  RECOVERY_SMTP_PORT: undefined,
  RECOVERY_SMTP_USER: undefined,
  RECOVERY_SMTP_PASS: undefined,
};
const cfg = (over = {}) => ({ ...BASE_ENV, ...over });
const message = (over = {}) => ({
  to: 'user@example.com',
  from: 'noreply@example.com',
  code: '483920',
  ttlMinutes: 10,
  ...over,
});

// ── 1. 配置判定与选路 ────────────────────────────────────────────────────────
section('配置判定与 MAIL_DRIVER 选路');
check('全空配置返回 null', getMailConfig(cfg()) === null);
check(
  'HTTP 通道缺发件人返回 null',
  getMailConfig(cfg({ RECOVERY_MAIL_API_URL: endpoint })) === null,
);
check(
  'Resend 缺发件人返回 null',
  getMailConfig(cfg({ RESEND_API_KEY: 're_test' })) === null,
);
check(
  'MAIL_DRIVER=smtp 且 SMTP 配置不全返回 null',
  getMailConfig(cfg({ MAIL_DRIVER: 'smtp', RECOVERY_SMTP_HOST: 'smtp.example.com' })) === null,
);
check(
  'MAIL_DRIVER=http 缺 URL 返回 null',
  getMailConfig(cfg({ MAIL_DRIVER: 'http', RECOVERY_MAIL_FROM: 'noreply@example.com' })) === null,
);

const httpOnly = getMailConfig(cfg({ RECOVERY_MAIL_API_URL: endpoint, RECOVERY_MAIL_FROM: 'noreply@example.com' }));
check('auto + 自定义 URL → http 通道', httpOnly?.driver === 'http', httpOnly);
check('http 通道带正确 endpoint', httpOnly?.endpoint === endpoint, httpOnly?.endpoint);

const smtpCfg = cfg({
  RECOVERY_SMTP_HOST: 'smtp.example.com',
  RECOVERY_SMTP_PORT: 465,
  RECOVERY_SMTP_USER: 'smtp-user',
  RECOVERY_SMTP_PASS: 'smtp-pass',
  RECOVERY_MAIL_FROM: 'noreply@example.com',
});
const smtpOnly = getMailConfig(smtpCfg);
check('auto + 仅 SMTP 配置 → smtp 通道', smtpOnly?.driver === 'smtp', smtpOnly);
check('smtp 通道端口沿用 465', smtpOnly?.smtp?.port === 465, smtpOnly?.smtp?.port);

const resendCfg = cfg({
  RESEND_API_KEY: 're_test_key',
  RESEND_API_URL: `${base}/resend`,
  RECOVERY_MAIL_API_URL: endpoint,
  RECOVERY_MAIL_FROM: 'noreply@example.com',
});
check('auto 下 Resend 优先于自定义 URL', getMailConfig(resendCfg)?.driver === 'resend');
check(
  'MAIL_DRIVER=http 强制走自定义 URL',
  getMailConfig(cfg({ ...resendCfg, MAIL_DRIVER: 'http' }))?.endpoint === endpoint,
);
check(
  'MAIL_DRIVER=smtp 强制走 SMTP（即使有 Resend key）',
  getMailConfig(cfg({
    ...smtpCfg,
    RESEND_API_KEY: 're_test_key',
    RESEND_API_URL: `${base}/resend`,
    RECOVERY_MAIL_API_URL: endpoint,
    MAIL_DRIVER: 'smtp',
  }))?.driver === 'smtp',
);
check('默认 Resend 端点正确', getMailConfig(cfg({
  RESEND_API_KEY: 're_test_key', RECOVERY_MAIL_FROM: 'noreply@example.com',
}))?.endpoint === 'https://api.resend.com/emails');

// ── 2. 自定义 HTTP 网关投递 ──────────────────────────────────────────────────
section('自定义 HTTP 网关请求');
responseStatus = 200;
requests.length = 0;
const httpResult = await sendRecoveryCode(message(), {
  ...httpOnly,
  apiKey: 'gw-secret',
});
check('投递成功', httpResult.ok === true, httpResult);
check('POST 到配置端点', requests[0]?.method === 'POST' && requests[0]?.url === '/send', requests[0]);
check('Bearer 鉴权头正确', requests[0]?.headers?.authorization === 'Bearer gw-secret');
check('Content-Type 为 JSON', /application\/json/.test(requests[0]?.headers?.['content-type'] || ''));
const httpBody = requests[0]?.body || {};
check('收件人 / 发件人正确', httpBody.to === 'user@example.com' && httpBody.from === 'noreply@example.com', httpBody);
check('主题正确', httpBody.subject === '你的登录密码重置验证码', httpBody.subject);
check('明文含验证码与有效期', httpBody.text?.includes('483920') && httpBody.text?.includes('10 分钟'), httpBody.text);
check('HTML 含验证码', httpBody.html?.includes('483920'), httpBody.html);
check('附带结构化 code / ttl_minutes', httpBody.code === '483920' && httpBody.ttl_minutes === 10, httpBody);

// ── 3. Resend 通道 ──────────────────────────────────────────────────────────
section('Resend 通道请求');
requests.length = 0;
const resendResult = await sendRecoveryCode(message(), getMailConfig(resendCfg));
check('投递成功', resendResult.ok === true && resendResult.driver === 'resend', resendResult);
check('命中 /resend 覆盖端点', requests[0]?.url === '/resend', requests[0]?.url);
check('Resend Bearer 头正确', requests[0]?.headers?.authorization === 'Bearer re_test_key');
check('Resend 的 to 是数组', Array.isArray(requests[0]?.body?.to) && requests[0].body.to[0] === 'user@example.com', requests[0]?.body?.to);
check('Resend 不带 code / ttl_minutes 扩展字段', !('code' in (requests[0]?.body || {})));

// ── 4. 无鉴权头 / 内容一致 ───────────────────────────────────────────────────
section('可选鉴权与内容一致性');
requests.length = 0;
await sendRecoveryCode(message(), { ...getMailConfig(cfg({
  RECOVERY_MAIL_API_URL: endpoint, RECOVERY_MAIL_FROM: 'noreply@example.com',
})) });
check('未配 API key 时无 Authorization 头', !requests[0]?.headers?.authorization);
const content = buildMailContent(message());
check('内容层主题/正文/HTML 三件套齐全',
  !!content.subject && content.text.includes('483920') && content.html.includes('483920'));
check('HTTP 投递正文与内容层完全一致',
  requests[0]?.body?.text === content.text && requests[0]?.body?.html === content.html);

// ── 5. SMTP 运行时注入 ──────────────────────────────────────────────────────
section('SMTP 由 Node 入口注入（Workers 下不加载 node:net）');
const smtpOnlyCfg = getMailConfig(smtpCfg);
const noSender = await sendRecoveryCode(message(), smtpOnlyCfg);
check('未注入投递器 → 结构化失败而非抛异常', noSender.ok === false, noSender);
check('错误信息指向 HTTP 邮件 API', noSender.ok === false && noSender.message.includes('HTTP 邮件 API'), noSender.message);
let smtpCalled = null;
globalThis.__DETECT_SMTP_SEND__ = async (opts, c) => { smtpCalled = { opts, c }; };
const withSender = await sendRecoveryCode(message(), smtpOnlyCfg);
check('注入后 SMTP 分支成功', withSender.ok === true && withSender.driver === 'smtp', withSender);
check('SMTP 收到完整配置与邮件参数',
  smtpCalled?.c?.host === 'smtp.example.com' && smtpCalled.c.port === 465 &&
  smtpCalled.opts.code === '483920', smtpCalled);
delete globalThis.__DETECT_SMTP_SEND__;

// ── 6. 失败路径 ─────────────────────────────────────────────────────────────
section('失败路径（不抛异常，返回结构化结果）');
responseStatus = 500;
const fail500 = await sendRecoveryCode(message(), httpOnly);
check('HTTP 500 → ok=false', fail500.ok === false, fail500);
check('错误信息含状态码', fail500.ok === false && fail500.message.includes('500'), fail500.message);
check('错误信息含响应体摘要', fail500.ok === false && fail500.message.includes('mock-id'), fail500.message);
responseStatus = 200;

const unreachable = await sendRecoveryCode(message(), {
  ...getMailConfig(cfg({ RECOVERY_MAIL_API_URL: 'http://127.0.0.1:1/nope', RECOVERY_MAIL_FROM: 'noreply@example.com' })),
  timeoutMs: 1500,
});
check('端点不可达 → ok=false 且不抛异常', unreachable.ok === false, unreachable);

const slow = await sendRecoveryCode(message(), {
  ...getMailConfig(cfg({ RECOVERY_MAIL_API_URL: `${base}/slow`, RECOVERY_MAIL_FROM: 'noreply@example.com' })),
  timeoutMs: 80,
});
check('超时 → ok=false', slow.ok === false, slow);
check('超时错误信息可读', slow.ok === false && slow.message.length > 0, slow.message);

server.close();
console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===\n`);
process.exit(failed === 0 ? 0 : 1);
