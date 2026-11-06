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

## Begin 半程验证（2026-11-06 22:52–22:56 CST）

> 只验 Begin：不打开浏览器、不完成授权、不消耗账号；未改 Go 代码。

### 命令链路

1. 开关：`app-state.db` 的 `config:server` 原本没有 `codexBrowserAuthViaGo`（缺省 false）。
   用 node:sqlite 备份原值后置为 true，其它键逐字节保留：
   ```
   原值 = <absent>；original sha256 = 3ba3255c58a5d7a490e36999fd9c8b3a81ec85b1e5c0ee38e76f8b45172f55ae
   ```
2. 重启网关（沿用原参数，`HOME=/Users/model`、`AIH_HOME_DIR=/Users/model/.ai_home`）：
   ```
   launchctl remove com.meadeo.aih-server
   launchctl submit -l com.meadeo.aih-server -o <server.log> -e <server.log> -- /bin/bash -lc      'export HOME=/Users/model AIH_HOME_DIR=/Users/model/.ai_home; cd <repo>;       exec node lib/cli/app.js server serve --host 0.0.0.0 --port 9527       --no-proxy localhost,127.0.0.1,0.0.0.0,192.168.31.57 --models-probe-accounts 8 --window-activation'
   ```
   `/healthz` 在 9s 内 200；`/readyz` 的 `go_core.state=ready`（pid 25253）。
3. Begin（管理密钥走 `Authorization: Bearer`）：
   ```
   POST /v0/webui/accounts/add
   {"provider":"codex","authMode":"oauth-browser"}

   200 {"ok":true,"status":"pending","jobId":"95128ca4-12bc-4400-9647-e1e59ca2549f",
        "authorizationUrl":"","callbackCaptureStatus":"starting"}
   ```
   1s 后 `GET /v0/webui/accounts/add/jobs/<nodeJobId>` 已带 `authorizationUrl`，
   `authProgressState=auth_url_ready`，job 日志出现 `Go OAuth Job 已创建：e6190a97…`。

### URL 关键参数对照（Go: internal/adapters/accountauth/codexoauth/provider.go）

| 参数 | Begin 实际值 | Go 常量/写法 | 结果 |
| --- | --- | --- | --- |
| authorize endpoint | `https://auth.openai.com/oauth/authorize` | 同值 | PASS |
| client_id | `app_EMoamEEZ73f0CkXaXp7hrann` | 同值 | PASS |
| redirect_uri | `http://localhost:1455/auth/callback` | 同值 | PASS |
| code_challenge_method | `S256` | 同值 | PASS |
| originator | `codex_cli_rs` | 同值 | PASS |
| state | 43 字符 base64url，解码 32B（`z0eUYQsj…`） | `GenerateState(random, 32)` | PASS |
| code_challenge | 43 字符 base64url | `GeneratePKCE(random, 64)` 的 S256 | PASS |

state 来源判定：Node 在 `useGoAuthJob` 分支把 `state` 置空（web-account-auth.js:1093），
Begin 响应初始 `authorizationUrl` 为空，URL 来自 Go 返回的 `authorization_url`；Node 侧没有生成
PKCE/state 的代码路径。另注：`originator=codex_cli_rs` 与 Go 一致，但仍是本文档 §3 风险 1 的
待统一项（Node 旧路径用 `Codex Desktop`），本次只验证未切换。

### Go job 是否落下

Node 没有 `/v1/management/account-auth-jobs` 中转路由，直接用 Go 子进程的 management key
直连 `127.0.0.1:<go-port>` 查询（不打印密钥）：

```
GET /v1/management/account-auth-jobs/e6190a97...
200 {"status":"pending","provider_id":"codex","created_at":"2026-11-06T14:53:01.876118Z",
     "expires_at":"2026-11-06T15:03:01.876118Z"}
```

job id `e6190a97…` 与 Node 日志中的 `_goAuthJobId` 一致，创建时间与 Node job 同一秒。

### 取消与 pending 释放

```
POST /v0/webui/accounts/add/jobs/95128ca4.../cancel
200 {"ok":true,"job":{"status":"cancelled","authProgressState":"cancelled"}}

GET go /v1/management/account-auth-jobs/e6190a97...
200 {"status":"cancelled","failure_code":"cancelled","finished_at":"2026-11-06T14:53:42.178428Z"}
```

随后立即第二次 Begin，未被 `active_job_exists` 拦截：

```
POST /v0/webui/accounts/add -> {"ok":true,"status":"pending","jobId":"ca64acc7-..."}
job 日志 -> Go OAuth Job 已创建：1f2eea15...
取消后 Go 查询 -> {"status":"cancelled","failure_code":"cancelled"}
```

### 复原确认

- 用备份原值写回 `config:server`，`restoredExactly=true`，sha256 回到
  `3ba3255c…f55ae`，`codexBrowserAuthViaGo` 键不存在（恢复缺省 false）；
- 原参数再次 `launchctl remove + submit`，`/healthz` 200（8s 内），`go_core.state=ready`；
- 只读探测旧路径：`GET /v0/webui/accounts` 200、32 个账号、codex 1 个；未发起任何新登录；
- 临时备份/脚本/响应文件已删除；未打开浏览器、未完成授权、未消耗账号、未改 Go 代码、
  未 `git add` / `git commit`。
