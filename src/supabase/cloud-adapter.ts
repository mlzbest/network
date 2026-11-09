import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';
import {
  createMiniProgramWorkBuddyCloud,
  type MiniProgramWorkBuddyCloudClient,
} from '@tencent-ai/workbuddy-cloud-sdk/miniprogram';
import type { Database } from './types';
import { selfhostClient } from './selfhost-client';

export const CLOUD_STORAGE_BUCKET = 'runtime';

declare global {
  interface ImportMetaEnv {
    readonly VITE_CLOUD_ENDPOINT?: string;
    readonly VITE_CLOUD_PUBLISHABLE_KEY?: string;
    readonly VITE_CLOUD_OAUTH_RELAY_BASE_URL?: string;
    readonly VITE_CLOUD_WORKBUDDY_OAUTH_CLIENT_ID?: string;
  }
}

type MiniProgramWxLike =
  | NonNullable<
      Parameters<typeof createMiniProgramWorkBuddyCloud>[0]['wx']
    >
  | undefined;

type CloudClient = MiniProgramWorkBuddyCloudClient<Database>;

/**
 * 宽类型查询构造器：让 `from('profiles')` / `from('messages')` 等任意表名调用都能编译通过。
 * 运行期仍走 WorkBuddy PostgREST，类型层故意放宽到 `any`，避免 15+ 业务文件全量报 `never`。
 */
type LooseQueryBuilder = any;

/**
 * 兼容 Supabase 的 Storage 桶接口。
 * 当前 SDK 的 `storage.from()` 返回 `WorkBuddyStorageBucket`，没有 `getPublicUrl`，
 * 这里补上同步 URL 拼接，方便 `thumb-url.ts` 等旧代码继续走通。
 */
interface LegacyStorageBucket {
  getPublicUrl(
    path: string,
    opts?: { transform?: Record<string, unknown>; cacheControl?: string },
  ): {
    data: { publicUrl: string };
    error: null;
  };
  upload(
    path: string,
    body: Parameters<CloudClient['storage']['upload']>[1],
    options?: Parameters<CloudClient['storage']['upload']>[2],
  ): ReturnType<CloudClient['storage']['upload']>;
  createSignedUrl(
    path: string,
    expiresIn?: number,
  ): ReturnType<CloudClient['storage']['createSignedUrl']>;
  createSignedUploadUrl(
    path: string,
    options?: Parameters<CloudClient['storage']['createSignedUploadUrl']>[1],
  ): ReturnType<CloudClient['storage']['createSignedUploadUrl']>;
}

function readGlobalWx(): MiniProgramWxLike {
  return (globalThis as { wx?: MiniProgramWxLike }).wx;
}

function requireCloudConfig() {
  const endpoint = import.meta.env.VITE_CLOUD_ENDPOINT;
  const publishableKey = import.meta.env.VITE_CLOUD_PUBLISHABLE_KEY;

  if (!endpoint) {
    throw new Error(
      '[WorkBuddy Cloud] Missing endpoint. Set VITE_CLOUD_ENDPOINT before using the cloud adapter.',
    );
  }
  if (!publishableKey) {
    throw new Error(
      '[WorkBuddy Cloud] Missing publishableKey. Set VITE_CLOUD_PUBLISHABLE_KEY before using the cloud adapter.',
    );
  }

  return {
    endpoint,
    publishableKey,
    oauthRelayBaseUrl: import.meta.env.VITE_CLOUD_OAUTH_RELAY_BASE_URL,
    workBuddyOAuthClientId:
      import.meta.env.VITE_CLOUD_WORKBUDDY_OAUTH_CLIENT_ID,
    wx: readGlobalWx(),
  };
}

let cachedClient: CloudClient | null = null;

/**
 * 获取 WorkBuddy Cloud 小程序客户端单例。
 *
 * 小程序没有 `location.origin`，所以 `endpoint` 必须显式来自环境变量；
 * `publishableKey` 是公开 key，可以打进前端产物，但不应出现在日志里。
 */
export function getWorkBuddyCloudClient(): CloudClient {
  if (!cachedClient) {
    const config = requireCloudConfig();
    if (config.wx) {
      // 小程序运行时（微信/钉钉/抖音）：必须用 /miniprogram 入口，它负责注入
      // wx.request 版 fetch、wx storage 和 polyfill，顺序由 SDK 内部固定。
      cachedClient = createMiniProgramWorkBuddyCloud<Database>({
        endpoint: config.endpoint,
        publishableKey: config.publishableKey,
        ...(config.oauthRelayBaseUrl
          ? { oauthRelayBaseUrl: config.oauthRelayBaseUrl }
          : {}),
        ...(config.workBuddyOAuthClientId
          ? { workBuddyOAuthClientId: config.workBuddyOAuthClientId }
          : {}),
        wx: config.wx,
      });
    } else {
      // H5 / 浏览器预览：没有全局 wx，小程序入口会直接抛
      // "createMiniProgramWorkBuddyCloud: 未找到全局 wx 对象"，导致注册/登录整条
      // 鉴权链路停用。Web 入口用 fetch + localStorage，API 形状一致。
      // 两者按运行时分流（同一进程只会走其一），不是混用两种加载形式。
      cachedClient = createWorkBuddyCloud<Database>({
        endpoint: config.endpoint,
        publishableKey: config.publishableKey,
        ...(config.oauthRelayBaseUrl
          ? { oauthRelayBaseUrl: config.oauthRelayBaseUrl }
          : {}),
        ...(config.workBuddyOAuthClientId
          ? { workBuddyOAuthClientId: config.workBuddyOAuthClientId }
          : {}),
      }) as unknown as CloudClient;
    }
  }
  return cachedClient;
}

export function getCloudSessionToken() {
  return getWorkBuddyCloudClient().auth.getAccessToken();
}

/**
 * 数据面兼容层。
 *
 * 这里刻意把签名放宽到 `string` + `LooseQueryBuilder`：
 * - 现有业务代码都是 `supabase.from('profiles')` 字面量，类型层不需要再做表名白名单；
 * - 运行期 `database.from` 仍然走 WorkBuddy 的 PostgREST 端点，RLS 由数据库侧控制。
 */
export const cloudSupabase = {
  from(_table: string): LooseQueryBuilder {
    // 运行期透传；类型层返回宽 query builder 避免 `never`
    return getWorkBuddyCloudClient().database.from(_table as any);
  },
  rpc(_fn: string, args?: Record<string, unknown>): LooseQueryBuilder {
    return getWorkBuddyCloudClient().database.rpc(_fn as any, args as any);
  },
};

/**
 * Auth 面。
 *
 * 这里把 SDK 返回的 `CloudResult<CloudSession>` 包装成 Supabase 风格的
 * `{ data: { session }, error }`，让 `src/api/**` 里 `.data.session?.user?.id`
 * 这类旧写法不用改。
 */
type LegacySession = {
  data: {
    session:
      | {
          access_token: string;
          user: {
            id: string;
            email?: string;
            phone?: string;
            [key: string]: unknown;
          };
        }
      | null;
  };
  error: null;
};

export const cloudAuth = {
  async getSession(): Promise<LegacySession> {
    const { data, error } = await getWorkBuddyCloudClient().auth.getSession();
    if (error) {
      // 旧 Supabase 风格：error 非空时 data 仍是空对象
      return { data: { session: null }, error: null };
    }
    if (!data) {
      return { data: { session: null }, error: null };
    }
    return {
      data: {
        session: {
          access_token: data.accessToken,
          user: {
            ...data.user,
            id: data.user.id,
            email: (data.user as any).email,
            phone: (data.user as any).phone,
          },
        },
      },
      error: null,
    };
  },

  async signOut(_scope?: 'local' | 'global') {
    const { error } = await getWorkBuddyCloudClient().auth.signOut();
    if (error) {
      return { data: null, error };
    }
    return { data: null, error: null };
  },

  onAuthStateChange(
    callback: Parameters<CloudClient['auth']['onAuthStateChange']>[0],
  ) {
    return getWorkBuddyCloudClient().auth.onAuthStateChange(callback);
  },

  signInWithWechat(code: string, appid: string) {
    return getWorkBuddyCloudClient().auth.signInWithWechat(code, appid);
  },

  signInWithPassword(
    credentials: Parameters<CloudClient['auth']['signInWithPassword']>[0],
  ) {
    return getWorkBuddyCloudClient().auth.signInWithPassword(credentials);
  },

  signUp(
    credentials: Parameters<CloudClient['auth']['signUp']>[0],
  ) {
    return getWorkBuddyCloudClient().auth.signUp(credentials);
  },

  /** 云端没有独立 `auth.getUser()`；旧代码若调用会拿到空。 */
  async getUser() {
    const { data } = await getWorkBuddyCloudClient().auth.getSession();
    return {
      data: data ? { ...data.user } : null,
      error: null,
    };
  },

  /**
   * 旧 Supabase 的 `auth.updateUser` 用于改密码等；
   * 云端改密码走 `auth.resetPasswordForOld`，这里做一层最小桥接，
   * 返回 Supabase 风格的 `{ data: { user }, error }`，让 `auth.ts` 旧调用少改。
   */
  async updateUser(update: {
    password?: string;
    oldPassword?: string;
    email?: string;
  }) {
    const result = await getWorkBuddyCloudClient().auth.getSession();
    if (result.error || !result.data) {
      return {
        data: { user: null as { id: string; [k: string]: unknown } | null },
        error: result.error ?? new Error('[WorkBuddy Cloud] 未登录，无法更新用户信息'),
      };
    }
    const currentSession = result.data;
    const cloudUser: Record<string, unknown> = { ...currentSession.user };

    if (!update.password) {
      // 仅 email 等元数据更新：直接回传当前 user，不做网络请求
      return { data: { user: cloudUser }, error: null };
    }

    if (update.oldPassword) {
      const resetResult = await getWorkBuddyCloudClient().auth.resetPasswordForOld({
        oldPassword: update.oldPassword,
        newPassword: update.password,
      } as any);
      if (resetResult.error) {
        return { data: { user: null }, error: resetResult.error };
      }
      if (resetResult.data?.user) {
        Object.assign(cloudUser, resetResult.data.user);
      }
      return { data: { user: cloudUser }, error: null };
    }

    // 没有旧密码时：Supabase 语义下可走「直接更新当前会话密码」，
    // 但 WorkBuddy 需要 oldPassword 走 resetPasswordForOld；这里按新密码直填旧密码位置试一次。
    const resetResult = await getWorkBuddyCloudClient().auth.resetPasswordForOld({
      oldPassword: '',
      newPassword: update.password,
    } as any);
    if (resetResult.error) {
      return { data: { user: null }, error: resetResult.error };
    }
    if (resetResult.data?.user) {
      Object.assign(cloudUser, resetResult.data.user);
    }
    return { data: { user: cloudUser }, error: null };
  },

  /**
   * 旧 Edge Function 时代的 verifyOtp 已废弃；
   * 这里保留方法签名，运行期提示改用 signInWithWechat，避免编译报错。
   */
  async verifyOtp(_input: unknown) {
    return {
      data: null,
      error: new Error(
        '[WorkBuddy Cloud] auth.verifyOtp 已废弃；请使用 cloudAuth.signInWithWechat',
      ),
    };
  },
};

/**
 * Storage 面。
 *
 * 返回带 `getPublicUrl` 的兼容桶对象，方便 `thumb-url.ts` / `upload.ts` 继续按 Supabase 风格调用。
 */
export function getCloudStorageBucket(bucketID?: string): LegacyStorageBucket {
  const client = getWorkBuddyCloudClient();
  const bucket = client.storage.from(bucketID as any);
  const endpoint = client.endpoint;

  return {
    getPublicUrl(path: string, _opts?: Record<string, unknown>) {
      return {
        data: {
          publicUrl: `${endpoint.replace(/\/$/, '')}/.cloud/storage/object/public/${bucketID ?? CLOUD_STORAGE_BUCKET}/${path}`,
        },
        error: null,
      };
    },
    upload(path: string, body: any, options?: any) {
      return (bucket as any).upload(path, body, options);
    },
    createSignedUrl(path: string, expiresIn?: number, options?: any) {
      return (bucket as any).createSignedUrl(path, expiresIn, options);
    },
    createSignedUploadUrl(path: string, options?: any) {
      return (bucket as any).createSignedUploadUrl(path, options);
    },
  };
}

// selfhost 模式下，所有存储读写回落到自建后端（避免循环依赖，直接读 env）
const SELFHOST = (import.meta.env as any).VITE_AUTH_BACKEND === 'selfhost';

export const cloudStorage = {
  from(bucketID?: string): LegacyStorageBucket {
    if (SELFHOST) {
      const b = selfhostClient.storage.from(bucketID as string);
      return b as unknown as LegacyStorageBucket;
    }
    return getCloudStorageBucket(bucketID);
  },

  getPublicUrl(bucket: string, path: string) {
    if (SELFHOST) return selfhostClient.storage.getPublicUrl(bucket, path);
    return getCloudStorageBucket(bucket).getPublicUrl(path);
  },

  upload(
    path: string,
    body: Parameters<CloudClient['storage']['upload']>[1],
    options?: Parameters<CloudClient['storage']['upload']>[2],
  ) {
    if (SELFHOST) {
      return selfhostClient.storage.from('runtime').upload(path, body, options as any) as any;
    }
    return getWorkBuddyCloudClient().storage.upload(path, body, options);
  },

  createSignedUrl(path: string, expiresIn?: number) {
    if (SELFHOST) {
      // 自建后端走 /api/storage/public 代理，URL 永不过期，因此忽略 expiresIn。
      // 之前这里返回 `{ error: null }` 会让调用方拿到 undefined 的 signedUrl 而静默失败。
      const { data } = selfhostClient.storage.getPublicUrl('runtime', path);
      return Promise.resolve({ data: { signedUrl: data.publicUrl }, error: null }) as any;
    }
    return getWorkBuddyCloudClient().storage.createSignedUrl(path, expiresIn);
  },

  createSignedUploadUrl(
    path: string,
    options?: Parameters<
      CloudClient['storage']['createSignedUploadUrl']
    >[1],
  ) {
    if (SELFHOST) {
      // 两阶段签名上传在自建后端未实现；明确报错，不要伪装成成功。
      return Promise.resolve({
        data: null,
        error: new Error('selfhost 不支持 createSignedUploadUrl，请用 storage.from(bucket).upload()'),
      }) as any;
    }
    return getWorkBuddyCloudClient().storage.createSignedUploadUrl(path, options);
  },
};

/**
 * LLM 面。
 */
export const cloudLlm = {
  get chat() {
    return getWorkBuddyCloudClient().llm.chat;
  },
  get models() {
    return getWorkBuddyCloudClient().llm.models;
  },
};

/**
 * 把云端会话里的 user id 映射成本应用的 `profiles.id`。
 *
 * 云端微信登录后，`session.user.id` 通常是 TCB custom uid；
 * 本项目 RLS 通过 `profiles.openid = auth.uid()` 做身份映射，
 * 所以这里额外提供一个“业务用户 ID”出口，避免上层到处散落映射逻辑。
 */
export async function getCloudBusinessUserId(): Promise<string | null> {
  const { data } = await getWorkBuddyCloudClient().auth.getSession();
  if (!data?.user?.id) {
    return null;
  }

  const cloudUserId = data.user.id;

  const { data: profiles } = await getWorkBuddyCloudClient().database
    .from('profiles')
    .select('id, openid')
    .eq('openid', cloudUserId)
    .limit(1);

  return (profiles?.[0]?.id as string) ?? cloudUserId;
}
