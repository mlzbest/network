import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';
import { hashPassword, verifyPassword } from './password.js';
import { signToken, verifyToken } from './jwt.js';
import { requireAuth } from './guard.js';

interface ProfileRow {
  id: string;
  username: string | null;
  email: string | null;
  password_hash: string;
}

const PLACEHOLDER_SUFFIX = '@meoo.local';
const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/;

function publicUser(p: ProfileRow) {
  return { id: p.id, email: p.email, username: p.username };
}

function issueSession(p: ProfileRow) {
  const token = signToken(p.id, p.username ?? p.email ?? p.id);
  return {
    session: {
      access_token: token,
      token_type: 'bearer',
      expires_in: 60 * 60 * 24 * 30,
      user: publicUser(p),
    },
    user: publicUser(p),
  };
}

async function resolveProfileByIdentifier(identifier: string): Promise<ProfileRow | null> {
  const { rows } = await query<ProfileRow>(
    'SELECT id, username, email, password_hash FROM profiles WHERE email = $1 OR username = $1 LIMIT 1',
    [identifier],
  );
  if (rows[0]) return rows[0];
  // 占位邮箱回落：{username}@meoo.local → 按 username 查
  if (identifier.endsWith(PLACEHOLDER_SUFFIX)) {
    const username = identifier.slice(0, -PLACEHOLDER_SUFFIX.length);
    const r2 = await query<ProfileRow>(
      'SELECT id, username, email, password_hash FROM profiles WHERE username = $1 LIMIT 1',
      [username],
    );
    return r2.rows[0] ?? null;
  }
  return null;
}

export async function authRouter(app: FastifyInstance) {
  // 注册（用户名 + 密码；邮箱默认占位 {username}@meoo.local）
  app.post('/api/auth/register', async (req, reply) => {
    const { username, password, email } = (req.body ?? {}) as {
      username?: string;
      password?: string;
      email?: string;
    };
    if (!username || !password) {
      return reply.code(400).send({ error: '用户名和密码必填' });
    }
    if (!USERNAME_RE.test(username)) {
      return reply.code(400).send({ error: '用户名需为 2-20 位字母/数字/下划线/中文' });
    }
    if (String(password).length < 6) {
      return reply.code(400).send({ error: '密码至少 6 位' });
    }
    const normalizedEmail = email?.trim() || `${username}${PLACEHOLDER_SUFFIX}`;
    const exists = await query('SELECT id FROM profiles WHERE username = $1 OR email = $2', [
      username,
      normalizedEmail,
    ]);
    if (exists.rowCount && exists.rowCount > 0) {
      return reply.code(409).send({ error: '用户名或邮箱已存在' });
    }
    const passwordHash = await hashPassword(password);
    const id = randomUUID();
    await query(
      `INSERT INTO profiles (id, username, email, password_hash, created_at)
       VALUES ($1, $2, $3, $4, now())`,
      [id, username, normalizedEmail, passwordHash],
    );
    const profile: ProfileRow = {
      id,
      username,
      email: normalizedEmail,
      password_hash: passwordHash,
    };
    return reply.code(201).send({ data: issueSession(profile) });
  });

  // 登录（支持 email 或 {username}@meoo.local 占位）
  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    if (!email || !password) {
      return reply.code(400).send({ error: '账号和密码必填' });
    }
    const profile = await resolveProfileByIdentifier(email.trim());
    if (!profile) {
      return reply.code(401).send({ error: '账号或密码错误' });
    }
    const ok = await verifyPassword(password, profile.password_hash);
    if (!ok) {
      return reply.code(401).send({ error: '账号或密码错误' });
    }
    // 顺带刷新 last_login_at（非阻塞，失败不影响登录）
    query('UPDATE profiles SET last_login_at = now() WHERE id = $1', [profile.id]).catch(() => {});
    return reply.send({ data: issueSession(profile) });
  });

  // 当前会话（Bearered）
  app.get('/api/auth/session', async (req, reply) => {
    const user = parseBearer(req);
    if (!user) return reply.send({ data: { session: null } });
    const { rows } = await query<ProfileRow>(
      'SELECT id, username, email, password_hash FROM profiles WHERE id = $1',
      [user.uid],
    );
    if (!rows[0]) return reply.send({ data: { session: null } });
    return reply.send({ data: { session: issueSession(rows[0]).session } });
  });

  // 刷新令牌（Bearered，重新签发）
  app.post('/api/auth/refresh', async (req, reply) => {
    const user = parseBearer(req);
    if (!user) return reply.code(401).send({ error: '未授权' });
    const { rows } = await query<ProfileRow>(
      'SELECT id, username, email, password_hash FROM profiles WHERE id = $1',
      [user.uid],
    );
    if (!rows[0]) return reply.code(401).send({ error: '用户不存在' });
    return reply.send({ data: issueSession(rows[0]) });
  });

  // 修改密码（已登录）
  app.post('/api/auth/update-password', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password || String(password).length < 6) {
      return reply.code(400).send({ error: '密码至少 6 位' });
    }
    const hash = await hashPassword(password);
    await query('UPDATE profiles SET password_hash = $1 WHERE id = $2', [hash, user.uid]);
    return reply.send({ data: { user: { id: user.uid } } });
  });

  // 登出（无状态 JWT，仅返回成功；前端清本地令牌）
  app.post('/api/auth/logout', async () => ({ data: { ok: true } }));
}

function parseBearer(req: { headers: Record<string, unknown> }): { uid: string; username: string } | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  const payload = verifyToken(token);
  if (!payload) return null;
  return { uid: payload.uid, username: payload.username };
}
