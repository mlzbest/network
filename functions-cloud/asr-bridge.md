# ASR / 找回密码邮件 —— 外部承载说明

## 为什么保留外部承载

| 能力 | 依赖 | WorkBuddy Cloud 是否有等价面 |
|------|------|-----------------------------|
| 百度短语音识别（`/vop/server_api`） | 百度 OAuth AK/SK + 30 天 token 缓存 | ❌（第三方密钥白名单在 Deno env） |
| OpenAI 兼容 `/audio/transcriptions` | 外部 baseUrl + Bearer Key | ❌（白名单校验在 Deno env） |
| 找回密码 SMTP 投递 | RECOVERY_SMTP_* 环境变量 | ❌（Deno.connect / connectTls） |
| Meoo AI 平台通道（`/meoo-ai/compatible-mode/v1/chat/completions`） | MEOO_PROJECT_API_KEY | ✅ → 已切 `cloudLlm.chat` |
| 第三方 relay 通道 | 客户端传的 baseUrl + apiKey | ❌（白名单在 Deno env） |

## 外部承载候选

- **腾讯云 TCB（云函数）**：与微信生态契合，`wx.getAccountInfoSync` 直读，环境变量注入方便
- **阿里云函数计算 FC**：境内延迟最优，支持 SMTP 出站（需 VPC）
- **Cloudflare Workers**：免费额度最高，但境内延迟不可控；建议仅承载 relay/地理

## 调用侧契约

外部承载部署完成后，**前端调用路径不变**（仍打 `functions/*` 网关），由网关侧把流量转发到外部承载。
本迁移期（Task #5 本地测试阶段）调用侧：
- `src/api/asr.ts` → 仍走 `supabaseUrl + /functions/v1/ai-chat`（asr=true 分支）
- `src/api/auth.ts` 的 `sendPasswordRecoveryCode` → 仍走 `supabaseUrl + /functions/v1/set-account-email`
- `src/api/net-diagnose.ts` → 仍走 `supabaseUrl + /functions/v1/net-diagnose`
- `src/api/geocode.ts` → 仍走 `supabaseUrl + /functions/v1/net-diagnose`（geocode-reverse 分支）

## 验收

外部承载部署完成后，把以上 4 个调用点的 `AI_CHAT_URL` / `FUNCTION_URL` 等常量切到外部网关 URL，并在
`functions-cloud/` 对应文件里把 `*_EXTERNAL_REQUIRED` 置 false。
