import { supabase } from '@/supabase/client';
import type { Database } from '@/supabase/types';
import { takeSecretEntry } from '@/lib/secret-entry';
import { reverseGeocode } from '@/api/geocode';
import { getCurrentLocation } from '@/lib/location-message';
import { logDbg, logWarn } from '../lib/logger';

export type Profile = Database['public']['Tables']['profiles']['Row'];

/** 获取所有用户资料（用于用户列表选人发起聊天） */
export async function listProfiles(): Promise<Profile[]> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      console.warn('查询用户列表失败，降级为空数组:', error.message);
      return [];
    }
    return data ?? [];
  } catch (err) {
    // 云服务不可用(502/网络错误)时降级处理
    console.warn('查询用户列表异常，降级为空数组:', err);
    return [];
  }
}

/**
 * 按 id 批量拉取资料的唯一网络出口。
 * 注意：本函数只负责"打网络拿数据"，缓存与去重由 src/store/profiles-store.ts 统一负责，
 * 业务侧请调用 store 的 ensure/refresh，不要直接用这里的结果自行维护状态。
 */
export async function fetchProfilesByIds(ids: string[], force = false): Promise<Profile[]> {
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  if (uniq.length === 0) return [];
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .in('id', uniq);
  if (error) throw new Error(`查询用户资料失败: ${error.message}`);
  logDbg(`[profiles] 🌐 拉取 ${data?.length ?? 0}/${uniq.length} 份资料${force ? '（强制刷新）' : ''}`);
  return data ?? [];
}

/**
 * 按用户名精确查一份资料（隐藏命令 `check <用户名> ...` 的入口）。
 *
 * profiles.username 有唯一约束且 RLS 允许所有人读，所以这里不需要任何额外权限。
 * 查不到返回 null（而不是抛错）——命令通道要把「用户不存在」当成一种正常结果展示，
 * 抛错会让页面弹 toast，而隐藏命令的语义是「把结果打在结果区里」。
 */
export async function fetchProfileByUsername(username: string): Promise<Profile | null> {
  const name = username.trim();
  if (!name) return null;
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('username', name)
      .limit(1);
    if (error) {
      console.warn('[profiles] 按用户名查询失败:', error.message);
      return null;
    }
    return data?.[0] ?? null;
  } catch (err) {
    console.warn('[profiles] 按用户名查询异常:', err);
    return null;
  }
}

/** 更新自己的资料（昵称、头像、登录邮箱、在线状态可见性） */
export async function updateProfile(
  id: string,
  input: { nickname?: string; avatar_url?: string; email?: string | null; hide_presence?: boolean },
): Promise<Profile> {
  const { data, error } = await supabase
    .from('profiles')
    .update(input)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(`更新资料失败: ${error.message}`);
  if (!data) throw new Error('更新资料失败：可能被 RLS 策略拦截');
  return data;
}

// 记录登录/下线时间的节流窗口：onAuthStateChange 在冷启动 getSession、
// INITIAL_SESSION、TOKEN_REFRESHED 等场景会多次触发，同一账号 60 秒内只写一次库。
// 之所以从 5 分钟缩短到 60 秒：为了「实时感知」——登录后约 1 分钟内即可被对方看到，
// 同时仍足以吸收 token 刷新风暴，不会打爆数据库。
const LOGIN_THROTTLE_MS = 60 * 1000;
let lastLoginRecordedAt = 0;
let lastLoginRecordedUid = '';

/**
 * 「本进程内是否已为某账号记过一次上线」的闸门。
 *
 * 【为什么需要】用户口径是「打开小程序就算上线一次」，而冷启动恢复会话
 * （`INITIAL_SESSION` / `getSession`）正是「打开小程序」这个动作本身。
 * 但同一进程内 token 刷新、切后台回前台也会反复触发 auth 回调，
 * 若每次都计数，「上线次数」会退化成「设备保活次数」。
 *
 * 所以口径定为：**每个进程生命周期内，每个账号最多计 1 次冷启动上线**。
 * 用户杀掉小程序再打开 = 新进程 = 再计 1 次，符合「打开一次算一次」的直觉。
 *
 * ⚠️ 与 `api/auth.ts` 的 `countedUids` 是**两个不同维度**的闸门，不能合并：
 *    - `countedUids`：防「同一次登录被 getSession + INITIAL_SESSION 双回调算两次」
 *    - 本闸门：防「同一进程内 token 刷新/切后台被算成多次上线」
 *    前者在 SIGNED_OUT 时清空，后者只在进程重启时自然清空。
 */
const coldStartCountedUids = new Set<string>();

/**
 * 把 profiles 的登录相关字段按「是否暗号进入」写库，并 `.select()` 回读校验受影响行。
 * 拆成私有函数的原因：冷启动恢复会话时 INITIAL_SESSION 与 getSession 会几乎同时回调，
 * 若两处各自 UPDATE + INSERT，同一笔暗号额度会被消费两次、产生两条重复 login_events。
 * @param withBoundary 是否同值重置统计分界（true=暗号进入 → 计数清零重算）
 * @param withEvent    是否追加一条 login_events（false=只刷活跃度）
 */
async function writeLoginFields(
  id: string,
  stamp: string,
  opts: { withBoundary: boolean; withEvent: boolean },
): Promise<{ ok: boolean; boundary: string | null; message?: string }> {
  const patch = opts.withBoundary
    ? { last_login_at: stamp, last_seen_boundary_at: stamp }
    : { last_login_at: stamp };
  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', id)
    .select('id,last_login_at,last_seen_boundary_at')
    .maybeSingle();
  if (error) return { ok: false, boundary: null, message: error.message };
  if (!data) return { ok: false, boundary: null, message: 'RLS拦截或资料行缺失' };
  if (opts.withEvent) {
    const { error: insErr } = await supabase.from('login_events').insert({ user_id: id });
    if (insErr) console.warn('[profiles] 记录登录事件失败(不影响使用):', insErr.message);
  }
  return { ok: true, boundary: data.last_seen_boundary_at ?? null };
}

/**
 * 记录本人最近一次登录/恢复会话的时间（供聊天列表展示对方在线近况）。
 *
 * 【计数口径】「上线一次」= 用户打开小程序并到达真实登录态，共两条来源：
 *   1. **冷启动**：本进程内该账号第一次到达真实登录态（`coldStartCountedUids` 闸门）。
 *      用户杀掉小程序再打开 = 新进程 = 再计 1 次，符合「打开一次算一次」的直觉。
 *   2. **暗号进入**：ping 页输暗号 / login 页账密或微信一键登录时由
 *      `lib/secret-entry.markSecretEntry()` 打点，`takeSecretEntry()` 命中即计一次。
 *
 * ⚠️ 同一进程内的 token 刷新、切后台回前台**不计数**——它们会反复触发 auth 回调，
 *    若都算，「上线次数」会退化成「设备保活次数」。靠 `coldStartCountedUids` 闸住。
 * ⚠️ 旧实现只认暗号进入，导致一直靠 session 恢复使用的账号（实测 `xiao`）
 *    `login_events` 恒为 0、`last_seen_boundary_at` 恒为 null，用户看到的就是
 *    「上线次数统计还是不对」。
 * 未计数时仍更新 last_login_at（属活跃度信息，不是登录次数），保持「最近在线」准确。
 * @param allowCount 调用方（api/auth）的 uid 级一次性闸门：同一进程内第二次到达的
 *                   真实登录态传 false，即使有暗号额度也不重复计数（防 getSession 与
 *                   INITIAL_SESSION 双回调把一次进入算成两次）。
 * 静默失败：这是附属信息，绝不能影响登录主流程。
 */
export async function recordLastLogin(id: string, allowCount = true): Promise<void> {
  const now = Date.now();
  // 先判定额度再判节流：takeSecretEntry 是消费式（读后即焚），不能被节流窗口吞掉——
  // 若命中暗号却因 60 秒节流直接 return，这次进入就永久丢额度了。
  const bySecret = allowCount && takeSecretEntry();
  /**
   * 冷启动上线：本进程内该账号第一次到达真实登录态。
   *
   * 【为什么冷启动也要计数】用户口径是「打开小程序就算上线一次」。旧实现只认
   * 「暗号进入聊天区」，导致一直靠 session 恢复使用的账号（实测 `xiao`）
   * `login_events` 恒为 0、`last_seen_boundary_at` 恒为 null——用户看到的就是
   * 「上线次数统计还是不对」。
   *
   * ⚠️ 必须用 `coldStartCountedUids` 闸门：同一进程内 token 刷新、切后台回前台
   *    都会再次走到这里，不闸住就会把「设备保活」算成「上线」。
   * ⚠️ 与 `bySecret` 是「或」关系：暗号进入时额度已消费，冷启动闸门可能也已用过，
   *    两者任一命中都算一次，但**同一次调用只写一条事件**（下面分支互斥）。
   */
  const byColdStart = allowCount && !coldStartCountedUids.has(id);
  if (byColdStart) coldStartCountedUids.add(id);
  const shouldCount = bySecret || byColdStart;
  const throttled = lastLoginRecordedUid === id && now - lastLoginRecordedAt < LOGIN_THROTTLE_MS;
  // 关键证据日志：排查「上线次数一直是 0」时先看这一行——
  // bySecret=false 且 byColdStart=false 说明既没暗号打点、本进程也已计过。
  logDbg(
    `[profiles] 🔑 登录计数判定: bySecret=${bySecret} byColdStart=${byColdStart} shouldCount=${shouldCount} throttled=${throttled} allowCount=${allowCount} uid=${id.slice(0, 8)}`,
  );
  if (!shouldCount && throttled) {
    logDbg('[profiles] ⏭ 非计数进入且命中节流窗口, 跳过');
    return;
  }
  try {
    // 用服务端时间戳避免本机时钟偏差；RLS 沿用 users_update_own_profile（仅本人可改）。
    const stamp = new Date(now).toISOString();
    if (shouldCount && throttled) {
      // 极端情况：60 秒内刚写过，又计了一次。为遵守「一次进入计一次」，
      // 单独补一条事件（不动分界、不重复 UPDATE profiles），量极小可接受。
      logDbg('[profiles] ⏭ 命中节流窗口但本次应计数，仅补记一条登录事件');
      const { error: insErr } = await supabase.from('login_events').insert({ user_id: id });
      if (insErr) console.warn('[profiles] 补记登录事件失败(不影响使用):', insErr.message);
      return;
    }
    if (shouldCount) {
      const r = await writeLoginFields(id, stamp, { withBoundary: true, withEvent: true });
      if (!r.ok) {
        console.warn(`[profiles] 登录记录未生效(不影响使用): ${r.message}`);
        return;
      }
      lastLoginRecordedAt = now;
      lastLoginRecordedUid = id;
      // 关键证据日志：打出本次登录时刻与服务端回读的分界值，用于核对计数是否真的落库
      logDbg(
        `[profiles] ✅ 已计入上线次数(${bySecret ? '暗号进入' : '冷启动'}) loginAt=${stamp} boundary=${r.boundary ?? 'null'}`,
      );
      return;
    }
    const r = await writeLoginFields(id, stamp, { withBoundary: false, withEvent: false });
    if (!r.ok) {
      console.warn(`[profiles] 记录最近登录时间未生效(不影响使用): ${r.message}`);
      return;
    }
    lastLoginRecordedAt = now;
    lastLoginRecordedUid = id;
    // 关键降噪日志：非计数进入（token 刷新/切后台）只刷活跃度，明确不计数
    logDbg(`[profiles] 🌙 非计数进入(auth事件) → 仅更新 last_login_at=${stamp}，不计上线次数`);
  } catch (err) {
    console.warn('[profiles] 记录最近登录时间异常(不影响使用):', err);
  }
}

// 下线时间独立节流（与登录分开计时，互不干扰）
let lastLogoutRecordedAt = 0;
let lastLogoutRecordedUid = '';

/**
 * 记录本人主动退出登录的时间（供聊天列表把对方显示为「离线 · 刚刚」）。
 * 静默失败：绝不能阻塞登出主流程。
 * ⚠️ 仅在 SIGNED_OUT（主动退出）时调用；切后台/杀进程不会触发，属已知限制。
 */
export async function recordLogout(id: string): Promise<void> {
  const now = Date.now();
  if (lastLogoutRecordedUid === id && now - lastLogoutRecordedAt < LOGIN_THROTTLE_MS) {
    logDbg('[profiles] ⏭ 下线时间记录命中节流窗口, 跳过');
    return;
  }
  try {
    const { data, error } = await supabase
      .from('profiles')
      .update({ last_logout_at: new Date(now).toISOString(), last_seen_boundary_at: new Date(now).toISOString() })
      .eq('id', id)
      .select('id');
    if (error) {
      console.warn('[profiles] 记录下线时间失败(不影响使用):', error.message);
      return;
    }
    if (!data || data.length === 0) {
      console.warn('[profiles] 记录下线时间未生效(可能被 RLS 拦截或资料行缺失)');
      return;
    }
    lastLogoutRecordedAt = now;
    lastLogoutRecordedUid = id;
    logDbg('[profiles] ✅ 已记录下线时间');
  } catch (err) {
    console.warn('[profiles] 记录下线时间异常(不影响使用):', err);
  }
}

/** 页面级在场状态三态（共享契约下沉到 api 层，避免 lib/presence ↔ api/auth 循环依赖）。 */
export type PresenceState = 'online' | 'away' | 'offline';

/**
 * 上报本人页面级在场状态（三态：online / away / offline）。
 * 由 `lib/presence.ts` 的 reportPresence 在生命周期点调用，本函数只负责落库。
 *
 * ⚠️ 写 profiles 沿用现有 RLS：所有人可读（users_select_profiles）、仅本人可写
 *    （users_update_own_profile），无需新策略。
 * ⚠️ 必须 `.select('id')` 回读校验受影响行数——RLS 无匹配策略时 PostgREST 不报错、
 *    只返回 0 行，光判 error 会误报成功。
 * 静默失败：附属信息，绝不阻塞页面切换主流程。
 */
export async function reportPresenceState(
  id: string,
  state: PresenceState,
  stamp: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .update({ presence_state: state, presence_at: stamp })
      .eq('id', id)
      .select('id');
    if (error) {
      console.warn('[profiles] 上报在场状态失败(不影响使用):', error.message);
      return false;
    }
    if (!data || data.length === 0) {
      console.warn(`[profiles] 上报在场状态未生效(可能被 RLS 拦截或资料行缺失): ${state}`);
      return false;
    }
    logDbg(`[profiles] ✅ 在场状态已落库: ${state} @ ${stamp}`);
    return true;
  } catch (err) {
    console.warn('[profiles] 上报在场状态异常(不影响使用):', err);
    return false;
  }
}

/**
 * 上报本人「最后一次自动定位到的坐标」。
 *
 * 【为什么必须落库】原先自动定位结果只写本机 `chat_last_location_v1`（见 lib/location-message），
 * 换设备就没了、别人也读不到。隐藏命令 `check <用户名> place` 要查「TA 最后一次自动定位的位置」，
 * 就必须有一份云端记录，故新增 profiles.last_lat / last_lng / last_location_at 三列。
 *
 * ⚠️ 沿用 profiles 现有 RLS：所有人可读（users_select_profiles）、仅本人可写
 *    （users_update_own_profile），无需新策略。
 * ⚠️ 必须 `.select('id')` 回读校验受影响行数——RLS 无匹配策略时 PostgREST 不报错、
 *    只返回 0 行，光判 error 会误报成功。
 * 静默失败：附属信息，绝不阻塞进聊天页的主流程。
 */
export async function reportLastLocation(id: string, lat: number, lng: number): Promise<boolean> {
  if (!id) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  try {
    const { data, error } = await supabase
      .from('profiles')
      .update({ last_lat: lat, last_lng: lng, last_location_at: new Date().toISOString() })
      .eq('id', id)
      .select('id');
    if (error) {
      console.warn('[profiles] 上报最近位置失败(不影响使用):', error.message);
      return false;
    }
    if (!data || data.length === 0) {
      console.warn('[profiles] 上报最近位置未生效(可能被 RLS 拦截或资料行缺失)');
      return false;
    }
    logDbg(`[profiles] 📍 最近位置已落库: (${lat}, ${lng})`);
    // 同时追加一条定位历史（`check stats` 要按周期看位置变化，profiles 三列只有最新一份）。
    //
    // ⚠️ 必须 await，不能 `void`（fire-and-forget）——这是「定位历史表恒为 0 行」的根因：
    //    调用方 `autoFetchCurrentLocation` 在 `useDidShow` 里跑，用户进页后往往几秒内就
    //    切走/返回；`void` 出去的 INSERT 请求会随页面销毁被微信底层中断，而错误又被
    //    `appendLocationHistory` 内部 catch 吞掉 → 表里一条都没有，且日志里毫无痕迹。
    //    实测证据：profiles.last_location_at 有值（UPDATE 成功），但历史表 0 行。
    // ⚠️ 仍然不把失败抛给调用方：历史是附属信息，写失败不该把「上报成功」变成失败。
    await appendLocationHistory(id, lat, lng);
    return true;
  } catch (err) {
    console.warn('[profiles] 上报最近位置异常(不影响使用):', err);
    return false;
  }
}

/** 定位历史去重窗口：同一位置在 10 分钟内重复上报只记一条 */
const LOCATION_HISTORY_DEDUPE_MS = 10 * 60 * 1000;
/** 定位历史去重距离阈值（米）：50 米内视为「同一位置」 */
const LOCATION_HISTORY_DEDUPE_METERS = 50;

/**
 * 地名补解析的分批参数。
 *
 * 【为什么需要】高德 Web 服务个人 Key 有 QPS 限制，一次性打几十个逆地理请求会触发限流
 * （返回 infocode=10021/10019），表现为「大部分点都解析不出来」。
 * 每解析 `BATCH_SIZE` 个不同坐标停顿 `BATCH_GAP_MS`，既跑得完又不触发限流。
 */
const BACKFILL_BATCH_SIZE = 8;
const BACKFILL_BATCH_GAP_MS = 1200;

/** 两点球面距离（米），Haversine。只用于去重判断，精度要求不高 */
function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * 追加一条定位历史（内部函数，由 `reportLastLocation` 调用）。
 *
 * 【为什么必须去重】`autoFetchCurrentLocation` 在**每次进聊天页**都会跑一次，
 * 用户一天进出十几次、坐标几乎不变，不去重的话历史表会被同一位置的重复记录灌满，
 * 「定位次数」这个统计也就失去意义（变成「进过几次聊天页」）。
 * 去重规则：与**最近一条**历史相比，10 分钟内且距离 < 50 米 → 跳过。
 *
 * 【为什么去重查询失败时照常 INSERT】宁可多记一条，也不能因为去重查询报错就丢掉
 * 这次真实定位——丢数据比多一条重复更难排查。
 *
 * 静默失败：历史是附属信息，只 logWarn，不影响调用方返回值。
 */
async function appendLocationHistory(id: string, lat: number, lng: number): Promise<void> {
  try {
    const { data: lastRows, error: lastErr } = await supabase
      .from('user_location_history')
      .select('lat,lng,recorded_at')
      .eq('user_id', id)
      .order('recorded_at', { ascending: false })
      .limit(1);
    if (lastErr) {
      // 去重查询失败不阻断写入（宁可多记一条，也不能丢真实定位），但必须留痕：
      // 这条日志是排查「历史表为什么是空的」的第一手证据。
      logWarn('[profiles] 定位历史去重查询失败，继续写入:', lastErr.message);
    }
    if (!lastErr && lastRows && lastRows.length > 0) {
      const last = lastRows[0];
      const lastAt = new Date(last.recorded_at as string).getTime();
      const withinWindow = Number.isFinite(lastAt) && Date.now() - lastAt < LOCATION_HISTORY_DEDUPE_MS;
      const near =
        distanceMeters(lat, lng, last.lat as number, last.lng as number) < LOCATION_HISTORY_DEDUPE_METERS;
      if (withinWindow && near) {
        logDbg('[profiles] 📍 定位历史去重：10 分钟内同一位置，跳过写入');
        return;
      }
    }
    // 写入前先解析地名：地名是「写一次长期复用」的信息，放在写入时解析最省配额。
    // ⚠️ 解析失败不阻断写入（`resolvePlaceName` 内部已吞掉所有异常并返回空串）：
    //    坐标本身才是主数据，地名只是展示增强。
    const place = await resolvePlaceName(lat, lng);
    // ⚠️ 必须 `.select('id')` 回读校验：RLS 的 INSERT 策略不匹配时 PostgREST **不报错**、
    //    只返回 0 行（与 `reportLastLocation` 的 UPDATE 同一个坑）。只判 `error` 会把
    //    「被 RLS 静默拦掉」误判成「写入成功」，于是历史表恒为 0 行却毫无告警。
    const { data: inserted, error } = await supabase
      .from('user_location_history')
      .insert({ user_id: id, lat, lng, name: place.name, address: place.address })
      .select('id');
    if (error) {
      logWarn('[profiles] 写入定位历史失败(不影响使用):', error.message);
      return;
    }
    if (!inserted || inserted.length === 0) {
      logWarn('[profiles] 写入定位历史未生效(可能被 RLS 拦截): user_id=', id);
      return;
    }
    logDbg(`[profiles] 📍 定位历史已追加: (${lat}, ${lng}) ${place.name || '(无地名)'}`);
  } catch (err) {
    logWarn('[profiles] 写入定位历史异常(不影响使用):', err);
  }
}

/**
 * 补录一条定位历史（用于「历史表为空但 profiles.last_* 有值」的存量数据）。
 *
 * 【为什么需要】定位历史表是后加的，上线前所有定位只写进了 `profiles.last_lat/last_lng`。
 * 不补录的话，用户升级后第一次进聊天页之前，「定位次数」永远是 0、轨迹页永远没有点，
 * 看起来就像功能坏了（用户实测报过「没有看到位置轨迹地图」）。
 *
 * 【为什么只在「该用户历史为空」时补】补录是兜底，不是常规写入路径。每次进页都补会把
 * 历史表灌成「进过几次聊天页」；只在空表时补一次，之后由 `appendLocationHistory` 正常累积。
 *
 * 静默失败：附属信息，只 logWarn。
 */
export async function backfillLocationHistory(id: string, lat: number, lng: number): Promise<boolean> {
  if (!id) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  try {
    const { count, error: countErr } = await supabase
      .from('user_location_history')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', id);
    if (countErr) {
      logWarn('[profiles] 补录前查询历史条数失败:', countErr.message);
      return false;
    }
    if ((count ?? 0) > 0) {
      logDbg(`[profiles] 📍 定位历史已有 ${count} 条，无需补录`);
      return false;
    }
    const place = await resolvePlaceName(lat, lng);
    const { data: inserted, error } = await supabase
      .from('user_location_history')
      .insert({ user_id: id, lat, lng, name: place.name, address: place.address })
      .select('id');
    if (error) {
      logWarn('[profiles] 补录定位历史失败(不影响使用):', error.message);
      return false;
    }
    if (!inserted || inserted.length === 0) {
      logWarn('[profiles] 补录定位历史未生效(可能被 RLS 拦截): user_id=', id);
      return false;
    }
    logDbg(`[profiles] 📍 定位历史已补录: (${lat}, ${lng})`);
    return true;
  } catch (err) {
    logWarn('[profiles] 补录定位历史异常(不影响使用):', err);
    return false;
  }
}

/**
 * 解析坐标对应的地名/地址（失败一律返回空串）。
 *
 * 【为什么吞掉所有异常】地名是展示增强，不是主数据。逆地理可能因为
 * 「云函数未配置 Key」「配额用尽」「网络抖动」失败，任何一种都不该让
 * 「这条定位没记下来」——坐标本身仍然有价值。
 *
 * ⚠️ 不在这里做缓存：调用方（`appendLocationHistory`）只在真正要写库时调一次，
 *    天然不会重复解析同一坐标；轨迹页的补解析走 `backfillLocationNames`。
 * ⚠️ 对外导出：地点对比页的「兜底坐标」（来自 `profiles.last_lat/lng`，库里没有
 *    对应历史行）需要就地解析一次地名，否则清单里永远显示「未知地点」。
 */
export async function resolvePlaceName(
  lat: number,
  lng: number,
): Promise<{ name: string; address: string }> {
  try {
    const r = await reverseGeocode(lat, lng);
    return { name: r.name, address: r.address };
  } catch (e) {
    logWarn('[profiles] 逆地理解析失败，地名留空:', e);
    return { name: '', address: '' };
  }
}

/**
 * 拉取某用户的**全部**定位历史（不分时间窗），供「一次性补齐地名」使用。
 *
 * 【为什么不能复用 `listLocationHistoryBetween`】那个函数按时间窗 + `limit(500)` 取，
 * 补齐地名需要的是「所有缺地名的行」，用时间窗取会漏掉窗口外的历史。
 *
 * ⚠️ 只取 `name` 为空的候选行由调用方过滤：这里不写 `.is('name', null)`，
 *    因为「空串」与 NULL 都算缺地名，PostgREST 的 `is` 只能匹配 NULL。
 * ⚠️ 分页拉取：PostgREST 单次默认上限 1000 行，历史多的账号必须翻页，
 *    否则「一次性补齐」只补了前 1000 行。
 */
export async function listAllLocationHistory(userId: string): Promise<LocationHistoryRow[]> {
  if (!userId) return [];
  const PAGE_SIZE = 1000;
  const out: LocationHistoryRow[] = [];
  for (let page = 0; page < 20; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from('user_location_history')
      .select('lat,lng,recorded_at,name,address')
      .eq('user_id', userId)
      .order('recorded_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`查询全部定位历史失败: ${error.message}`);
    const rows = (data ?? []).map((r) => ({
      lat: r.lat as number,
      lng: r.lng as number,
      recordedAt: r.recorded_at as string,
      name: (r.name as string | null) ?? '',
      address: (r.address as string | null) ?? '',
    }));
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  logDbg(`[profiles] 📍 全部定位历史: ${out.length} 条`);
  return out;
}

/**
 * 给「已存在但缺地名」的历史行补解析地名（轨迹页首次打开时调用）。
 *
 * 【为什么需要补】地名列是后加的，升级前写入的历史行 `name` 全是 NULL。
 * 不补的话，用户打开轨迹页看到的仍是「一堆坐标」，会以为功能没生效。
 *
 * 【为什么按「坐标」去重后再解析】同一栋楼会被记几十次（GPS 抖动 + 每次进聊天页都上报），
 * 逐行解析等于对同一个坐标反复请求第三方接口——既慢又白烧配额。
 * 先按坐标归并，一次解析结果回填给该坐标下的**所有**行。
 *
 * 【为什么分批 + 每批之间停顿】逆地理是第三方接口、有 QPS 限制，一口气打几十个请求
 * 会触发限流（表现为「大部分点都解析不出来」）。按 `BATCH_SIZE` 分批、批间 `BATCH_GAP_MS`
 * 停顿，既跑得完又不触发限流。
 *
 * ⚠️ 只更新 `name` / `address` 两列，绝不碰 `lat` / `lng` / `recorded_at`：
 *    补解析是「给已有记录加注释」，不是「重写记录」。
 * ⚠️ 单条失败不中断整批：某个坐标查不到地名不该让后面的点全部放弃。
 * ⚠️ 调用方必须传**全部**历史行（不是当前时间窗内的），否则「一次性补齐」只补了窗口内那几条。
 */
export async function backfillLocationNames(
  userId: string,
  rows: LocationHistoryRow[],
  maxCount = Number.POSITIVE_INFINITY,
): Promise<number> {
  if (!userId) return 0;
  const missing = rows.filter((r) => !r.name);
  if (missing.length === 0) return 0;

  // 按坐标归并：key → 该坐标下的全部行（同一坐标可能有多条不同时间的记录）
  const groups: Record<string, LocationHistoryRow[]> = {};
  for (const r of missing) {
    const key = `${r.lat.toFixed(6)},${r.lng.toFixed(6)}`;
    (groups[key] ??= []).push(r);
  }
  // 只解析最近 `maxCount` 个**不同坐标**（默认不限）
  const keys = Object.keys(groups).slice(-maxCount);
  logDbg(
    `[profiles] 📍 开始补解析地名: ${missing.length} 行 / ${keys.length} 个不同坐标`,
  );

  let updated = 0;
  for (let i = 0; i < keys.length; i += 1) {
    const group = groups[keys[i]];
    const { lat, lng } = group[0];
    const place = await resolvePlaceName(lat, lng);
    if (place.name || place.address) {
      // 一次解析结果回填给该坐标下的所有行（逐行 update，避免依赖 RPC）
      for (const r of group) {
        try {
          // 按 (user_id, lat, lng, recorded_at) 精确定位到那一行：
          // 同一坐标可能有多条记录（不同时间），只更新本次解析的这一条。
          const { data, error } = await supabase
            .from('user_location_history')
            .update({ name: place.name, address: place.address })
            .eq('user_id', userId)
            .eq('lat', r.lat)
            .eq('lng', r.lng)
            .eq('recorded_at', r.recordedAt)
            .select('id');
          if (error) {
            logWarn('[profiles] 补写地名失败(不影响展示):', error.message);
            continue;
          }
          if (data && data.length > 0) updated += 1;
        } catch (e) {
          logWarn('[profiles] 补写地名异常(不影响展示):', e);
        }
      }
    }
    // 批间停顿：每解析 BATCH_SIZE 个坐标歇一下，避免触发第三方 QPS 限流
    if ((i + 1) % BACKFILL_BATCH_SIZE === 0 && i + 1 < keys.length) {
      logDbg(
        `[profiles] 📍 地名补解析进度 ${i + 1}/${keys.length}，暂停 ${BACKFILL_BATCH_GAP_MS}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, BACKFILL_BATCH_GAP_MS));
    }
  }
  logDbg(`[profiles] 📍 地名补解析完成: ${updated}/${missing.length} 行`);
  return updated;
}

/**
 * 登录成功后上报一次定位（让「登录地点」真正对应每次登录）。
 *
 * 【为什么需要单独一个函数，而不是让登录页直接调 `getCurrentLocation` + `reportLastLocation`】
 * 登录页 / ping 页 / 未来的任何登录入口都要做同一件事，且都要处理三个坑：
 * ① 必须**先等 auth 会话就绪**再写库——`signInWithPassword` 成功后 supabase-js 是
 *    **同步**触发 `onAuthStateChange`，但 access token 落到 client 上可能还差一拍；
 *    此刻发 PostgREST 请求会被 RLS 当匿名挡掉（UPDATE 返回 0 行、不报错）。
 * ② 定位是**慢操作**（真机首次定位可能 3~8 秒），绝不能阻塞登录跳转。
 * ③ 失败必须静默——用户登录成功了，不该因为定位失败看到任何错误提示。
 * 把这三件事收口到一个函数里，新增登录入口时只需一行调用。
 *
 * ⚠️ 调用方**不要 await**：登录跳转优先，定位在后台跑完即可。
 * ⚠️ 不在这里做「是否已登录」判断：调用方都是登录成功后的路径，
 *    多一层判断反而会在过渡态（`bootstrapped`）下误判成未登录而跳过。
 */
export async function reportLoginLocation(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    // ① 等会话就绪：`getSession()` 在 token 尚未落盘时会返回 null，
    //    这里最多等 3 秒（每 200ms 轮询一次），超时就放弃本次上报。
    //    ⚠️ 不用 `onAuthStateChange` 等待：那是一次性事件，登录已完成时它不会再触发。
    let hasSession = false;
    for (let i = 0; i < 15; i += 1) {
      const { data } = await supabase.auth.getSession();
      if (data.session?.access_token) {
        hasSession = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!hasSession) {
      logWarn('[profiles] 登录定位跳过：会话尚未就绪');
      return false;
    }

    // ② 取当前坐标。`getCurrentLocation` 内部已做环境判断与异常吞掉，
    //    非微信环境（H5 预览）直接返回 null，不会抛错。
    const loc = await getCurrentLocation();
    if (!loc) {
      logDbg('[profiles] 登录定位跳过：未取到坐标（未授权或非小程序环境）');
      return false;
    }

    // ③ 写 profiles.last_* + 追加一条历史（内部含 10 分钟/50 米去重，
    //    与「进聊天页自动定位」共用同一套去重，不会因为登录+进页各报一次而记两条）。
    const ok = await reportLastLocation(userId, loc.lat, loc.lng);
    logDbg(`[profiles] 🔑 登录定位上报${ok ? '成功' : '失败(不影响登录)'}`);
    return ok;
  } catch (e) {
    logWarn('[profiles] 登录定位上报异常(不影响登录):', e);
    return false;
  }
}

/** 一条定位历史记录 */
export interface LocationHistoryRow {
  lat: number;
  lng: number;
  recordedAt: string;
  /**
   * 逆地理解析出的地点名（如「望京SOHO」）。
   * 空串表示「该坐标查不到地名」或「尚未解析」——两者在展示层都退回显示坐标，
   * 但只有后者值得再调一次逆地理（见 `needsGeocode`）。
   */
  name: string;
  /** 逆地理解析出的完整地址，空串语义同 `name` */
  address: string;
}

/** 定位历史摘要（供 `check stats` 的位置块渲染） */
export interface LocationHistorySummary {
  count: number;
  first: LocationHistoryRow | null;
  last: LocationHistoryRow | null;
  /** 去重后的位置个数（约 100 米网格粗聚类），用于判断「一直在同一片区域」还是「换过地方」 */
  distinctCount: number;
}

/**
 * 查某人在 `[startIso, endIso]` 内的定位历史（**升序**，末项即周期内最后一次）。
 *
 * 【为什么升序而不是倒序】调用方要的是「轨迹」：首次在哪、最后在哪、中间换过几个地方。
 * 升序读起来自然，`rows[rows.length - 1]` 就是最后一次；倒序则每次都要 reverse。
 *
 * 【为什么 limit 500】一个周期内定位次数不会太多（有 10 分钟去重），但必须封顶——
 * 异常数据（如脚本刷）不能把结果区撑爆。
 *
 * 【为什么失败抛错】这是用户主动敲命令要的结果，静默返回空数组会让结果区显示
 * 「该周期内无定位记录」——把「查询失败」伪装成「真的没定位」，是更严重的误导。
 */
export async function listLocationHistoryBetween(
  userId: string,
  startIso: string,
  endIso: string,
): Promise<LocationHistoryRow[]> {
  const { data, error } = await supabase
    .from('user_location_history')
    .select('lat,lng,recorded_at,name,address')
    .eq('user_id', userId)
    .gte('recorded_at', startIso)
    .lte('recorded_at', endIso)
    .order('recorded_at', { ascending: true })
    .limit(500);
  if (error) throw new Error(`查询定位历史失败: ${error.message}`);
  const rows = (data ?? []).map((r) => ({
    lat: r.lat as number,
    lng: r.lng as number,
    recordedAt: r.recorded_at as string,
    name: (r.name as string | null) ?? '',
    address: (r.address as string | null) ?? '',
  }));
  logDbg(`[profiles] 📍 定位历史 ${startIso} ~ ${endIso}: ${rows.length} 条`);
  return rows;
}

/**
 * 把定位历史压成摘要（纯函数，无网络）。
 *
 * 【为什么 distinctCount 用 3 位小数网格而不是精确聚类】用户只想知道「TA 是一直在
 * 同一片区域，还是换过地方」。3 位小数 ≈ 100 米网格，足够回答这个问题，且实现是
 * 一个 Set、零依赖；真正的轨迹聚类（DBSCAN 之类）对「看个统计」是过度设计。
 */
export function summarizeLocationHistory(rows: LocationHistoryRow[]): LocationHistorySummary {
  const grid = new Set<string>();
  for (const r of rows) grid.add(`${r.lat.toFixed(3)},${r.lng.toFixed(3)}`);
  return {
    count: rows.length,
    first: rows.length > 0 ? rows[0] : null,
    last: rows.length > 0 ? rows[rows.length - 1] : null,
    distinctCount: grid.size,
  };
}

/**
 * 轻量心跳：把「最后活跃时间」写进 profiles.last_active_at。
 * 由 app.tsx 的 App 级心跳定时器在前台每 45 秒调用一次；回前台瞬间也会立即补写。
 * 切后台时微信冻结 JS 定时器、杀进程时代码根本不执行——所以「停止写入」本身就是
 * 离线信号，展示端按超时（约 2 分钟）推断离线，无需也无法收到显式下线通知。
 * 静默失败：附属信息，绝不阻塞主流程。
 */
export async function recordHeartbeat(id: string): Promise<void> {
  const now = Date.now();
  try {
    const { data, error } = await supabase
      .from('profiles')
      .update({ last_active_at: new Date(now).toISOString() })
      .eq('id', id)
      .select('id');
    if (error) {
      console.warn('[profiles] 心跳上报失败(不影响使用):', error.message);
      return;
    }
    if (!data || data.length === 0) {
      console.warn('[profiles] 心跳上报未生效(可能被 RLS 拦截或资料行缺失)');
      return;
    }
    logDbg('[profiles] 💓 心跳已上报');
  } catch (err) {
    console.warn('[profiles] 心跳上报异常(不影响使用):', err);
  }
}

/**
 * 登录统计窗口：本用户「上次退回 ping 页」→「本次从 ping 页进入聊天区」之间的区间。
 * - fromAt 为空（首次使用/清缓存）→ 不设下限，退化为全部历史。
 * - toAt   为空（无有效进入打点）→ 不设上限，等价于「到现在为止」。
 */
export interface LoginWindow {
  fromAt: string | null;
  toAt: string | null;
}

/**
 * 对方登录统计：在我离开聊天区的窗口内，TA 登录了几次、最后一次是什么时候，
 * 以及历次登录时刻（loggedAts，按 logged_at 倒序——首条即最新）。
 * loggedAts 供聊天页「登录明细」弹层逐条展示；列表页只用 count/lastLoggedAt。
 * recentLoggedAt：窗口终点**之后**最近一次登录时刻——用于「我停留期间 TA 又登录了」
 * 的实时感知（此时页面直接显示「已在线」，不再展示窗口次数）。
 */
export interface PeerLoginStats {
  count: number;
  lastLoggedAt: string | null;
  loggedAts: string[];
  recentLoggedAt: string | null;
}

/**
 * 查询「我在离开聊天区期间，对方登录了几次 + 最后登录详细时间」。
 * 口径：`fromAt < logged_at <= toAt` 的 login_events 事件（fromAt = 上次退回 ping 页时刻，
 * toAt = 本次暗号进入时刻），两端都可选。
 * ⚠️ 只取 logged_at 一列倒序拉回前端计数（单用户事件量极小），避免依赖 COUNT+聚合的复杂查询；
 * 同时把 `> toAt` 的第一条留作 recentLoggedAt 供在线判定。
 * 静默失败：附属信息，异常时返回 null 让页面不渲染该行。
 */
export async function fetchPeerLoginStats(
  peerId: string,
  win: LoginWindow,
): Promise<PeerLoginStats | null> {
  if (!peerId) return null;
  try {
    const query = supabase.from('login_events').select('logged_at').eq('user_id', peerId);
    if (win.fromAt) query.gt('logged_at', win.fromAt);
    // 不设上限时会拿到「到现在为止」的全部事件，此时窗口内/窗口后无法区分 → recent 置空
    if (win.toAt) query.lte('logged_at', win.toAt);
    const { data, error } = await query.order('logged_at', { ascending: false });
    if (error) {
      console.warn('[profiles] 查询对方登录统计失败(不影响使用):', error.message);
      return null;
    }
    const rows = data ?? [];
    const recent = win.toAt ? await fetchLatestLoginAfter(peerId, win.toAt) : null;
    return {
      count: rows.length,
      lastLoggedAt: rows.length > 0 ? (rows[0].logged_at as string) : null,
      loggedAts: rows.map((r) => r.logged_at as string),
      recentLoggedAt: recent,
    };
  } catch (err) {
    console.warn('[profiles] 查询对方登录统计异常(不影响使用):', err);
    return null;
  }
}

/** 取某人在 toAt 之后的最新一条登录时刻（limit 1，倒序）；失败静默返回 null */
async function fetchLatestLoginAfter(peerId: string, toAt: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('login_events')
      .select('logged_at')
      .eq('user_id', peerId)
      .gt('logged_at', toAt)
      .order('logged_at', { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return null;
    return (data[0].logged_at as string) ?? null;
  } catch {
    return null;
  }
}

/**
 * 某人在指定时间区间内的上线统计（隐藏命令 `check <用户名> stats` 用）。
 *
 * 【为什么 count 与 lastLoggedAt 一起返回】用户看「上线次数」时几乎必然接着问
 * 「最后一次是什么时候」，两次请求拆开会让结果区出现「次数已出、时间还在转」的
 * 半成品状态；一次查询同时拿到两者，渲染层可以一次性出结果。
 */
export interface PeerLoginRangeStats {
  count: number;
  lastLoggedAt: string | null;
}

/**
 * 统计某人在 `[startIso, endIso]` 内登录了几次、最后一次是什么时候。
 *
 * 【为什么用 count + head 而不是把 logged_at 全拉回来数】
 * 与 `countMessagesBetween` 同口径：`head: true` 只回 `Content-Range` 头、不回行，
 * 一个月的登录事件再多也只传一个数字。但「最后一次时刻」必须单独取一行，
 * 所以这里发两条并行请求（count + limit 1 倒序），而不是拉全量再取首条。
 *
 * 【为什么失败时抛错而不是像 fetchPeerLoginStats 那样静默返回 null】
 * 那个函数是聊天页的**附属信息**（拿不到就不渲染那一行，页面照常可用）；
 * 这里是用户主动敲命令要的结果，静默吞掉会让结果区显示「上线 0 次」——
 * 把「查询失败」伪装成「真的没上线」，是更严重的误导。抛错由调用方如实展示。
 *
 * ⚠️ 能力边界：`login_events` 的 SELECT 策略是 `USING (true)`（所有人可读），
 *    所以这里能统计**任意用户**的上线次数，不受「只能看自己会话」的限制。
 *    这与 message / place 子命令的 RLS 边界不同，结果文案里不要混为一谈。
 */
export async function countPeerLoginsBetween(
  peerId: string,
  startIso: string,
  endIso: string,
): Promise<PeerLoginRangeStats> {
  const base = () =>
    supabase
      .from('login_events')
      .select('logged_at', { count: 'exact', head: true })
      .eq('user_id', peerId)
      .gte('logged_at', startIso)
      .lte('logged_at', endIso);

  const [countRes, lastRes] = await Promise.all([
    base(),
    supabase
      .from('login_events')
      .select('logged_at')
      .eq('user_id', peerId)
      .gte('logged_at', startIso)
      .lte('logged_at', endIso)
      .order('logged_at', { ascending: false })
      .limit(1),
  ]);
  if (countRes.error) throw new Error(`统计上线次数失败: ${countRes.error.message}`);
  if (lastRes.error) throw new Error(`查询最近上线时刻失败: ${lastRes.error.message}`);
  const count = countRes.count ?? 0;
  const lastLoggedAt = lastRes.data && lastRes.data.length > 0 ? (lastRes.data[0].logged_at as string) : null;
  logDbg(`[profiles] 📊 上线统计 ${startIso} ~ ${endIso}: ${count} 次，最近 ${lastLoggedAt ?? '无'}`);
  return { count, lastLoggedAt };
}

/**
 * 取某人「最后一次自动定位」的坐标（`profiles.last_lat / last_lng / last_location_at`）。
 *
 * 【为什么单独查一次 profiles，而不是复用调用方手里那份 profile】
 * 调用方（`check stats`）手里的 profile 是 `fetchProfileByUsername` 刚拉回来的，
 * 本来就有这三列——但那个函数是「按用户名查」，字段集合由它决定；把「取位置」
 * 做成独立函数，将来 `check place` 与 `stats` 可以共用同一份解析逻辑，
 * 不必各自判断 `typeof lat === 'number'` 这类细节。
 *
 * 【为什么返回 null 而不是抛错】位置是**附属信息**：TA 可能从未在真机进过聊天页
 * （H5 预览端 getCurrentLocation 直接返回 null，永远不上报），此时「没有位置记录」
 * 是正常状态，不是错误。调用方按 null 渲染「无记录」即可。
 */
export function pickLastLocation(profile: Profile | null | undefined): { lat: number; lng: number; at: string | null } | null {
  if (!profile) return null;
  const lat = profile.last_lat;
  const lng = profile.last_lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, at: profile.last_location_at ?? null };
}

/**
 * 批量版登录统计（会话列表用）：一次查回多个对方的登录事件，前端按 user_id 分组计数。
 * 与 fetchPeerLoginStats 同口径（fromAt < logged_at <= toAt），但只发一条 SQL——
 * 列表页若逐行调单查会打 N 次请求，这里用 in + 单次拉取替代。
 * ⚠️ 批量路径不填 recentLoggedAt：列表页的「已在线」判定走 profiles 三时间列
 * （isPeerOnline），不需要额外查询；单查路径才补这一列。
 * 返回 Map：无事件的 peer 不在 Map 里（页面按 count>0 渲染，缺失即不占行）。
 */
export async function fetchPeerLoginStatsBatch(
  peerIds: string[],
  win: LoginWindow,
): Promise<Map<string, PeerLoginStats>> {
  const result = new Map<string, PeerLoginStats>();
  const uniq = Array.from(new Set(peerIds.filter(Boolean)));
  if (uniq.length === 0) return result;
  try {
    const query = supabase
      .from('login_events')
      .select('user_id,logged_at')
      .in('user_id', uniq);
    if (win.fromAt) query.gt('logged_at', win.fromAt);
    if (win.toAt) query.lte('logged_at', win.toAt);
    const { data, error } = await query.order('logged_at', { ascending: false });
    if (error) {
      console.warn('[profiles] 批量查询登录统计失败(不影响使用):', error.message);
      return result;
    }
    for (const row of data ?? []) {
      const uid = row.user_id as string;
      const existing = result.get(uid);
      if (existing) {
        // 已倒序，首条即最新；后续同主只需累加次数并追加时刻
        existing.count += 1;
        existing.loggedAts.push(row.logged_at as string);
      } else {
        result.set(uid, {
          count: 1,
          lastLoggedAt: row.logged_at as string,
          loggedAts: [row.logged_at as string],
          recentLoggedAt: null,
        });
      }
    }
  } catch (err) {
    console.warn('[profiles] 批量查询登录统计异常(不影响使用):', err);
  }
  return result;
}
