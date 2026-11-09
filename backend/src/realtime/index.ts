import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { parseAuth } from '../auth/guard.js';

let io: Server | null = null;

export function initRealtime(server: HttpServer) {
  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  io.use((socket, next) => {
    // 允许携带 Bearer（通过 auth.token 或 query）以绑定 uid，用于在线状态
    const token =
      (socket.handshake.auth as any)?.token ||
      (socket.handshake.query as any)?.token;
    if (token && typeof token === 'string') {
      const user = parseAuth({ headers: { authorization: `Bearer ${token}` } } as any);
      if (user) socket.data.uid = user.uid;
    }
    next();
  });

  io.on('connection', (socket) => {
    const uid: string | undefined = socket.data.uid;
    if (uid) {
      socket.join(`user:${uid}`);
      // 上报在线
      broadcastPresence(uid, 'online');
    }
    socket.on('disconnect', () => {
      if (uid) broadcastPresence(uid, 'offline');
    });
  });

  return io;
}

/** 向某用户的所有连接推送 */
export function pushToUser(uid: string, event: string, payload: unknown) {
  io?.to(`user:${uid}`).emit(event, payload);
}

/** 广播数据变更（替代 postgres_changes） */
export function broadcastChange(
  table: string,
  eventType: 'INSERT' | 'UPDATE' | 'DELETE',
  newRow: unknown,
  oldRow?: unknown,
) {
  io?.emit(`table:${table}`, { eventType, new: newRow, old: oldRow });
  io?.emit('any', { table, eventType, new: newRow, old: oldRow });
}

/** 在线状态广播（presence） */
export function broadcastPresence(uid: string, state: 'online' | 'offline') {
  io?.emit('presence', { uid, state });
}

export function getIO(): Server | null {
  return io;
}
