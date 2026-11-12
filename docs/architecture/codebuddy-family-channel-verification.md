# CodeBuddy / WorkBuddy 渠道校验（code 11128）实测结论

> 实测日期：2026-10-21 ｜ 客户端：官方 CodeBuddy Code CLI `2.161.4`（Bun 1.4.2 打包单文件）
> 账号：本机两个 workbuddy OAuth 账号（`acct_cb6a07c689c8d46432e6` / `acct_eb98859a3976214292ea`）
> 上游：`https://www.workbuddy.ai/v2/chat/completions`（APISIX/3.12.0）

## 一、事故现象

relay 家族模型时上游回：

```json
{"code":11128,"msg":"request illegal",
 "displayMsg":{"zh":"请求被拦截，请重新发送"},
 "displayTips":{"zh":"这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。"}}
```

同一时段还有大量 `401 {"message":"invalid_format"}`（APISIX 请求格式拒绝），两者都不是账号问题。

## 二、结论：只校验三个会话头

**缺 `X-Conversation-ID`、`X-Conversation-Message-ID`、`X-Conversation-Request-ID`
任一个，或任一为空，上游就返回 11128。三者齐备且非空则一律通过。**

值的格式不校验：`x` / `y` / `z` 这样任意非空短串也放行。

### 不参与校验的项（逐项删除实测，全部 200）

| 项 | 结果 |
|---|---|
| `User-Agent`（含删掉整个头） | 不影响 |
| `x-codebuddy-request: 1` | 不影响 |
| `x-requested-with` | 不影响 |
| `X-Product: SaaS`、`X-Domain` | 不影响 |
| `X-IDE-Type/Name/Version` 全套 | 不影响 |
| `X-Agent-Purpose/Intent/Type` | 不影响 |
| `X-User-Id` | 不影响 |
| `x-stainless-*` 全套 | 不影响 |
| `baggage` / `traceparent` / `b3` / `X-B3-*` / `X-Trace-ID` | 不影响 |
| `Accept`、`X-Private-Data` | 不影响 |
| 请求体形状（有无 tools / reasoning_effort / verbosity / temperature / stream_options） | 不影响 |
| TLS 栈（Node 与 Bun 分别发） | 不影响 |
| 出口 IP（本机经本地 Node 转发代理） | 不影响 |

### 判定为必需（删除即 11128）

| 头 | 说明 |
|---|---|
| `X-Conversation-ID` | 会话级，官方同一会话复用同一个值（UUIDv7，时间有序） |
| `X-Conversation-Message-ID` | 消息级，每条消息新建 |
| `X-Conversation-Request-ID` | 请求级，每次请求新建 |

`X-Request-ID` 与 `X-Root-Request-ID` **不是**必需项（单删仍 200）。

## 三、关键对照实验

1. 官方 CLI 直接打真上游 → `PONG`（200）。
2. 官方 CLI 经本机 Node 写的转发代理打同一个上游 → `200`。
   → 传输栈、出口 IP 都不是因素。
3. 把捕获的官方 rawHeaders（保序）+ 原 body 用我们自己的 `https` 客户端重放 → `200`。
   → 校验完全在应用层请求内容上。
4. 从该 200 基线逐项删头 → 只有删会话三件套会掉回 11128。
5. 用我们自己的最小头 + 会话三件套 + 我们的最小 body（system + user，无 tools）→ 两个账号都 `200`。

## 四、已落地的修复

- Node `lib/account/codebuddy-family-inference.js`
  - 新增 `buildCodebuddyFamilyConversationHeaders` / `createCodebuddyFamilyConversationId`；
  - `buildCodebuddyFamilyUpstreamHeaders` 始终携带会话三件套；
  - `conversationId` 由客户端会话键 sha256 派生（同一会话稳定、不把客户端会话 ID 原样外发）；
  - `parseCodebuddyFamilyError` 对「11128 + request illegal」撤销 retryable。
- Node `lib/server/upstream-endpoints-transport-general.js`
  - 调用点传入 `requestMeta.sessionId || sessionKey`；
  - 家族分支判定改为忽略 query（原先带 query 时整段适配被跳过）。
- Go `internal/transport/http/codebuddyfamilyrelay/`
  - `DecorateUpstream` 补会话三件套（毫秒时间戳 12 位十六进制 + 随机后缀）；
  - 导出 `ConversationHeaders` / `Conversation*Header` 常量与 Node 同名同语义。
- Go `internal/adapters/codebuddyfamily/upstreamfailure/observer.go`
  - 渠道校验失败撤销 `Retryable`，避免每个请求烧 4 个账号并给整个家族模型池挂冷却。

## 五、家族模型在 harness 里的路由策略（实测）

**结论：走 HTTP relay，不走 cli 也不走 desktop。** `relay.transport = 'http'`，
`clientDependent = false`；`client-cli` 只是契约词汇（全仓零实现），desktop 通道
（`lib/server/desktop-launch/`）只负责按账号起隔离的 App 实例，与推理无关。

家族推理有**两条独立实现**，两条都必须带会话三件套：

| 路径 | 实现 | 入口 | 何时承接 |
|---|---|---|---|
| Node | `lib/server/upstream-endpoints-transport-general.js` + `codebuddy-family-inference.js` | `/v1/chat/completions`、`/v1/responses`、`/v1/messages` | 交还 Node 的所有情形 |
| Go | `internal/transport/http/codebuddyfamilyrelay/` | 挂载在 `/v1/chat/completions` | 满足转发判定的 chat completions 请求 |

交还 Node 的判定见 `lib/server/go-core-route-deferral.js`。与家族直接相关的一条：
**池里存在 Go 服务不了的 Provider 时，只有「该模型的承载者全为 relay 通道」才继续给 Go**
（`pool_model_carriers_unknown`）。本机池里混有 opencode 等账户，因此家族请求日常由 Node 承接；
实测 `streamTransport = codebuddy_family_sse_aggregated`，Go Core 日志零命中。

2026-10-21 实测（改后、两侧均为新代码）：

```text
网关 9527（Node 路径）  acct_cb6a07c689c8d46432e6 / acct_eb98859a3976214292ea / acct_229f9ffa9b05e70467dd → 200 OK
Go Core 19550（直连）    acct_cb6a07c689c8d46432e6 / acct_eb98859a3976214292ea                        → 200 OK
流式与非流式（Node 侧聚合上游 SSE）两条路径均 200
```

跨语言一致性由 `test/codebuddy-family-channel-header-parity.test.js` 守卫：两侧头名集合、
必需项、是否真的写进上游请求三件事都钉住（已用「注入改名」反向验证守卫会变红）。

## 六、官方客户端画像复刻（2026-10-21 抓包）

官方 CodeBuddy Code CLI 2.161.4（Bun 打包，底层 OpenAI SDK）在
`POST {site}/v2/chat/completions` 上共发 **35 个**头（不含 Authorization / Content-Length /
Host / Connection）。**本端现在逐项对齐，零差异**（`test/codebuddy-family-channel-header-parity.test.js`
与 Go `TestOfficialClientPictureIsComplete` 两侧都钉住）。

关键形状（照抄，不是猜）：

| 项 | 官方取值 |
|---|---|
| `User-Agent` / `X-IDE-Version` | `CLI/2.161.4 CodeBuddy/2.161.4`（本端**探测本机安装版本**，不写死） |
| 全部 ID（Conversation / Message / Request / Root） | UUIDv7：`01a15ede-5927-7289-86f7-0648bbaa2d32` |
| `X-Conversation-Message-ID` 与 `X-Request-ID` | **同值** |
| `X-Conversation-Request-ID` 与 `X-Root-Request-ID` | **同值** |
| `X-Domain` | 站点根域名（`www.workbuddy.ai`），**不是** origin |
| `X-Product` / `X-IDE-Type` / `X-IDE-Name` | `SaaS` / `CLI` / `CLI` |
| `X-Agent-Purpose` / `Intent` / `Type` | `conversation` / `craft` / `main` |
| `X-Private-Data` / `x-codebuddy-request` | `false` / `1` |
| `x-stainless-*` | `arm64` / `js` / `MacOS` / `6.25.0` / `0` / `node` / `v26.3.0` |
| trace 家族 | `traceparent` + `b3` + `X-B3-*` + `X-Trace-ID`（同一 traceId） |
| `baggage` | `codebuddy.session_id=<conv>,codebuddy.conversation_request_id=<req>` |
| `X-User-Id` | 账号 uid（= token 的 `sub`） |

**官方 CLI 身份不发 `Origin` / `Referer`** —— 这两个是浏览器语义头，只有桌面/VSCode 身份才带。
本端此前补发它们，是一处与官方不符的差异，现已移除。

本端另外**不再向家族上游发内部标识** `x-aih-account-ref` / `x-aih-account-email`：它们没有任何
上游消费方，留在请求里等于自报「不是官方客户端」；账号归属由响应头 `x-aih-server-account-ref`
与日志承担。

以上这些项实测都**不参与**渠道校验（删掉仍 200），复刻它们是为了让请求画像与官方一致。

## 七、本端相对官方的剩余差异

头画像已逐项对齐（35/35，见第六节）。剩下的差异只有两类：

| 差异 | 说明 | 影响 |
|---|---|---|
| 请求体 | 官方发 `tools`（22 个内置工具）、`temperature`、`max_tokens`、`stream_options`、`reasoning_effort`、`verbosity`、`reasoning_summary`；本端只透传客户端给的字段 + 补 system | 实测不影响渠道校验；本端是**网关**，工具集由下游客户端决定，不能替它伪造官方工具表 |
| 出口 IP / 网络 | 官方从用户本机直连；本端可能经代理或云主机出口 | 实测不影响渠道校验；若上游将来把风控前移到 IP 画像，需要另做（住宅出口） |

此前「我们多发 `x-aih-account-ref` / `x-aih-account-email`」这条已消除：家族上游不再收到它们。

## 八、复现方法（不必再猜）

```bash
# 1. 本地起一个转发代理，记录 rawHeaders 与 body
node /tmp/cbcap/proxy.js https://www.workbuddy.ai 8899

# 2. 让官方 CLI 打这个代理（base 要带 /v2，CLI 自己拼 /chat/completions）
CODEBUDDY_AUTH_TOKEN=<token> CODEBUDDY_BASE_URL=http://127.0.0.1:8899/v2 \
  codebuddy -p "reply with exactly: PONG" --model deepseek-v4.1-flash

# 3. 用捕获的 rawHeaders 原样重放，再逐项删除二分
```

> 注意：`CODEBUDDY_BASE_URL` 不含 `/v2` 时 CLI 会打 `/chat/completions`，上游回 405 nginx。
