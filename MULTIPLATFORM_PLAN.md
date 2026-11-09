# 检测网络 · 微信 / 钉钉 / 抖音 多端适配方案

> 目标：把现有「检测网络」（Taro 4.2 + React18 + TS + Tailwind v4 + Zustand，后端 Meoo Cloud / Supabase）从纯微信小程序，扩展到微信、钉钉、抖音三端可运行。
> 本文为规划文档，结论基于 2026-10-26 对仓库的逐文件核查。

---

## 1. 项目本质（速览）

- **形态**：网络诊断 + AI 解读的 IM 类小程序。
- **架构**：`pages → zustand stores(auth/profiles/chats/messages) → api 层（页面禁止直连 supabase）→ Supabase`。
- **实时性**：Realtime 三层订阅（app 全局 / chats 页 / chat 页），大量针对微信 socket 行为的补丁（见 AGENTS.md）。
- **后端**：Meoo Cloud 包装的 Supabase，网关形如 `https://mp-api.meoo.host/mp-api/<app-id>`，客户端文件 `src/supabase/client.ts` 由平台自动生成、不可手改。

## 2. 可行性结论

- **编译层**：✅ Taro 原生支持三类目标端：
  - 微信 `weapp`（已有）
  - 抖音 `tt` → `@tarojs/plugin-platform-tt`（内置）
  - 钉钉 `dd` → `@tarojs/plugin-platform-alipay-dd`（NervJS，env `process.TARO_ENV==='dd'`，钉钉 API 基于支付宝规范）
- **业务层**：绝大多数 UI / 状态 / PostgREST / 订阅逻辑平台无关，可复用。
- **真正工作量**集中在「微信原生能力适配层」，共 7 个热点，其中 **Supabase 传输层 + 登录** 是战略级。

## 3. 耦合点分级

### 🟢 平台无关（直接复用）
页面与组件、Zustand stores、PostgREST 查询、消息实时性订阅逻辑、Tailwind 样式、tabbar 结构。

### 🟡 轻微改造
约 25 处 `Taro.getEnv() === Taro.ENV_TYPE.WEAPP` 把「微信」误当「所有小程序」。大部分应改为 `isMiniProgram()`（非 H5），仅微信专属能力才判 `isWeapp()`。

### 🔴 微信强耦合（7 项，需重写或平台分支）
1. **Supabase 传输层**：`config/index.ts` 把 `@supabase/supabase-js` alias 到 `supabase-wechat-js`，运行期硬调 `wx.request / wx.connectSocket / wx.getStorageSync`。tt/dd 无此包。
2. **登录**：`src/supabase/wx-mp-login.ts` 依赖 `wx.login` + 同名 Edge Function，绑定微信 app-id。
3. **语音 ASR**：`src/lib/wechat-asr.ts` 依赖微信同声传译插件 WechatSI（个人主体不可用）。
4. **SSE 流式**：`src/lib/sse.ts` 用 `Taro.request` 的 `enableChunked`（微信选项）。
5. **文件选择**：`src/lib/upload.ts` 用 `chooseMessageFile`（微信独有）。
6. **隐私授权**：`src/components/privacy-shield` 用微信隐私 API。
7. **socket 补丁**：`src/lib/realtime-socket-patch.ts` 处理 `closeSocket:fail taskID not exist` 的微信语义。

## 4. 战略前置（0 号风险，必须先定）

Meoo Cloud 的网关 URL、`OneDay-App-Id` 头、storageKey、以及 `wx-mp-login` Edge Function 全部绑定**微信 app-id `p13z02n1pgq4`**。tt/dd 要跑起来，前提是：

- **路径 A（Meoo 路线）**：确认 Meoo Cloud 支持 tt/dd 的 app 注册、网关放行、登录函数与 `OneDay-App-Id` 映射。能 → 改动最小。
- **路径 B（自托管路线）**：Meoo 不支持 → 改用裸 Supabase（自托管或 supabase.com），自行实现 tt/dd 的传输层与登录。

> 这条决策决定整条技术路线，应最先与 Meoo Cloud 确认。

## 5. 分阶段实施路线

- **阶段 0 · 决策**：确认 Meoo 对 tt/dd 的支持度，选定路径 A / B。
- **阶段 1 · 编译骨架**：装 `@tarojs/plugin-platform-tt` 与 `@tarojs/plugin-platform-alipay-dd`；新增 `build:tt` / `build:dd`；配 `project.tt.json` / `project.dd.json`；扩展 alias 与 `meoo-supabase-url` 插件按 `TARO_ENV` 分支。先用空壳让三端 dev 都跑通。
- **阶段 2 · 平台感知 helper**：新增 `isMiniProgram() / isWeapp() / isTT() / isDD()`，重构 ~25 处 `WEAPP` 判断（多数改 `isMiniProgram`）。
- **阶段 3 · Supabase 多端传输层**：用 `supabase-mp-js`（或自建适配器）按 `TARO_ENV` 注入 `global.fetch` / `auth.storage` / `realtime.transport`（wx / tt / dd 各自的 request / connectSocket / storage），替换 `supabase-wechat-js`；统一 socket 补丁。
- **阶段 4 · 登录多端**：`tt.login` / `dd.login` + 对应 Edge Function（或统一 OAuth 函数）。
- **阶段 5 · 原生能力分支/降级**：SSE（验证 tt/dd 的 chunked 支持）、文件选择（各自 API）、ASR（平台各自或云函数通道兜底）、隐私（各自框架）、Map 标记（三端 marker 差异）。
- **阶段 6 · 联调与上架**：三端真机联调 + 各自后台配置、隐私协议、类目审核。

## 6. 风险与工作量

- **最大不确定性**：Meoo Cloud 对 tt/dd 的支持程度（网关 / 登录 / 函数）。这是 0 号风险。
- **Realtime / SSE** 在 tt/dd 的 WebSocket 与 chunked 兼容性需真机实测（抖音 `tt.connectSocket`、钉钉 `dd.connectSocket`）。
- **语音 / 位置** 等原生能力三端体验不一致，建议作为「渐进增强」而非硬依赖。
- **粗略估算**：骨架 + helper 约 1–2 周；传输层 + 登录 2–3 周（含实测）；原生能力分支 2–3 周。总计约 1.5–2.5 人月，随 Meoo 支持度浮动。

## 7. 建议的下一步

1. 先确认 Meoo Cloud 能否给 tt/dd 开 app 与网关（决定路径 A / B）。
2. 确认后，从**阶段 1（编译骨架）** 动手，先让三端 dev server 都跑起来，再逐层替换传输层与登录。
