/**
 * 客户端入口（双栈）。
 *
 * ⚠️ 为什么默认走 `legacy`：
 * WorkBuddy Cloud SDK 的 `auth.signUp` 强制要求 `verificationToken`（必须先
 * `sendOtp` + `verifyOtp`），SDK 源码注释明确写着「只有用户名+密码的注册会被
 * 上游明确拒绝」。而本应用的账号体系是「用户名 + 密码 + `{username}@meoo.local`
 * 占位邮箱」，没有可收信的真实邮箱，OTP 链路走不通。为完整保留现有用户名密码
 * 体系（以及与之绑定的历史数据、RLS、Realtime），鉴权 / 数据 / 存储 / Realtime
 * 主栈默认使用 Meoo Cloud 的 Supabase 网关。
 *
 * 承载层（Task #8/#9）不受影响：ASR / SMTP 找回密码 / 网络诊断 / 逆地理 / relay
 * 仍通过 `VITE_CLOUD_FN_BASE_URL` / `VITE_CLOUD_FN_RELAY_URL` 走 TCB / Cloudflare，
 * 未配置时才回落到旧的 `${supabaseUrl}/functions/v1/*`。
 *
 * 切回 WorkBuddy Cloud：设置 `VITE_AUTH_BACKEND=cloud`。该模式下注册需先完成
 * OTP 验证，当前业务 UI 不支持，故仅作为后续云端移植的预留分支。
 *
 * 平台差异：weapp 构建里 `@supabase/supabase-js` 被 alias 成 `supabase-wechat-js`
 * （见 config/index.ts），会自动使用 wx.request / wx storage / wx.connectSocket，
 * 因此这里无需手写小程序 polyfill；`realtime-socket-patch.ts` 也会重新生效。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';
import {
  cloudAuth,
  cloudLlm,
  cloudStorage,
  cloudSupabase,
  CLOUD_STORAGE_BUCKET,
  getCloudBusinessUserId,
  getCloudSessionToken,
  getWorkBuddyCloudClient,
} from './cloud-adapter';
import { selfhostClient } from './selfhost-client';

declare global {
  interface ImportMetaEnv {
    readonly VITE_SUPABASE_URL?: string;
    readonly VITE_SUPABASE_ANON_KEY?: string;
    readonly VITE_ONEDAY_APP_ID?: string;
    readonly VITE_SUPABASE_AUTH_STORAGE_KEY?: string;
    readonly VITE_CLOUD_ENDPOINT?: string;
    readonly VITE_CLOUD_PUBLISHABLE_KEY?: string;
    readonly VITE_CLOUD_OAUTH_RELAY_BASE_URL?: string;
    readonly VITE_CLOUD_WORKBUDDY_OAUTH_CLIENT_ID?: string;
    /**
     * 鉴权后端选择：
     *  - `legacy`（默认）：Meoo Cloud Supabase 网关，支持「用户名 + 密码」注册/登录
     *  - `cloud`：WorkBuddy Cloud SDK，注册需 OTP 验证码
     *  - `selfhost`：自建 Node + Postgres 后端（backend/ 目录），彻底脱离 Meoo Cloud
     */
    readonly VITE_AUTH_BACKEND?: 'legacy' | 'cloud' | 'selfhost';
    /** selfhost 模式下后端 API 根地址（如 http://localhost:4000 或生产域名） */
    readonly VITE_SELFHOST_API_BASE?: string;
    /**
     * Task #8/#9：承载层网关 URL（TCB / Cloudflare Workers 部署后填入）。
     * 配置后 5 类外部依赖能力（ASR / SMTP 找回密码 / 网络诊断 / 逆地理 / relay）
     * 走承载层，未配置时各调用点自动回落到 `${supabaseUrl}/functions/v1/*`。
     */
    readonly VITE_CLOUD_FN_BASE_URL?: string;
    /** 承载层 relay 专用 URL（Cloudflare Workers），独立于 TCB 网关。 */
    readonly VITE_CLOUD_FN_RELAY_URL?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

function requirePublicEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`[Meoo Cloud] Missing environment variable: ${name}`);
  }
  return value;
}

/** 当前鉴权后端。`cloud` 需显式开启，避免误切后注册链路整体失效。 */
export const AUTH_BACKEND: 'legacy' | 'cloud' | 'selfhost' =
  (import.meta.env.VITE_AUTH_BACKEND as any) === 'cloud'
    ? 'cloud'
    : (import.meta.env.VITE_AUTH_BACKEND as any) === 'selfhost'
      ? 'selfhost'
      : 'legacy';

export const isCloudAuth = AUTH_BACKEND === 'cloud';
export const isSelfhost = AUTH_BACKEND === 'selfhost';

// ─── 兼容导出：旧业务文件仍 import 这些，保持签名不变 ───────────────────────
// ⚠️ 这里必须取旧的 VITE_SUPABASE_URL / ANON_KEY，不能回退到 VITE_CLOUD_ENDPOINT：
// `supabaseUrl` 同时是承载层未配置时 `/functions/v1/*` 的回落基础，指向
// WorkBuddy Cloud 域名会让 ASR / 找回密码等能力打到不存在的路径上。
// selfhost 模式下这些 legacy 变量无需存在（整条链路走自建后端），给占位空串。
export const projectUrlId = isSelfhost
  ? ''
  : requirePublicEnv(import.meta.env.VITE_ONEDAY_APP_ID, 'VITE_ONEDAY_APP_ID');

export const supabaseUrl = isSelfhost
  ? (import.meta.env.VITE_SELFHOST_API_BASE ?? '')
  : requirePublicEnv(import.meta.env.VITE_SUPABASE_URL, 'VITE_SUPABASE_URL');

export const supabaseAnonKey = isSelfhost
  ? ''
  : requirePublicEnv(import.meta.env.VITE_SUPABASE_ANON_KEY, 'VITE_SUPABASE_ANON_KEY');

const supabaseAuthStorageKey = import.meta.env.VITE_SUPABASE_AUTH_STORAGE_KEY;

export function getSupabaseUrl(): string {
  return supabaseUrl;
}

// ─── Task #8/#9：承载层 URL 解析（优先 VITE_CLOUD_FN_BASE_URL，回落旧网关）──────

/** TCB 承载层网关根（尾部无斜杠），未配置时返回 null */
export function getCloudFnBaseUrl(): string | null {
  const raw = import.meta.env.VITE_CLOUD_FN_BASE_URL;
  return raw ? raw.replace(/\/+$/, '') : null;
}

/**
 * 解析某类承载层能力的调用 URL：
 *  - 已配置 VITE_CLOUD_FN_BASE_URL → `${base}/${fnName}`
 *  - 未配置 → 回落到旧的 `${supabaseUrl}/functions/v1/${legacyFnName}`
 */
export function resolveCloudFnUrl(fnName: string, legacyFnName: string): string {
  const base = getCloudFnBaseUrl();
  if (base) return `${base}/${fnName}`;
  return `${supabaseUrl}/functions/v1/${legacyFnName}`;
}

/** relay 通道：已配置走 Cloudflare Workers，否则回落旧 ai-chat 的 relay 分支 */
export function resolveRelayUrl(): string {
  const raw = import.meta.env.VITE_CLOUD_FN_RELAY_URL;
  return raw ? raw.replace(/\/+$/, '') : `${supabaseUrl}/functions/v1/ai-chat`;
}

// 重新导出适配层符号，供 cloud 模式与 cloud-fn-adapter 使用
export {
  cloudAuth,
  cloudLlm,
  cloudStorage,
  cloudSupabase,
  CLOUD_STORAGE_BUCKET,
  getCloudBusinessUserId,
  getCloudSessionToken,
  getWorkBuddyCloudClient,
};

// ─── cloud 模式兼容对象（保留 WorkBuddy Cloud 迁移成果，供后续切回）────────────

type LegacyRealtimeChannel = {
  on: (
    event: string,
    filter?: unknown,
    callback?: (payload: { new?: unknown; old?: unknown }) => void,
  ) => LegacyRealtimeChannel;
  subscribe: (
    callback?: (status?: string, err?: Error) => void,
  ) => LegacyRealtimeChannel;
  unsubscribe: () => Promise<{ error: Error | null }>;
};

type RealtimePlaceholder = {
  channel: (name: string, opts?: unknown) => LegacyRealtimeChannel;
};

function legacyRealtimeChannel(name: string): LegacyRealtimeChannel {
  return {
    on: () => legacyRealtimeChannel(name),
    subscribe: () => legacyRealtimeChannel(name),
    unsubscribe: async () => ({
      error: new Error(
        `[WorkBuddy Cloud] realtime 通道 ${name} 无等价实现；请切回 VITE_AUTH_BACKEND=legacy。`,
      ),
    }),
  };
}

/** WorkBuddy Cloud 兼容面：只在 `VITE_AUTH_BACKEND=cloud` 时作为 `supabase` 使用。 */
const cloudCompatSupabase = {
  from: cloudSupabase.from,
  rpc: cloudSupabase.rpc,
  auth: {
    getSession: cloudAuth.getSession,
    signOut: cloudAuth.signOut,
    onAuthStateChange: cloudAuth.onAuthStateChange,
    signInWithPassword: cloudAuth.signInWithPassword,
    signUp: cloudAuth.signUp,
    signInWithWechat: cloudAuth.signInWithWechat,
    getUser: cloudAuth.getUser,
    updateUser: cloudAuth.updateUser,
    verifyOtp: cloudAuth.verifyOtp,
  },
  storage: {
    from: cloudStorage.from,
    getPublicUrl: cloudStorage.getPublicUrl,
    upload: cloudStorage.upload,
    createSignedUrl: cloudStorage.createSignedUrl,
    createSignedUploadUrl: cloudStorage.createSignedUploadUrl,
    list(_bucket?: string, _opts?: unknown) {
      throw new Error('[WorkBuddy Cloud] storage.list 无等价接口');
    },
    remove(_bucket?: string, _paths?: unknown, _opts?: unknown) {
      throw new Error('[WorkBuddy Cloud] storage.remove 无等价接口');
    },
    createBucket(_name?: string, _opts?: unknown) {
      throw new Error('[WorkBuddy Cloud] storage.createBucket 无等价接口');
    },
    getBucket(_name?: string) {
      throw new Error('[WorkBuddy Cloud] storage.getBucket 无等价接口');
    },
  },
  realtime: {
    channel: (name: string, _opts?: unknown) => legacyRealtimeChannel(name),
  } satisfies RealtimePlaceholder,
  channel: (name: string, _opts?: unknown) => legacyRealtimeChannel(name),
  removeChannel: (channel: LegacyRealtimeChannel) =>
    channel.unsubscribe().catch(() => undefined),
  functions: {
    invoke: (fn: string) =>
      Promise.resolve({
        data: undefined,
        error: new Error(
          `[WorkBuddy Cloud] Edge Function "${fn}" 已迁移，请改用 cloudLlm。`,
        ),
      }),
  },
  getBusinessUserId: getCloudBusinessUserId,
};

// ─── legacy 模式：真实 SupabaseClient ───────────────────────────────────────

/**
 * 构造 Meoo Cloud Supabase 客户端。
 *
 * `OneDay-App-Id` 是网关的必需头：**缺了它 `/auth/v1/signup` 会返回空 400**
 * （实测），加上后 `{username}@meoo.local` + 密码注册、`grant_type=password`
 * 登录、`user_metadata.username` 写入 profiles 全部正常。supabase-js 的
 * `global.headers` 会同时作用到 auth / rest / storage / functions 四类请求。
 */
function createLegacyClient(): SupabaseClient<Database> {
  return createClient<Database>(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: { 'OneDay-App-Id': projectUrlId },
    },
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      ...(supabaseAuthStorageKey ? { storageKey: supabaseAuthStorageKey } : {}),
    },
  });
}

/**
 * 业务统一入口。legacy 下是真 SupabaseClient（含完整 Realtime），
 * cloud 下是 WorkBuddy 兼容对象（cast 成同一类型，避免 15+ 业务文件改类型）。
 * selfhost 下是自建后端适配器（同样 cast，业务代码零改动）。
 */
export const supabase: SupabaseClient<Database> = isSelfhost
  ? (selfhostClient as unknown as SupabaseClient<Database>)
  : isCloudAuth
    ? (cloudCompatSupabase as unknown as SupabaseClient<Database>)
    : createLegacyClient();

// 保留占位变量的引用，避免 TS 判为 unused。
void supabaseAuthStorageKey;
void getWorkBuddyCloudClient;
void getCloudSessionToken;
void cloudLlm;
void CLOUD_STORAGE_BUCKET;
void getCloudBusinessUserId;
