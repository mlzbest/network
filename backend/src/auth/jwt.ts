import jwt from 'jsonwebtoken';
import { env } from '../env.js';

export interface JwtPayload {
  uid: string;
  username: string;
}

export function signToken(uid: string, username: string): string {
  return jwt.sign({ uid, username } as JwtPayload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as any,
  });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    if (!decoded.uid || !decoded.username) return null;
    return decoded;
  } catch {
    return null;
  }
}
