# codex 登录切片方案（2026-11-06 调研）

> 只读调研结论，未改代码。目标：Node 保留浏览器/loopback，Go 承接 token 交换与落库。

## 1. 现状步骤链（全在 Node）

`POST /v0/webui/accounts/add` → `startOauthJob`(web-account-auth.js:1234) → `startNativeOauthJob`(:863)
→ PKCE/state/authorize URL(:869-878) → `attachManualCallbackLoopback`(:805, localhost:1455)
→ loopback 收 code(:841) → `completeBrowserOauthCallback`(:1622) → 策略(native-oauth.js:24)
→ `exchangeManualCallbackCodexCode`(:511; POST :525-548) → `buildCodexAuthJsonFromTokenResponse`(oauth-urls.js:158)
→ 写 runtimeDir/auth.json(:551) → `finalizeJob`(:376) → `registerProviderAuthProjection`(native-auth-projection.js:508)
→ 事件（web-ui-router.js:634 / :435）

Go 侧同一条链已完整实现（尽管 Node 从不调用）：
`Start`(service.go:118) → `Begin`(provider.go:91)；`Complete`(service.go:271) → `parseCallback`(callback.go:14)
→ `exchangeTokens`(flow.go:87) → `decodeCodex`(decoder.go:141) → 注册(service.go:321)；端点 handler.go:143/239。

## 2. 边界

| 留在 Node | 可搬 Go（Go 已有实现） |
| --- | --- |
| loopback 监听（1455）、打开浏览器、手填回调兜底 | token 交换、JWT 取 account_id |
| job 进度/日志/取消、SSE、账号页交互 | auth.json 构造/解码、注册落库 |

注意：Begin 虽是纯 HTTP，但 **state/PKCE 必须与 Exchange 同进程**——Begin 不能单独搬走。

## 3. Go 的完成度与缺口

可用：Begin 完整（S256 / 64B verifier / 32B state / 官方参数）；Exchange 校验完整（scheme/host/path、
白名单键、单值、constant-time state、error 参数；4xx→provider_rejected、5xx→provider_unavailable）。

缺口（切流前必须逐条处理）：

1. `originator`：Node 用 `Codex Desktop`（oauth-urls.js:47），Go 侧未对齐 → **需真机确认上游取值**；
2. redirect 端口固定 1455（与 Node 一致，暂无问题）；
3. Go 强制要求 `id_token`，Node 只要求 access+refresh → 需放宽或确认上游必返；
4. 回调响应缺 email/planType/displayName（账号页首帧会缺字段）；
5. 重复 `Complete` 返回 `job_not_pending`，需要幂等映射（网络重试场景）；
6. Begin/Exchange/callback **零单测**（只有 refresh_test.go）。

## 4. 最小切片（M）

只对 **codex + oauth-browser** 开，旧路径保留：

1. Node 调 `POST /v1/management/account-auth-jobs` 取 `job_id + authorization_url`，存 goJobId；
2. loopback 收到回调后 `POST /v1/management/account-auth-jobs/{job_id}/callback`，body `{"callback":"<完整 URL>"}`；
   Node 不做本地 state 校验（Go 权威）；
3. 用 Go 返回的 `account_ref/cli_account_id` 收尾，并**主动触发一次** go-account-sync reconcile（不等 15s）再发既有事件。

## 5. 验收

- Go：httptest 表驱动（好回调 / 坏 state / 坏 redirect / 上游 4xx / 5xx / 重复回调 / 缺 id_token）；
- Node：假 Go client 跑状态机；
- 真机：一次登录 → `aih.db` 的 accounts + account_credentials 有行、账号页出现、**二次登录不新增账号**。

## 6. 风险

- `originator` 差异可能影响上游返回的套餐/权益 → 切流前先统一并真机验证一次；
- Go 的 Complete 同步等 token+注册（oauth client 10s 超时，composition.go:88）：Node 转发超时必须 >10s，
  否则 Go 已 claim 而失败，且 `job_not_pending` 不可重试；
- Go 注册完成到 Node adoption 之间账号页查不到账号 → 切片必须包含「主动 reconcile」。
