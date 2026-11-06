# 找回密码邮件 —— 外部承载说明

## 原函数

`functions/set-account-email/index.ts` 承载三条通道：

| 通道 | 触发条件 | 依赖 |
|------|---------|------|
| 修改登录邮箱 | 含 Authorization + email | service_role 改写 `auth.users.email` |
| 找回密码·发信 | 含 email 且无 Authorization | SMTP 投递 + 自签 6 位验证码 |
| 找回密码·校验 | 含 token + username + password | service_role 改写 `auth.users.password` |

## WorkBuddy Cloud 替代

| 通道 | 替代方案 | 状态 |
|------|---------|------|
| 修改登录邮箱 | `cloudAuth.updateUser({ email })` → `functions-cloud/set-account-email.cloud.ts` 的 `cloudUpdateEmail` | ✅ 可用 |
| 找回密码·校验 | `cloudAuth.updateUser({ password })` + 比对 `public.profiles.recovery_token_hash` → `cloudResetPasswordWithCode` | ✅ 可用（哈希比对走 SDK） |
| 找回密码·发信 | SMTP 投递，WorkBuddy 无等价面 | ❌ 外部承载 |

## 外部承载要点

- 外部承载需要**自己签发 6 位数字验证码**，把 `sha256(验证码)` 哈希写入 `public.profiles.recovery_token_hash`
- 哈希存储走 SDK `cloudSupabase.from('profiles').update(...)`（外部承载内可用 Taro/Node 的 fetch 直连 PostgREST 网关）
- SMTP 投递保留原 `functions/set-account-email/shared/password-recovery.ts` 的 SMTP 客户端（Deno.connect / connectTls）
- 外部承载部署完成后，`src/api/auth.ts` 的 `sendPasswordRecoveryCode` 调用路径不变，仅网关侧切流

## 限频保留

外部承载必须保留原函数的三级限频（IP / 账号 / 校验），见 `functions/set-account-email/shared/password-recovery.ts` 的 `RATE_WINDOW_MS` 常量。
