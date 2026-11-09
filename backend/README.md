# 检测网络 · 自建后端

替代 Meoo Cloud Supabase 的自托管后端：**Node (Fastify) + Postgres + JWT + Socket.IO**。
前端通过 `src/supabase/selfhost-client.ts` 适配层接入，业务代码几乎零改动。

---

## 一、本地跑通（三分钟）

无需 Docker、无需安装 Postgres——内置 PGlite（WASM 版真实 PostgreSQL）。

```bash
cd backend

# 1) 装依赖
pnpm install

# 2) 起数据库（前台常驻，保持这个终端不关）
pnpm db:start
#   → 打印 DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres

# 3) 另开一个终端：配环境变量
cp .env.example .env
#   把 .env 里 DATABASE_URL 改成上面打印的那条，JWT_SECRET 随便填 ≥16 位

# 4) 建表
pnpm db:init

# 5) 起服务
pnpm dev
#   → http://localhost:4000/api/health
```

> 如果你的环境能跑真 Postgres 二进制（本机装了 PG 或 Docker），改用 `pnpm db:start:native`
> 起 `postgres.exe`；数据目录分别是 `.pgdata-pglite` / `.pgdata`，都已 gitignore。

## 二、验证（已全部通过）

```bash
pnpm test:e2e        # = test:api + test:adapter
```

| 命令 | 内容 | 结果 |
|---|---|---|
| `pnpm test:api` | 后端 42 项：注册登录、权限隔离、敏感列、触发器、RPC、存储、Socket.IO | 42/42 ✅ |
| `pnpm test:adapter` | 前端适配层 18 项：响应解包、`.insert().select().single()` 语义、storage 上传/读取/删除 | 18/18 ✅ |
| `pnpm test:r2` | R2 驱动 29 项：本地 S3 mock 独立复算 SigV4、特殊字符 key、两种 publicUrl、HTTP 全链路 | 29/29 ✅ |

测试自带唯一用户名（时间戳后缀），可反复执行，不会互相污染。

## 三、前端如何切过来

前端 `.env` 改两行即可，业务代码不动：

```ini
VITE_AUTH_BACKEND="selfhost"
VITE_SELFHOST_API_BASE="http://localhost:4000"
```

改回 `"legacy"` 立即回退到 Meoo Cloud，数据互不影响。

## 四、目录结构

```
src/
  server.ts            Fastify 入口：路由注册 + 存储接口 + Socket.IO 挂载
  env.ts               环境变量校验（zod）
  db/
    schema.sql         9 张表 + 2 个 plpgsql 函数 + 1 个触发器（依据 types.ts 反推）
    init.ts            执行 schema.sql（幂等）
    pool.ts            pg 连接池
    schema-map.ts      表/列白名单（防 SQL 注入）
  auth/                自研鉴权：scrypt 口令哈希 + JWT + 守卫中间件
  data/
    routes.ts          /api/db（通用查询）+ /api/rpc
    query-engine.ts    把 PostgREST 式查询翻译成参数化 SQL
    ownership.ts       RLS 等价的行级所有权校验
  edge/                从 Supabase Edge Function 移植：找回密码、改邮箱、微信登录
  realtime/index.ts    Socket.IO 广播（替代 postgres_changes）
  storage/
    index.ts           local / r2 两种驱动分流 + URL 生成
    r2.ts              R2 S3 兼容客户端（SigV4 签名，零第三方依赖）
scripts/
  dev-db.mjs           PGlite 启动器（默认）
  dev-db-native.mjs    原生 postgres.exe 启动器
  copy-assets.mjs      构建后把 schema.sql 复制进 dist/db/
  wait-db.mjs          容器启动前探测 Postgres 可达
  smoke.mjs            后端 API 端到端测试
  e2e-adapter.mjs      前端适配层端到端测试（用 esbuild 打包后跑真实代码）
Dockerfile              两阶段镜像（builder 编译 + runtime 仅生产依赖）
docker-entrypoint.sh    等待 DB → 幂等建表 → exec 启动服务
.dockerignore           排除密钥、本地数据与测试脚本
```

## 五、关键设计：用服务端校验替代 RLS

原 Supabase 用 RLS 做行级隔离，自建后改由 `data/ownership.ts` 在 SQL 层注入谓词：

| 表 | 规则 |
|---|---|
| `profiles` | 可读全部（联系人列表需要），写仅限本人 |
| `conversations` | 仅 `user1_id`/`user2_id` 为本人 |
| `messages` | 仅所属会话的参与者 |
| 其余业务表 | 仅 `user_id = 本人` |

写入时 `enforceInsertOwner` 强制把 `sender_id` / `user_id` / `profile.id` 改写为当前用户，
**客户端伪造这些字段无效**（测试已覆盖）。

`profiles` 的 `password_hash`、`recovery_token_hash` 不会经 `/api/db` 下发
（`SENSITIVE_COLUMNS` 剔除 + 列白名单拒绝）。

## 六、容器化部署

后端需要**常驻 Node 进程 + 可连的 Postgres + WebSocket**，这决定了可选形态。

### 6.1 镜像

`backend/Dockerfile` 为两阶段构建：builder 用 pnpm 9.0.0 执行 `pnpm build`（`tsc` +
复制 `schema.sql` 进 `dist/db/`）并 `prune` 掉开发依赖；runtime 基于 `node:20-alpine`，
以内置 `node` 用户（uid 1000）运行，时区 `Asia/Shanghai`。

```bash
docker build -t detect-network-backend:latest ./backend
# 国内网络拉官方源慢时：
docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  -t detect-network-backend:latest ./backend
```

容器入口 `docker-entrypoint.sh` 依次执行：**等待数据库 → 幂等建表 → `exec node dist/launch.js`**，
因此不依赖 compose 也能在独立 `docker run` 下正确启动。健康检查打 `/api/health`。

### 6.2 路径 A：VPS + Docker Compose + Caddy（推荐）

```bash
cd D:/工作云文档/network
cp deploy/.env.example deploy/.env
# 必改 POSTGRES_PASSWORD / JWT_SECRET；启用 HTTPS 时再改 PUBLIC_DOMAIN 与 PUBLIC_BASE_URL
# 前提：域名已 ICP 备案、DNS A 记录指向本机、安全组放行 80/443

docker compose -f docker-compose.selfhost.yml --env-file deploy/.env --profile tls up -d --build
docker compose -f docker-compose.selfhost.yml --env-file deploy/.env logs -f backend
```

> 根目录原有的 `docker-compose.yml` 属于旧 Supabase Edge Runtime 部署链，
> 未被改动；自建后端编排独立放在 `docker-compose.selfhost.yml`。

- `postgres` **不向宿主机暴露 5432**，只在容器网络内可达。
- `backend` 仅绑 `127.0.0.1:${BACKEND_PORT:-4000}`，公网入口统一走 Caddy。
- Caddy 按 `PUBLIC_DOMAIN` 自动申请并续期证书；`reverse_proxy` 原生支持 WebSocket
  升级，后端 Socket.IO 的 `/socket.io/` 无需额外配置。
  **注意**：`src/supabase/selfhost-client.ts` 的 `.channel()` 目前仍是轮询兜底占位，
  前端尚未安装 `socket.io-client`，所以现阶段还不会发起 wss 连接。
- 不加 `--profile tls` 则只跑 PG + backend（纯 HTTP），用于本地验证或交给外部网关终止 TLS。
- 数据在 `pgdata` / `uploads` 两个 volume；`docker compose down` 不会丢数据。

### 6.3 路径 B：Cloudflare Containers

镜像不变，但由 Cloudflare 终止 TLS，因此**不要启动 Caddy**，容器只暴露 4000。
下面示例省略了 R2 凭据；实际部署必须按 6.5 设置 `STORAGE_DRIVER=r2`，否则上传文件会在容器重建时丢失：

```bash
docker build -t detect-network-backend:latest ./backend
docker run --rm -p 4000:4000 \
  -e DATABASE_URL="postgres://<user>:<pass>@<外部PG主机>:5432/<db>" \
  -e JWT_SECRET="<长随机串>" \
  -e PUBLIC_BASE_URL="https://<你的域名>" \
  -e CORS_ORIGINS="https://<你的域名>" \
  detect-network-backend:latest
```

三个必须注意的差异：

| 约束 | 说明 |
|---|---|
| 数据库必须外置 | 容器无持久盘，`postgres` 不能一起塞进容器；用 Neon / Supabase / 云 RDS |
| 上传文件会丢 | `/app/uploads` 是临时文件系统，容器重启即清空。**必须设 `STORAGE_DRIVER=r2`** 把头像 / 图片 / 语音写入 Cloudflare R2，配置见 6.5 |
| TLS 由平台承担 | 配 `PUBLIC_BASE_URL` 为对外 HTTPS 域名；后续接入 `socket.io-client` 时还需平台放行 `wss` 升级 |

### 6.4 方案对照

| 方案 | 适配度 | 说明 |
|---|---|---|
| **VPS + Compose + Caddy** | ✅ 最贴合 | 代码零改动，持久卷与 WebSocket 都原生支持 |
| **Cloudflare Containers** + 外部 PG + R2 | ✅ 已适配 | 镜像可直接用；数据库外置、存储走 R2（6.5） |
| **托管 PaaS**（Railway/Render）+ Neon | ✅ 省事 | 推代码即部署；境外节点国内延迟偏高 |
| **Cloudflare Workers / D1** | ❌ 需重写 | 无常驻进程，`pg` 连接池与 Socket.IO 都跑不了 |

> ⚠️ 微信小程序只接受**已备案域名的 HTTPS 443**。上线前须在公众平台
> 「开发管理 → 开发设置 → 服务器域名」配置：
> - `request` 合法域名：`https://<你的 API 域名>`
> - `socket` 合法域名：`wss://<你的 API 域名>` —— 仅在前端适配层接入 `socket.io-client`
>   之后才需要；当前为轮询占位，暂时用不到
> - `uploadFile` / `downloadFile` 合法域名：同源即可
>
> 这一关与选哪家云无关，且必须在前端把 `VITE_SELFHOST_API_BASE` 指向该域名之后才生效。

### 6.5 Cloudflare R2 对象存储

容器没有持久盘时（Cloudflare Containers，或任何会重建容器的部署），`local` 驱动写入的
头像、聊天图片、语音会在重启后全部丢失。把 `STORAGE_DRIVER` 切到 `r2` 即可。

**前置条件（踩过的坑）**：账户必须已有 **R2 订阅**。新账号即使持有全权限 API Token，
调用 `GET/POST /accounts/{id}/r2/buckets` 仍会返回
`10042 Please enable R2 through the Cloudflare Dashboard`。Cloudflare 把开通设计成
Dashboard 的 checkout 流程（免费 10GB 额度也要绑定支付方式并确认条款），
**没有任何 API 端点可代开**；`entitlements` 里也不会出现任何 R2 项。
入口：<https://dash.cloudflare.com/?to=/:account/r2/overview>。

**准备凭据**：Cloudflare 控制台 → R2 → 创建存储桶 → 「管理 R2 API 令牌」→
创建带「对象读与写」权限的令牌，取得 `Account ID` / `Access Key ID` / `Secret Access Key`。

**两种公开读模式**（决定 `publicUrl()` 返回什么）：

| `R2_PUBLIC_URL` | 返回的 URL | 特点 |
|---|---|---|
| 留空（默认） | `https://<API 域名>/api/storage/public/<bucket>/<key>` | 桶保持私有，后端用 R2 凭据代读；URL 永不过期，适合长期存进 `profiles.avatar_url` |
| 填公开域 | `https://<公开域>/<bucket>/<key>` | 图片直连 R2，不经后端；需在 R2 绑定自定义域或启用 r2.dev 公开访问 |

> 不要把会过期的预签名 GET URL 存进数据库。头像地址是长期数据，两种模式都返回永久 URL。

**配置**（`deploy/.env` 填好后由 compose 注入，或独立 `docker run` 直接传）：

```bash
docker run --rm -p 4000:4000 \
  -e DATABASE_URL="postgres://<user>:<pass>@<外部PG>:5432/<db>" \
  -e JWT_SECRET="<长随机串>" \
  -e PUBLIC_BASE_URL="https://<你的域名>" \
  -e STORAGE_DRIVER="r2" \
  -e R2_ACCOUNT_ID="<Account ID>" \
  -e R2_BUCKET="detect-network" \
  -e R2_ACCESS_KEY_ID="<Access Key ID>" \
  -e R2_SECRET_ACCESS_KEY="<Secret Access Key>" \
  -e R2_PUBLIC_URL="" \
  detect-network-backend:latest
```

实现说明：

- `src/storage/r2.ts` 用 `node:crypto` 实现 AWS SigV4，仅发 PUT / GET / DELETE 三个对象请求，
  **不引入 AWS SDK**（镜像更小，也无需额外的构建脚本白名单）。
- R2 只有一个桶，业务侧的 `bucket` 参数作为对象 key 的前缀（`<bucket>/<path>`），
  避免不同业务分类的同名文件互相覆盖。
- 上传写入的 `Content-Type` 由 R2 原样返回；走后端代理读时会透传，避免语音 / webp
  之类文件被扩展名猜测成 `application/octet-stream`。
- 删除链路已打通：前端 `storage.remove(paths)` → `POST /api/storage/remove`（JWT 鉴权，
  单次上限 50 个）→ R2 DELETE。
- 凭据只从环境变量注入，`deploy/.env` 与 `backend/.env` 均已 gitignore，**不要写进镜像或仓库**。

本地无需真实 R2 账号即可验证协议正确性：

```bash
cd backend && pnpm test:r2
```

该命令启动一个本地 S3 mock，独立复算 SigV4 校验签名，并跑通
上传 → 公开读 → 删除、特殊字符 key、两种 publicUrl 模式。

**有真实 R2 凭据时**可做一次联网冒烟（凭据只从环境变量读取，不打印、不落仓库）：

```bash
# 写入 backend/.env（已 gitignore），或直接在命令行导出四项 R2_* 变量
cd backend && pnpm test:r2:live
```

脚本先做 TLS/HTTP 连通性预检，再依次验证 PUT → GET 内容与 Content-Type →
错误密钥被拒（确认 SigV4 生效）→ DELETE → 后端 HTTP 路由全链路，并在异常时
自动清理测试对象。退出码区分：`0` 通过、`1` 功能失败、`2` 凭据缺失、`3` 网络层不可达。

**一键准备凭据**（只需一个 Cloudflare API Token，自动建桶 → 签发 24h 最小权限 R2 令牌
→ 派生 S3 凭据 → 跑冒烟 → 删除临时令牌与临时 `.env`）：

```bash
cd backend && CLOUDFLARE_API_TOKEN=<token> pnpm test:r2:live:prepare
```

可选 `--bucket` / `--endpoint` / `--public-url` / `--timeout` / `--force-relay` /
`--keep-bucket` / `--keep-env`。

- **未开通 R2**：打印 10042 指引。此时 `<account>.r2.cloudflarestorage.com`
  的 TLS 也会握手失败（账户 S3 子域证书尚未签发），**开通后自动恢复**，
  不要误判成本机网络被拦。
- **S3 端点确实不可达**：脚本自动启用 `scripts/r2-rest-relay.mjs`，把原生 SigV4
  请求经 `api.cloudflare.com` 的 R2 对象 REST 接口转发到真实 R2。适配层用同一份
  S3 凭据独立复算签名并严格比对，错误密钥依旧被拒，PUT / GET / DELETE 真实落盘；
  可用 `--force-relay` 强制走该通道验证。该脚本仅用于本地测试，不进镜像。

实测（2026-11-09，北京）：直连 S3 端点与 REST 适配层两条通道均为 **13/13 通过**。
测试桶、24h 临时令牌、临时 `backend/.env` 在脚本结束时全部自动删除。

## 七、Cloudflare Containers 部署（备选，暂缓）

> **当前主路径是 §九 的 VPS 方案**：Containers 需要 Workers Paid（$5/月），
> 账户暂未开通该订阅。本节配置已完整落地并通过构建预演，随时可启用。

入口工程在 `deploy/cloudflare/`：`wrangler.jsonc` + 一个转发用 Worker
（Durable Object 单例）＋ 部署脚本。镜像直接复用本目录的 `Dockerfile`，
不另建镜像定义（`image: ../../backend/Dockerfile`，build context 为 `backend/`）。

### 7.1 架构与三条硬约束

```
小程序 / H5 → api.maolizheng.xyz (Custom Domain)
            → Worker → 单例 DO → Container :4000
            → 外部 Postgres(5432) + Cloudflare R2(S3 443)
```

1. **磁盘全临时**：实例休眠/重启后回到镜像初始盘。Postgres **不能**跑在容器里，
   上传文件必须走 `STORAGE_DRIVER=r2`；`docker-compose.selfhost.yml` 的
   `postgres` + `uploads` 卷方案只适用于 VPS，不适用于 Containers。
2. **固定单例**：Socket.IO 广播是进程内状态，多实例会漏推送，因此
   `max_instances: 1`，所有请求经 `getContainer()` 默认单例名路由。
   要横向扩展须先把 realtime 换成跨实例总线。
3. ** Workers Paid 订阅**：Containers 仅对 Workers Paid（$5/月起）开放，
   Workers Free 账户 `wrangler deploy` 会失败。R2 订阅与 Workers 订阅是两回事。

出站：`enableInternet = true`（默认即 true）必须保留，否则非 80/443 端口
（Postgres 5432）会被拒绝。不要设置 `allowedHosts` / `enableInternet=false`。

### 7.2 落地前准备

| 项 | 状态 / 操作 |
|---|---|
| Cloudflare R2 | 已开通 + 已自动建桶 `detect-network-prod`、签发长期 S3 凭据（`npm run provision-r2`，2026-11-09 实测） |
| Zone `maolizheng.xyz` | 已存在且 active，`api.maolizheng.xyz` 无 DNS 冲突 |
| Workers Paid | **待开通**（$5/月） |
| 外部 Postgres 14+ | **待提供** `DATABASE_URL` |
| Docker CLI（本机） | 未安装；见 7.4 三条构建路径 |
| 微信小程序白名单 | 上线前在公众平台把 `https://api.maolizheng.xyz` 加入 request 合法域名 |

数据库选型（容器磁盘临时，任选其一，代码无需改动）：

| 方案 | 成本 | 说明 |
|---|---|---|
| Neon / Supabase 免费层 | 0 | 最快，给连接串即可；跨公网用 `sslmode=require` |
| 自建 VPS Postgres | 已有机器则 0 | 需放行 Cloudflare 容器出口 IP 或干脆不设 IP 白名单 |
| Hyperdrive | 免费层可用 | 主要加速 Worker 侧查询；本架构 pg 在容器内，收益有限，可后加 |

### 7.3 部署步骤

```bash
cd deploy/cloudflare
npm ci                              # 若未装过依赖

# 1) 自动建生产 R2 桶 + 签发长期 S3 凭据（写入 .dev.vars；已实测）
CLOUDFLARE_API_TOKEN=<token> npm run provision-r2

# 2) 手工补 DATABASE_URL（外部 Postgres）与 JWT_SECRET（openssl rand -hex 32）
#    键名清单见 .dev.vars.example

# 3) 预检（只读）：订阅、R2、Zone、DNS 冲突、密钥完整性、PG 连通性
CLOUDFLARE_API_TOKEN=<token> npm run preflight

# 4) 初始化外部库结构（幂等，与容器 entrypoint 用同一份 schema.sql）
npm run bootstrap-db

# 5) 把 .dev.vars 注入 Worker Secrets（值只走 stdin，不进命令行/日志）
CLOUDFLARE_API_TOKEN=<token> npm run secrets

# 6) 校验 Worker bundle（本机无 Docker 时用 --containers-rollout=none）
npm run dry-run

# 7) 真实部署（需 Docker 或 Workers Builds，见 7.4）
CLOUDFLARE_API_TOKEN=<token> npm run deploy
```

`npm run typecheck` 与 `npm run dry-run` 已实测通过（2026-11-09 北京）：
Worker bundle 55.35 KiB / gzip 14.26 KiB，DO 与 12 项 vars 绑定正确。

### 7.4 镜像构建：本机无 Docker 时

`wrangler deploy` 在 `image` 指向 Dockerfile 时会调用本机 Docker 构建并推送到
Cloudflare Registry（由 R2 承载，鉴权自动处理），**连 `--dry-run` 也需要 Docker**。
三条可选路径：

1. 安装 Docker Desktop 后直接 `npm run deploy`（最直接）。
2. Workers Builds：把仓库连到 GitHub，生产分支 deploy command 设为
   `npx wrangler deploy`，由 Cloudflare 侧构建镜像（Root directory 指向
   `deploy/cloudflare`）。注意非生产分支默认 `wrangler versions upload`
   **不会**更新镜像，且 DO Worker 不生成 Version URL。
3. CI 构建：`npx wrangler containers build -p -t <tag> ../../backend`
   推送到 `registry.cloudflare.com/<account>/<image>:<tag>`，把 `wrangler.jsonc`
   的 `image` 改成该引用，再 `wrangler deploy`（此时无需本机 Docker）。

镜像须为 `linux/amd64`。`Dockerfile` 的 `ENTRYPOINT` 用 `exec` 交接 PID 1，
平台 SIGTERM → 15 分钟宽限 → SIGKILL 的停机流程可正常优雅退出。

### 7.5 验证与已知约束

```bash
curl https://detect-network-api.maolizheng-emby.workers.dev/__worker/health  # 只测 Worker，不唤醒容器
curl https://api.maolizheng.xyz/api/health                                    # 触发冷启动，验证全链路
npx wrangler containers list && npx wrangler containers images list
```

- 首次部署需等数分钟镜像分发，期间 Worker 已响应但容器路由可能报错。
- 冷启动 ≈ 1-3s + `wait-db` + 幂等 `schema.sql`；`DB_WAIT_*` 已收紧到最坏 ~10.5s。
- `sleepAfter = 20m`，空闲后休眠（停止计费），下次请求重新冷启动。
- Worker Secrets 在**容器启动时**注入；轮换密钥后需让实例重启才生效。
- `@cloudflare/containers@0.3.7` 的 `containerFetch` 已用 `WebSocketPair` 双向代理
  WebSocket，Socket.IO 可透传；前端当前 `.channel()` 仍是轮询兜底，未依赖长连接。
- 计费：Workers Paid $5/月 + Containers 按运行时长（含 25 GiB-hours / 375 vCPU-min
  / 200 GB-hours 月度额度）+ 出口流量；`observability` 自 2026-12-01 起按 Observability 计费。
- 前端切换：`.env` / `.env.miniprogram` 只需设 `VITE_AUTH_BACKEND=selfhost` 与
  `VITE_SELFHOST_API_BASE=https://api.maolizheng.xyz`，或在项目根执行
  `node deploy/switch-backend.mjs selfhost --check`。

## 八、迁移存量数据

```bash
# 从 Meoo 老库导出（需老库连接串），只灌数据、不建结构
pg_dump "$MEOO_DATABASE_URL" --data-only --no-owner \
  -t profiles -t conversations -t conversation_deletes \
  -t messages -t message_deletes -t message_visibility \
  -t login_events -t user_location_history -t user_we_run_steps \
  | psql "$DATABASE_URL"
```

注意：迁移后 JWT 密钥变化，老用户需**重新登录一次**（数据不丢，仅需重新认证）。

## 九、VPS 部署（备选）

2026-11-09 决策：不升级 Workers Paid，改用 **VPS + 外部 Postgres（Supabase 免费层）
+ Cloudflare R2**；§七 的 Containers 配置原样保留，日后开通订阅可直接切换。
**同日稍后已改为优先走 §十 的 Workers Free 方案**，本节保留为「需要长驻
Socket.IO 实时推送」时的备选路径（找回密码发信已由 §10.6 的 HTTP 邮件 API 解决，
不再依赖 SMTP 直连）。

```
小程序 / H5 → https://api.maolizheng.xyz（Cloudflare Tunnel 或 DNS + Caddy）
            → 本机 127.0.0.1:4000 → backend 容器（无状态）
            → Supabase Postgres(5432) + R2(S3 443)
```

编排文件 `docker-compose.vps.yml`（与 `docker-compose.selfhost.yml` 并存，互不覆盖）：
- 不启动容器内 Postgres，`DATABASE_URL` 必须来自 `deploy/.env`；
- `STORAGE_DRIVER` 由编排强制覆盖为 `r2`，不挂 uploads 卷，容器可随时重建；
- 后端只绑 `127.0.0.1:4000`，公网入口交给 Tunnel 或 `--profile tls` 的 Caddy。

### 9.1 Supabase 免费层的连接串（三个必避的坑）

官方《Connect to your database》（2026-11-06 更新）对免费层的约束：

1. **用 Session pooler（端口 5432，IPv4）**，从 Dashboard → Connect 对话框复制。
   免费层的 Direct connection 是 **IPv6-only**，多数 VPS 只有 IPv4，会直接连不上。
2. **不要用 6543 transaction pooler**：不支持 prepared statements、query pipelining
   与 session 状态；本项目是长驻 `pg.Pool` + 多语句 `schema.sql`，必须用 session mode。
3. **pooler host 必须从 Connect 对话框复制**（形如 `aws-<index>-<region>.pooler.supabase.com`），
   不能按 region 自行拼接；密码里的 `& # ?` 空格等需 percent-encode；
   结尾追加 `?sslmode=require`，否则驱动可能明文回退。

```ini
# deploy/.env
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
JWT_SECRET=<openssl rand -hex 32>
```

`preflight.mjs --vps` 会自动检查 6543 端口与 `sslmode=require` 并告警。
免费层项目长期无活动可能被平台暂停，正式上线前请确认项目状态与配额。

### 9.2 部署步骤

```bash
# 1) R2 凭据已由 provision-r2 写入 .dev.vars；同步到 VPS 用的 deploy/.env
node deploy/cloudflare/scripts/provision-r2.mjs --sync-only

# 2) 只需在 deploy/.env 填 DATABASE_URL（Supabase）
#    JWT_SECRET 已生成 64 位随机值；R2_* 与 PUBLIC_DOMAIN / PUBLIC_BASE_URL 均已写好
#    模板：deploy/.env.example（已 gitignore，不提交）

# 3) 预检：R2、Zone/DNS、密钥完整性、Supabase 连通性（不检查 Workers Paid）
CLOUDFLARE_API_TOKEN=<token> node deploy/cloudflare/scripts/preflight.mjs --vps

# 4) 在外部库建 9 张表（幂等，与容器 entrypoint 同一份 schema.sql）
node deploy/cloudflare/scripts/bootstrap-db.mjs --env-file deploy/.env

# 5) 起服务（VPS 上需 git clone 本仓库，且装好 Docker + compose）
docker compose -f docker-compose.vps.yml --env-file deploy/.env up -d --build
#    若 VPS 有公网 80/443 且 DNS A 已指向它，加 --profile tls 启用 Caddy 自动 HTTPS

# 6) 验证
curl http://127.0.0.1:4000/api/health
curl https://api.maolizheng.xyz/api/health
```

`preflight.mjs --vps` 与 `bootstrap-db.mjs --env-file` 已实测（2026-11-09 北京）：
前者准确报出剩余阻塞，后者连本地 PGlite 建表 **9/9** 通过；
`docker-compose.vps.yml` 与 `docker-compose.selfhost.yml` 均通过 YAML 解析校验。

### 9.3 公网入口二选一

| 方案 | 适用 | 要点 |
|---|---|---|
| **Cloudflare Tunnel**（推荐） | VPS 无公网 80/443、不想放行端口 | `cloudflared tunnel create` → `route dns ... api.maolizheng.xyz` → ingress 指向 `http://127.0.0.1:4000`。TLS 由 Cloudflare 终止，Caddy 不需要 |
| Caddy（`--profile tls`） | VPS 有公网 IP、域名已解析到本机 | 需放行 80（ACME HTTP-01）与 443；`deploy/.env` 设 `PUBLIC_DOMAIN=api.maolizheng.xyz`。若 DNS 走橙云代理，需改用 CF Origin Certificate 或改灰云直连 |

`api.maolizheng.xyz` 当前**无 DNS 记录**（§七 的 Custom Domain 未部署，不冲突），
可安全用于任一方案。上线前还需在微信公众平台把该域名加入
**request 合法域名**（小程序不允许 `workers.dev` / 未备案域名）。

前端两行（`.env` 与 `.env.miniprogram`）：

```ini
VITE_AUTH_BACKEND=selfhost
VITE_SELFHOST_API_BASE=https://api.maolizheng.xyz
```

> 旧文档曾列 `VITE_DATA_BACKEND`；该键不存在，`src/supabase/client.ts` 与
> `selfhost-client.ts` 都不读取，配置它不会有任何效果。用
> `node deploy/switch-backend.mjs status` 可查看当前生效的开关。

### 9.4 成本与回滚

- 费用：VPS（已有）+ Supabase 免费层 + R2 免费 10GB 额度 + Cloudflare 免费
  （Tunnel 与 DNS），** Workers 订阅 $0**。
- 回滚：容器无状态，重新 `docker compose ... up -d` 或换机器即可；
  数据在 Supabase 与 R2，不随容器销毁。
- 凭据位置：R2 S3 密钥在 `deploy/.env` 与 `deploy/cloudflare/.dev.vars`
  （均 gitignore）；Supabase 连接串只在 `deploy/.env`。全权限 Cloudflare API Token
  仍建议轮换。

## 十、Cloudflare Workers Free 部署（当前主路径）

2026-11-09 决策：**不升级 Workers Paid、不用 VPS**，把后端直接跑在 Workers Free 上。

### 10.1 链路

```
小程序 / H5 → api.maolizheng.xyz（Custom Domain）
            → Worker（wrangler.workers.jsonc / src/worker.ts）
            → 轻量路由层（backend/src/http/worker-app.ts）
            → Hyperdrive binding → Supabase Postgres
            → R2 REST（SigV4，复用 storage/r2.ts）
```

后端已无状态，所以既不需要容器，也不需要常驻进程。免费额度：

| 组件 | Workers Free 额度 |
|---|---|
| Worker | 10 万请求/天、无冷启动、不休眠 |
| Hyperdrive | 10 万次数据库查询/天、无额外费用、无流量费 |
| R2 | 10 GB 存储（已开通） |
| Supabase | 500 MB 库、5 GB 出网（1 周无活动会暂停） |

### 10.2 为什么不用 Fastify

Fastify 4 的 `find-my-way` 在注册路由时用 `new Function()` 生成参数解析代码，
而 Workers **永久禁用动态代码求值**（官方 Web standards 文档明列，没有
compatibility flag 可以打开）。实测报错：
`EvalError: Code generation from strings disallowed for this context`，
随后 avvio 超时伪装成 `Plugin did not start in time`。

解决方式是**双入口共享 handler**：

| 入口 | 路由层 | 用途 |
|---|---|---|
| `backend/src/server.ts` → `launch.ts` | Fastify + Socket.IO | VPS / 本地 Node |
| `backend/src/http/worker-app.ts` | 自研 MiniApp（Fastify 风格 `app.get/post/register/inject`） | Workers Free |

`authRouter` / `dataRouter` / `edgeRouter` / `http/routes.ts` 四个业务路由文件
由两个入口注册同一份代码，业务逻辑零分叉。Worker bundle 约 569 KB，
不含 Fastify / pino / socket.io / dotenv。

另有三处运行时适配（均已写入代码注释）：
`env.ts` 支持 `globalThis.__DETECT_ENV__` 注入（Workers 无 Node 进程环境）；
`db/pool.ts` 检测 `__DETECT_DB_URL__` 后改为「每请求 new Client()」（真实连接池由
Hyperdrive 维护）；`data/routes.ts` 的实时广播改为运行时注入，Workers 下为 no-op。

### 10.3 部署步骤

```bash
cd deploy/cloudflare

# 1) 填密钥：.dev.vars 写 DATABASE_URL（Supabase Session pooler 5432 + ?sslmode=require）
#    R2_* 与 JWT_SECRET 已由 provision-r2 自动写好
# 2) 构建后端 dist（Worker bundle 直接引用 backend/dist）
npm run build:backend

# 3) 创建 Hyperdrive 配置并把 id 写回 wrangler.workers.jsonc
CLOUDFLARE_API_TOKEN=<token> npm run provision-hyperdrive

# 4) 初始化外部库结构（幂等，9 张表；自动从 .dev.vars 读 DATABASE_URL）
npm run bootstrap-db

# 5) 注入 Worker Secrets（--workers 指向 wrangler.workers.jsonc，值只走 stdin）
CLOUDFLARE_API_TOKEN=<token> npm run secrets -- --workers

# 6) 预检 / 打包预演 / 部署
CLOUDFLARE_API_TOKEN=<token> npm run preflight:workers
npm run dry-run:workers
CLOUDFLARE_API_TOKEN=<token> npm run deploy:workers
```

`preflight:workers` 退出码：`0` 可部署、`1` 阻塞、`2` Token 不可用、
`3` 基础检查通过但尚缺 `DATABASE_URL` / Hyperdrive 配置或真实 id。退出 `3` 时
**不要**直接 `wrangler deploy`，先跑 `provision-hyperdrive` 把真实 id 写回
`wrangler.workers.jsonc` 再复检。

`secrets -- --workers` 会自动跳过 `DATABASE_URL`、`CLOUDFLARE_API_TOKEN`、
`CLOUDFLARE_ACCOUNT_ID`：Workers Free 的数据库由 Hyperdrive binding 提供，
连接串只在本机给 `provision-hyperdrive` / `bootstrap-db` 用，不会上传为
Worker Secret；容器模式仍会注入 `DATABASE_URL`。

前端 `.env` / `.env.miniprogram` 只需两行：`VITE_AUTH_BACKEND=selfhost`、
`VITE_SELFHOST_API_BASE=https://api.maolizheng.xyz`。**必须在 Worker 部署完成且
`/api/health` 返回 200 之后才切换**，否则小程序会连到不存在的域名。回到项目根执行：

```bash
node deploy/switch-backend.mjs status                 # 查看当前开关
node deploy/switch-backend.mjs selfhost --check      # 健康检查通过才切换
pnpm build:weapp                                     # Vite 环境变量在构建时注入
node deploy/switch-backend.mjs legacy                # 一键回滚到 Meoo Cloud 网关
```

脚本幂等、只改这两个键、保留其它所有行，并把原文件备份到
`deploy/.backups/`（已 gitignore）。本轮**只提供工具，未执行切换**。

### 10.4 本地实测（2026-11-09，北京）

`pnpm --dir backend db:start`（PGlite 55432）→ `bootstrap-db` →
`npm run dev:workers`（workerd 8791）后跑通：探活、注册 201 + JWT、
登录（邮箱/用户名）、错误密码 401、重复注册 409、会话查询、`/api/db` 查询、
未授权 401、404、CORS 预检、以及 **真实 R2** 上传 → 公开读回内容 → 删除 →
删除后 404。除了一次测试参数写错（login 用 `email` 而非 `username`、
rpc 用 `name` 而非 `fn`），全部通过。

密码哈希风险已实测澄清：本地 workerd 的 scrypt `hashPassword` +
`verifyPassword` 合计约 **96 ms wall time**；把同一函数部署到**真实
Workers Free**（临时 `detect-network-bench` Worker，测完已删除）后，
连续 5 次 `/hash` 与 5 次纯 JS CPU 密集对照全部返回 200，**未出现 Error 1102**。
原生 `node:crypto` 的执行不计入该账户的 CPU 计量。上线后仍建议监控 1102。

### 10.5 限制与风险

- **实时推送**：Workers 下 `broadcastChange` 是 no-op；前端 `.channel()` 本就是
  轮询兜底，不影响消息可达性。需要真 WebSocket 时只能走 §九 的 Node 路径。
- **找回密码邮件**：SMTP 直连（`node:net/tls`）在 Workers 出站不可用，但已由
  §10.6 的 HTTP 邮件 API 通道解决；一条发信通道都没配时仍返回
  `RESET_CONFIG_MISSING`。
- **限频**：`edge/routes.ts` 的实例级内存 Map 只在同一 isolate 内有效，不跨实例。
- **域名**：HTTPS / 证书 / DNS / Custom Domain 绑定已于 2026-11-10 就绪（见 §10.7）；
  仍需完成 ICP 备案，并在小程序后台把 `https://api.maolizheng.xyz` 加入 request
  合法域名。该 custom domain 与 §七 的 Containers Worker 互斥，只能绑一个。
- **Hyperdrive 缓存已禁用**（`caching.disabled=true`）：聊天写多读多，避免
  缓存 SELECT 导致读到过期会话。
- **免费层波动**：Supabase Free 项目 1 周无活动会暂停；保持 Docker 镜像 +
  标准 Postgres，随时可回退到 §九 / §十 之外的方案。

### 10.6 Workers 下的找回密码发信（HTTP 邮件 API）

`edge/mail.ts` 是统一投递入口，`edge/mail-content.ts` 与 SMTP 共用主题/正文。
`MAIL_DRIVER=auto`（默认）按 `RESEND_API_KEY` → `RECOVERY_MAIL_API_URL` → SMTP
顺序选路；`http` / `smtp` 可强制单一通道。SMTP 实现由 `launch.ts` 注入
`globalThis.__DETECT_SMTP_SEND__`（与实时广播 `__DETECT_REALTIME_EMIT__` 同一套机制），
Workers 不注入，因此 Worker bundle **完全不含** `node:net` / `node:tls`。
注意：静态 import 与动态 import 都会被 esbuild 内联成 bundle 顶层 import，
所以这里不能用 `await import('./smtp.js')` 来规避。

| 通道 | 必填 | 请求体 |
| --- | --- | --- |
| Resend | `RESEND_API_KEY` + `RECOVERY_MAIL_FROM` | `POST https://api.resend.com/emails`：`{ from, to:[...], subject, text, html }` |
| 自定义网关 | `RECOVERY_MAIL_API_URL` + `RECOVERY_MAIL_FROM` | `POST <URL>`：`{ from, to, subject, text, html, code, ttl_minutes }`；`RECOVERY_MAIL_API_KEY` 作 Bearer |
| SMTP（仅 Node / VPS） | `RECOVERY_SMTP_HOST/USER/PASS` + `RECOVERY_MAIL_FROM` | 465 隐式 TLS / 587 STARTTLS |

`RESEND_API_URL` 可覆盖默认端点（代理 / 本地 mock），`RECOVERY_MAIL_TIMEOUT_MS`
默认 15000。这些键由 `secrets -- --workers` 注入，模板见 `.dev.vars.example`。
`pnpm --dir backend test:mail` 用本地 HTTP mock 验证选路、请求体、SMTP 注入、
5xx、端点不可达与超时，40/40 通过，不需要真实邮箱服务或数据库。

**顺带修复的顺序缺陷**：旧 `recoverySend()` 先把验证码哈希写进 `profiles`，再检查
发信配置并发信。配置缺失或投递失败时会留下一个用户永远收不到的「死码」，同时作废
上一次仍有效的验证码，还白白消耗该账号的限频额度。现在改为「先确认通道可用 →
写哈希 → 发信」，投递失败时带哈希条件回滚清空（避免误清并发新码），返回 502
而不是抛异常。

### 10.7 域名引导与证书（2026-11-10，北京）

**证书不需要单独签发。** Cloudflare Universal SSL 是 Zone 级证书，实测账户下只有
一张 `universal / active` 证书包，hosts 为 `maolizheng.xyz, *.maolizheng.xyz`，
由 Google Trust Services `WE1` 签发，有效期至北京 2027-01-18 18:40。
`api.maolizheng.xyz` 已落在通配 SAN 内。为单个子域签发专属证书需要付费的
Advanced Certificate Manager，对微信小程序没有任何额外收益。

**域名绑定的正确触发方式**：Cloudflare 不允许为「尚不存在的 Worker」手工创建
Custom Domain，DNS 记录与绑定都由 `wrangler deploy` 自动完成。因此在数据库就绪前，
先用 `wrangler.domain.jsonc` + `src/domain-probe.ts` 部署同名占位 Worker：

```bash
cd deploy/cloudflare
npm run dry-run:domain     # 打包预演，1.16 KiB
npm run deploy:domain      # 需 CLOUDFLARE_API_TOKEN；创建 DNS + Custom Domain
```

部署后 Cloudflare 自动生成 `AAAA 100::`（proxied）记录并绑定
`api.maolizheng.xyz → detect-network-worker`。实测：
`https://api.maolizheng.xyz/__worker/health` 返回 200，`ssl_verify_result=0`，
TLS 1.2 / 1.3 均可用，证书链完整；与 `proxy.maolizheng.xyz` 为同一张证书。

**引导态的安全约束**：`/api/health` 刻意返回 `503 BACKEND_NOT_DEPLOYED`，
避免 `deploy/switch-backend.mjs selfhost --check` 误判后端已就绪而把前端切到
一个没有数据库的 selfhost 地址。实测该守护确实拒绝切换（退出码 3），
`.env` / `.env.miniprogram` 保持 `legacy` 未被改动。

**正式部署时无需清理域名**：`npm run deploy:workers` 用同一个 Worker 名字覆盖，
Custom Domain 与 DNS 记录由 Cloudflare 复用。`preflight.mjs --workers` 已改为
先查 Workers Custom Domains：域名已绑定目标 Worker 时报 OK 并提示复用，
不再误报「需清理 DNS」；绑定到其它 Worker 时才报 BLOCK。

**仍需人工完成的两项**（工具无法代做）：域名 ICP 备案有效性确认；微信公众平台
「开发管理 → 开发设置 → 服务器域名」把 `https://api.maolizheng.xyz` 加入 request
合法域名（不能带端口或路径，平台会校验备案）。小程序自身也需完成 ICP 代备案。
