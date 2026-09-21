# network-app 本地部署指南

## 快速开始

### 1. 修改配置文件

编辑 `.env` 文件，修改以下必填项：
```bash
WX_APP_ID=wx1234567890abcdef      # 微信小程序 AppID
WX_APP_SECRET=your-app-secret      # 微信小程序 AppSecret
GOTRUE_JWT_SECRET=your-random-string  # 生成随机密钥
PGRST_ANON_KEY=your-anon-key         # 生成随机密钥
PGRST_SERVICE_ROLE_KEY=your-service-key # 生成随机密钥
```

### 2. 启动服务

```bash
cd /home/maolizheng/.openclaw/workspace-main/projects/network-app
docker-compose up -d
```

### 3. 验证运行状态

```bash
docker-compose ps
```

---

## 端口说明

| 服务 | 端口 | 用途 |
|------|------|------|
| Postgres | 5432 | 数据库 |
| GoTrue | 9999 | 认证服务 |
| PostgREST | 3000 | REST API |
| Realtime | 4000 | WebSocket 实时通信 |
| Storage | 5000 | 文件存储 |
| Edge Functions | 54321 | 微信登录、网络探测 |
| Studio | 54322 | 管理界面 |

---

## 前端配置

修改 `.env.miniprogram`，指向本地服务：

```bash
VITE_SUPABASE_URL=http://localhost:3000
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_ONEDAY_APP_ID=network-app
```

---

## 常用命令

```bash
# 启动所有服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down

# 重启某个服务
docker-compose restart edge_functions

# 查看数据库状态
docker exec -it network-app-db psql -U postgres -d supabase

# 执行迁移
docker exec -i network-app-db psql -U postgres -d supabase -f /path/to/migration.sql
```

---

## 管理界面

- Supabase Studio: http://localhost:54322
- 数据库: localhost:5432
- REST API: http://localhost:3000

---

## 安全问题

⚠️ **生产环境必须修改**:
1. 所有密钥改为强随机字符串
2. 数据库密码不要使用默认值
3. 配置 HTTPS
4. 限制端口暴露范围
