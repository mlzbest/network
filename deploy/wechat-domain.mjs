#!/usr/bin/env node
/**
 * 代开发小程序 · 服务器域名配置助手
 *
 * 背景：小程序把「开发权限集」（ID 18）授权给第三方平台后，微信公众平台后台
 * 不再允许自行配置服务器域名，只能由服务商用 authorizer_access_token 调接口。
 *
 * 本脚本封装微信开放平台两个接口：
 *   - modify_domain_directly（方式二，默认）：无需先把域名登记到第三方平台，
 *     配置后需发布上线才生效。适合本项目的单个自有域名。
 *   - modify_domain（方式一）：需服务商先用 component_access_token 调用
 *     modify_wxa_server_domain 把域名登记到第三方平台白名单，否则发布时会被删除。
 *
 * 凭证只从环境变量读取，不落盘、不回显。默认 dry-run，必须显式 --apply 才提交。
 * 修改配额：每月 50 次；不要混用多种配置方式。
 *
 * 用法：
 *   WX_AUTHORIZER_ACCESS_TOKEN=<token> node deploy/wechat-domain.mjs
 *   WX_AUTHORIZER_ACCESS_TOKEN=<token> node deploy/wechat-domain.mjs --apply
 *   WX_AUTHORIZER_ACCESS_TOKEN=<token> node deploy/wechat-domain.mjs --effective
 *   WX_AUTHORIZER_ACCESS_TOKEN=<token> node deploy/wechat-domain.mjs --mode standard --apply
 *
 * 环境变量 WX_API_BASE 可覆盖 API 根地址（仅用于本地 mock 测试）。
 */

const DEFAULT_BASE = 'https://api.weixin.qq.com';
const DEFAULT_DOMAIN = 'https://api.maolizheng.xyz';
const FIELDS = [
  'requestdomain', 'wsrequestdomain', 'uploaddomain',
  'downloaddomain', 'udpdomain', 'tcpdomain',
];

// 错误码释义以官方接口文档为准（modifyserverdomaindirectly / modifyserverdomain /
// geteffectiveserverdomain，最后编辑 2026-07-04 / 2026-09-09）。
// 注意：方式二未备案返回 errcode=45082；no_icp_domain / invalid_requestdomain
// 是方式一 modify_domain 的返回字段，不是方式二的。
const ERR_HINTS = {
  61007: '权限集 18 未授权给该第三方平台，或已被另一家服务商占用（该权限集互斥）',
  40001: 'access_token 无效：确认使用 authorizer_access_token 而非 component_access_token',
  40014: 'access_token 不合法或已过期，请让服务商重新换取',
  42001: 'access_token 已过期，请让服务商重新换取',
  44002: 'POST 请求体为空（脚本已自动传 {}，若出现需检查代理是否改写请求）',
  45082: '域名未完成 ICP 备案（need icp license for the url domain）；第三方托管不是备案豁免',
  48001: '接口未授权，检查第三方平台权限集配置',
  85015: '该账号不是小程序账号，请确认 authorizer 对应的是小程序而非公众号',
  85016: '域名数量超出限制（每类最多 200 个）',
  85017: '没有可修改的域名：输入为空，或域名尚未登记到第三方平台（方式一）',
  85018: '域名没有在第三方平台设置（方式一需先调 modify_wxa_server_domain 登记）',
  85301: '存在不符合域名规则的域名，导致无修改',
  85302: '存在缺少 ICP 备案的域名，导致无修改',
  85303: '同时存在不符合规则与缺少 ICP 备案的域名，导致无修改',
  86100: 'URL 协议头有误（request 合法域名必须是 https://）',
  86101: '不支持把 api.weixin.qq.com 配置为服务器域名',
  86102: '本月域名修改次数已达 50 次上限',
};

function usage() {
  console.log(`用法：WX_AUTHORIZER_ACCESS_TOKEN=<token> node deploy/wechat-domain.mjs [选项]

  --apply              真实提交（默认 dry-run，只打印请求体）
  --effective          查询「发布后生效」的域名列表，不做修改
  --mode <mode>        directly（默认，方式二）| standard（方式一）
  --domain <url>       目标 request 合法域名，默认 ${DEFAULT_DOMAIN}
  --token-env <name>   凭证环境变量名，默认 WX_AUTHORIZER_ACCESS_TOKEN
  --base-url <url>     API 根地址，默认 ${DEFAULT_BASE}（也可用 WX_API_BASE）
  -h, --help           显示本帮助

退出码：0 成功 / 1 接口或调用失败 / 2 参数或凭证缺失`);
}

function parseArgs(argv) {
  const opts = {
    apply: false,
    effective: false,
    mode: 'directly',
    domain: DEFAULT_DOMAIN,
    tokenEnv: 'WX_AUTHORIZER_ACCESS_TOKEN',
    base: (process.env.WX_API_BASE || DEFAULT_BASE).replace(/\/$/, ''),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--effective') opts.effective = true;
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (['--mode', '--domain', '--token-env', '--base-url'].includes(a)) {
      const value = argv[++i];
      if (!value) { console.error(`[wechat-domain] ${a} 缺少取值`); process.exit(2); }
      if (a === '--mode') opts.mode = value;
      if (a === '--domain') opts.domain = value;
      if (a === '--token-env') opts.tokenEnv = value;
      if (a === '--base-url') opts.base = value.replace(/\/$/, '');
    } else {
      console.error(`[wechat-domain] 未知参数：${a}`);
      process.exit(2);
    }
  }
  if (!['directly', 'standard'].includes(opts.mode)) {
    console.error('[wechat-domain] --mode 只能是 directly 或 standard');
    process.exit(2);
  }
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(opts.domain)) {
    console.error('[wechat-domain] --domain 必须是 https://域名，不含端口与路径');
    process.exit(2);
  }
  return opts;
}

async function call(base, path, token, body) {
  const url = `${base}${path}?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  return json;
}

function printDomains(label, obj) {
  console.log(`  ${label}`);
  for (const f of FIELDS) {
    const arr = Array.isArray(obj?.[f]) ? obj[f] : [];
    console.log(`    ${f.padEnd(16)} ${arr.length ? arr.join(', ') : '(空)'}`);
  }
}

/**
 * 方式一 modify_domain 可能在 errcode=0 时仍返回「被拒域名」字段（伪成功）。
 * 方式二 modify_domain_directly 的返回体按官方只有 errcode/errmsg，
 * 未备案走 errcode=45082；这里保留字段检查作为防御，避免混用方式时漏判。
 * 返回 true 表示存在需要当作失败处理的警告。
 */
function printWarnings(res) {
  let bad = false;
  if (Array.isArray(res.no_icp_domain) && res.no_icp_domain.length) {
    console.error(`[wechat-domain] 以下域名未完成 ICP 备案：${res.no_icp_domain.join(', ')}`);
    console.error('[wechat-domain] 第三方托管不是备案豁免，必须先完成域名 ICP 备案。');
    bad = true;
  }
  if (Array.isArray(res.invalid_requestdomain) && res.invalid_requestdomain.length) {
    console.error(`[wechat-domain] 被拒绝的 request 域名：${res.invalid_requestdomain.join(', ')}`);
    bad = true;
  }
  return bad;
}

function fail(res) {
  console.error(`[wechat-domain] 接口返回 errcode=${res.errcode} errmsg=${res.errmsg ?? ''}`);
  const hint = ERR_HINTS[res.errcode];
  if (hint) console.error(`[wechat-domain] 提示：${hint}`);
  printWarnings(res);
  process.exit(1);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = (process.env[opts.tokenEnv] || '').trim();
  if (!token) {
    console.error(`[wechat-domain] 缺少凭证：请设置环境变量 ${opts.tokenEnv}（authorizer_access_token）`);
    console.error('[wechat-domain] 该凭证只能由持有权限集 18 的第三方服务商生成。');
    process.exit(2);
  }

  console.log(`[wechat-domain] 模式=${opts.mode} 目标=${opts.domain}`);
  console.log(`[wechat-domain] 端点=${opts.base} 凭证=${opts.tokenEnv}（尾号 …${token.slice(-4)}）`);

  if (opts.effective) {
    const res = await call(opts.base, '/wxa/get_effective_domain', token, {});
    if (res.errcode) fail(res);
    printDomains('mp_domain（公众平台配置）', res.mp_domain);
    printDomains('third_domain（方式一配置）', res.third_domain);
    printDomains('direct_domain（方式二配置）', res.direct_domain);
    printDomains('effective_domain（发布后真正生效）★', res.effective_domain);
    return;
  }

  const path = opts.mode === 'directly'
    ? '/wxa/modify_domain_directly'
    : '/wxa/modify_domain';

  // 先 get：避免重复添加已存在的域名（官方明确要求 add 前先 get）。
  const current = await call(opts.base, path, token, { action: 'get' });
  if (current.errcode) fail(current);
  printDomains('当前服务器域名配置', current);

  const existing = Array.isArray(current.requestdomain) ? current.requestdomain : [];
  if (existing.includes(opts.domain)) {
    console.log(`\n[wechat-domain] ${opts.domain} 已在 request 合法域名中，无需修改。`);
    console.log('[wechat-domain] 用 --effective 确认它是否已在发布后生效列表中。');
    return;
  }

  const body = { action: 'add', requestdomain: [opts.domain] };
  for (const f of FIELDS) if (f !== 'requestdomain') body[f] = [];

  console.log('\n[wechat-domain] 待提交请求体：');
  console.log(JSON.stringify(body, null, 2));
  if (!opts.apply) {
    console.log('\n[dry-run] 未实际提交。确认无误后追加 --apply；修改配额每月 50 次。');
    return;
  }

  const res = await call(opts.base, path, token, body);
  if (res.errcode) fail(res);
  if (printWarnings(res)) {
    console.error('[wechat-domain] 接口返回 ok 但存在被拒域名，配置未完成，请修复后重试。');
    process.exit(1);
  }
  console.log('\n[wechat-domain] 配置成功（errcode=0）。');
  console.log('[wechat-domain] 注意：域名需发布上线后才真正生效；发布前执行 --effective 核对 effective_domain。');
  if (opts.mode === 'standard') {
    console.log('[wechat-domain] 方式一：请确认服务商已用 component_access_token 调用');
    console.log('                modify_wxa_server_domain 把 api.maolizheng.xyz 登记到平台白名单，');
    console.log('                否则小程序发布时该域名会被删除。');
  }
  console.log('[wechat-domain] 官方建议不要混用公众平台 / 方式一 / 方式二配置同一小程序域名。');
}

main().catch((err) => {
  console.error(`[wechat-domain] 调用失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
