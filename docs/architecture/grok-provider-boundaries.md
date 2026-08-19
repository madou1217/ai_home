# Grok Provider 边界研究（Web / Console / Build / API Key）

状态：已研究（2026-08-19），结论已用于 `lib/server/accounts.js` 的 `grokBoundary` 标记

范围：grok 账号存在多个产品边界，各自使用不同的上游协议与计费账本。本文记录边界图谱、凭据指纹、实测证据与路由决策，作为后续接入 Web/Console 账号和排查 grok 出图问题的依据。

## 1. 四个边界是谁（先记住身份）

| 边界 | 它是谁 | 你怎么登录它 | 登录后拿到什么凭据 | 出图走哪条路 |
|---|---|---|---|---|
| **Web** | grok.com 网页/App——普通消费者聊天的界面 | 在 grok.com 用邮箱或 X 账号网页登录 | SSO cookie（浏览器会话） | grok.com 协议（WebSocket `/ws/mgw/` 会话事件流） |
| **Console** | console.x.ai 开发者控制台——管理 API key、团队、用量、账单的地方 | 在 console.x.ai 网页登录 | SSO cookie（浏览器会话） | grok.com 协议（同上，无状态模式） |
| **Build（= CLI）** | 编程/命令行构建平台——grok CLI 就是这个边界的客户端 | **Device OAuth**（CLI 打印链接/二维码，浏览器授权） | OIDC access token（client `b1a00492-073a-47ea-816f-4c329264a828`） | **官方 api.x.ai REST**（OpenAI 兼容） |
| **API Key** | 在 Console 里创建的一串密钥（`xai-` 开头），属于某个 API team | Console → API Keys 页面创建 | `xai-` 字符串密钥 | 官方 api.x.ai REST |

一句话区分：

- **Web 和 Console 都是"网页登录的浏览器会话"**（SSO cookie），两者走同一种 grok.com 协议。区别只在身份：Web 是消费者聊天界面，Console 是开发者管理界面。
- **Build 和 API Key 都是"程序化凭据"**（token / key），两者都走官方 api.x.ai REST。区别只在认证：Build 用 OAuth2 登录的 token（记在个人账号上），API Key 用控制台生成的密钥（记在 API team 上）。
- **CLI ≠ Web**：CLI 用 Device OAuth 拿 OIDC token（Build 边界）；网页登录拿 SSO cookie（Web 边界）。两种凭据不能互换——见 §3 实测。

## 2. 边界图谱（详细）

| 边界 | 登录/凭据 | 认证指纹 | 图片/媒体能力 | 上游协议 | 计费账本 |
|---|---|---|---|---|---|
| **Web** | grok.com 网页登录 | SSO cookie（非 OAuth2） | Imagine 生成+编辑、视频 | grok.com 协议（`/ws/mgw/` WebSocket + 会话事件流） | SuperGrok 订阅 / 每周共享池 |
| **Console** | console.x.ai 登录 | SSO cookie | 图片+编辑+视频+TTS/STT+Realtime | grok.com 协议（无状态 Responses/Chat/Messages） | Console 订阅 / API 团队 |
| **Build（CLI）** | Device OAuth（`aih grok login --oauth`） | OIDC token（client `b1a00492-...`，scope 含 `grok-cli:access` `api:access`） | 客户端协议无图片；**但 OAuth2 token 可直调官方 API 出图**（已实测认证通过） | `api.x.ai/v1` REST（OpenAI 兼容） | 个人 team 的 API credits / Extra Usage Credits |
| **API Key** | Console → API Keys 创建 | `xai-` Bearer key | 官方 images API（generations/edits/quality/resolution） | `api.x.ai/v1` REST | API 团队预付信用 |

补充事实：

- **Grok Build 客户端协议不提供图片生成/编辑路由**（grok2api 源码明确：`Build currently exposes no image generation or image editing routes`）；但 Build 的 OAuth2 token 直调官方 API 出图是可行的（已实测认证通过，仅受 credits 限制）。
- 官方 API 文档模型名：`grok-imagine-image` / `grok-imagine-image-2.0`（pro）/ `grok-imagine-image-quality` / `grok-imagine-image-lite`；图片生成支持 `n`（≤10）、`quality`（low/medium）、`aspect_ratio`、`resolution`（1K/2K）；图片编辑为同端点 image-to-image。
- grok.com 客户端图片输出 URL 域：`assets.grok.com`、`imagine-public.x.ai`、`imgen.x.ai`。

## 3. 实测证据（2026-08-19，本机两个 Build（CLI）账号）

| 探针 | 结果 | 结论 |
|---|---|---|
| `POST api.x.ai/v1/images/generations`（Bearer OIDC token） | **403 `personal-team-blocked:spending-limit`**（认证通过，错误来自余额检查） | OIDC token 被官方 API 接受；缺 API credits |
| `POST grok.com/rest/media/imagine/quota_info`（cookie 形式 `sso=<token>`） | 401 Bad credentials | 裸 OIDC token 不是有效 SSO cookie |
| `POST grok.com/rest/media/imagine/quota_info`（Bearer OIDC token） | **403 `unauthorized:oauth2-auth-forbidden` — "Action cannot be performed by OAuth2 token users"** | **grok.com Web/Console 边界拒绝 OIDC token**——SSO 边界需要网页登录的 cookie，与 Build（CLI）凭据不可互换 |
| 真实 OAuth 刷新（`auth.x.ai/oauth2/token`） | 两账号均 `refreshed:true`，token 轮换并持久化 | 账号健康；OIDC client 与 grok2api 的 SSO client 相同（`b1a00492-...`），同族授权服务器 |

结论：**本机账号 = Build（CLI）边界**。正确路线就是官方 `api.x.ai` REST API；`spending-limit` 是账号无 API credits（需在 grok.com 充值 Extra Usage Credits 或升级 SuperGrok），不是路线错误、不是账号掉线、不是认证失效。

## 4. 网关路由决策

当前 `lib/server/accounts.js` `loadGrokServerAccounts` 为每个 grok 账号打上 `grokBoundary` 标记：

- `api-key`（有 `XAI_API_KEY`）→ 走 passthrough（官方 API 用 key）
- `build-cli`（Device OAuth 登录的 OIDC token）→ 走 `lib/server/image-generation-grok.js` 原生策略（官方 API 用 OAuth token，模型映射 `grok-imagine-*`）

标记值与边界的对应：

| `grokBoundary` 值 | 对应边界 | 上游协议 |
|---|---|---|
| `api-key` | API Key | 官方 api.x.ai REST |
| `build-cli` | Build（CLI） | 官方 api.x.ai REST |
| `sso-web`（未来） | Web | grok.com 协议 |
| `sso-console`（未来） | Console | grok.com 协议 |

未来接入 Web/Console SSO 账号时：新增 `sso-web` / `sso-console` 标记，路由到 grok.com 协议策略（WebSocket + SSO cookie 构建 + CF 租约 + 会话事件流 + Imagine 配额探测），实现可参考 grok2api 的 `gateway.go` / `sso_build.go` / `image.go` / `quota.go`（Go 实现，约 3000 行；Node 侧预计 800-1500 行，可复用 codex 策略的 SSE/事件流解析经验）。

## 5. 参考来源

- grok2api（Go 网关，逆向 grok.com 客户端协议）：https://github.com/chenyme/grok2api （clone 备份在 `/tmp/grok2api`，含完整 Web 协议实现与模型 catalog）
- xAI 官方文档：https://docs.x.ai/developers/model-capabilities/images/generation （官方 images API 契约）
- xAI FAQ / 定价：https://docs.x.ai/grok/faq （June 2026 起共享每周用量池；Web 订阅与 API credits 独立账本）
- 本机 DB：`~/.ai_home/app-state.db` 的 `account_credentials.native_auth_json`（grok 账号凭据结构）