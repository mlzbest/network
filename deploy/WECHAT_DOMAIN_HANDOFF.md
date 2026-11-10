# 小程序服务器域名配置 · 服务商操作单

> **执行方**：持有本小程序「开发权限集（ID 18）」授权的第三方平台服务商
> **需求方**：小程序 `wx24a39e0a660ee585`
> **方式**：方式二 / `modify_domain_directly`（快速配置小程序服务器域名）
> **生成时间**：北京时间 2026-11-10
> 本文档自包含，无需阅读需求方仓库中的其它文档。

---

## 1. 请求背景

该小程序已把「开发权限集 18」授权给贵方代开发。依据微信官方
《代开发的小程序域名配置说明》，此类小程序**不能在微信公众平台后台自行配置
服务器域名**，只能由服务商通过开放平台接口配置。

本次把**同一个域名追加到三个域名分类**（request / uploadFile / downloadFile），
全部使用 `action=add` 追加，不改动该小程序已有的其它域名配置。
socket / udp / tcp 三类无需配置——本项目 selfhost 后端不使用 WebSocket。

## 2. 本次配置值

| 项 | 值 |
| --- | --- |
| 小程序 AppID | `wx24a39e0a660ee585` |
| 接口 | `POST https://api.weixin.qq.com/wxa/modify_domain_directly` |
| 操作 | `action=add`（**追加**；严禁使用 `set` 覆盖） |
| 目标域名 | `https://api.maolizheng.xyz` |
| 需追加到的分类 | `requestdomain`、`uploaddomain`、`downloaddomain`（**三类都要**） |
| 其余三类 | `wsrequestdomain` / `udpdomain` / `tcpdomain` 传空数组 `[]` |

**为什么是三类**（依据微信官方《网络》文档与需求方代码）：

| 分类 | 对应 API / 组件 | 需求方依据 |
| --- | --- | --- |
| `requestdomain` | `wx.request` | `selfhost-client.ts` 的 `shFetch` 用 `Taro.request`，承载登录、数据、RPC 与 base64 上传 |
| `uploaddomain` | `wx.uploadFile` | **预留**：当前上传走 `Taro.request` + base64，未用 uploadFile；一并配置可避免日后再次消耗每月配额 |
| `downloaddomain` | `wx.downloadFile`、网络图片 | `src/lib/file-message.ts` 与 `src/pages/profile/index.tsx` 明确调用 `Taro.downloadFile`；官方《网络》文档把「https 图片无法加载」归入同一套域名/证书检查流程 |

后端把业务 API 与对象存储放在**同一个域名**下
（`PUBLIC_BASE_URL=https://api.maolizheng.xyz`，未配置 `R2_PUBLIC_URL` 直出），
因此三类填的是同一个值。若漏配 `downloaddomain`，头像、图片消息与文件预览在
正式版将全部失败——开发者工具勾选「不校验合法域名」时不会暴露该问题。

域名写法必须严格为 `https://api.maolizheng.xyz`：带 `https://` 前缀、
**不带端口**（连 `:443` 也不能带）、不带路径、不是 IP、不是父域名。

需求方侧端点当前已就绪：`https://api.maolizheng.xyz` 已绑定 Cloudflare
Workers Custom Domain，实测 HTTPS `200`、证书由受信 CA 签发、SAN 明确包含
该主机名、TLS 1.2 / 1.3 可用。

> 说明：当前线上是**引导占位 Worker**（`/__worker/health` 返回 200，
> `/api/health` 返回 503 `BACKEND_NOT_DEPLOYED`），正式业务 Worker 待数据库
> 就绪后覆盖部署。域名配置动作与后端正式上线互不影响，可以先行完成。

## 3. 前置条件（请贵方确认）

1. **权限集 18** 已授权给贵方第三方平台，且未被其它服务商占用（该权限集互斥，
   否则返回 `61007 api is unauthorized to component`）。
2. `maolizheng.xyz` **已完成 ICP 备案**且状态有效。第三方托管不是备案豁免；
   未备案时方式二返回 `45082 need icp license for the url domain`。
3. 贵方能生成该小程序的 **`authorizer_access_token`**（短期凭证）：用贵方
   `component_appid` / `component_secret` / `authorizer_refresh_token` 换取，
   见官方 [获取授权方令牌](https://developers.weixin.qq.com/doc/oplatform/openApi/ticket-token/api_getauthorizeraccesstoken)。
   **请勿把 token 发给需求方、贴进聊天或写入日志**；仅在贵方服务器环境变量中使用。

需求方仓库内没有 `component_appid` / `component_secret` /
`authorizer_refresh_token`，因此无法代为调用，需由贵方执行。

## 4. 三步操作（可直接复制；均需在服务器端调用，不可前端调用）

```bash
export WX_TOKEN='<贵方生成的 authorizer_access_token>'

# 步骤 1 · 读取当前配置（官方要求 add 前先 get，避免重复添加）
curl -sS -X POST "https://api.weixin.qq.com/wxa/modify_domain_directly?access_token=$WX_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"get"}'
# 检查返回的 requestdomain / uploaddomain / downloaddomain 三类：
#   三类都已含目标域名 → 跳过步骤 2，直接做步骤 3
#   只含部分分类       → 步骤 2 请求体中把已存在的分类改为 []，只 add 缺失的

# 步骤 2 · 追加域名到三类（action=add，不是 set）
curl -sS -X POST "https://api.weixin.qq.com/wxa/modify_domain_directly?access_token=$WX_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"add","requestdomain":["https://api.maolizheng.xyz"],"wsrequestdomain":[],"uploaddomain":["https://api.maolizheng.xyz"],"downloaddomain":["https://api.maolizheng.xyz"],"udpdomain":[],"tcpdomain":[]}'

# 步骤 3 · 查询「发布后真正生效」的域名列表（POST body 不能为空，必须传 {}）
curl -sS -X POST "https://api.weixin.qq.com/wxa/get_effective_domain?access_token=$WX_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

**更推荐用需求方仓库的零依赖脚本**：它会先 `get`、逐类比对，**只追加缺失的分类**，
可安全重复执行（默认 dry-run，凭证只从环境变量读取、不回显）：

```bash
WX_AUTHORIZER_ACCESS_TOKEN="$WX_TOKEN" node deploy/wechat-domain.mjs            # 空跑确认请求体
WX_AUTHORIZER_ACCESS_TOKEN="$WX_TOKEN" node deploy/wechat-domain.mjs --apply     # 提交 add（三类）
WX_AUTHORIZER_ACCESS_TOKEN="$WX_TOKEN" node deploy/wechat-domain.mjs --effective # 查生效域名
```

若贵方已按**旧版操作单**只配置了 `requestdomain`，无需手工构造请求体，直接再跑一次
`--apply` 即可自动补上 `uploaddomain` / `downloaddomain`。
仅需 request 分类时可用 `--scope request`（兼容旧行为）。

## 5. 成功判据

1. 步骤 2 返回 `{"errcode":0,"errmsg":"ok"}`；
2. 步骤 3 的 `direct_domain` 中 **`requestdomain`、`uploaddomain`、
   `downloaddomain` 三类都包含** `https://api.maolizheng.xyz`；
3. **方式二配置的域名需发布上线后才真正生效**：发布后
   `effective_domain` 的三类同样都应包含该域名。发布前请务必先看
   `effective_domain`，确认无误再发布代码。

`mp_domain`（公众平台）、`third_domain`（方式一）、`direct_domain`（方式二）
是三个不同来源，只有 `effective_domain` 代表线上实际生效结果。

## 6. 常见错误码（微信官方）

| errcode | 含义 | 处理 |
| --- | --- | --- |
| `45082` | 域名未完成 ICP 备案 | 先完成 `maolizheng.xyz` 备案；托管不豁免 |
| `61007` | 权限集 18 未授权 / 已被另一家服务商占用 | 确认授权关系（互斥，只能一家） |
| `40001` / `40014` / `42001` | token 无效或过期 | 重新换取 `authorizer_access_token` |
| `44002` | POST body 为空 | `get_effective_domain` 也要传 `{}` |
| `85015` | 该账号不是小程序账号 | 核对 authorizer 对应的 AppID |
| `85016` | 域名数量超限（每类最多 200） | 清理无用域名 |
| `86100` | URL 协议头有误 | 必须 `https://` |
| `86101` | 不支持配置 `api.weixin.qq.com` | 更换域名 |
| `86102` | 每月修改次数超过 50 次 | 等下月或一次性配好 |
| `85017` / `85018` / `85301`–`85303` | **方式一**才会出现：域名未登记到第三方平台 / 格式或备案问题 | 本次用方式二，一般不出现 |

方式一 `modify_domain` 另有 `no_icp_domain` / `invalid_requestdomain` 字段，
可能在 `errcode=0` 时返回「伪成功」，需一并检查；方式二返回体只有
`errcode` / `errmsg`。

## 7. 必须遵守的注意事项

- **三类域名分类必须都配**：只配 `requestdomain` 时，`wx.downloadFile` 与
  网络图片在正式版会被拦截；开发者工具勾选「不校验合法域名」或手机调试模式
  不会暴露该问题，容易误判为「已配好」。
- `wsrequestdomain` / `udpdomain` / `tcpdomain` 保持为空，本项目 selfhost
  后端不使用 WebSocket / UDP / TCP socket。
- **每月域名修改上限 50 次**，一次配好即可。
- 官方明确：之前通过该 API 配置且**已上线成功**的旧域名不要重新 `set`，
  否则需要重新发布才生效；新增只用 `add`。
- **不要混用**公众平台后台 / 方式一 `modify_domain` / 方式二
  `modify_domain_directly` 为同一小程序配置域名。
- 方式二**不需要**先把域名登记到第三方平台的「小程序服务器域名」白名单；
  这是选它的主要原因。
- `action=set` 会**覆盖**已有全部域名配置，本次严禁使用。
- 配置完成后仍需**发布上线**才生效。

## 8. 若贵方只支持方式一（备选）

先由贵方用 `component_access_token` 调
`cgi-bin/component/modify_wxa_server_domain` 把 `api.maolizheng.xyz`
登记到第三方平台「小程序服务器域名」，再调
`POST /wxa/modify_domain` 执行 `action=add`。

⚠️ 方式一的风险（官方原文）：小程序通过第三方平台发布代码上线后，
**小程序原先自己配置的服务器域名会被删除，只保留第三方平台登记的域名**。
若漏登记或发布前从平台删除，线上域名会失效。发布前务必用
`get_effective_domain` 核对 `effective_domain`。

## 9. 完成后请回传

请把**步骤 1 / 2 / 3 的原始 JSON 响应**回传需求方（token 请脱敏），
以便确认配置成功与发布后生效状态。若返回任何非 0 的 `errcode`，
请连同 `errmsg` 一并回传。

## 10. 官方文档索引

- [快速配置小程序服务器域名（方式二）](https://developers.weixin.qq.com/doc/oplatform/openApi/miniprogram-management/domain-management/api_modifyserverdomaindirectly.html)
- [配置小程序服务器域名（方式一）](https://developers.weixin.qq.com/doc/oplatform/openApi/miniprogram-management/domain-management/api_modifyserverdomain.html)
- [获取发布后生效服务器域名列表](https://developers.weixin.qq.com/doc/oplatform/openApi/miniprogram-management/domain-management/api_geteffectiveserverdomain.html)
- [代开发的小程序域名配置说明](https://developers.weixin.qq.com/doc/oplatform/Third-party_Platforms/2.0/product/domain.html)
- [小程序网络使用说明](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)
