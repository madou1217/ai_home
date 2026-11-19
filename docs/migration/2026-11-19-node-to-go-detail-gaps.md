# Node → Go 细节缺口清单（2026-11-19）

触发：移除 `aih server serve` 的 Node 常驻入口后，逐项核对 Go 是否完整承接 Node 行为。
本清单只列**代码里能证明的缺口**：显式"留空/未接入/501/让走 Node"的标记，以及 serve 参数差异；不代表全量端点已完成对拍。

**单库原则：所有缺口只补进 aih.db，不新增第二个数据库。** 文中出现的 `state*.sqlite` 是 Codex CLI 自己的本地文件，不是 aih 的库，也不是要接入的存储；需要的会话元数据应落到 aih.db 的索引表。

## 已关闭

- `aih server serve` Node 常驻入口已切到 Go 适配器（`af264cf9`）。
- 会话元数据已物化到 aih.db：schema v32 新增 `session_index` / `session_index_state`；列表优先读索引，30 秒 TTL，扫描结果回填。**不读取、不新增 Codex 的 `state*.sqlite`。**

## 清单：Node 已不再回落，当前会直接失败

1. **会话列表非 codex provider**
   `internal/transport/http/webuisessionslistapi/handler.go:187`
   返回 501 `unsupported_provider`，文案仍写"请走 Node 网关"。Node 常驻网关已移除，该提示已失效。
2. **会话增量事件非 codex provider**
   `internal/transport/http/webuisessioneventsapi/handler.go:169-171`
   返回 501 `unsupported_provider`；注释仍写"由 Node 继续本地处理"。
3. **会话消息非支持 provider**
   `internal/transport/http/webuisessionmessagesapi/handler.go:77,155`
   返回 501 `unsupported_provider`。
4. **已关闭：Codex 会话元数据已落到 aih.db**
   `session_index` / `session_index_state` 由扫描结果回填；列表优先读 aih.db。仍未读取 Codex `state*.sqlite`（不引入第二库），非 codex provider 的会话读取仍未承接。
5. **账号新增/本机导入只承接部分模式**
   `internal/transport/http/webuiaccountaddapi/handler.go:270,457,621`
   Go 只承接 OAuth 登录与 Kiro refresh_token；其他 auth mode / 本机登录态来源返回 400/503。
6. **聊天附件仓库未接入**
   `internal/transport/http/webuichatapi/handler.go:268-270`
   明确返回 503 `chat_attachment_store_unavailable`，用户上传的附件不会被接收。
7. **聊天切片无会话存储**
   `internal/transport/http/webuichatapi/handler.go:256,275`
   模型必须由调用方显式给出；单连接内联流断线即取消上游，和 Node 的会话/轮次解耦语义不同。
8. **auth-job 进度字段缺失**
   `internal/transport/http/accountauthapi/jobs_watch.go:30-35`
   `callbackCaptureStatus` 恒留空，注释说明由 Node loopback 捕获合并；Node 仅作为按需宿主能力存在时需确认该合并仍在。

## 清单：接口能返回 200，但字段/诊断被留空

1. **账号行的调度规则为空**
   `internal/transport/http/webuiaccountsapi/row.go:37,234`
   `upstreamErrorRules` / `upstreamErrorGroupIds` 固定为空数组；WebUI 看不到账号已有的错误规则。
2. **tokenUsageSource 为空**
   `internal/transport/http/webuiaccountsapi/row.go:52`
   Node 的 `go` / `node` 诊断字段未承接。
3. **派生 status 留空**
   `internal/transport/http/webuiaccountsapi/row.go:20`
   Go 只回 `enabled`，Node 行原有 `status`（up/down）派生值缺失。
4. **启停接口只回最小账号视图**
   `internal/transport/http/webuiaccountstatusapi/handler.go:115-127`
   只回 `accountRef/provider/status/configured`；Node 返回的可合并字段（displayName/updatedAt 等）未回，前端是否依赖需逐端点核对。
5. **模型目录/账号更新等已修项**
   - `webuimodelsyncapi` 的策略时间已归一（UTC 毫秒）。
   - `webuiaccountupdateapi` 已补回 `account` 行；同类"成功响应少字段"的点仍需逐端点扫。

## 清单：`aih server serve` 参数缺口（当前 fail-closed）

已映射到 Go flag/env：
`host`、`port`、`client-key/api-key`、`management-key`、`proxy-url`、`no-proxy`、`strategy`、`codex-client-version`、`cooldown-ms`、`failure-threshold`、`upstream-timeout-ms`、`max-attempts`、`models-cache-ttl-ms`、`models-probe-accounts`、`provider-cli-auto-upgrade*`、`window-activation*`、`strict-port`、`allow-multi`；hooks 与 web-dir 由适配器自动传。

尚未移植（显式传入会报 `serve_options_not_ported`，不会静默忽略）：
- 上游默认值：`--codex-base-url`、`--gemini-base-url`、`--claude-base-url`、`--agy-base-url`、`--codex-models`
- 路由/重试：`--backend`、`--provider`、`--strategy`（strategy 已支持，backend/provider 非默认值未支持）
- 并发/队列：`--codex-max-concurrency`、`--gemini-max-concurrency`、`--claude-max-concurrency`、`--agy-max-concurrency`、`--opencode-max-concurrency`、`--queue-limit`
- 会话亲和：`--session-affinity-ttl-ms`、`--session-affinity-max`
- 用量扫描：`--model-usage-scan`、`--no-model-usage-scan`、`--model-usage-scan-start-delay-ms`、`--model-usage-scan-interval-ms`
- 日志：`--no-request-log`

行为差异：
- `--host` 非 loopback 现在显式拒绝（Go 只允许 loopback）。
- Node 默认单实例锁/端口占用处理与 Go 的严格 bind 不同；`--allow-multi` 只是不再探测已运行实例。
- 删除了 Node 启动前的 usage scheduler / state-index 预热；Go 自己启动刷新，需用真实数据对拍确认无缺口。

## 清单：合同/文档残留

- `contracts/routeownership/contract.go:732,743` 仍保留两条 `node_owned` legacy aggregate；不是实际路由，但会让完成度看起来未清零。
- `contracts/routeownership/contract.go` 的 `webui.static_shell` 注释仍写"web/dist 缺失回落 Node"；Go-only 已无 Node 可回落。
- `docs/testing/autostart-*.md` 保留 `--front-door --supervise-node` 历史参数，属历史证据，不应作为当前启动模板。

## 下一轮对拍建议

1. 逐个 `/v0/webui/*` 端点比较 Node 响应键与 Go 响应键（尤其 accounts、sessions、chat、models、auth jobs）。
2. 逐字段核对 account/session row builder，优先补 P0/P1 的空字段。
3. 把 serve 的 P2 选项按 Go 运行时配置逐项接线；每次只移一个 fail-closed 项。
4. 清理 2 条 `node_owned` 合同标签并重新生成 `lib/generated/route-ownership.json`。
