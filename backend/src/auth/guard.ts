import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, type JwtPayload } from './jwt.js';

export interface AuthedUser {
  uid: string;
  username: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser;
  }
}

/**
 * 从 Authorization: Bearer <jwt> 解析并校验当前用户。
 * 校验失败仅清空 request.user（由各路由自行决定是否 401），便于「可选鉴权」场景。
 */
export function parseAuth(req: FastifyRequest): AuthedUser | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  const payload = verifyToken(token);
  if (!payload) return null;
  return { uid: payload.uid, username: payload.username };
}

/** 强制鉴权：未登录直接 401。 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<AuthedUser | null> {
  const user = parseAuth(req);
  if (!user) {
    reply.code(401).send({ error: '未授权或登录已过期', code: 'unauthorized' });
    return null;
  }
  req.user = user;
  return user;
}
