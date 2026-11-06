# wx-mp-login — 已退役（Task #4）

## 原职责

1. 前端 `wx.login()` 拿到 code
2. 本函数用 code + WX_APP_ID + WX_APP_SECRET 调微信 `jscode2session` 换 openid/unionid
3. 用 openid 生成 `{openid}@wx.local` 虚拟邮箱
4. `supabaseAdmin.auth.admin.createUser` 建用户（幂等：已注册则按"email 已注册"处理）
5. `generateLink({ type: 'magiclink' })` 生成 hashed_token
6. 前端 `supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })` 完成登录

## 云端替代

Task #4 已在 `src/supabase/wx-mp-login.ts` 切到：

```ts
// 1) wx.login 拿 code
const loginRes = await Taro.login();
// 2) 读小程序 appid
const appid = wx.getAccountInfoSync()?.miniProgram?.appId;
// 3) 直接走 WorkBuddy Cloud 微信登录
const { data, error } = await cloudAuth.signInWithWechat(loginRes.code, appid);
// 4) 从 TCB custom uid 反解 openid
const openid = data.user.id.startsWith('wx:') ? data.user.id.slice(3) : data.user.id;
```

WorkBuddy SDK 的 `signInWithWechat` 内部已完成：
- code + appid → openid（平台侧 jscode2session）
- 创建/关联云端用户
- 写入 `profiles.openid` 列（Plan A：业务 UUID 主键 + openid 映射）

## 退役判定

- ✅ 前端 `wx-mp-login.ts` 已切到 `cloudAuth.signInWithWechat`，不再调 Edge Function
- ✅ `src/api/auth.ts` 的 `signInWithWeapp()` 走 `wxMpLogin()`，间接已切
- ✅ 类型检查清零（Task #3 / #4 验收）
- ❌ 旧 `functions/wx-mp-login/index.ts` 仍保留在仓库，标记为 deprecated；正式下线外部承载后再删

## 环境变量差异

| 旧 Edge Function | WorkBuddy Cloud |
|---|---|
| `WX_APP_ID` / `WX_APP_SECRET`（Edge Function 运行时环境变量） | `VITE_CLOUD_ENDPOINT` + `VITE_CLOUD_PUBLISHABLE_KEY`（前端环境变量）；微信 AppSecret 在 WorkBuddy 后台配置 |

## 残留引用（待清理）

- `src/api/auth.ts` 顶部 `import type { User } from '@supabase/supabase-js'` —— 已在 Task #4 保留（类型兼容），但 `User` 实际指代 WorkBuddy 的 `CloudSession.user`
- `functions/wx-mp-login/index.ts` 保留但不再被调用
