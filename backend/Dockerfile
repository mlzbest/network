# syntax=docker/dockerfile:1
# 检测网络 · 自建后端镜像
#   docker build -t detect-network-backend:latest ./backend
#
# 设计要点：
#   1. 两阶段构建，运行镜像只含生产依赖（不含 typescript / tsx / PGlite / PG 二进制）。
#   2. pnpm 固定 9.0.0，与仓库根 packageManager 一致；--frozen-lockfile 保证可复现。
#   3. builder 用 --ignore-scripts：tsc 与 copy-assets 都是纯 JS，无需任何原生构建脚本，
#      同时避开 esbuild / embedded-postgres 在 Alpine 上的平台包问题。
#   4. 运行时以内置 node 用户（uid 1000）启动，uploads 单独挂卷。

# ── 构建阶段 ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
RUN npm install -g pnpm@9.0.0

# 国内构建可覆盖：docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com ...
ARG NPM_REGISTRY=https://registry.npmjs.org/
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts --registry=$NPM_REGISTRY

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# tsc 编译 + 把 schema.sql 复制进 dist/db/（tsc 不会复制非 TS 资源）
RUN pnpm build && pnpm prune --prod --ignore-scripts

# ── 运行阶段 ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN apk add --no-cache tzdata
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=4000

WORKDIR /app

COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node scripts/wait-db.mjs ./scripts/wait-db.mjs
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh

# 双保险：即便 .gitattributes 未生效、Windows 检出的脚本带 CRLF，也先去掉 \r
RUN tr -d '\r' < docker-entrypoint.sh > /tmp/entrypoint.sh \
 && mv /tmp/entrypoint.sh docker-entrypoint.sh \
 && chmod 0755 docker-entrypoint.sh \
 && mkdir -p uploads \
 && chown -R node:node uploads

USER node
EXPOSE 4000
VOLUME ["/app/uploads"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
