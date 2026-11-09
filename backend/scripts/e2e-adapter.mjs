/**
 * 前端适配层端到端验证：把真实的 src/supabase/selfhost-client.ts 打包后在 Node 里跑，
 * 对着真实启动的自建后端执行一遍聊天主链路。
 *
 *   node scripts/e2e-adapter.mjs
 *
 * 前置：dev-db 已启动、后端已在 4000 端口运行。
 * 目的：验证「适配器的响应解包 / .select() 语义 / single() / storage」这些
 *      只有前端侧才会暴露的问题（后端 smoke 测不到）。
 */
import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '.tmp');
const OUT_FILE = join(OUT_DIR, 'selfhost-client.mjs');

mkdirSync(OUT_DIR, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(HERE, '../../src/supabase/selfhost-client.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: OUT_FILE,
  alias: {
    '@tarojs/taro': resolve(HERE, '_taro-stub.mjs'),
  },
  // 适配器里读 import.meta.env.VITE_SELFHOST_API_BASE；置空即回落到默认 http://localhost:4000
  define: { 'import.meta.env': '{}' },
  logLevel: 'silent',
});

const { selfhostClient } = await import(pathToFileURL(OUT_FILE).href);

const BASE = process.env.SMOKE_BASE || 'http://localhost:4000';
const RUN = Date.now().toString(36).slice(-6);

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
function section(t) {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 40 - t.length))}`);
}

const sb = selfhostClient;

// ── 注册（走适配器 signUp）────────────────────────────────────────────────
section('适配器 auth.signUp');
const username = `adapter_${RUN}`;
{
  const { data, error } = await sb.auth.signUp({
    email: `${username}@meoo.local`,
    password: 'pass1234',
    options: { data: { username } },
  });
  check('signUp → 返回 user + session（已解包）', !!data?.session?.access_token && data.user?.username === username, {
    data,
    error,
  });
}

// ── 登录 ───────────────────────────────────────────────────────────────────
section('适配器 auth.signInWithPassword');
{
  const { data, error } = await sb.auth.signInWithPassword({
    email: username,
    password: 'pass1234',
  });
  check('用用户名登录 → session 就绪', !!data?.session?.access_token, { data, error });
}
{
  const { data, error } = await sb.auth.getSession();
  check('getSession → 读到本地会话', !!data?.session?.access_token, { data, error });
}
const myId = (await sb.auth.getUser()).data?.user?.id;
check('getUser → 返回本人 id', !!myId, { myId });

// ── 注册第二个用户（直连 HTTP，避免适配器单例覆盖本地 token）──────────────
section('准备对端用户');
let peerId = null;
let peerToken = null;
{
  const peerName = `peer_${RUN}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: peerName, password: 'pass1234' }),
  });
  const json = await res.json();
  peerId = json?.data?.user?.id;
  peerToken = json?.data?.session?.access_token;
  check('对端用户创建成功', !!peerId && !!peerToken, json);
}

// ── 查询：select + eq + single ─────────────────────────────────────────────
section('适配器 .from().select()');
{
  const { data, error } = await sb
    .from('profiles')
    .select('id,username,nickname')
    .eq('id', peerId)
    .single();
  check('select 链式查询 → data 直接是行对象（不是 {data,error}）', data && !Array.isArray(data) && data.id === peerId, {
    data,
    error,
  });
  check('查询结果不含 password_hash', data && !('password_hash' in data), data);
}
{
  const { data, error } = await sb.from('profiles').select('id').limit(2);
  check('无 single 的 select → data 是数组', Array.isArray(data), { data, error });
}

// ── 插入：insert + select + single（创建会话的真实用法）────────────────────
section('适配器 .insert().select().single()');
let convId = null;
{
  const { data, error } = await sb
    .from('conversations')
    .insert({ user1_id: myId, user2_id: peerId })
    .select('*')
    .single();
  convId = data?.id ?? null;
  check('建会话 → 返回单条会话对象', !!convId && data.user1_id === myId, { data, error });
}
{
  const { data, error } = await sb
    .from('messages')
    .insert({ conversation_id: convId, content: `adapter-hi-${RUN}` })
    .select('*')
    .single();
  check('发消息 → 返回单条消息对象且 sender 为本人', !!data?.id && data.sender_id === myId, { data, error });
}

// ── 更新 ───────────────────────────────────────────────────────────────────
section('适配器 .update().select().single()');
{
  const { data, error } = await sb
    .from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('sender_id', myId)
    .select('id,read_at')
    .limit(1);
  check('update 链 → 返回数组（未加 single）', Array.isArray(data), { data, error });
}

// ── RPC ────────────────────────────────────────────────────────────────────
section('适配器 .rpc()');
{
  const { data, error } = await sb.rpc('get_conversation_summaries', {});
  const row = (data ?? []).find((x) => x.conversation_id === convId);
  check('get_conversation_summaries → 命中新会话', !!row, { data, error });
}

// ── storage ────────────────────────────────────────────────────────────────
section('适配器 storage');
{
  const content = `adapter-file-${RUN}`;
  const { data, error } = await sb.storage
    .from('avatars')
    .upload(`e2e/${RUN}.txt`, new TextEncoder().encode(content).buffer, {
      contentType: 'text/plain',
    });
  check('upload → 返回 path 与 publicUrl', !!data?.path && !!data?.publicUrl, { data, error });

  if (data?.publicUrl) {
    const full = /^https?:\/\//i.test(data.publicUrl) ? data.publicUrl : `${BASE}${data.publicUrl}`;
    const res = await fetch(full);
    const text = await res.text();
    check('upload 后回读内容一致', res.status === 200 && text === content, { status: res.status, text });

    const rm = await sb.storage.from('avatars').remove([`e2e/${RUN}.txt`]);
    check('remove → 真实转发后端删除接口', !rm.error && rm.data?.removed === 1, {
      data: rm.data, error: rm.error,
    });
    const after = await fetch(full);
    check('remove 后公开读返回 404', after.status === 404, { status: after.status });
  }
}
{
  const { data } = sb.storage.from('avatars').getPublicUrl('e2e/x.txt');
  check('getPublicUrl → 拼出可访问路径', typeof data?.publicUrl === 'string' && data.publicUrl.includes('/api/storage/public/'), data);
}

// ── 登出 ───────────────────────────────────────────────────────────────────
section('适配器 signOut');
{
  await sb.auth.signOut();
  const { data } = await sb.auth.getSession();
  check('signOut 后本地会话清空', data?.session === null, data);
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('适配层与后端契约一致 ✅');
process.exit(0);
