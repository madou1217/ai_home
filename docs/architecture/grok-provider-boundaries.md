# Grok Provider 边界研究（Web / Console / Build / API）

状态：已研究（2026-08-19），结论已用于 `lib/server/accounts.js` 的 `grokBoundary` 标记

范围：grok 账号存在多个产品边界，各自使用不同的上游协议与计费账本。本文记录边界图谱、凭据指纹、实测证据与路由决策，作为后续接入 Web/Console 账号和排查 grok 出图问题的依据。

## 1. 为什么需要区分边界

grok 不是单一产品。xAI 把访问分成多个独立商业表面，**模型可用性与计费按表面跟随，不跨表面通用**。网关接入 grok 时，账号属于哪个边界决定它该走哪条上游协议——走错边界会出现「认证通过但无法使用」的假象（见 §3 实测）。

## 2. 边界图谱

| 边界 | 登录/凭据 | 认证指纹 | 图片/媒体能力 | 上游协议 | 计费账本 |
|---|---|---|---|---|---|
| **Grok Web** | grok.com 网页登录 | SSO cookie（非 OAuth2） | Imagine 生成+编辑、视频 | grok.com 协议（`/ws/mgw/` WebSocket + 会话事件流） | SuperGrok 订阅 / 每周共享池 |
| **Grok Console** | console.x.ai 登录 | SSO cookie | 图片+编辑+视频+TTS/STT+Realtime | grok.com 协议 | Console 订阅 / API 团队 |
| **Grok Build / CLI** | OAuth2 / Device OAuth | OIDC token（client `b1a00492-073a-47ea-816f-4c329264a828`，scope 含 `grok-cli:access` `api:access`） | 客户端协议无图片；但 **OAuth2 token 可直调官方 API** | `api.x.ai/v1` REST（OpenAI 兼容） | 个人 team 的 API credits / Extra Usage Credits |
| **API Key** | console.x.ai API team | `xai-` Bearer key | 官方 images API（generations/edits/quality/resolution） | `api.x.ai/v1` REST | API 团队预付信用 |

关键点：

- **Grok Build 客户端协议不提供图片生成/编辑路由**（grok2api 源码明确：`Build currently exposes no image generation or image editing routes`）；但 Build 的 OAuth2 token 可以直调官方 API 出图（已实测认证通过）。
- 官方 API 文档模型名：`grok-imagine-image` / `grok-imagine-image-2.0`（pro）/ `grok-imagine-image-quality` / `grok-imagine-image-lite`；图片生成支持 `n`（≤10）、`quality`（low/medium）、`aspect_ratio`、`resolution`（1K/2K）；图片编辑为同端点 image-to-image。
- grok.com 客户端图片输出 URL 域：`assets.grok.com`、`imagine-public.x.ai`、`imgen.x.ai`。

## 3. 实测证据（2026-08-19，本机两个 OAuth2 账号）

| 探针 | 结果 | 结论 |
|---|---|---|
| `POST api.x.ai/v1/images/generations`（Bearer OAuth2 token） | **403 `personal-team-blocked:spending-limit`**（认证通过，错误来自余额检查） | OAuth2 token 被官方 API 接受；缺 API credits |
| `POST grok.com/rest/media/imagine/quota_info`（cookie 形式 `sso=<token>`） | 401 Bad credentials | 裸 OAuth2 token 不是有效 SSO cookie |
| `POST grok.com/rest/media/imagine/quota_info`（Bearer OAuth2 token） | **403 `unauthorized:oauth2-auth-forbidden` — "Action cannot be performed by OAuth2 token users"** | **grok.com Web 边界拒绝 OAuth2 token**——Web 边界需要网页登录的 SSO 凭据 |
| 真实 OAuth 刷新（`auth.x.ai/oauth2/token`） | 两账号均 `refreshed:true`，token 轮换并持久化 | 账号健康；OIDC client 与 grok2api 的 SSO client 相同（`b1a00492-...`），同族凭据 |

结论：**本机账号 = Grok Build/CLI 边界（OAuth2）**。正确路线就是官方 `api.x.ai` REST API；`spending-limit` 是账号无 API credits（需在 grok.com 充值 Extra Usage Credits 或升级 SuperGrok），不是路线错误、不是账号掉线、不是认证失效。

## 4. 网关路由决策

当前 `lib/server/accounts.js` `loadGrokServerAccounts` 为每个 grok 账号打上 `grokBoundary` 标记：

- `api-key`（有 `XAI_API_KEY`）→ 走 passthrough（官方 API 用 key）
- `oauth2-cli`（OAuth2/Device OAuth）→ 走 `lib/server/image-generation-grok.js` 原生策略（官方 API 用 OAuth token，模型映射 `grok-imagine-*`）

未来接入 Web/Console SSO 账号时：新标记值 `sso-web` / `sso-console`，路由到 grok.com 协议策略（WebSocket + SSO cookie 构建 + CF 租约 + 会话事件流 + Imagine 配额探测），实现可参考 grok2api 的 `gateway.go` / `sso_build.go` / `image.go` / `quota.go`（Go 实现，约 3000 行；Node 侧预计 800-1500 行，可复用 codex 策略的 SSE/事件流解析经验）。

## 5. 参考来源

- grok2api（Go 网关，逆向 grok.com 客户端协议）：https://github.com/chenyme/grok2api （clone 备份在 `/tmp/grok2api`，含完整 Web 协议实现与模型 catalog）
- xAI 官方文档：https://docs.x.ai/developers/model-capabilities/images/generation （官方 images API 契约）
- xAI FAQ / 定价：https://docs.x.ai/grok/faq （June 2026 起共享每周用量池；Web 订阅与 API credits 独立账本）
- 本机 DB：`~/.ai_home/app-state.db` 的 `account_credentials.native_auth_json`（grok 账号凭据结构）