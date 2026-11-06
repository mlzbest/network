# 承载层选型与部署方案

> Task #6 子项：把 5 类「⚠️ 外部承载」能力落到可真实调用的函数运行时，替代旧 `functions/*` Edge Function 网关。

## 一、5 类能力盘点

| 能力 | 旧入口 | 外部依赖 | 是否必须 | 推荐运行时 |
|------|--------|----------|----------|-----------|
| 1. ASR 语音识别 | `functions/ai-chat` (asr=true) | 百度 OAuth AK/SK / OpenAI 兼容 `/audio/transcriptions` | 否（功能可选） | TCB / 阿里云函数（国内延迟低） |
| 2. 找回密码·SMTP 发信 | `functions/set-account-email` | RECOVERY_SMTP_* (外部 SMTP 凭据) | 否（功能可选） | TCB / 阿里云函数（支持 465/587/STARTTLS） |
| 3. 自定义 relay（第三方模型直连） | `functions/ai-chat` (relay=true) | 客户端传入 baseUrl + apiKey（白名单校验） | 否（功能可选） | Cloudflare Workers（国际出站稳） |
| 4. 网络诊断 8 项 | `functions/net-diagnose` | Deno.resolveDns / 第三方拨测 API / 17CE token | 否（功能可选） | TCB / 阿里云函数（需 DNS 解析 + 出站白名单） |
| 5. 逆地理编码 | `functions/net-diagnose` (geocode-reverse) | 高德 Web API (AMAP_WEB_KEY) | 否（功能可选） | TCB / 阿里云函数（境内高德延迟低） |

## 二、运行时选型结论

### 推荐：腾讯云 TCB 云函数（主选）+ Cloudflare Workers（辅）

**理由**：
1. 项目目标三端（微信 / 钉钉 / 抖音）都在境内，TCB 与微信生态契合，真机测试延迟最低
2. 5 类能力里 4 类是境内出站（百度 / 高德 / SMTP / 17CE），只有 relay 是国际出站
3. TCB 支持 Node.js / Python / Deno 三种运行时，覆盖大部分 Deno API 等价实现
4. Cloudflare Workers 仅承载 relay 通道（国际出站 + 白名单校验），国内延迟可接受

### 备选：阿里云函数计算 FC
- 优势：境内节点更多，免费额度充足
- 劣势：部署链路比 TCB 复杂，与微信小程序真机测试的连通性弱于 TCB

### 不推荐：保留旧 Meoo Edge Function 网关
- 旧网关在 Meoo Cloud 关闭后会失效，且 `MEOO_PROJECT_API_KEY` 注入机制不通用
- 仅作「回滚兜底」保留，不作为主承载

## 三、部署拓扑

```
┌─────────────────────────────────────────────────────────────┐
│  前端（小程序 / H5）                                         │
│  src/api/{asr,auth,net-diagnose,geocode,ai}.ts              │
│    └─ VITE_CLOUD_FN_BASE_URL = https://<tcb-region>.tcb.    │
│       qcloudapi.com/cloudfunctions/prod-xxx/                │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  承载层网关（TCB 云函数路由）                                │
│                                                             │
│  /asr            → asr.ts          (TCB Node.js)           │
│  /smtp-recovery  → smtp-recovery.ts (TCB Node.js)          │
│  /ai-relay       → ai-relay.ts     (Cloudflare Workers)    │
│  /net-diagnose   → net-diagnose.ts (TCB Node.js)          │
│  /reverse-geo    → reverse-geocode.ts (TCB Node.js)       │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  外部依赖                                                   │
│  - 百度 vop.baidu.com/server_api                            │
│  - OpenAI 兼容 /audio/transcriptions                        │
│  - 外部 SMTP (RECOVERY_SMTP_*)                               │
│  - 高德 webapi.amap.com                                     │
│  - 17CE / Globalping 拨测 API                               │
│  - WorkBuddy Cloud SDK (@tencent-ai/workbuddy-cloud-sdk)   │
└─────────────────────────────────────────────────────────────┘
```

## 四、环境变量注入（承载层）

| 变量 | 承载层运行时 | 来源 |
|------|-------------|------|
| `WX_CLOUD_ENDPOINT` / `WX_CLOUD_PUBLISHABLE_KEY` | TCB Node.js | WorkBuddy 后台获取，与前端 `VITE_CLOUD_ENDPOINT` 同值 |
| `BAIDU_API_KEY` / `BAIDU_SECRET_KEY` | TCB Node.js | 百度智能云控制台 |
| `ASR_BASE_URL` / `ASR_API_KEY` / `ASR_MODEL` | TCB Node.js | 用户自定义（OpenAI 兼容） |
| `RECOVERY_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` / `RECOVERY_MAIL_FROM` | TCB Node.js | 自建 SMTP 或第三方 |
| `AMAP_WEB_KEY` | TCB Node.js | 高德开放平台 |
| `PROBE_17CE_TOKEN` | TCB Node.js | 17CE 云监测（可选） |
| `RELAY_WHITELIST` | Cloudflare Workers | 白名单 host 列表（JSON） |

## 五、部署顺序

1. **TCB 控制台开通**：选 ap-shanghai / ap-guangzhou 区域（境内延迟最优）
2. **部署 4 个 TCB 函数**（asr / smtp-recovery / net-diagnose / reverse-geocode）：
   - 每个函数独立包，部署源码 = `functions-cloud/providers/<name>/`
   - 注入 `WX_CLOUD_ENDPOINT` / `WX_CLOUD_PUBLISHABLE_KEY` + 该函数专属密钥
3. **Cloudflare Workers 部署 1 个**（ai-relay）：
   - 源码 = `functions-cloud/providers/ai-relay/`
   - 注入 `RELAY_WHITELIST`（JSON 字符串）
4. **前端切换**（Task #9 已完成，代码层面）：
   - `.env` / `.env.miniprogram` 加承载层 URL 占位（注释形式，部署后填入真实值）：
     - `VITE_CLOUD_FN_BASE_URL`（TCB 承载层网关根）
     - `VITE_CLOUD_FN_RELAY_URL`（Cloudflare Workers relay 专用）
   - `src/supabase/client.ts` 新增 URL 解析助手：
     - `getCloudFnBaseUrl()` / `resolveCloudFnUrl(fnName, legacyFnName)` / `resolveRelayUrl()`
     - 已配置承载层 → 承载层 URL；未配置 → 自动回落旧 `supabaseUrl + /functions/v1/*`（混合期不炸）
   - 5 个前端调用点切换对照：

| 调用点 | 文件 | 承载层函数 | 回落旧入口 |
|--------|------|-----------|-----------|
| ASR 语音识别 | `src/api/asr.ts` | `asr` | `ai-chat` (asr 分支) |
| 找回密码·SMTP | `src/api/auth.ts` (`sendPasswordRecoveryCode` / `resetPasswordWithCode`) | `smtp-recovery` | `set-account-email` |
| 网络诊断 | `src/api/net-diagnose.ts` | `net-diagnose` | `net-diagnose` |
| 逆地理编码 | `src/api/geocode.ts` | `reverse-geo` | `net-diagnose` (geocode-reverse) |
| 自定义 relay | `src/api/ai.ts` (`requestLLMStream`) | `ai-relay` (Workers) | `ai-chat` (relay 分支) |

5. **回滚兜底**：`VITE_CLOUD_FN_BASE_URL` / `VITE_CLOUD_FN_RELAY_URL` 未配置时，`resolveCloudFnUrl` / `resolveRelayUrl` 自动回落旧 `supabaseUrl + /functions/v1/*` 路径——承载层与旧网关可任意切换，零代码改动。

## 六、验收标准

- 5 类能力真机调用走承载层网关，旧 `functions/*` 网关流量归零
- 承载层函数错误日志统一带 `requestId`，前端 toast 文案友好（不暴露内部状态码）
- 密钥（百度 / 高德 / SMTP / 17CE / relay）全部在服务端环境变量，前端零接触
- 承载层部署完成后，把 `functions-cloud/*.bridge.md` 里的 `*_EXTERNAL_REQUIRED` 置 false

## 七、本任务后续子任务

- Task #8：承载层 5 个函数源码（按本方案 `functions-cloud/providers/*` 目录落码）
- Task #9：前端调用点切到承载层网关 URL

## 八、Task #8 / #9 交付清单（已完成）

### 承载层 5 个函数源码（`functions-cloud/providers/`）

| 函数 | 文件 | 运行时 | 入口 | 外部依赖（密钥服务端注入） |
|------|------|--------|------|--------------------------|
| `asr` | `providers/asr/index.ts` | TCB Node.js | `mainHandler(event)` | `BAIDU_API_KEY` / `BAIDU_SECRET_KEY` 或 `ASR_BASE_URL` / `ASR_API_KEY` / `ASR_MODEL` |
| `smtp-recovery` | `providers/smtp-recovery/index.ts` | TCB Node.js | `mainHandler(event)` | `RECOVERY_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` / `RECOVERY_MAIL_FROM` |
| `net-diagnose` | `providers/net-diagnose/index.ts` | TCB Node.js | `mainHandler(event)` | `PROBE_17CE_TOKEN`（可选增强源，Globalping 免费） |
| `reverse-geocode` | `providers/reverse-geocode/index.ts` | TCB Node.js | `mainHandler(event)` | `AMAP_WEB_KEY`（高德） |
| `ai-relay` | `providers/ai-relay/index.ts` + `wrangler.toml` | Cloudflare Workers | `export default { fetch }` | 客户端传 `apiKey` + `RELAY_WHITELIST`（host 白名单 JSON） |

### 前端 5 个调用点切换（`src/api/`）

| 调用点 | 承载层函数 | 回落旧入口 | 切换方式 |
|--------|-----------|-----------|---------|
| `src/api/asr.ts` | `asr` | `ai-chat` (asr 分支) | `resolveCloudFnUrl('asr', 'ai-chat')` |
| `src/api/auth.ts` (找回密码 2 处) | `smtp-recovery` | `set-account-email` | `resolveCloudFnUrl('smtp-recovery', 'set-account-email')` |
| `src/api/net-diagnose.ts` | `net-diagnose` | `net-diagnose` | `resolveCloudFnUrl('net-diagnose', 'net-diagnose')` |
| `src/api/geocode.ts` | `reverse-geo` | `net-diagnose` (geocode-reverse) | `resolveCloudFnUrl('reverse-geo', 'net-diagnose')` |
| `src/api/ai.ts` (relay) | `ai-relay` (Workers) | `ai-chat` (relay 分支) | `resolveRelayUrl()` |

### 回落契约

`src/supabase/client.ts` 导出 `getCloudFnBaseUrl()` / `resolveCloudFnUrl(fnName, legacyFnName)` / `resolveRelayUrl()`：
- `VITE_CLOUD_FN_BASE_URL` 已配置 → 承载层 TCB 网关 URL
- 未配置 → 回落旧 `supabaseUrl + /functions/v1/<legacyFnName>`
- `VITE_CLOUD_FN_RELAY_URL` 已配置 → Cloudflare Workers；未配置 → 回落旧 `ai-chat` relay 分支

`.env` / `.env.miniprogram` 已加占位注释，部署后填入真实值即生效，零代码改动。
