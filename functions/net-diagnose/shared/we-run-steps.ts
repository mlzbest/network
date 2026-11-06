/**
 * 微信运动步数共享模块（被 net-diagnose/index.ts 相对引用）
 *
 * ⚠️ 为什么放在函数目录内而不是 functions/ 顶层：每个 Edge Function 是**独立部署包**，
 *    跨函数目录的相对引用会在部署前 deno check 报 TS2307。共享模块必须落在该函数
 *    自己目录内、用 `./shared/...` 引用（与 set-account-email 的 password-recovery 同构）。
 *
 * 为什么必须有这段逻辑：`wx.getWeRunData()` 返回的是 **加密数据**
 * （encryptedData + iv），解密需要该用户本次登录的 `session_key`；
 * session_key 只能由服务端用 jscode2session 换取，绝不能下发前端。
 *
 * 流程：
 * 1. 前端 wx.login() 拿 code、getWeRunData() 拿 encryptedData/iv，一并 POST 过来
 * 2. code → jscode2session 换 openid + session_key
 * 3. AES-256-CBC(PKCS#7) 解密 encryptedData → { stepInfoList: [{ step, timestamp }] }
 * 4. upsert 进 public.user_we_run_steps（ON CONFLICT (user_id, day)）
 * 5. 顺带查回会话对方近 N 天步数（conversations 校验参与者身份，防越权窥探）
 *
 * ⚠️ 隐私硬约束：本接口属于采集类，**禁止**写进 app.config.ts 的 requiredPrivateInfos
 *    （那个字段只接受 8 个地理位置类接口，写了会让平台 CI 直接拒绝生成预览码）。
 *    真机报 "api scope is not declared in the privacy agreement" 的正解只在微信公众平台
 *    后台《用户隐私保护指引》勾选「微信运动步数」。
 *
 * 环境变量（必需）：WX_APP_ID / WX_APP_SECRET / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface Jscode2SessionResponse {
  openid?: string;
  session_key?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

interface WeRunStepItem {
  step?: number;
  timestamp?: number;
}

interface WeRunDecrypted {
  stepInfoList?: WeRunStepItem[];
  /** 部分基础库回包会带这两份冗余信息，仅用于日志核对，不落库 */
  rank?: string;
  totalRank?: string;
}

type Json = Record<string, unknown>;

const DAY_MS = 24 * 60 * 60 * 1000;

function json(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** base64 → bytes（Deno 内置 atob 即可，避免引入 std 依赖） */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** PKCS#7 去填充：微信加密数据块固定 32 字节对齐，填充长度 1~32 */
function stripPkcs7(buf: Uint8Array): Uint8Array {
  if (buf.length === 0) return buf;
  const pad = buf[buf.length - 1];
  if (pad <= 0 || pad > 32 || pad > buf.length) return buf;
  return buf.slice(0, buf.length - pad);
}

/**
 * 解密微信运动数据。
 * ⚠️ 必须 copyToArrayBuffer 新建 ArrayBuffer：WebCrypto 要求 key/iv/data 都是
 *    **非共享内存**的 ArrayBuffer，直接传 TypedBuffer.buffer 在部分运行时会被拒。
 */
async function decryptWeRunData(
  encryptedB64: string,
  sessionKeyB64: string,
  ivB64: string,
): Promise<WeRunDecrypted> {
  const keyData = b64ToBytes(sessionKeyB64);
  const ivData = b64ToBytes(ivB64);
  const cipherData = b64ToBytes(encryptedB64);

  const copyToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
    const ab = new ArrayBuffer(bytes.length);
    new Uint8Array(ab).set(bytes);
    return ab;
  };

  const key = await crypto.subtle.importKey('raw', copyToArrayBuffer(keyData), 'AES-CBC', false, [
    'decrypt',
  ]);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: copyToArrayBuffer(ivData) },
    key,
    copyToArrayBuffer(cipherData),
  );
  const trimmed = stripPkcs7(new Uint8Array(plain));
  return JSON.parse(new TextDecoder().decode(trimmed)) as WeRunDecrypted;
}

/**
 * 把微信回包的时间戳归一成东八区「日」键（YYYY-MM-DD）。
 * ⚠️ 不能用 UTC：若按 UTC 切日，中国用户会把 0~8 点的跨零点数据算到前一天，
 *    导致「今天步数」比微信运动里少一大截。Edge Runtime 的默认时区即容器时区，
 *    这里显式用 Intl 取 Asia/Shanghai 兜底，保证与小程序端展示口径一致。
 * ⚠️ 必须做秒/毫秒自适应（实测踩过）：官方文档说 stepInfoList.timestamp 是毫秒，
 *    但真机回包出现过**秒级**值——1759xxx000 当毫秒解析就是 1970-01-22，
 *    库里落的就是这种错日期。判据：数值 < 1e11（约等于公元 3365 年的毫秒值）
 *    视为秒并 ×1000；Date.now() 恒 ≥ 1.7e12，永远不会被误伤。
 */
function toEpochMs(ts: number): number {
  return ts < 1e11 ? ts * 1000 : ts;
}
function toDayKey(ms: number): string {
  const d = new Date(ms);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    if (map.year && map.month && map.day) return `${map.year}-${map.month}-${map.day}`;
  } catch {
    /* 运行时不支持该 timeZone 时回落本地时区 */
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 从 stepInfoList 提取「今日步数」与近 days 天序列。
 * 微信回包是按小时切片的数组（每条约 15 分钟~1 小时粒度），
 * 同一天内 **最后一条** 才是当天累计值——直接 sum 会把累计重复叠加好几倍。
 */
function extractSteps(
  list: WeRunStepItem[],
  days: number,
): { today: number; series: Array<{ day: string; steps: number }> } {
  const byDay = new Map<string, number>();
  let maxTs = 0;
  let coercedCount = 0;
  for (const item of list) {
    const raw = Number(item?.timestamp ?? 0);
    const step = Number(item?.step ?? 0);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    // 秒/毫秒自适应：真机回包出现过秒级 timestamp，直接当毫秒会归到 1970 年
    const ts = toEpochMs(raw);
    if (ts !== raw) coercedCount++;
    const key = toDayKey(ts);
    if (maxTs <= ts) maxTs = ts;
    // 同一天的后写入值覆盖前值（回包本身按时间升序，故最终留下的是当日累计）
    byDay.set(key, step);
  }
  if (coercedCount > 0) {
    console.info(`[we-run-steps] ⏱ stepInfoList 有 ${coercedCount}/${list.length} 条 timestamp 为秒级，已 ×1000 修正为毫秒`);
  }
  const sorted = Array.from(byDay.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-Math.max(1, days))
    .map(([day, steps]) => ({ day, steps }));
  const todayKey = maxTs > 0 ? toDayKey(maxTs) : toDayKey(Date.now());
  const today = byDay.get(todayKey) ?? sorted[sorted.length - 1]?.steps ?? 0;
  return { today, series: sorted };
}

/**
 * code → openid + session_key。
 * 每次调用都现换：session_key 会随用户重新登录刷新，缓存旧 key 必然解密失败
 * （报 bad openid / aes decrypt error），宁多一次上游请求也不做进程内缓存。
 */
async function exchangeCode(code: string): Promise<Jscode2SessionResponse> {
  const appid = Deno.env.get('WX_APP_ID');
  const secret = Deno.env.get('WX_APP_SECRET');
  if (!appid || !secret) {
    throw new Error('微信配置缺失：请到「云服务 → 登录认证 → 微信登录」配置 WX_APP_ID 和 WX_APP_SECRET');
  }
  const url =
    `https://api.weixin.qq.com/sns/jscode2session` +
    `?appid=${encodeURIComponent(appid)}` +
    `&secret=${encodeURIComponent(secret)}` +
    `&js_code=${encodeURIComponent(code)}` +
    `&grant_type=authorization_code`;
  const res = await fetch(url);
  const data = (await res.json()) as Jscode2SessionResponse;
  if (data.errcode || !data.openid || !data.session_key) {
    throw new Error(
      `换取 session_key 失败: ${data.errmsg || '微信未返回 openid/session_key'}${data.errcode ? `(${data.errcode})` : ''}`,
    );
  }
  return data;
}

/**
 * openid → profiles.id（真实 UUID）。
 * ⚠️ 本运行时的 supabase-js 2.117.x 的 `auth.admin` **没有** getUserByEmail
 *    （部署前 deno check 实测 TS2551），所以走 public.profiles：
 *    wx-mp-login 建号时把 openid 写进了 profiles.openid 列，直接按它反查即可，
 *    比翻 auth.users 更省且不受网关 schema 白名单限制。
 */
async function resolveUserId(openid: string, requestId: string): Promise<string | null> {
  // ⚠️ client 必须在使用处就地创建：跨函数传 client 会让 Schema 被推成 never，
  //    行类型随之变 never（首次部署实测 TS2339/TS2345）。
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await admin
    .from('profiles')
    .select('id')
    .eq('openid', openid)
    .limit(1);
  if (error) {
    console.warn(`[we-run-steps] 按 openid 反查资料失败: ${error.message}`);
    return null;
  }
  const row = (data ?? [])[0] as { id?: unknown } | undefined;
  console.info(
    `[we-run-steps] ${requestId} openid 反查账号 ${typeof row?.id === 'string' ? '命中' : '未命中'}`,
  );
  return typeof row?.id === 'string' ? row.id : null;
}

/**
 * 把 openid 补绑到指定账号（profile 行必须已存在）。
 * 用于「用户名密码注册的存量账号首次同步微信步数」时打通身份：
 * 这些账号建号时没有微信 openid，profiles.openid 为空，反查必然落空。
 * ⚠️ 只更新已有 profile 行（.eq('id', uid)），绝不新建；client 就地创建，理由同 resolveUserId。
 */
async function bindOpenidToProfile(uid: string, openid: string, requestId: string): Promise<boolean> {
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await admin
    .from('profiles')
    .update({ openid })
    .eq('id', uid)
    .is('openid', null)
    .select('id');
  if (error) {
    console.warn(`[we-run-steps] 绑定 openid 失败: ${error.message}`);
    return false;
  }
  const bound = (data ?? []).length > 0;
  console.info(`[we-run-steps] ${requestId} openid 补绑账号 ${bound ? '成功' : '未命中(账号不存在或已被其他微信占用)'}`);
  return bound;
}

/** 是否存在 me 与 peer 的双人会话（校验「确实是聊天对象」才允许看其步数） */
async function hasConversationBetween(me: string, peer: string): Promise<boolean> {
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await admin
    .from('conversations')
    .select('id')
    .or(`and(user1_id.eq.${me},user2_id.eq.${peer}),and(user1_id.eq.${peer},user2_id.eq.${me})`)
    .limit(1);
  if (error) {
    console.warn(`[we-run-steps] 查询会话失败: ${error.message}`);
    return false;
  }
  return (data ?? []).length > 0;
}

/** 读取一批人在 sinceDay 之后的步数明细（调用方须已完成参与者越权校验） */
async function readStepsRows(
  userIds: string[],
  sinceDay: string,
): Promise<Array<{ user_id: string; day: string; steps: number }>> {
  if (userIds.length === 0) return [];
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await admin
    .from('user_we_run_steps')
    .select('user_id,day,steps')
    .in('user_id', userIds)
    .gte('day', sinceDay)
    .order('day', { ascending: true });
  if (error) throw new Error(`查询步数失败: ${error.message}`);
  return (data ?? []) as Array<{ user_id: string; day: string; steps: number }>;
}

/**
 * 读取某人**全历史**最近一次同步的日期（不限时间窗）。
 * 用途：区分「对方从未同步过」与「对方同步过但近期没同步」——只查近 N 天窗口
 * 无法区分这两种情况（都表现为空数组），必须单独探一次全历史最新日期。
 * 返回 '' 表示该用户从未落库过任何步数。
 */
async function readLatestDay(userId: string): Promise<string> {
  if (!userId) return '';
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await admin
    .from('user_we_run_steps')
    .select('day')
    .eq('user_id', userId)
    .order('day', { ascending: false })
    .limit(1);
  if (error) {
    console.warn(`[we-run-steps] 查询最近同步日失败: ${error.message}`);
    return '';
  }
  const row = (data ?? [])[0] as { day?: unknown } | undefined;
  return row?.day ? String(row.day) : '';
}

/**
 * 入口分发：由宿主函数的路由在识别到 `action=steps-query` / `action=steps-sync` 时调用。
 * 返回 Response，宿主直接透传（不套诊断项的 ItemResult 结构）。
 */
export async function handleWeRunSteps(req: Request, requestId: string): Promise<Response> {
  const startTime = Date.now();
  const body = (await req.json()) as Json;
  const action = typeof body.action === 'string' ? body.action : '';

  try {
    // ---------- 纯查询动作：不需要 code，只按已落库的数据出对比 ----------
    if (action === 'steps-query') {
      const myId = typeof body.user_id === 'string' ? body.user_id : '';
      const peerId = typeof body.peer_id === 'string' ? body.peer_id : '';
      const days = Math.min(Math.max(Number(body.days) || 7, 1), 30);
      if (!myId) return json({ error: '缺少 user_id' }, 400);

      const sinceDay = toDayKey(Date.now() - (days - 1) * DAY_MS);

      // 越权闸门：只有确实存在双人会话时才查对方数据
      let allowedPeer = '';
      if (peerId && peerId !== myId) {
        if (await hasConversationBetween(myId, peerId)) {
          allowedPeer = peerId;
        } else {
          console.warn(`[we-run-steps] query ${requestId} 无双人会话，拒绝返回对方步数`);
        }
      }

      const rows = await readStepsRows(allowedPeer ? [myId, allowedPeer] : [myId], sinceDay);
      const mine = rows
        .filter((r) => r.user_id === myId)
        .map((r) => ({ day: String(r.day), steps: Number(r.steps) }));
      const peerRows = allowedPeer
        ? rows
            .filter((r) => r.user_id === allowedPeer)
            .map((r) => ({ day: String(r.day), steps: Number(r.steps) }))
        : [];
      // 对方全历史最近同步日：用于前端区分「从未同步」与「近期没同步」
      const peerLastDay = allowedPeer ? await readLatestDay(allowedPeer) : '';
      console.info(
        `[we-run-steps] query ${requestId} mine=${mine.length} peer=${peerRows.length} peerLastDay=${peerLastDay || '无'} durationMs=${Date.now() - startTime}`,
      );
      return json({ ok: true, mine, peer: peerRows, peerAllowed: Boolean(allowedPeer), peerLastDay });
    }

    // ---------- 同步动作：解密并落库本人当日步数 ----------
    const code = typeof body.code === 'string' ? body.code : '';
    const encryptedData = typeof body.encryptedData === 'string' ? body.encryptedData : '';
    const iv = typeof body.iv === 'string' ? body.iv : '';
    const peerId = typeof body.peer_id === 'string' ? body.peer_id : '';
    // 前端已登录账号的真实 uid（密码注册的老账号也带得上），用于 openid 未命中时补绑身份
    const clientUid = typeof body.user_id === 'string' ? body.user_id : '';
    const days = Math.min(Math.max(Number(body.days) || 7, 1), 30);

    if (!code || !encryptedData || !iv) {
      return json({ error: '参数不完整：需要 code / encryptedData / iv' }, 400);
    }

    const wx = await exchangeCode(code);
    const decrypted = await decryptWeRunData(encryptedData, wx.session_key!, iv);
    const list = Array.isArray(decrypted.stepInfoList) ? decrypted.stepInfoList : [];
    if (list.length === 0) {
      console.warn(`[we-run-steps] sync ${requestId} 解密成功但 stepInfoList 为空`);
      return json({ error: '微信未返回步数明细，可能是尚未授权或未产生过运动数据' }, 422);
    }

    const { today, series } = extractSteps(list, days);
    // 身份解析：① openid 已绑过账号 → 直接归属该账号；
    // ② 未命中且前端带了已登录 uid → 把 openid 补绑到该账号（老密码账号首次同步）；
    // ③ 两者都没有 → 无法定位身份，提示重试。
    let uid = await resolveUserId(wx.openid!, requestId);
    if (!uid && clientUid) {
      const bound = await bindOpenidToProfile(clientUid, wx.openid!, requestId);
      if (bound) uid = clientUid;
    }
    if (!uid) {
      console.warn(`[we-run-steps] sync ${requestId} openid 未对应到账号`);
      return json({ error: '账号信息尚未初始化完成，请重新进入小程序后再试' }, 409);
    }

    // 逐日 upsert（一般 1~N 条，量极小）。client 就地创建，理由同 resolveUserId。
    const writer = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const upsertRows = series.map((s) => ({ user_id: uid, day: s.day, steps: s.steps }));
    if (upsertRows.length > 0) {
      const { data: written, error: upErr } = await writer
        .from('user_we_run_steps')
        .upsert(upsertRows, { onConflict: 'user_id,day' })
        .select('day');
      if (upErr) return json({ error: `保存步数失败: ${upErr.message}` }, 500);
      console.info(`[we-run-steps] sync ${requestId} 落库 ${(written ?? []).length}/${upsertRows.length} 天`);
    }

    // 顺带把对方近 N 天数据带回，省一次往返
    let peerSeries: Array<{ day: string; steps: number }> = [];
    let peerAllowed = false;
    let peerLastDay = '';
    if (peerId && peerId !== uid) {
      if (await hasConversationBetween(uid, peerId)) {
        peerAllowed = true;
        const sinceDay = toDayKey(Date.now() - (days - 1) * DAY_MS);
        try {
          const pd = await readStepsRows([peerId], sinceDay);
          peerSeries = pd.map((r) => ({ day: String(r.day), steps: Number(r.steps) }));
          peerLastDay = await readLatestDay(peerId);
        } catch (pe) {
          console.warn(
            `[we-run-steps] sync ${requestId} 查对方步数失败: ${pe instanceof Error ? pe.message : String(pe)}`,
          );
        }
      } else {
        console.warn(`[we-run-steps] sync ${requestId} 与目标无双人会话，跳过对方步数`);
      }
    }

    console.info(
      `[we-run-steps] success ${requestId} today=${today} days=${series.length} peerLastDay=${peerLastDay || '无'} durationMs=${Date.now() - startTime}`,
    );
    return json({ ok: true, today, mine: series, peer: peerSeries, peerAllowed, peerLastDay });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[we-run-steps] failed ${requestId}: ${message}`);
    return json({ error: message }, 400);
  }
}
