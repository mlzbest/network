#!/bin/sh
# 容器入口：等待数据库 → 幂等建表 → 启动服务。
# 用 exec 交接 PID 1，确保 SIGTERM 能正常触发 Fastify / Socket.IO 优雅退出。
set -e

: "${DATABASE_URL:?DATABASE_URL 未设置}"
: "${JWT_SECRET:?JWT_SECRET 未设置}"

echo "[entrypoint] 检测网络自建后端启动中（Node $(node -v), TZ=${TZ:-UTC}）"

node scripts/wait-db.mjs
node dist/db/init.js

echo "[entrypoint] 启动 HTTP + Socket.IO 服务，端口 ${PORT:-4000}"
exec node dist/launch.js
