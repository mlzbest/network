/**
 * 域名引导占位 Worker（临时态）
 *
 * 用途：在 DATABASE_URL / Hyperdrive 尚未就绪前，先把 api.maolizheng.xyz 的
 * DNS 记录与 Custom Domain 绑定建立起来。Cloudflare 的 Universal SSL 是 Zone 级
 * 证书（hosts = maolizheng.xyz, *.maolizheng.xyz），绑定 Custom Domain 后自动套用，
 * 不需要为子域单独签发证书。
 *
 * 生命周期：正式部署 `npm run deploy:workers` 会用同名 Worker 覆盖本文件，
 * Custom Domain 与 DNS 记录由 Cloudflare 复用，无需删除或重建。
 *
 * 注意：/api/health 刻意返回 503，避免 switch-backend.mjs --check 误判后端已就绪
 * 而把前端切到尚无数据库的 selfhost 后端。
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/__worker/health') {
      return json({
        ok: true,
        mode: 'domain-bootstrap',
        worker: 'detect-network-worker',
        domain: 'api.maolizheng.xyz',
        ts: Date.now(),
      });
    }

    if (url.pathname === '/api/health') {
      return json(
        {
          ok: false,
          code: 'BACKEND_NOT_DEPLOYED',
          error: '域名与证书已就绪，业务后端尚未部署（等待 DATABASE_URL / Hyperdrive）',
        },
        503,
      );
    }

    return json({ code: 'BACKEND_NOT_DEPLOYED', path: url.pathname }, 503);
  },
};
