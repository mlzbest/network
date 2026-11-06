# supabase 目录

`client.ts` **现由本项目自行维护**，不再是 Meoo Cloud 自动生成文件（平台恢复云服务时请勿覆盖）。

- `client.ts` 是双栈鉴权入口，默认 `VITE_AUTH_BACKEND=legacy`：用 `createClient()` 连接 Meoo Cloud Supabase 网关，保留「用户名 + 密码 + `{username}@meoo.local` 占位邮箱」账号体系，并恢复历史数据、RLS、Storage、Realtime。
- `VITE_AUTH_BACKEND=cloud` 切到 WorkBuddy Cloud SDK（见 `cloud-adapter.ts`）。注意该平台 `signUp` 强制要求 OTP 换来的 `verificationToken`，**不支持纯用户名密码注册**，当前业务 UI 不能启用。
- Database / Auth / Storage / Realtime 统一使用 `client.ts` 导出的 `supabase`。
- 云函数或 `Taro.request` 直连网关时，URL 基于 `supabaseUrl`，且必须带 `apikey`、`Authorization`（有会话时）和 **`OneDay-App-Id`** 三个头；缺 `OneDay-App-Id` 时 `/auth/v1/signup` 会返回空 400。
- ASR / SMTP 找回密码 / 网络诊断 / 逆地理 / relay 等外部能力走承载层，用 `resolveCloudFnUrl()` / `resolveRelayUrl()` 取 URL；未配置 `VITE_CLOUD_FN_*` 时自动回落 `${supabaseUrl}/functions/v1/*`。
- weapp 构建把 `@supabase/supabase-js` alias 成 `supabase-wechat-js`（见 `config/index.ts`），小程序端无需手写 fetch/storage polyfill。
