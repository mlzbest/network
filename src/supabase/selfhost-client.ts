/**
 * 自建后端客户端适配器（selfhost）。
 *
 * 提供与 `@supabase/supabase-js` 高度兼容的调用面：`.from().select/insert/update/delete`
 * 链式构造器（可 await）、`.rpc()`、`.auth.*`、`.storage.*`、`.channel()`。
 * 业务代码（15+ 文件）无需逐处改写，只需把 `VITE_AUTH_BACKEND` 设为 `selfhost`，
 * 底层即从 Meoo Cloud 网关切到本地 Node + Postgres 后端。
 *
 * 实时（Realtime）：自建后端用 Socket.IO 推送，但本适配器第一版把 `.channel()` 实现为
 * 「主动失败」占位——subscribe 回调收到 'TIMED_OUT'，触发应用已有的轮询兜底
 * （`realtimeOkRef`），聊天实时性由轮询保证。后续版本可接入 socket.io-client 升级为真实时。
 */
import Taro from '@tarojs/taro';

const BASE: string =
  (import.meta.env.VITE_SELFHOST_API_BASE as string | undefined)?.replace(/\/+$/, '') ||
  'http://localhost:4000';

const TOKEN_KEY = 'selfhost_auth_token';
const UID_KEY = 'selfhost_auth_uid';

// ─── token 存取（Taro 存储，web/小程序通用）──────────────────────────────────
function getToken(): string {
  try {
    return (Taro.getStorageSync(TOKEN_KEY) as string) || '';
  } catch {
    return '';
  }
}
function setToken(t: string, uid?: string) {
  try {
    Taro.setStorageSync(TOKEN_KEY, t);
    if (uid) Taro.setStorageSync(UID_KEY, uid);
  } catch {
    /* ignore */
  }
}
function clearToken() {
  try {
    Taro.removeStorageSync(TOKEN_KEY);
    Taro.removeStorageSync(UID_KEY);
  } catch {
    /* ignore */
  }
}

// ─── 轻量 fetch 封装 ─────────────────────────────────────────────────────────
async function shFetch<T = any>(
  path: string,
  body?: unknown,
  method: 'GET' | 'POST' = 'POST',
): Promise<{ data: T | null; error: { message: string; status?: number } | null }> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await Taro.request({
      url: `${BASE}${path}`,
      method: method as any,
      header: headers,
      data: body as any,
    });
    const payload = (res.data ?? {}) as any;
    if (res.statusCode >= 400) {
      return {
        data: null,
        error: { message: payload?.error || `请求失败(${res.statusCode})`, status: res.statusCode },
      };
    }
    // 后端成功响应统一为 `{ data, error }` 包裹；这里解一层，
    // 让各调用点直接拿到业务数据（rows / { session } / { publicUrl }）。
    return { data: (payload?.data ?? null) as T, error: payload?.error ?? null };
  } catch (e: any) {
    return { data: null, error: { message: e?.message || String(e) } };
  }
}

// ─── auth 事件订阅（替代 onAuthStateChange）────────────────────────────────
type AuthCb = (event: string, session: any) => void;
const authListeners = new Set<AuthCb>();
function emitAuth(event: string, session: any) {
  authListeners.forEach((cb) => {
    try {
      cb(event, session);
    } catch {
      /* ignore */
    }
  });
}

// ─── 查询构造器（thenable，对齐 supabase 的 await 用法）──────────────────────
type Filter = {
  t: string;
  c?: string;
  v?: unknown;
  op?: string;
  raw?: string;
  parts?: Array<{ c: string; op: string; v: unknown }>;
};

class ShQueryBuilder {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private columns = '*';
  private values: Record<string, unknown> | Record<string, unknown>[] = {};
  private filters: Filter[] = [];
  private orderBy: Array<{ c: string; asc?: boolean; nullsFirst?: boolean }> = [];
  private limitN?: number;
  private offsetN?: number;
  private singleFlag = false;
  private maybeSingleFlag = false;

  constructor(private table: string) {}

  select(columns?: string) {
    // 注意：不能在这里把 op 改成 'select'。
    // PostgREST 语义下 `.insert(x).select('*')` / `.update(y).select('id')`
    // 表示「写入后回读受影响行」，op 必须保持 insert/update。
    if (columns) this.columns = columns;
    return this;
  }
  insert(values: Record<string, unknown> | Record<string, unknown>[]) {
    this.op = 'insert';
    this.values = values;
    return this;
  }
  update(values: Record<string, unknown>) {
    this.op = 'update';
    this.values = values;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  private add(f: Filter) {
    this.filters.push(f);
    return this;
  }
  eq(c: string, v: unknown) {
    return this.add({ t: 'eq', c, v });
  }
  neq(c: string, v: unknown) {
    return this.add({ t: 'neq', c, v });
  }
  gt(c: string, v: unknown) {
    return this.add({ t: 'gt', c, v });
  }
  gte(c: string, v: unknown) {
    return this.add({ t: 'gte', c, v });
  }
  lt(c: string, v: unknown) {
    return this.add({ t: 'lt', c, v });
  }
  lte(c: string, v: unknown) {
    return this.add({ t: 'lte', c, v });
  }
  is(c: string, v: unknown) {
    return this.add({ t: 'is', c, v });
  }
  in(c: string, v: unknown[]) {
    return this.add({ t: 'in', c, v });
  }
  or(expr: string) {
    return this.add({ t: 'or', raw: expr });
  }
  filter(c: string, op: string, v: unknown) {
    return this.add({ t: 'filter', c, op, v });
  }
  order(c: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orderBy.push({ c, asc: opts?.ascending, nullsFirst: opts?.nullsFirst });
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  range(from: number, to: number) {
    this.offsetN = from;
    this.limitN = to - from + 1;
    return this;
  }
  single() {
    this.singleFlag = true;
    return this;
  }
  maybeSingle() {
    this.maybeSingleFlag = true;
    return this;
  }

  async execute() {
    const spec = {
      op: this.op,
      table: this.table,
      columns: this.columns,
      values: this.values,
      filters: this.filters,
      order: this.orderBy,
      limit: this.limitN,
      offset: this.offsetN,
      single: this.singleFlag,
      maybeSingle: this.maybeSingleFlag,
    };
    const res = await shFetch('/api/db', spec);
    return { data: res.data, error: res.error };
  }

  then<TResult1 = { data: any; error: any }, TResult2 = never>(
    onFulfilled?: ((value: { data: any; error: any }) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onFulfilled as any, onRejected as any);
  }
}

// ─── rpc（thenable）─────────────────────────────────────────────────────────
class ShRpc {
  constructor(private name: string, private params: Record<string, unknown>) {}
  async execute() {
    const res = await shFetch('/api/rpc', { name: this.name, params: this.params });
    return { data: res.data, error: res.error };
  }
  then<TResult1 = { data: any; error: any }, TResult2 = never>(
    onFulfilled?: ((value: { data: any; error: any }) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onFulfilled as any, onRejected as any);
  }
}

// ─── storage ────────────────────────────────────────────────────────────────
async function toBase64(body: any): Promise<string> {
  let buf: ArrayBuffer;
  if (typeof body === 'string') return body;
  if (body instanceof ArrayBuffer) buf = body;
  else if (body?.arrayBuffer) buf = await body.arrayBuffer();
  else if (Array.isArray(body) && body instanceof Uint8Array) buf = body.buffer as ArrayBuffer;
  else buf = new Uint8Array(body).buffer as ArrayBuffer;
  // 小程序/Web 通用：优先 Taro 提供的 base64（小程序无全局 btoa）
  const anyTaro = Taro as any;
  if (typeof anyTaro.arrayBufferToBase64 === 'function') {
    return anyTaro.arrayBufferToBase64(buf);
  }
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const selfhostStorage = {
  from(bucket: string) {
    return {
      async upload(path: string, body: any, options?: { contentType?: string }) {
        const base64 = await toBase64(body);
        const res = await shFetch('/api/storage/upload', {
          bucket,
          path,
          contentBase64: base64,
          contentType: options?.contentType || 'application/octet-stream',
        });
        if (res.error) return { data: null, error: res.error };
        // 后端未配置 PUBLIC_BASE_URL 时返回相对路径；补齐成绝对地址，
        // 否则小程序 <Image> 无法加载（小程序没有同源概念）。
        const raw = res.data?.publicUrl as string | undefined;
        const publicUrl = raw && !/^https?:\/\//i.test(raw) ? `${BASE}${raw}` : raw;
        return { data: { path, publicUrl }, error: null };
      },
      getPublicUrl(path: string) {
        const url = `${BASE}/api/storage/public/${encodeURIComponent(bucket)}/${String(path).replace(
          /^\/+/,
          '',
        )}`;
        return { data: { publicUrl: url }, error: null };
      },
      async remove(paths: string | string[]) {
        const list = (Array.isArray(paths) ? paths : [paths]).map(String);
        const res = await shFetch('/api/storage/remove', { bucket, paths: list });
        if (res.error) return { data: null, error: res.error };
        return { data: res.data ?? {}, error: null };
      },
    };
  },
  getPublicUrl(bucket: string, path: string) {
    return this.from(bucket).getPublicUrl(path);
  },
};

// ─── channel（realtime 占位：触发轮询兜底）──────────────────────────────────
function selfhostChannel(_name: string) {
  return {
    on(_event: string, _filter?: unknown, _cb?: unknown) {
      return this;
    },
    subscribe(cb?: (status?: string) => void) {
      // 主动上报 TIMED_OUT，让应用切换到轮询兜底
      if (cb) cb('TIMED_OUT');
      return this;
    },
    unsubscribe() {
      return Promise.resolve({ error: null });
    },
  };
}

// ─── auth ───────────────────────────────────────────────────────────────────
const selfhostAuth = {
  async signInWithPassword({ email, password }: { email: string; password: string }) {
    const res = await shFetch('/api/auth/login', { email, password });
    if (res.error || !res.data?.session) {
      return { data: null, error: res.error || { message: '登录失败' } };
    }
    const session = res.data.session;
    setToken(session.access_token, session.user?.id);
    emitAuth('SIGNED_IN', session);
    return { data: { session, user: session.user }, error: null };
  },

  async signUp({
    email,
    password,
    options,
  }: {
    email: string;
    password: string;
    options?: { data?: { username?: string } };
  }) {
    const username = options?.data?.username;
    const res = await shFetch('/api/auth/register', { username, password, email });
    if (res.error || !res.data?.session) {
      return { data: null, error: res.error || { message: '注册失败' } };
    }
    const session = res.data.session;
    setToken(session.access_token, session.user?.id);
    emitAuth('SIGNED_IN', session);
    return { data: { user: res.data.user, session }, error: null };
  },

  async signOut(_arg?: unknown) {
    clearToken();
    emitAuth('SIGNED_OUT', null);
    shFetch('/api/auth/logout').catch(() => {});
    return { error: null };
  },

  async getSession() {
    const token = getToken();
    if (!token) return { data: { session: null } };
    const res = await shFetch('/api/auth/session', undefined, 'GET');
    if (res.error || !res.data?.session) return { data: { session: null } };
    return { data: { session: res.data.session } };
  },

  async getUser() {
    const { data } = await selfhostAuth.getSession();
    return { data: { user: data.session?.user ?? null }, error: null };
  },

  async updateUser({ password }: { password: string }) {
    const res = await shFetch('/api/auth/update-password', { password });
    if (res.error) return { data: null, error: res.error };
    return { data: { user: {} }, error: null };
  },

  onAuthStateChange(cb: AuthCb) {
    authListeners.add(cb);
    return {
      data: {
        subscription: {
          unsubscribe() {
            authListeners.delete(cb);
          },
        },
      },
    };
  },

  // 微信 OTP / 微信登录：自建后端需单独实现微信 code 换取，本版本暂不支持
  async verifyOtp(_args: unknown) {
    return {
      data: null,
      error: { message: 'selfhost 模式暂不支持微信 OTP 登录，请使用用户名 + 密码' },
    };
  },
  async signInWithWechat(_code: string, _appid?: string) {
    return {
      data: null,
      error: { message: 'selfhost 模式暂不支持微信登录，请使用用户名 + 密码' },
    };
  },
};

// ─── 导出与 supabase 兼容的对象 ─────────────────────────────────────────────
/**
 * 供 wx-mp-login 等外部流程在拿到后端签发的会话后写入本地登录态。
 * （自建后端的微信登录直接返回 JWT 会话，无需 verifyOtp 交换。）
 */
export function applySelfhostSession(session: {
  access_token: string;
  user?: { id?: string; email?: string; username?: string };
}) {
  setToken(session.access_token, session.user?.id);
  emitAuth('SIGNED_IN', session);
}

export const selfhostClient = {
  from(table: string) {
    return new ShQueryBuilder(table);
  },
  rpc(name: string, params: Record<string, unknown> = {}) {
    return new ShRpc(name, params);
  },
  auth: selfhostAuth,
  storage: selfhostStorage,
  channel: selfhostChannel,
  realtime: { channel: selfhostChannel },
  removeChannel(channel: any) {
    return channel?.unsubscribe?.() ?? Promise.resolve({ error: null });
  },
  getBusinessUserId() {
    return getToken() ? getSelfUid() : null;
  },
};

function getSelfUid(): string | null {
  try {
    return (Taro.getStorageSync(UID_KEY) as string) || null;
  } catch {
    return null;
  }
}
