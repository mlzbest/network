# AGENTS.md

## Dependencies
- `supabase-wechat-js`：微信小程序端 Supabase client（构建时 alias `@supabase/supabase-js`），realtime 走 `wx.connectSocket`
- `zustand` v4：全局状态（auth / profiles / chats / messages 四个 store）
- `date-fns`：东八区时间切日与格式化

## Architecture
- 页面（Taro 4.2.0 + React 18）→ store（zustand）→ api（`src/api/`，禁止页面直接 import supabase client）→ Supabase
- `profiles-store`：全局唯一资料真源，模块加载即 hydrate 本地缓存；`ensure` 命中即返回、缺失批量补拉；末尾有 profiles 表全局 Realtime 订阅（`payload.new` 直接 upsert，零网络往返）
- `messages-store`：消息快照缓存按「用户+会话」隔离（`chat_msg_cache_${uid}_${cid}`，上限 100 条）；`receiveMessage` 带 100ms 批量合并窗口，连发多条只触发一次 setState
- Realtime 三层订阅：① app.tsx 全局 messages INSERT（登录态就绪才建，登出即停）② chats 页（conversations UPDATE + messages INSERT 双通道，300ms 防抖）③ chat 页（本会话 INSERT/UPDATE + typing broadcast）
- 鉴权/数据默认走 Meoo Cloud Supabase 网关（`VITE_AUTH_BACKEND=legacy`）：账号是「用户名 + 密码 + `{username}@meoo.local` 占位邮箱」，所有请求必须带 `OneDay-App-Id` 头（缺了 `/auth/v1/signup` 返回空 400）。`cloud` 模式走 WorkBuddy Cloud SDK，但其 `signUp` 强制 OTP，无法承载纯账密注册，仅作云端移植预留。ASR/SMTP/诊断/逆地理/relay 等外部能力仍走 `VITE_CLOUD_FN_*` 承载层，未配置才回落 `/functions/v1/*`。

## What Didn't Work
- ❌ 用 `Taro.showActionSheet` 展示动态列表（如全部联系人）→ H5 与微信小程序都硬限 `itemList` 最多 6 项，超过直接 fail 且不弹任何东西；若 `fail` 回调只处理 cancel 就变成「点按钮毫无反应」→ 动态列表一律用自定义可滚动弹层（居中卡片，避开 tabBar 原生层级）
- ❌ Realtime 触发的 `fetchConversations()` 不带 force → 会复用在途请求（inflightFetch），复用的可能是「消息发出之前」发起的旧请求，事件到了列表却拿旧结果 → Realtime 路径必须 `fetchConversations(true)`
- ❌ chat 页 Realtime 回调里同步调 `markAsRead` → 这是一次 200-500ms 的 PostgREST UPDATE，阻塞同批后续事件处理 → 改 500ms 防抖 + `void` 不等待，连续多条消息只发一次已读请求
- ❌ `receiveMessage` 每条消息一次 `set` → 连发时聊天页全量重渲染风暴 → 100ms 合并窗口批量提交
- ❌ 在 Realtime UPDATE 回调里无条件同步 `payload.new` 的 read_at → 本端自己 markAsRead 触发的 UPDATE 被推回形成回环，把「我发的消息」污染成已读双勾 → UPDATE 回调只同步对方发来的消息
- ❌ 补拉「待回复暗号」用 `.order('created_at', ascending: true).limit(200)` → 升序+limit 取到的是最早的 200 条，活跃会话里最新的 where 永远取不到 → 必须 descending 取最新再反转回升序
- ❌ 离线补发基线取消息数组末项的 created_at → temp- 乐观占位行是本机时钟拼的，设备时钟领先会漏掉对方随后发的消息 → 基线必须取「最后一条真实消息行」的 created_at

## Lessons
- 日志统一 `src/lib/logger.ts`（logDbg/logWarn/logErr），生产构建静默 logDbg；新增代码禁止裸 console.log
- messages.content_type 是裸 TEXT 列、无 DB CHECK，写入必须过 `assertMessageType` 闸门，非法值抛错而非静默落库
- Realtime 订阅受 RLS 过滤：过渡态（bootstrapped=true）无 access token，此时建立的订阅会被当匿名挡掉——需要真实登录态的订阅必须门控 `user && !bootstrapped`
- 微信端 Realtime WebSocket 会被基础库回收（`closeSocket:fail wcwss taskID not exist`），`src/lib/realtime-socket-patch.ts` 在模块顶层包装已存在的 realtime 实例的 disconnect/_sendHeartbeat/connect 三条 close 出口；包装 `_initRealtimeClient` 无效（createClient 在模块加载时已执行完）
- ❌ 撤回倒计时 60s 定时器无条件 setState → 4200 行页面每次全量重渲染 → 改为「仅当存在 2 分钟内未读可撤回消息时才 tick」，无候选时定时器空转不触发渲染
- ❌ Realtime UPDATE 回执逐条 setState → 对方批量已读 50 条 = 50 次全量 map 遍历重渲染 → 150ms 窗口 Map 合并（后到覆盖先到）批量提交
- ❌ receiveMessage 里每条消息同步 setStorageSync 写缓存 → 同步 IO 每次序列化+磁盘写 5-20ms，连发时阻塞主线程 → 缓存写入移入 100ms 合并窗口，只写一次
- ❌ 图片消息 Image 不加 lazy-load → 长会话几百个 Image 同时挂载并发请求 → 加 `lazy-load` 属性
- 延迟量化日志是排查消息实时性的关键：chat 页与 app.tsx 全局订阅都打印「服务端 created_at → 本机收到」的毫秒差，先看日志确认延迟发生在推送层还是渲染层，再对症下药
