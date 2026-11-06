# 4 个 Edge Function 的云端迁移方案（Task #5 总览）

WorkBuddy Cloud SDK 当前提供 `database` / `auth` / `storage` / `llm` 四个面，没有原生 Edge Function 运行时（SMTP、Deno.resolveDns、第三方 ASR 网关等都需要外部承载）。因此迁移策略按「能力归属」分三类：

| 函数 | 原职责 | 云端替代路线 | 文件 |
|------|--------|-------------|------|
| `wx-mp-login` | 微信一键登录（jscode2session + admin.createUser + generateLink） | **已退役**：Task #4 已切到 `cloudAuth.signInWithWechat(code, appid)`；本函数不再被调用 | 见 `wx-mp-login.retired.md` |
| `ai-chat` | LLM 流式 + 模型目录 + 第三方 relay + 百度/OpenAI ASR | LLM 主通道切到 `cloudLlm.chat.completions.create`（WorkBuddy LLM 网关）；ASR / relay 因外部密钥依赖暂保留为「外部承载」，调用路径走 `functions/ai-chat` 不变 | 见 `src/cloud-fn-adapter/ai-chat.cloud.ts` |
| `set-account-email` | 改邮箱 + 找回密码（SMTP 发信 + 自签验证码） | 改邮箱走 `cloudAuth.updateUser` 桥接；找回邮件保留外部承载（SMTP 依赖 Deno API），调用路径走 `functions/set-account-email` 不变 | 见 `src/cloud-fn-adapter/set-account-email.cloud.ts` |
| `net-diagnose` | 网络诊断 8 项 + 微信步数 + 逆地理编码 | 网络诊断的 Deno API 调用保留外部承载；步数/地理编码走 SDK `database.from` 重写 | 见 `src/cloud-fn-adapter/net-diagnose.cloud.ts` |

> ⚠️ **诚实降级**：本迁移不假装 SDK 能提供 SDK 没有的能力（SMTP / Deno 网络 API / 第三方 ASR 白名单）。
> 这些函数在「本地开发 + 真机测试」期间仍走原 `functions/*`，正式切换外部承载后再下线。

---

## 迁移原则

1. **主链路（登录 / 会话 / 消息 / 上传）零阻塞**：Task #3 + #4 已完成，类型清零。
2. **LLM 主通道**：`ai-chat` 的平台通道（Meoo AI）→ `cloudLlm.chat`（WorkBuddy LLM 网关），保留 `stream: true` 语义。
3. **外部依赖类**（SMTP / 百度 ASR / 高德地理 / 17CE 拨测）：保留 `functions/*` 的调用入口，仅在调用侧加注释标注「需外部承载」，避免本地测试期阻塞。
4. **Realtime / 微信步数 / 诊断**：明确标记「Task #6 单独处理」，不在本任务里假装支持。

## 文件组织

```
functions-cloud/                       ← 迁移文档与外部承载说明
  README.md                            ← 本文（总览）
  deployment.md                        ← 承载层选型与部署方案（Task #8 / #9）
  wx-mp-login.retired.md              ← 退役说明
  asr-bridge.md                        ← ASR 外部承载说明（百度 / OpenAI 兼容）
  password-recovery.bridge.md          ← SMTP 外部承载说明

functions-cloud/providers/            ← 承载层函数源码（TCB / Cloudflare Workers）
  asr/index.ts                         ← ASR 语音识别（TCB Node.js，百度/OpenAI 兼容双路由）
  smtp-recovery/index.ts               ← 找回密码 SMTP 发信（TCB Node.js）
  net-diagnose/index.ts                ← 网络诊断 9 项（TCB Node.js，Deno API → Node.js 等价）
  reverse-geocode/index.ts             ← 逆地理编码（TCB Node.js，高德 Web API 代理）
  ai-relay/index.ts + wrangler.toml   ← 自定义 relay（Cloudflare Workers，白名单 + 密钥注入）

src/cloud-fn-adapter/                  ← 云端适配层（TS 代码，进打包）
  ai-chat.cloud.ts                     ← LLM 主通道（cloudLlm.chat.completions.create）
  set-account-email.cloud.ts           ← 改邮箱 + 找回密码校验（cloudAuth.updateUser）
  net-diagnose.cloud.ts                ← 微信步数 + 网络诊断降级标记
```

## 承载层 5 类能力 → 函数 → 外部依赖 对照表（Task #8 产出）

| 能力 | 承载层函数 | 运行时 | 外部依赖（密钥全在服务端） | 旧入口 |
|------|-----------|--------|--------------------------|--------|
| 1. ASR 语音识别 | `providers/asr/index.ts` | TCB Node.js | 百度 `BAIDU_API_KEY`/`BAIDU_SECRET_KEY` 或 OpenAI 兼容 `ASR_BASE_URL`/`ASR_API_KEY`/`ASR_MODEL` | `functions/ai-chat` (asr=true) |
| 2. 找回密码·SMTP | `providers/smtp-recovery/index.ts` | TCB Node.js | `RECOVERY_SMTP_HOST`/`_PORT`/`_USER`/`_PASS`/`RECOVERY_MAIL_FROM` | `functions/set-account-email` |
| 3. 自定义 relay | `providers/ai-relay/index.ts` | Cloudflare Workers | 客户端传 `apiKey` + `RELAY_WHITELIST`（host 白名单） | `functions/ai-chat` (relay=true) |
| 4. 网络诊断 9 项 | `providers/net-diagnose/index.ts` | TCB Node.js | `PROBE_17CE_TOKEN`（可选增强源，Globalping 免费） | `functions/net-diagnose` |
| 5. 逆地理编码 | `providers/reverse-geocode/index.ts` | TCB Node.js | `AMAP_WEB_KEY`（高德） | `functions/net-diagnose` (geocode-reverse) |

> 5 类能力密钥（百度 / 高德 / SMTP / 17CE / relay）全部注入承载层运行时环境变量，前端零接触。
> 部署步骤见 `deployment.md`。

## 验收标准

- 业务层 `src/api/*` 对 `supabase.functions.invoke` 的调用全部清零（已在 Task #4 完成）。
- LLM 流式主链路（`ai.ts` / `chat/index.tsx`）走 `cloudLlm.chat.completions.create`，不再依赖 `MEOO_PROJECT_API_KEY`。
- `wx-mp-login` 函数不再被调用；旧 Edge Function 保留但标记 deprecated。
- 其他 3 个函数的外部承载部分保留入口，调用侧明确降级路径，不在本地假装支持。
