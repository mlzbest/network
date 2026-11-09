/**
 * Cloudflare Workers 专用轻量路由层。
 *
 * 为什么不用 Fastify：Fastify 4 的 find-my-way 在注册路由时用
 * `new Function()` 生成参数解析代码，而 Workers 永久禁用动态代码求值
 * （没有 compatibility flag 可开启）。这里提供一份 Fastify 风格的最小
 * app/request/reply 接口，让 authRouter / dataRouter / edgeRouter /
 * registerCoreRoutes 原样注册，业务逻辑零分叉。
 *
 * Node / VPS 继续走 server.ts 的 Fastify，两者共享同一批 handler。
 */
import { corsOrigins } from '../env.js';
import { authRouter } from '../auth/router.js';
import { dataRouter } from '../data/routes.js';
import { edgeRouter } from '../edge/routes.js';
import { registerCoreRoutes } from './routes.js';

type AnyHandler = (req: any, reply: any) => any;
type Plugin = (app: any) => any;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: AnyHandler;
}

interface InjectOptions {
  method: string;
  url: string;
  headers: Record<string, string>;
  payload?: Uint8Array;
}

export interface WorkerInjectResponse {
  statusCode: number;
  headers: Record<string, string>;
  rawPayload: Uint8Array;
}

class MiniReply {
  statusCode = 200;
  headers: Record<string, string> = {};
  body: unknown = undefined;
  sent = false;

  code(status: number): this {
    this.statusCode = status;
    return this;
  }

  header(name: string, value: string | number): this {
    this.headers[name] = String(value);
    return this;
  }

  type(contentType: string): this {
    this.headers['Content-Type'] = contentType;
    return this;
  }

  send(body?: unknown): this {
    this.body = body;
    this.sent = true;
    return this;
  }
}

function compilePath(path: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const parts = path.split('/').map((segment) => {
    if (segment === '*') {
      keys.push('*');
      return '(.*)';
    }
    if (segment.startsWith(':')) {
      keys.push(segment.slice(1));
      return '([^/]+)';
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return { regex: new RegExp(`^${parts.join('/')}$`), keys };
}

function lowerKeyHeaders(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) out[key.toLowerCase()] = value;
  return out;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function serializeBody(reply: MiniReply): Uint8Array {
  const body = reply.body;
  if (body == null) return new Uint8Array(0);
  if (ArrayBuffer.isView(body)) {
    const view = body as Uint8Array;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (!hasHeader(reply.headers, 'content-type')) {
    reply.headers['Content-Type'] =
      typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
  }
  return encodeUtf8(typeof body === 'string' ? body : JSON.stringify(body));
}

class MiniApp {
  private routes: Route[] = [];

  get(path: string, handler: AnyHandler): void {
    this.add('GET', path, handler);
  }
  post(path: string, handler: AnyHandler): void {
    this.add('POST', path, handler);
  }
  put(path: string, handler: AnyHandler): void {
    this.add('PUT', path, handler);
  }
  delete(path: string, handler: AnyHandler): void {
    this.add('DELETE', path, handler);
  }

  private add(method: string, path: string, handler: AnyHandler): void {
    const { regex, keys } = compilePath(path);
    this.routes.push({ method, regex, keys, handler });
  }

  async register(plugin: Plugin): Promise<void> {
    await plugin(this);
  }

  private corsHeaders(requestHeaders: Record<string, string>): Record<string, string> {
    const origin = requestHeaders.origin || '';
    const allowOrigin = corsOrigins.includes('*')
      ? '*'
      : corsOrigins.includes(origin)
        ? origin
        : '';
    const out: Record<string, string> = {
      'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    };
    if (allowOrigin) out['Access-Control-Allow-Origin'] = allowOrigin;
    return out;
  }

  async inject(opts: InjectOptions): Promise<WorkerInjectResponse> {
    const method = opts.method.toUpperCase();
    const headers = lowerKeyHeaders(opts.headers || {});
    const cors = this.corsHeaders(headers);

    if (method === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: { ...cors },
        rawPayload: new Uint8Array(0),
      };
    }

    const [rawPath, rawQuery = ''] = opts.url.split('?', 2);
    let path = rawPath;
    try {
      path = decodeURIComponent(path);
    } catch {
      // 非法 percent-encoding 直接原样处理，后续 404
    }

    const route = this.routes.find((r) => r.method === method && r.regex.test(path));
    if (!route) {
      return {
        statusCode: 404,
        headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
        rawPayload: encodeUtf8(JSON.stringify({ error: 'not_found' })),
      };
    }

    let body: unknown = undefined;
    if (opts.payload && opts.payload.byteLength > 0) {
      const text = new TextDecoder().decode(opts.payload);
      try {
        body = JSON.parse(text);
      } catch {
        return {
          statusCode: 400,
          headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
          rawPayload: encodeUtf8(JSON.stringify({ error: 'invalid_json' })),
        };
      }
    }

    const match = route.regex.exec(path)!;
    const params: Record<string, string> = {};
    route.keys.forEach((key, index) => {
      params[key] = match[index + 1] ?? '';
    });

    const query: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(rawQuery)) query[key] = value;

    const req = {
      method,
      url: opts.url,
      path,
      headers,
      body,
      params,
      query,
      ip:
        (headers['cf-connecting-ip'] || headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        '127.0.0.1',
      user: undefined as unknown,
    };

    const reply = new MiniReply();
    try {
      const returned = await route.handler(req, reply);
      // Fastify 语义：async handler 直接返回对象等价于 reply.send(对象)。
      if (!reply.sent && returned !== undefined) reply.send(returned);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[worker-app] handler error:', message);
      reply.code(500).send({ error: 'internal_error', message: message.slice(0, 300) });
    }

    const payload = serializeBody(reply);
    const outHeaders: Record<string, string> = { ...cors, ...reply.headers };
    if (!hasHeader(outHeaders, 'content-length')) {
      outHeaders['content-length'] = String(payload.byteLength);
    }
    return { statusCode: reply.statusCode, headers: outHeaders, rawPayload: payload };
  }
}

/** 构造 Worker 版应用：与 server.ts 注册同一批业务路由。 */
export async function buildWorkerApp(): Promise<MiniApp> {
  const app = new MiniApp();
  await app.register(authRouter);
  await app.register(dataRouter);
  await app.register(edgeRouter);
  await app.register(registerCoreRoutes);
  return app;
}
