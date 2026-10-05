# 插件架构 M2 报告：网关接线与发布

日期：2026-10-04。对应 [插件化规划](../plans/2026-09-30-plugin-architecture-plan.md) §7 的 M2，建立在 [M0](plugin-m0-report.md)、[M1](plugin-m1-report.md) 之上。只记录有运行证据的结论；没有证据的条目标为「未完成」。

结论：M2 的五个扩展点在 Node 网关的两个选号循环上已接通，并有测试证据。Responses WebSocket 已按 `response.create` 接入全部五个扩展点（account 对首个 create 受会话亲和约束，见 §2）。以下几项没有完成：Go 插件端口的 account / attempt / observe（gateway.request 已由 Go 执行，见 §2）、真实协议 shadow 验证，以及 images / Fabric 路由的 account / attempt / observe 覆盖。Go 把请求交回 Node 处理；插件启用前已由 Go 接管的 WebSocket 会话在 codex 重连之前不经过插件（§5 第 8 条）。

## 1. 交付物

| 交付 | 提交 | 说明 |
| --- | --- | --- |
| 代次固定与按租约退役 | `4688de3a` | 每个网关请求在入口 `acquire()` 一个不可变快照与租约，整个请求只调用这一代，响应 `close` 时释放。发布顺序为：准备 → CAS 提交 → 激活（保留旧代次）。旧代次在最后一个租约释放时卸载；超过排空时限（默认 10 分钟）就强制卸载并计数。宿主按代数回收时，会等到租约归零才执行 |
| gateway.request | `4688de3a` | waterfall。身份、授权、continuation 和加密字段的指纹在变换前后必须一致。拒绝只能用 4xx。deny（默认）时请求失败（502）；delegate 只跳过出错的那个插件 |
| gateway.account | `33149937` | serial。只能在宿主筛过的候选里排序，偏好候选之外的账号判为 `plugin_scope_violation`。偏好排在会话亲和之后、默认账号之前。插件看不到邮箱和凭据 |
| model.catalog | `9b0de544` | 别名在准备阶段求值一次，随快照固定。真实模型 ID 和用户别名优先。两个插件声明同一别名时，候选被拒。`/v1/models` 与路由读同一份有效目录，代次变化时列表同步重建 |
| observe（尝试观察） | `1216146f` | 每次尝试结束投递一条低敏摘要（不含正文和凭据）。队列有界（256），满了就丢弃并计数，永不阻塞请求。每个排队事件持有自己代次的租约 |
| 反向 RPC（协议 v2） | `9841075a` | 宿主可以在某个调用名下回调网关（`parent` 指向仍在进行中的调用）。父调用一结束（结果、错误、取消、超时、断开），挂在下面的反向调用两端都会取消。Go 客户端对反向调用立即回 `method_unknown` |
| gateway.attempt | `454339bc`、`9b0bc0c3` | 单次 next 的洋葱中间件，详见 §3 |
| WebSocket 明确拒绝（已撤销） | `b70f64dd` | 过渡方案：account / attempt 活跃时回 426 让 codex 回落 HTTPS；WS 接入后已移除 |
| WebSocket 按 response.create 接入 | `46210ac2` | 包装交给桥接的客户端 socket（桥接状态机不改）。每个 `response.create` 取到达时的代次租约并跑 gateway.request；被拒绝的 create 不出站，回带状态码的 `error` 事件。上游事件按 response id 归属，终止或断开时投递 observe 并释放租约 |
| WebSocket 的 account / attempt | `380970ec` | 桥接换号恢复经两个可选钩子接入：`beforeRecover`（上一尝试以未提交失败结束 → 交回中间件决定是否停止换号，并用当前 create 的代次刷新账号偏好）与 `beforeReplay`（连上新账号、重放前运行新尝试的中间件，拒绝则不重放）。首个尝试由客户端 socket 包装驱动：中间件的 next() 把 create 交给桥接 |

## 2. 路由 × 能力覆盖

Go 插件端口第一阶段（`4cbc81f0`）：Node 把存活代次的投影（含宿主地址与令牌）推给 Go 管理接口 `/v1/management/plugins/projection`，记下 Go 确认的代次；转发器固定代次（Node 持有租约到响应结束）并带内部代次头，客户端自带的同名头被剥掉。Go 在 `/v1/responses`、`/v1/chat/completions`、`/v1/messages` 入口执行 gateway.request（语义与 Node 一致，身份字段清单来自插件合同）。其余情况仍交回 Node：account / attempt / observe 贡献、WebSocket 升级、其它 Go 入口、Go 尚未确认的代次。Go 丢失投影（例如重启）或请求体被压缩时，Go 按「解码拒收」把请求交还 Node（此时尚无副作用），下一轮推送（10 秒内）恢复。HTTP 与 upgrade 入口 `go-core-gateway-forwarder.js` 都同步调用 `deferToNode`。下表是 Node 侧的实际覆盖情况。

| 路由 / 处理器 | request | account | attempt | observe | catalog |
| --- | --- | --- | --- | --- | --- |
| `/v1/*` 通用透传（`handleUpstreamPassthrough`：claude、gemini、agy、opencode 等） | ✓ | ✓ | ✓ | ✓ | ✓ |
| codex `/v1/responses`、`/v1/chat/completions`（`handleCodexChatCompletions`） | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/v1/images/generations`（独立选号循环） | ✓ | ✗ | ✗ | ✗ | ✓ |
| Fabric 远端节点转发（`tryFabricGatewayRoute`） | ✓ | ✗（由远端节点选号） | ✗ | ✗ | ✓ |
| `/v1/models` | — | — | — | — | ✓ |
| codex Responses WebSocket（每个 `response.create`） | ✓ | ✓（换号恢复；首个 create 先沿用升级时的账号——会话亲和——之后的 create 留在连接的账号上，它持有续写） | ✓（首个尝试 + 每次桥内换号恢复） | ✓（每个 response 一条摘要，`accountRef` 取回答结束时连接的账号） | ✓ |



上表中 ✗ 表示该路由不经过对应阶段，属于已知缺口（§5），不是由插件明确拒绝。

## 3. gateway.attempt 语义

- **插件收到的输入。** 插件 handler 收到 `{ provider, model, attempt, accountRef, authType }`，上下文多一个 `next()`。`next()` 经反向调用 `gateway.next` 执行内层（下一个中间件；最内层是真实的上游尝试），**在提交点返回**摘要：`{ committed, outcome, status?, error?, stopped?, rejected? }`。
  - 提交点指响应头已写给客户端。流式请求是第一帧回答输出写出时（codex 路径会扣住 `created` / `in_progress` 前导帧，等首个回答帧通过提交闸门才写头，因此提交前的额度拒绝仍能换号；见 `codex-response-stream.js` 的提交闸门；codex stop 测试里，上游回 500 的那次尝试摘要为 `committed: false`）；非流式请求是整个响应结束。
  - 提交点的检测方式：每个响应包一次 `res.writeHead`。`write`、`end`、`flushHeaders` 隐式写头时也会经过 `writeHead`。
- **插件只能收窄宿主行为。**
  - 不调用 `next()` 时，可以返回 `{ reject: { status, message } }`（4xx/5xx），上游零命中。
  - 尝试未提交就失败时，可以返回 `{ recovery: 'stop' }` 停止后续换号。请求按「尝试耗尽」结束，调用方照常写出失败响应。
  - 已提交之后的返回值只用于观察。尝试本身抛出的错误原样交还宿主。
  - `next()` 至多调用一次：宿主侧 SDK 和网关侧各校验一次。插件无法自行重试，也无法重复计费。
- **预算。** `next()` 之前、`next()` 返回之后各有一段 1 秒的插件预算。在 `next()` 里等待上游的时间不计入。
- **失败语义。**
  - deny（默认）：尝试还没开始时请求失败（502）；已经开始后只计数，不影响结果。
  - delegate：由网关替插件调用 `next()`。
  - 两种情况的失败都计入 `runtime.status().contributionFailures`。
- **在途名额。** 停在 `next()` 里的调用单独计数（`limits.parkedCalls = 1024`），不占用 `inflightCalls`（64）。长时间等待上游时，request / account 等短调用仍然可用。
- **组合顺序。** 多个中间件在 Node 侧组合：进入 A→B，返回 B→A。外层能看到内层的停止决定（`stopped`）。

## 4. 验收证据

自动化测试：

| 测试 | 项数 |
| --- | --- |
| `test/plugin-gateway-m2.test.js` | 16 |
| `test/plugin-gateway-attempt.test.js` | 19 |
| `test/plugin-rpc-reverse.test.js` | 6 |
| `internal/adapters/pluginruntime` 一致性测试 | 7 |

测试环境与结果：

- **macOS**（Node 22.16）：插件全套（M0 + M1 + M2 + attempt + 反向 RPC，共 73 项）全部通过。另外，在 `b70f64dd` 的干净 worktree 里跑了引用选号循环、两个调用方和 WS 处理器的 33 个网关测试文件：593 项通过、3 项跳过、0 失败；其中 2 个文件因 worktree 缺 `web/node_modules` 无法加载，补上链接后 42/42 通过。
- **Windows**（Node 22.23，`b70f64dd`）：插件全套 72 项通过、0 失败、1 项跳过（符号链接权限）。
- 所有测试都在 `/tmp` 临时 aiHomeDir、随机端口上运行，不触碰用户的 `~/.ai_home` 与 9527。

| 规划门禁（§7 M2） | 状态与证据 |
| --- | --- |
| 候选失败不覆盖当前版本 | ✓ 候选被拒（含目录别名冲突）、提交冲突时，当前代次继续服务 |
| scope 越界拒绝 | ✓ 账号偏好越界 → `plugin_scope_violation`，请求不出站；request 阶段改身份字段 → 拒绝 |
| 单次 next | ✓ 第二次 `next()` → `plugin_next_called_twice`，上游只命中一次 |
| 取消 | ✓ 客户端在 `next()` 等待期间断开 → 插件调用被取消，尝试仍由宿主执行完毕。插件超出预算 → handler 的 signal 真的 abort |
| 发送后拒绝重放 | ✓ 已提交的尝试上，`stop` 被忽略；网关原有的「已暴露的回答不重放」规则不变 |
| 背压 | 插件不在字节路径上：中间件只拿到提交点摘要，响应字节仍由原有转发器直接写给客户端，背压语义不变。没有单独的插件背压测试 |
| 连续 SSE 跨升级保持合法归属 | ✓ 尝试停在 `next()` 时发布新代次：该尝试仍走旧代次，旧代次排空后卸载 |
| WS 跨升级保持合法归属 | ✓：同一连接上，回答进行中发布新代次，该回答仍走旧代次，结束后旧代次卸载；下一个 `response.create` 拿新代次（`test/plugin-gateway-websocket.test.js`，macOS 与 Windows 均通过）。account / attempt 经桥接钩子接入，测试覆盖换号恢复中的停止、拒绝、账号偏好与挂起钩子时断开 |
| Node/Go 命中同一 instance/generation | ✓（gateway.request）：请求携带 Node 固定的代次，Go 只用该代次的投影调用同一个 Plugin Host；发布新代次时在途请求保持旧代次直到响应结束（`test/plugin-gateway-go.test.js`，真实 Go + 真实宿主）。account / attempt / observe 仍由 Node 执行 |
| shadow 验证真实协议 | **未完成**：只用假上游验证过 claude 透传与 codex native Responses 流式。按约束，测试插件不装到用户的真实网关上 |

变异检验：

- 去掉父调用的挂起计数后，「70 个尝试停在 `next()`」测试在第 65 个处失败；恢复后通过。
- 这次检验还暴露了一个真实缺陷：宿主取消（dispose / cancel）一个停在 `next()` 的 handler 时，反向调用要等到 deadline 才结束，最长 10 分钟。已修复：反向调用改为跟随 handler 的 abort signal。
- 去掉 Go 客户端对反向调用的拒绝后，一致性测试会等到 deadline。

每次提交前，都在干净 worktree 里跑过插件全套。干净 worktree 只含本次提交，不含工作区里其他会话的改动。

## 5. 已知限制

1. **Go 插件端口只完成 gateway.request。** 有 account / attempt / observe 贡献时请求仍交回 Node（Go 承接的性能优势在此期间不生效）；Go 的 WebSocket 与其它入口（Gemini、图片、count_tokens）同样交回。后续阶段：observe（Go 的尝试终态记录器统一接入）、account（Go 三条选号循环）、attempt（Go 客户端处理反向调用）。Go 确认投影前会用推送的地址和令牌 ping 宿主，连不上就一个代次都不确认；执行中连不上宿主、请求体超限时，Go 把请求交还 Node 而不是报错。Node+Go 端到端测试在 Windows 上跳过：Go 测试夹具在 Windows 上打不开账号库（`SQL logic error: out of memory`），原有的 `server.codex-http-parity.test.js` 在 Windows 上同样失败，与插件端口无关；Go 侧插件代码（含命名管道上的真实宿主调用、重连与 ping）在 Windows 上由 Go 单元测试覆盖。
2. **WebSocket 上的账号偏好主要作用于换号恢复。** 首个 create 时桥接优先沿用升级时选中的账号（会话亲和），之后的 create 留在连接的账号上（它持有续写），所以偏好真正改变选号的是换号恢复。桥接钩子位于 `codex-responses-session.js` 的 `recover()`，该文件另有一项未提交的改动；若 `recover()` 再被重写，`test/plugin-gateway-websocket.test.js` 的恢复测试会发现钩子丢失。另外，WS 上 response id 以外的增量事件按先到先得归属；在流水线（多个 create 同时进行）时，观察摘要的归属是近似的，桥接此时也不再换号恢复。
3. **images 与 Fabric 远端路由只经过 request 阶段。** 它们有各自的选号逻辑，或者由远端节点选号。
4. **route policy 只能对账号排序。** 规划里「提议模型选择」没有实现；改模型目前只能经 gateway.request 改写 `model` 字段。
5. **observe 事件不含 token 用量。** 只有尝试级摘要，用量仍以网关自己的用量库为准。
6. **Windows 偶发一次失败。** `through aih server: a catalog plugin alias routes to its target…` 在 Windows 全套运行中失败过一次，当时没有采集到细节；随后 5 次重跑（单文件和全套）全部通过。暂按偶发记录。
7. **其他。** M1 报告中的秘密配置、插件私有状态、Web 管理界面等限制不变。
8. **插件启用前已由 Go 接管的 WebSocket 会话不受插件约束。** Go 只在升级时调用 `deferToNode`；之后同一连接上的 `response.create` 一直由 Go 处理，直到 codex 重连（换连接、出错或会话结束）。Node 接管的连接没有这个问题。
9. **gateway.request 可能被调用两次。** Go 执行完 gateway.request 后，如果之后的 Go 协议解码拒收了请求，Node 会用原文再执行一次插件阶段。改写只生效一次（Node 用的是原文），但有副作用的插件会看到两次调用。
