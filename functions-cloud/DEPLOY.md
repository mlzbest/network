# 承载层部署操作手册

> Task #10：把 4 个 TCB 函数 + 1 个 Cloudflare Worker 真正部署到云上，前端填入真实 URL 后可真机验收。
> 源码与配置已就绪（`providers/*`），本手册只讲「怎么把密钥填进去 + 怎么跑部署 + 怎么验」。

## 〇、部署前置清单（先备齐再跑脚本）

| 项 | 来源 | 注入位置 | 必需？ |
|----|------|---------|--------|
| `WX_CLOUD_ENDPOINT` / `WX_CLOUD_PUBLISHABLE_KEY` | WorkBuddy 后台（与前端 `VITE_CLOUD_ENDPOINT` 同值） | asr / smtp-recovery 的 tcb.json | smtp-recovery 必需（要反查 profiles）；asr 可选（asr 实际不读） |
| `BAIDU_API_KEY` / `BAIDU_SECRET_KEY` | 百度智能云控制台（短语音识别 server_api） | asr tcb.json | 走百度通道时必需 |
| `ASR_BASE_URL` / `ASR_API_KEY` / `ASR_MODEL` | 自建或第三方 OpenAI 兼容 ASR | asr tcb.json | 走 OpenAI 兼容通道时必需（与百度二选一） |
| `RECOVERY_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` / `RECOVERY_MAIL_FROM` | 自建 SMTP 或第三方邮件服务 | smtp-recovery tcb.json | 找回密码功能必需 |
| `AMAP_WEB_KEY` | 高德开放平台（Web 服务 Key） | reverse-geocode tcb.json | 逆地理功能必需 |
| `PROBE_17CE_TOKEN` | 17CE 云监测（可选增强源） | net-diagnose tcb.json | 可选（Globalping 免费） |
| `RELAY_WHITELIST` | JSON 数组字符串（relay 白名单 host） | ai-relay wrangler secret | 可选（未配走代码内置默认白名单） |

## 一、部署 4 个 TCB 函数

> **本节为 @cloudbase/cli 3.9.1 实测结论（2026-11）**，与旧版文档差异很大，务必按此执行。

### 1. 登录 TCB CLI
```bash
npx -y @cloudbase/cli login            # 设备码授权，输出扫码链接
npx -y @cloudbase/cli login --key      # 或 SecretId/SecretKey
```

### 2. 确认 TCB 实例 + 区域
```bash
npx -y @cloudbase/cli env list --json  # 拿 instanceId（形如 atomic-pigeon-xxx）
npx -y @cloudbase/cli env use <instanceId>
```
推荐区域：ap-shanghai / ap-guangzhou（境内延迟最优，契合微信/钉钉/抖音三端）。

### 3. 填密钥
把「前置清单」里的密钥写进各函数目录的 **`tcb.local.json`**（`cp asr/tcb.json asr/tcb.local.json`
后填写即可）。该文件已被 `.gitignore` 忽略；仓库中的 `tcb.json` 只是空值模板，部署脚本会优先读
`tcb.local.json`、不存在时才回退 `tcb.json`。**切勿把真实密钥提交到公开仓库。**
**`tcb fn deploy` 不会读 tcb.json** —— 部署脚本会用 `tcb api scf UpdateFunctionConfiguration`
把这些值单独写进云函数环境变量。

### 4. 部署
```bash
cd functions-cloud/providers
export TCB_ENV_ID=<instanceId>
bash deploy.sh tcb            # 4 个函数全上
bash deploy.sh tcb asr        # 只上 asr（渐进式切换用）
```

脚本对每个函数依次做：TS→CJS 编译 → `fn deploy --path /<name>` → 写环境变量。
单函数手工等价命令：
```bash
# Windows Git Bash 必须加 MSYS2_ARG_CONV_EXCL，否则 /asr 被转成 D:/... 路径
printf 'y\n' | MSYS2_ARG_CONV_EXCL='/asr' \
  npx -y @cloudbase/cli fn deploy asr \
    --force --dir ../deploy/asr --path /asr
```

### 5. 拿到 TCB 网关 URL

**没有「HTTP 触发器」也没有控制台里的「HTTP 访问服务」菜单**——新版控制台不显示，
公网 URL 由 `--path` 参数在部署时自动创建，格式固定：

```
https://<instanceId>.service.tcloudbase.com/<函数名>
```

例如本项目已上线：
```
https://atomic-pigeon-d1gas57l1df5397bb.service.tcloudbase.com/asr
```

4 个函数共用一个网关域，`VITE_CLOUD_FN_BASE_URL` 填的是**域名部分**（不含尾斜杠）：
```
VITE_CLOUD_FN_BASE_URL="https://atomic-pigeon-d1gas57l1df5397bb.service.tcloudbase.com"
```

### 6. 三个必踩的坑（实测）

| 坑 | 现象 | 解法 |
|----|------|------|
| 不带 `--path` | 函数是 `Type: Event`，**没有公网 URL**，控制台也看不到 HTTP 访问入口 | 必须 `--path /<name>` |
| 带了 `--httpFn` | 变成容器 Web function，要求 `scf_bootstrap` 启动文件 | **不要用**，这是另一条产品线 |
| 只传 `.ts` | 云函数运行时 Node 20 不认 TS | esbuild 编译成 CJS，且源码必须导出 `main`（默认 handler 是 `index.main`） |

验证通路（应返回业务错误而非 404）：
```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"audioUrl":"https://workbuddy.cn/storage/object/public/chat-media/x.m4a"}' \
  https://<instanceId>.service.tcloudbase.com/asr
# 期望：{"error":"音频地址不合法...","code":"BAD_AUDIO_URL","status":400}
```

### 7. 渐进式切换（只部署了部分函数时）

`VITE_CLOUD_FN_BASE_URL` 一旦填写，**5 类能力会一起切到 TCB**，未部署的函数会 404。
所以 4 个函数没全部上线前不要填它，保持注释即可自动回落旧 `supabaseUrl + /functions/v1/*`。
待全部部署完再一次性填域名，并跑第三节的验收对照表。

## 二、部署 1 个 Cloudflare Worker（ai-relay）

### 1. 登录 wrangler
```bash
npx -y wrangler login        # 浏览器授权
# 或 CI：export CLOUDFLARE_API_TOKEN=xxx
```

### 2. （可选）注入 relay 白名单
```bash
cd functions-cloud/providers/ai-relay
npx -y wrangler secret put RELAY_WHITELIST
# 粘贴 JSON 数组字符串，如 ["deepseek.com","moonshot.ai","openai.com"]
# 不注入也行——代码内置 DEFAULT_WHITELIST 兜底
```

### 3. 部署
```bash
cd functions-cloud/providers/ai-relay
npx -y wrangler deploy
# 部署后控制台会打印 Worker 公网 URL，形如：
#   https://ai-relay.<account>.workers.dev
```
**`VITE_CLOUD_FN_RELAY_URL` 填这个 URL（不含尾斜杠）**。

## 三、前端填入真实 URL

1. `.env`（H5/Web）：
   ```
   VITE_CLOUD_FN_BASE_URL="https://<region>.tcb.qcloudapi.com/cloudfunctions/prod-xxx"
   VITE_CLOUD_FN_RELAY_URL="https://ai-relay.<account>.workers.dev"
   ```
2. `.env.miniprogram`（微信/钉钉/抖音）：同值。
3. 构建 + 真机：
   ```bash
   pnpm build:weapp        # 微信
   pnpm build:dd          # 钉钉（Task #11 加）
   pnpm build:douyin      # 抖音（Task #11 加）
   ```

## 四、真机验收（5 类能力走承载层）

| 能力 | 操作 | 期望 |
|------|------|------|
| 1. ASR | 发一条语音 → 点「转文字」 | 出文字，控制台看请求打到 `<tcb-gateway>/asr` |
| 2. 找回密码 | 登录页「忘记密码」→ 输邮箱 → 收验证码 → 重置 | 邮箱收到验证码邮件，重置成功 |
| 3. 网络诊断 | 诊断页跑 9 项 | 每项出结果，console 看到 `<tcb-gateway>/net-diagnose` 命中 |
| 4. 逆地理 | 轨迹页定位点 | 地点名/地址回填，控制台 `<tcb-gateway>/reverse-geocode` |
| 5. relay | AI 聊天页配自定义模型（如 DeepSeek） | SSE 流正常，请求打到 `<relay-url>`（Workers） |

**回落验证**：注释掉 `.env` 里两行 `VITE_CLOUD_FN_*` → 重新 build → 5 类能力自动走旧
`supabaseUrl + /functions/v1/*` 网关（混合期兜底），证明回落契约有效。

## 五、回滚

- 承载层异常：把 `.env` / `.env.miniprogram` 的 `VITE_CLOUD_FN_*` 注释掉即可，零代码改动回落旧网关。
- 单个函数异常：`tcb fn log <name>` 看日志；`wrangler tail` 看 Worker 日志。

## 六、部署失败常见坑

| 现象 | 原因 | 解法 |
|------|------|------|
| `tcb fn deploy` 报 `no such env` | 没 `env use` 切到目标实例 | `tcb env use <instanceId>` |
| asr 返回 `ASR_NOT_CONFIGURED` | 百度/OpenAI 兼容两套密钥都没配 | 至少配一套（`BAIDU_*` 或 `ASR_*`） |
| smtp-recovery 返回 `DB_ERROR` | WorkBuddy SDK 在 TCB 跑不通 / `WX_CLOUD_*` 没配 | 确认 `WX_CLOUD_ENDPOINT` 在 TCB 可达；SDK 若拉不起，临时把发信改为不反查 profiles（直接按 email 发，校验通道在 cloudAuth 兜底） |
| reverse-geocode 返回 501 | `AMAP_WEB_KEY` 没配 | 高德开放平台申请 Web 服务 Key 填进 tcb.json |
| relay 400「地址不合法」 | 客户端 baseUrl 不在白名单 | 把目标域名加进 `RELAY_WHITELIST`（或代码 DEFAULT_WHITELIST） |
| Worker 部署报 `compatibility_date` 过期 | wrangler.toml 的 date 太旧 | 改成最近稳定日期（如 2026-01-01） |
