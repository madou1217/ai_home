# chat-A：WebUI Chat 运行时迁 Go（竖切）报告

基线：main @ `65555ab7`，工作分支 `slice/chat-wt`。

## 1. 结论

交付了一个可运行、可测试的 Go 竖切：`internal/transport/http/webuichatapi`。
它承接 **一次 turn.submit** 的完整链路——参数校验 → 账号征召（复用 relaycore）→
OpenAI chat_completions 上游流 → `aih.chat.event.v1` SSE 回写 → 用量/运行态记账。

Node 侧一行未改。本切片与 Node 的**结构性差异只有一条**：Node 把「提交指令」和「订阅事件」
拆成两条连接（202 + `/events`），Go 竖切在同一个 POST 上直接以 SSE 交付。所有事件信封、
字段名、字段语义与事件顺序都按 Node 的 canonical 合同对齐，逐项见第 4 节。

## 2. 交付物

| 文件 | 职责 |
| --- | --- |
| `envelope.go` | `aih.chat.event.v1` 信封、SSE 帧编码（与 Node 逐字节同格式）、心跳、写失败即停 |
| `command.go` | 指令信封校验，逐条对齐 Node `normalizeCommand` / `normalizeTurnSubmit` |
| `upstream.go` | OpenAI chat_completions 流解析（SSE 分帧 / `[DONE]` / 多行 data / 注释帧 / 非流式回退）+ 用量归集 + 业务错误信封识别 |
| `handler.go` | 编排：路由、请求体边界、账号征召与换号、上游请求构造、提交前预读、事件交付、记账 |
| `*_test.go` | 35 个用例，见第 6 节 |

复用的现有 Go 资产（没有新增模块依赖）：

- `relaycore.AccountSource` / `AccountCursor` / `CredentialResolver` / `Provider` / `HTTPClient` / `UsageRecorder`——账号选择、凭据解析、上游差异面、记账端口全部沿用透传通道那一套。
- `inferencegateway.ObservedAttemptRecorder` + `attemptfailure`——运行态成功/失败记账与 relaycore 同一条路径。
- `inferenceapi.AccountRefHeader` + `core/accounts.ParseAccountRef`——钉选账号。
- `inferenceapi.NewStreamDeadline`——长流的空闲写超时（每帧刷新）。
- `sharedfailure.ObserveHTTP` / `MaxErrorPayloadBytes`——上游失败分类。

## 3. 请求链路对照

| 步骤 | Node | Go 竖切 |
| --- | --- | --- |
| 入口 | `POST /v0/webui/chat/sessions/{id}/commands` → 202 | 同路径 → 200 + SSE（结构差异） |
| 指令校验 | `normalizeCommand` → `normalizeTurnSubmit` | `decodeTurnSubmit` 逐条同口径（第 4.1 节） |
| 会话/轮次状态 | SQLite（`chat_runtime_sessions` / `commands` / `events`） | 无持久化，单请求内内存状态 |
| 账号选择 | 会话 `executionAccountRef` + 账号调度器 | `relaycore.AccountSource` 游标，最多 4 次换号；`X-Account-Ref` 钉选 |
| 上游 | Codex app-server（chat 模式统一走 harness） | OpenAI `/chat/completions`（本切片只覆盖这一种 Provider） |
| 增量回写 | 事件表 + `/events` SSE（可重放，可断线重连） | 当前连接内联 SSE |
| 记账 | `attempts` + `turn_metrics` + 用量表 | `AttemptRecorder` + `UsageRecorder`（与 relaycore 同一套写入点） |

## 4. 字段级对照

### 4.1 请求体（`POST .../commands`）

Node 的 HTTP 路由把路径里的 `sessionId` **覆盖**进指令（`{...command, sessionId}`），
请求体里的 `sessionId` 因此从不参与校验。Go 保持同一行为：忽略体里的 `sessionId`。

| 字段 | Node 规则 | Go 规则 | 一致 |
| --- | --- | --- | --- |
| `commandId` | 必填非空，否则 400 `chat_command_id_required` | 同 | 是 |
| `type` | 必填；不在白名单 → 422 `unsupported_chat_command` | 只支持 `turn.submit`，其余同码 422 | 是（范围更窄） |
| `payload` | 必须是对象，否则 400 `invalid_chat_payload` | 同 | 是 |
| `payload.runId` / `payload.turnId` | 禁止，422 `chat_turn_identity_client_controlled` | 同 | 是 |
| `payload.content` | `String(v \|\| '').trim()`；空且无附件 → 422 `chat_turn_content_required` | 同 | 是 |
| `payload.model` | 有值时 trim，空值 → 422 `chat_turn_model_control_invalid` | 同；**另外要求必填**（见下） | 部分 |
| `payload.reasoningEffort` | 同 model | 同 | 是 |
| `payload.attachmentIds` | 数组、≤8、非空、不重复 | 同；解析通过后因无附件仓库返回 503 `chat_attachment_store_unavailable` | 部分 |
| 未知顶层/载荷字段 | 丢弃 | 丢弃 | 是 |
| 空请求体 | 视作 `{}` | 同 | 是 |

唯一新增的校验：`model` 必填（422 `chat_turn_model_required`）。Node 的模型来自会话策略，
本切片没有会话存储，只能要求调用方显式给出。

### 4.2 路由级错误体

Node `writeError`：`{ok:false, error, message, details?}`，状态码取 `ChatRuntimeError.statusCode`。
Go `writeRouteError` 字段与顺序完全一致，只在 `details` 有值时出现。

### 4.3 事件信封

| 字段 | Node | Go |
| --- | --- | --- |
| `schema` | `aih.chat.event.v1` | 同 |
| `eventId` | `idFactory('event')` → `event-<uuid>` | 同形：`event-<uuid v4>`（crypto/rand） |
| `sessionId` | 路径会话 id | 同 |
| `seq` | 会话内单调递增（事件表分配） | **单次请求内**从 1 递增（缺口 G1） |
| `type` | `EVENT_TYPES` 白名单成员 | 只发第 4.4 节的 6 种 |
| `at` | `Date.now()` 毫秒 | 注入时钟毫秒 |
| `turnId` / `runId` / `itemId` | 可选文本，服务端生成 | 同（客户端伪造会被 422 拒绝） |
| `source.provider` | 会话 provider | 本次上游 Provider ID |
| `source.runtimeId` | `codex:<scope>`（会话运行时绑定） | `go:chat-completions` |
| `payload` | 按类型归一化 | 同结构 |

SSE 帧逐字节对齐 Node `encodeSseEvent`：`id: <seq>\n`（仅 seq>0）+ `event: <type>\n` +
`data: <紧凑 JSON>\n\n`；心跳帧 `: heartbeat\n\n`；响应头
`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、
`Connection: keep-alive`、`X-Accel-Buffering: no`。

### 4.4 事件序列与载荷

成功一轮（与 Node `TurnLifecycle` + `store.settleTurn` 同序）：

| # | type | payload |
| --- | --- | --- |
| 1 | `turn.queued` | `{state:"starting", submissionCommandId, activeTurn}` |
| 2 | `turn.started` | `{state:"running", activeTurn}` |
| 3 | `timeline.item.started` | `{item}`，`status:"running"`、`content:""` |
| 4..n | `timeline.item.delta` | `{itemId, chunk}` |
| n+1 | `timeline.item.completed` | `{item}`，`status:"completed"`，`detail.metrics` |
| n+2 | `turn.completed` | `{state:"idle"}` |

失败一轮（上游中途断流）：第 n+1 条 `timeline.item.completed` 的 `status` 为 `failed`，
末条是 `turn.failed` `{state:"idle", retryable:true, error:{code, message}}`，不再发 `turn.completed`。
空回复不发任何 `timeline.item.*`（与 Node 事件桥「首个 delta 才建条目」一致），只发 `turn.completed`。

`activeTurn` = `{turnId, runId, clientUserMessageId, startedAt, state}`，其中
`clientUserMessageId` 与 Node 一样取 `runId`。

### 4.5 时间线条目与 metrics

条目字段集合与 Node `normalizeTimelineItem` 相同：`id / kind / createdAt / updatedAt /
status / content / detail / turnId`；`kind:"message"`，`detail:{role:"assistant", model, metrics?}`。

**取值差异（刻意）**：Node 的原生桥把 `createdAt`/`updatedAt` 写成 `0`（拿不到真实时间），
本切片写真实毫秒；`status` 用 `"running"` 而不是 `"streaming"`（第 9 节的取证）。

`detail.metrics` 规则照抄 Node `turn-metrics-repository.finishInTransaction`：

- `durationMs` 必有（`completedAt - startedAt`，下界 0）；
- `ttftMs` 只在真的收到首个可见增量时出现，且被夹到 `[0, durationMs]`；
- `tokensPerSec` 只在有 `ttftMs`、`outputTokens > 0` 且解码窗口 ≥500ms 时出现；
- `inputTokens`/`outputTokens` 只在上游真的给了 usage 时出现。

### 4.6 上游请求

```json
{"model":"<model>","messages":[{"role":"user","content":"<content>"}],
 "stream":true,"stream_options":{"include_usage":true},
 "reasoning_effort":"<仅当调用方给出>"}
```

请求体先过 `Provider.RewriteRequest`（家族等有额外约束的 Provider 在这里改写），再由
`Provider.DecorateUpstream` 补 `Content-Type / Accept / Authorization`，与透传通道一致。

响应侧：`text/event-stream` 按 SSE 逐帧解析；非流式 JSON 聚合成一块增量（前端仍看到完整流）；
2xx + `{"error":{...}}` 视为失败（提交前 → JSON 错误，提交后 → `turn.failed`）。

## 5. 错误码

状态码与码值优先沿用 Node/relaycore 既有词汇；新增的只有 Go 承接后才存在的几种。

| 场景 | 状态 | code |
| --- | --- | --- |
| 指令不是 JSON 对象 / 读不出来 | 400 | `invalid_chat_runtime_payload` |
| 缺 `commandId` / `type` | 400 | `chat_command_id_required` / `chat_command_type_required` |
| 非 `turn.submit` | 422 | `unsupported_chat_command` |
| 载荷非对象 | 400 | `invalid_chat_payload` |
| 客户端给 `runId`/`turnId` | 422 | `chat_turn_identity_client_controlled` |
| 正文为空且无附件 | 422 | `chat_turn_content_required` |
| `model`/`reasoningEffort` 为空 | 422 | `chat_turn_model_control_invalid` |
| 未给 `model` | 422 | `chat_turn_model_required`（新增） |
| 附件非法 / 重复 | 422 | `chat_attachment_ids_invalid` / `chat_attachment_ids_duplicate` / `chat_attachment_id_invalid` |
| 有附件但本切片没有附件仓库 | 503 | `chat_attachment_store_unavailable`（与 Node 同码） |
| 钉选头非法 / 重复 | 400 | `invalid_account_ref_header`（新增） |
| 账号调度不可用 | 503 | `chat_runtime_unavailable` |
| 没有可用账号（含钉选无匹配） | 503 | `chat_account_unavailable`（新增） |
| 账号不属于本通道 Provider / 非原生凭据 | 422 | `unsupported_chat_account`（新增） |
| 上游 HTTP 失败 | 上游状态码（401/403 折成 502） | `chat_upstream_error` |
| 上游站点边缘拒绝 | 502 | `chat_upstream_edge_rejected` |
| 上游不可达 | 502 | `chat_upstream_unavailable` |
| 上游流中断 | 502 或 `turn.failed` | `chat_upstream_stream_failed` |
| 路径/方法不匹配 | 404 / 405 | `chat_runtime_route_not_found` / `chat_runtime_method_not_allowed` |

上游 401/403 折成 502 是有意的：那是「账号对上游无效」，不是「本机调用方没登录」，
原样返回会把 WebUI 踢回登录页。

## 6. 测试

```
go test ./internal/transport/http/webuichatapi/ -count=1        → ok（35 个用例）
go test -race -count=2 ./internal/transport/http/webuichatapi/  → ok
```

覆盖任务要求的五类：

| 要求 | 用例 |
| --- | --- |
| 参数校验 | `TestDecodeTurnSubmitAcceptsMinimalCommand`、`TestDecodeTurnSubmitRejectsInvalidCommands`（13 个子用例）、`TestDecodeTurnSubmitTreatsEmptyBodyAsEmptyObject`、`TestHandleTurnRouteBoundaries` |
| 账号选择失败 | `TestHandleTurnReportsAccountSelectionFailure`（来源报错 / 池空 / 凭据失败三档）、`TestHandleTurnRejectsUnknownPinnedAccount`、`TestHandleTurnRejectsMalformedPinnedHeader`、`TestHandleTurnUsesPinnedAccount`、`TestHandleTurnRotatesAccountOnRetryableFailure` |
| 上游 4xx/5xx | `TestHandleTurnReportsUpstreamHTTPFailure`、`TestHandleTurnMapsUpstreamAuthFailureToGatewayError`、`TestHandleTurnReportsTransportFailure`、`TestHandleTurnReportsUpstreamErrorEnvelope` |
| SSE 分帧 | `TestChatStreamReaderReadsDeltasAndUsage`、`TestChatStreamReaderSurvivesByteWiseReads`（每次 Read 只给 1 字节 + CRLF）、`TestChatStreamReaderReadsSeveralFramesInOneChunk`、`TestChatStreamReaderFlushesTrailingFrame`、`TestChatStreamReaderRejectsMalformedFrame`、`TestEncodeEventMatchesNodeFrame`（帧字节与 Node 同格式）、`TestEventStreamNumbersEvents`、`TestEventStreamWritesHeartbeat`、`TestHandleTurnWritesHeartbeat` |
| 客户端断开取消 | `TestHandleTurnCancelsUpstreamOnClientDisconnect`（真 `httptest.Server` + 真断开，断言上游请求 ctx 被取消） |

另外：`TestHandleTurnStreamsCanonicalEvents` 断言 7 条事件的顺序/序号/信封/条目/metrics/记账；
`TestHandleTurnSkipsEmptyReply`、`TestHandleTurnFailsMidStream`、`TestTurnMetricsRules`、
`TestHandleTurnBuildsUpstreamRequest`、`TestHandleTurnAggregatesNonStreamingUpstream` 覆盖边界。

## 7. 验收结果

| 项 | 结果 |
| --- | --- |
| `go build ./internal/transport/http/webuichatapi/` | 通过 |
| 新增包测试 | 35/35 通过（含 `-race`） |
| `go build ./...` | **失败，但与本次改动无关**：`internal/adapters/accounts/deletionprojection/credential.go:540` 引用了 `nativeaccount.SanitizeClineProvidersDocument`，该符号在基线 `65555ab7` 的整棵树里不存在（`grep -rn` 只在调用点出现）。这是基线缺陷，属于 accounts 适配器，不在本任务范围，未改动。 |

## 8. 下一轮接线（精确步骤）

本切片**故意没有挂进 `newRouter`**：一旦挂上，Go 服务的 UI 会开始在真实路径上用这份半成品
接管聊天，而它还没有会话、历史与重放。接线的动作很小，但应该和 G1/G2 一起落：

1. `internal/host/aihserver/composition.go`：在 `serverHandlers` 增加字段
   `webUIChat http.Handler`，并在组装 `familyRelayHandler` 的同一处创建：

   ```go
   webUIChatHandler, err := webuichatapi.NewHandler(webuichatapi.Dependencies{
       Accounts: relaycore.NewAccountSourceChain(
           append(relayModuleAccounts(relayModules), familyRelayAccounts)...,
       ),
       // 家族 Provider 需要额外并入：relayModuleProviders 只含单 Provider 模块。
       Provider:    relaycore.NewProviderChain(relayModuleProviders(relayModules)...),
       Credentials: credentials,
       Client:      relayClient,
       Attempts:    accountRuntime,
       Usage:       attemptUsage,
       Clock:       time.Now,
   })
   ```

   这些依赖与 `codebuddyfamilyrelay.NewHandler` 用的是同一批对象，所以接线不引入新端口。

2. 同一函数返回的 `serverHandlers{...}` 里补 `webUIChat: webUIChatHandler`。
3. `internal/host/aihserver/router.go`：
   ```go
   if handlers.webUIChat != nil {
       mux.Handle(webuichatapi.CollectionPath, handlers.webUIChat)
   }
   ```
   （`CollectionPath` 带尾斜杠，前缀匹配即可覆盖 `/{sessionId}/commands`。）
4. Node 侧不动。WebUI 仍走 Node 的 `/v0/webui/chat/*`；Go 路线先用影子流量验证，
   或者在 Node 路由里加一条「哪些会话交给 Go」的开关——那是下一轮的事。

## 9. 剩余缺口

- **G1 序号与重放**：`seq` 每次请求从 1 开始，没有事件表。前端的 `after` 游标语义
  （`openChatRuntimeEventStream` 的 gap → `session.snapshot.reset`）无法成立。接会话存储时
  必须改成「会话内单调分配 + `readEvents(after)`」。
- **G2 无会话**：不认识 `/sessions/resolve`、历史、`policy`、队列、`turn.interrupt`。
  `messages` 只带本轮正文，多轮对话在模型看来永远是第一轮。
- **G3 单连接内联流**：Node 的轮次与 SSE 解耦，断线不取消轮次、重连可重放；本切片断线即取消
  上游。这是结构差异，不是 bug，但迁移时前端要接受「刷新即断」。
- **G4 只覆盖一种上游**：只做 OpenAI `chat_completions` 流式（+非流式回退）。`reasoning_content`
  目前在增量里被忽略（Node 时间线有 `kind:"reasoning"` 条目），工具调用/审批/交互也没有。
- **G5 附件**：只做了校验，没有附件仓库，命中即 503。
- **G6 背压**：Node 的 `BoundedSseWriter` 有 256 帧上限，溢出时交付
  `chat_runtime_backpressure_overflow` 的 `stream.error`。Go 的 `ResponseWriter.Write` 天然同步阻塞，
  不需要队列，也因此没有这个错误码——语义等价（慢客户端只会拖慢上游读取），但码值不存在。
- **G7 `stream.error`**：Node 只在传输层故障（背压溢出、重放缓冲溢出）时发；同步模型下没有
  对应场景，本切片不发这个事件。
- **G8 命令幂等**：Node 用 `commandId` 去重（`chat_command_id_conflict` / 重复返回既有结果）。
  本切片没有命令表，重复提交会重复请求上游。

## 10. 取证记录（本轮顺手确认的两件事）

1. `lib/server/chat-runtime/native-session-event-bridge.js:122` 发出的条目状态是
   `'streaming'`，但 canonical 合同的 `TIMELINE_STATUSES` 里没有这个值；
   实跑 `normalizeTimelineItem({... status:'streaming'})` 会抛 `invalid_timeline_status`，
   而 `status:'running'` 通过。Go 切片按合同用 `running`；Node 侧这条路径若真的经过
   `normalizeEvent`，会是一个待确认的缺陷（本轮未改 Node）。
2. 帧格式用 `node -e` 实跑 `encodeSseEvent` 取过样，Go 的 `encodeEvent` 与之逐字节对齐
   （`TestEncodeEventMatchesNodeFrame` 守住）。

## 11. 复现命令

```bash
go test ./internal/transport/http/webuichatapi/ -count=1 -v
go test -race -count=2 ./internal/transport/http/webuichatapi/
go build ./internal/transport/http/webuichatapi/
```
