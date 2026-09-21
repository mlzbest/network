# Meoo 项目开发指南

本项目从 [Meoo](https://meoo.space) 平台导出，修改后可重新导入。
以下规则确保项目能被平台正确识别和恢复，请在使用本地 AI 工具（Cursor / Copilot / Claude Code 等）开发时遵守。

## 启动项目

```bash
pnpm install
pnpm dev
```

开发服务器端口：**3015**（`http://localhost:3015`）

## 开发约束

- **技术栈**：react + vite，不要更换框架或构建工具（如切换为 Angular / Svelte），否则导入时会被拒绝
- **不要删除以下文件**：`meoo-manifest.json`、`meoo-cloud-snapshot.json`（重新导入时需要；同名隐藏文件为平台兼容副本）

## 云服务（Supabase）

### 数据库

- `src/supabase/client.ts` — Supabase 客户端配置，**不要删除或重命名此文件**（平台靠它检测云服务状态）
- 修改数据库结构时，在 `migrations/` 目录下**新增** `.sql` 文件，不要修改或删除已有的 migration 文件
- 命名格式：`YYYYMMDD_HHmmss_name.sql`，name 为纯小写 snake_case（如 `20260605_120000_add_orders_table.sql`）
- 平台按文件名字典序执行，时间戳前缀保证顺序
- **必须使用幂等语法**：`CREATE TABLE IF NOT EXISTS`、`CREATE OR REPLACE FUNCTION`、`DROP ... IF EXISTS` + `CREATE`，因为导入时所有 migration 会重新执行
- SQL 内容为纯 DDL（CREATE / ALTER / DROP），整个文件作为一条语句执行

### Edge Functions

- 云函数放在 `functions/<函数名>/index.ts`
- 每个函数一个目录，入口必须是 `index.ts`
- 导入后平台会自动部署所有检测到的云函数

### 环境变量

- 系统变量（`SUPABASE_URL`、`SUPABASE_ANON_KEY` 等）导入后自动配置，无需手动管理
- 自定义环境变量（如第三方 API Key）导入后需要在平台上重新设置

## 导入回平台

1. 将项目打包为 ZIP（排除 `node_modules`、`.git`、`dist` 目录）
2. 在 Meoo 首页点击输入框的「+」→「导入项目」
3. 上传 ZIP → 平台自动验证 → 创建新项目
4. 点击「确认开启云服务」一键恢复数据库和云函数
