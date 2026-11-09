/**
 * 自建后端端到端冒烟测试（不依赖任何测试框架，node 直接跑）。
 *
 *   node scripts/smoke.mjs                     # 默认 http://localhost:4000
 *   SMOKE_BASE=http://localhost:4000 node scripts/smoke.mjs
 *
 * 覆盖：健康检查 → 注册/登录/会话 → 会话与消息读写 → RLS 等效越权拦截
 *      → 敏感列不外泄 → 触发器 → RPC → 存储鉴权与读写 → Socket.IO 实时推送
 *
 * 退出码 0 = 全通过；非 0 = 有失败项。
 */

const BASE = (process.env.SMOKE_BASE || 'http://localhost:4000').replace(/\/+$/, '');
const RUN = Date.now().toString(36).slice(-6); // 每次跑用唯一用户名，可重复执行

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json, headers: res.headers };
}

const db = (token, spec) => api('POST', '/api/db', { token, body: spec });
const rpc = (token, name, params) => api('POST', '/api/rpc', { token, body: { name, params } });

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 42 - title.length))}`);
}

// ────────────────────────────────────────────────────────────────────────────
section('健康检查');
{
  const r = await api('GET', '/api/health');
  check('GET /api/health → 200 ok', r.status === 200 && r.body?.ok === true, r.body);
}

// ────────────────────────────────────────────────────────────────────────────
section('注册与校验');
const users = {};
for (const name of ['alice', 'bob', 'carol']) {
  const username = `${name}_${RUN}`;
  const r = await api('POST', '/api/auth/register', {
    body: { username, password: 'pass1234' },
  });
  check(
    `注册 ${name} → 201 并签发 access_token`,
    r.status === 201 && typeof r.body?.data?.session?.access_token === 'string',
    r.body,
  );
  users[name] = {
    username,
    id: r.body?.data?.user?.id,
    token: r.body?.data?.session?.access_token,
  };
}

{
  const r = await api('POST', '/api/auth/register', {
    body: { username: users.alice.username, password: 'pass1234' },
  });
  check('重复用户名注册 → 409', r.status === 409, r.body);
}
{
  const r = await api('POST', '/api/auth/register', {
    body: { username: `x_${RUN}`, password: '123' },
  });
  check('密码过短 → 400', r.status === 400, r.body);
}
{
  const r = await api('POST', '/api/auth/register', {
    body: { username: 'bad name!', password: 'pass1234' },
  });
  check('用户名非法字符 → 400', r.status === 400, r.body);
}

// ────────────────────────────────────────────────────────────────────────────
section('登录与会话');
{
  const r = await api('POST', '/api/auth/login', {
    body: { email: users.alice.username, password: 'pass1234' },
  });
  check('用户名直登 → 200', r.status === 200 && !!r.body?.data?.session?.access_token, r.body);
}
{
  const r = await api('POST', '/api/auth/login', {
    body: { email: `${users.alice.username}@meoo.local`, password: 'pass1234' },
  });
  check('占位邮箱 {username}@meoo.local 登录 → 200', r.status === 200, r.body);
}
{
  const r = await api('POST', '/api/auth/login', {
    body: { email: users.alice.username, password: 'wrong-pass' },
  });
  check('错误密码 → 401', r.status === 401, r.body);
}
{
  const r = await api('GET', '/api/auth/session', { token: users.alice.token });
  check('带 token 取会话 → session 非空', r.status === 200 && !!r.body?.data?.session, r.body);
}
{
  const r = await api('GET', '/api/auth/session');
  check('无 token 取会话 → session 为 null', r.body?.data?.session === null, r.body);
}
{
  const r = await db('bogus-token', { op: 'select', table: 'profiles' });
  check('伪造 token 访问 /api/db → 401', r.status === 401, r.body);
}

// ────────────────────────────────────────────────────────────────────────────
section('会话创建与权限隔离');
let convId = null;
{
  // 只传对方 id，服务端应把当前用户补为 user1_id
  const r = await db(users.alice.token, {
    op: 'insert',
    table: 'conversations',
    values: { user2_id: users.bob.id },
  });
  convId = r.body?.data?.[0]?.id ?? null;
  check('建会话（只传对方）→ 成功且 user1_id 被补为本人', !!convId && r.body?.data?.[0]?.user1_id === users.alice.id, r.body);
}
{
  const r = await db(users.carol.token, { op: 'select', table: 'conversations' });
  const hit = (r.body?.data ?? []).some((c) => c.id === convId);
  check('非参与者 carol 读不到该会话（RLS 等效）', r.status === 200 && !hit, r.body);
}
{
  const r = await db(users.alice.token, { op: 'select', table: 'conversations' });
  const hit = (r.body?.data ?? []).some((c) => c.id === convId);
  check('参与者 alice 能读到该会话', hit, r.body);
}
{
  const r = await db(users.carol.token, {
    op: 'insert',
    table: 'conversations',
    values: { user1_id: users.alice.id, user2_id: users.bob.id },
  });
  check('替他人建会话（双方都不是自己）→ 被拒', !!r.body?.error, r.body);
}

// ────────────────────────────────────────────────────────────────────────────
section('消息读写与触发器');
let msgId = null;
{
  const r = await db(users.alice.token, {
    op: 'insert',
    table: 'messages',
    values: { conversation_id: convId, content: `hello-${RUN}` },
  });
  msgId = r.body?.data?.[0]?.id ?? null;
  check('alice 发消息 → 成功且 sender_id 为本人', !!msgId && r.body?.data?.[0]?.sender_id === users.alice.id, r.body);
}
{
  const r = await db(users.bob.token, { op: 'select', table: 'messages' });
  const hit = (r.body?.data ?? []).some((m) => m.id === msgId);
  check('bob（对话对方）能读到消息', hit, r.body);
}
{
  const r = await db(users.carol.token, { op: 'select', table: 'messages' });
  const hit = (r.body?.data ?? []).some((m) => m.id === msgId);
  check('carol（无关者）读不到消息', !hit, r.body);
}
{
  const r = await db(users.carol.token, {
    op: 'insert',
    table: 'messages',
    values: { conversation_id: convId, content: 'intrude' },
  });
  check('carol 往别人的会话发消息 → 被拒', !!r.body?.error, r.body);
}
{
  const r = await db(users.alice.token, {
    op: 'insert',
    table: 'messages',
    values: { conversation_id: convId, content: 'spoof', sender_id: users.bob.id },
  });
  check('伪造 sender_id → 被服务端改写为本人', r.body?.data?.[0]?.sender_id === users.alice.id, r.body);
}
{
  const r = await db(users.alice.token, {
    op: 'select',
    table: 'conversations',
    filters: [{ t: 'eq', c: 'id', v: convId }],
  });
  const row = (r.body?.data ?? [])[0];
  check('触发器：last_message 已随消息更新', row?.last_message === 'spoof' && !!row?.last_message_at, row);
}

// ────────────────────────────────────────────────────────────────────────────
section('敏感列不外泄');
{
  const r = await db(users.alice.token, { op: 'select', table: 'profiles' });
  const rows = r.body?.data ?? [];
  const leaked = rows.filter((p) => 'password_hash' in p || 'recovery_token_hash' in p);
  check('profiles 全量查询不含 password_hash / recovery_token_hash', rows.length > 0 && leaked.length === 0, {
    count: rows.length,
    leakedSample: leaked[0],
  });
}
{
  const r = await db(users.alice.token, {
    op: 'select',
    table: 'profiles',
    columns: 'id,username',
    filters: [{ t: 'eq', c: 'username', v: users.bob.username }],
    single: true,
  });
  check('按 username 精确查对端资料 → 命中且字段受控', r.body?.data?.id === users.bob.id, r.body);
}
{
  const r = await db(users.alice.token, {
    op: 'select',
    table: 'profiles',
    columns: 'password_hash',
  });
  check('客户端主动请求 password_hash → 被列白名单拒绝', !!r.body?.error, r.body);
}

// ────────────────────────────────────────────────────────────────────────────
section('其他表的所有权约束');
{
  const day = '2026-11-06';
  const r = await db(users.alice.token, {
    op: 'insert',
    table: 'user_we_run_steps',
    values: { day, steps: 8888, user_id: users.bob.id },
  });
  check('步数写入伪造 user_id → 被改写为本人', r.body?.data?.[0]?.user_id === users.alice.id, r.body);

  const rb = await db(users.bob.token, { op: 'select', table: 'user_we_run_steps' });
  const hit = (rb.body?.data ?? []).some((s) => s.user_id === users.alice.id);
  check('bob 读不到 alice 的步数记录', !hit, rb.body);
}

// ────────────────────────────────────────────────────────────────────────────
section('PostgREST 语义兼容（适配器关键路径）');
{
  // 对应 supabase.from('x').insert(v).select('*').single()
  const r = await db(users.alice.token, {
    op: 'insert',
    table: 'conversations',
    values: { user1_id: users.alice.id, user2_id: users.carol.id },
    columns: '*',
    single: true,
  });
  const row = r.body?.data;
  check(
    'insert + select(*) + single → 返回单行对象（非数组）',
    row && !Array.isArray(row) && row.id && row.user1_id === users.alice.id,
    r.body,
  );

  const convId2 = row?.id;
  if (convId2) {
    // 对应 supabase.from('x').update(v).select('id').single()
    const u = await db(users.alice.token, {
      op: 'update',
      table: 'conversations',
      values: { last_message: 'touched' },
      filters: [{ t: 'eq', c: 'id', v: convId2 }],
      columns: 'id',
      single: true,
    });
    check(
      'update + select + single → 返回单行对象',
      u.body?.data && !Array.isArray(u.body.data) && u.body.data.id === convId2,
      u.body,
    );
  } else {
    check('update + select + single → 返回单行对象', false, '上一步未拿到会话 id');
  }

  // single 命中多行时必须报错，不能静默取第一条
  const multi = await db(users.alice.token, {
    op: 'select',
    table: 'profiles',
    single: true,
  });
  check('single 命中多行 → 返回错误', !!multi.body?.error, multi.body);
}

// ────────────────────────────────────────────────────────────────────────────
section('RPC');
{
  const r = await rpc(users.alice.token, 'get_conversation_summaries', {});
  const row = (r.body?.data ?? []).find((x) => x.conversation_id === convId);
  check('get_conversation_summaries → 返回该会话且统计正确', !!row && Number(row.visible_count) >= 2, r.body);
}
{
  const r = await rpc(users.alice.token, 'unknown_fn', {});
  check('未知 RPC → 404', r.status === 404, r.body);
}

// ────────────────────────────────────────────────────────────────────────────
section('存储鉴权与读写');
{
  const r = await api('POST', '/api/storage/upload', {
    body: { bucket: 'avatars', path: 'x.txt', contentBase64: 'aGk=' },
  });
  check('无 token 上传 → 401', r.status === 401, r.body);
}
{
  const r = await api('POST', '/api/storage/upload', {
    token: 'fake.token.here',
    body: { bucket: 'avatars', path: 'x.txt', contentBase64: 'aGk=' },
  });
  check('伪造 Bearer 上传 → 401（前缀存在但验签失败）', r.status === 401, r.body);
}
{
  const payload = Buffer.from(`smoke-${RUN}`).toString('base64');
  const path = `smoke/${RUN}.txt`;
  const up = await api('POST', '/api/storage/upload', {
    token: users.alice.token,
    body: { bucket: 'avatars', path, contentBase64: payload, contentType: 'text/plain' },
  });
  check('合法上传 → 200 并回传 publicUrl', up.status === 200 && !!up.body?.data?.publicUrl, up.body);

  const url = up.body?.data?.publicUrl;
  if (url) {
    const full = url.startsWith('http') ? url : `${BASE}${url}`;
    const res = await fetch(full);
    const text = await res.text();
    check('回读上传内容一致', res.status === 200 && text === `smoke-${RUN}`, { status: res.status, text });
  } else {
    check('回读上传内容一致', false, '无 publicUrl');
  }
}

// ────────────────────────────────────────────────────────────────────────────
section('实时推送（Socket.IO）');
{
  let io = null;
  try {
    ({ io } = await import('socket.io-client'));
  } catch {
    console.log('  ⚠️ 未安装 socket.io-client，跳过实时测试');
  }

  if (io) {
    const socket = io(BASE, {
      auth: { token: users.bob.token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });

    const connected = await new Promise((resolve) => {
      socket.on('connect', () => resolve(true));
      socket.on('connect_error', () => resolve(false));
      setTimeout(() => resolve(false), 5000);
    });
    check('Socket.IO 带 token 可连接', connected);

    if (connected) {
      const got = new Promise((resolve) => {
        socket.on('table:messages', (payload) => {
          if (payload?.new?.content === `live-${RUN}`) resolve(payload);
        });
        setTimeout(() => resolve(null), 5000);
      });
      // 触发一条写入，应广播出 table:messages INSERT
      await db(users.alice.token, {
        op: 'insert',
        table: 'messages',
        values: { conversation_id: convId, content: `live-${RUN}` },
      });
      const payload = await got;
      check('写消息后收到 table:messages INSERT 事件', !!payload && payload.eventType === 'INSERT', payload);
      socket.close();
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
section('双向删除后彻底清理');
{
  const r1 = await rpc(users.alice.token, 'purge_conversation_if_both_deleted', {
    _conversation_id: convId,
  });
  check('仅一方标记删除 → 不清理（返回 false）', r1.body?.data === false, r1.body);

  const r2 = await rpc(users.bob.token, 'purge_conversation_if_both_deleted', {
    _conversation_id: convId,
  });
  check('双方均标记删除 → 清理并返回 true', r2.body?.data === true, r2.body);

  const r3 = await db(users.alice.token, {
    op: 'select',
    table: 'conversations',
    filters: [{ t: 'eq', c: 'id', v: convId }],
  });
  check('会话已被彻底删除', (r3.body?.data ?? []).length === 0, r3.body);
}

// ────────────────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('全部通过 ✅');
process.exit(0);
