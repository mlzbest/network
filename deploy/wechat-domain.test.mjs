/**
 * deploy/wechat-domain.mjs 的本地 HTTP mock 测试（零依赖、不联网、不需要真实微信凭证）。
 *
 *   node deploy/wechat-domain.test.mjs
 *
 * 覆盖：参数校验、凭证缺失、dry-run 不提交、先 get 再 add、请求体构造、
 * 凭证不回显、域名已存在跳过、方式一路径、61007 权限集提示、
 * 方式二 45082 未备案、85015/86102 错误码释义、errcode=0 但
 * no_icp_domain 的伪成功、以及发布后生效域名查询。
 *
 * 注意：必须使用异步 spawn。spawnSync 会阻塞父进程事件循环，本机 mock server
 * 无法响应，子进程 fetch 会超时。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'wechat-domain.mjs');
const TARGET = 'https://api.maolizheng.xyz';
const PORT = 8794;

// 微信官方错误码（modifyserverdomaindirectly / modifyserverdomain）返回的原始形态
const ERR_SCENARIOS = {
  err45082: { errcode: 45082, errmsg: 'need icp license for the url domain' },
  err85015: { errcode: 85015, errmsg: '该账号不是小程序账号' },
  err86102: { errcode: 86102, errmsg: '每个月只能修改50次，超过域名修改次数限制' },
  err85303: {
    errcode: 85303,
    errmsg: 'no domain to modify after filtered, please confirm the domain has ICP licenses',
  },
};

let scenario = 'normal';
let hasTarget = false;
const calls = [];

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const path = new URL(req.url, 'http://x').pathname;
    calls.push({ path, body });
    res.setHeader('content-type', 'application/json');

    if (path === '/wxa/get_effective_domain') {
      res.end(JSON.stringify({
        errcode: 0, errmsg: 'ok',
        mp_domain: { requestdomain: ['https://mp.example.com'] },
        third_domain: { requestdomain: [] },
        direct_domain: { requestdomain: [TARGET] },
        effective_domain: { requestdomain: [TARGET] },
      }));
      return;
    }
    if (body.action === 'get') {
      res.end(JSON.stringify({
        errcode: 0, errmsg: 'ok',
        requestdomain: hasTarget ? [TARGET] : ['https://old.example.com'],
        wsrequestdomain: [], uploaddomain: [], downloaddomain: [],
        udpdomain: [], tcpdomain: [],
      }));
      return;
    }
    if (scenario === 'err61007') {
      res.end(JSON.stringify({ errcode: 61007, errmsg: 'api is unauthorized to component' }));
      return;
    }
    if (scenario === 'noicp') {
      // 方式一 modify_domain 的伪成功形态：errcode=0 但仍带被拒域名
      res.end(JSON.stringify({ errcode: 0, errmsg: 'ok', no_icp_domain: [TARGET] }));
      return;
    }
    if (ERR_SCENARIOS[scenario]) {
      res.end(JSON.stringify(ERR_SCENARIOS[scenario]));
      return;
    }
    res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '127.0.0.1', resolve);
});

function run(args = [], withToken = true) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: {
        ...process.env,
        WX_API_BASE: `http://127.0.0.1:${PORT}`,
        WX_AUTHORIZER_ACCESS_TOKEN: withToken ? 'fake-token-ABCDEFG' : '',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
}

// 1. 参数与帮助
check('--help 退出 0', (await run(['--help'])).status === 0);
check('缺凭证退出 2', (await run([], false)).status === 2);
check('非法域名退出 2', (await run(['--domain', 'http://x.com:8080/a'])).status === 2);

// 2. dry-run：打印请求体但不提交 add
calls.length = 0;
const dry = await run([]);
check('dry-run 退出 0', dry.status === 0, dry.stderr);
check('dry-run 只调用 get', calls.length === 1 && calls[0]?.body?.action === 'get');
check('dry-run 打印请求体', dry.stdout.includes('"action": "add"') && dry.stdout.includes(TARGET));
check('凭证未回显', !dry.stdout.includes('fake-token-ABCDEFG'));

// 3. apply：先 get 再 add
calls.length = 0;
const applied = await run(['--apply']);
const addCall = calls[1];
check('--apply 退出 0', applied.status === 0, applied.stderr);
check('apply 发起 get + add', calls.length === 2 && addCall?.body?.action === 'add');
check('add 只带目标域名', JSON.stringify(addCall?.body?.requestdomain) === JSON.stringify([TARGET]));
check('其它域名字段为空数组', ['wsrequestdomain', 'uploaddomain', 'downloaddomain', 'udpdomain', 'tcpdomain']
  .every((f) => Array.isArray(addCall?.body?.[f]) && addCall.body[f].length === 0));
check('apply 提示发布后生效', applied.stdout.includes('发布上线后才真正生效'));

// 4. 已存在则跳过
hasTarget = true;
calls.length = 0;
const exists = await run(['--apply']);
check('域名已存在时跳过 add', exists.status === 0 && calls.length === 1);
check('已存在给出提示', exists.stdout.includes('无需修改'));
hasTarget = false;

// 5. 方式一使用另一条路径
calls.length = 0;
await run(['--mode', 'standard', '--apply']);
check('standard 走 /wxa/modify_domain', calls[0]?.path === '/wxa/modify_domain');

// 6. 错误码提示
scenario = 'err61007';
const err = await run(['--apply']);
check('61007 退出 1', err.status === 1);
check('61007 给出权限集提示', err.stderr.includes('权限集 18'));

// 7. 方式二未备案：45082（不是 no_icp_domain 字段）
scenario = 'err45082';
const e45082 = await run(['--apply']);
check('45082 退出 1', e45082.status === 1);
check('45082 给出 ICP 备案提示', e45082.stderr.includes('ICP 备案'));
check('45082 不再误报域名数量问题', !e45082.stderr.includes('域名数量或格式'));

// 8. 错误码释义按官方文档校正
scenario = 'err85015';
const e85015 = await run(['--apply']);
check('85015 = 该账号不是小程序账号', e85015.stderr.includes('该账号不是小程序账号'));

scenario = 'err86102';
const e86102 = await run(['--apply']);
check('86102 提示 50 次上限', e86102.stderr.includes('50 次'));

scenario = 'err85303';
const e85303 = await run(['--mode', 'standard', '--apply']);
check('85303 提示备案/规则问题', e85303.stderr.includes('ICP 备案') || e85303.stderr.includes('域名规则'));

// 9. 方式一 errcode=0 但 no_icp_domain 的伪成功
scenario = 'noicp';
const noicp = await run(['--apply']);
check('no_icp_domain 被识别', noicp.status === 1 && noicp.stderr.includes('ICP 备案'));
scenario = 'normal';

// 10. 生效域名查询
const eff = await run(['--effective']);
check('--effective 退出 0', eff.status === 0, eff.stderr);
check('打印发布后生效域名', eff.stdout.includes('effective_domain') && eff.stdout.includes(TARGET));

server.close();
console.log(`\n=== wechat-domain mock: ${pass}/${pass + fail} 通过 ===`);
process.exit(fail ? 1 : 0);
