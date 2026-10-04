# 插件架构 M2 报告：网关接线与发布

日期：2026-10-04。对应 [插件化规划](../plans/2026-09-30-plugin-architecture-plan.md) §7 的 M2，建立在 [M0](plugin-m0-report.md)、[M1](plugin-m1-report.md) 之上。只记录有运行证据的结论；没有证据的条目标为「未完成」。

结论：M2 的五个扩展点在 Node 网关的两个选号循环上已接通，并有测试证据。以下几项没有完成：Go 原生插件端口、Responses WebSocket 按 `response.create` 接入、真实协议 shadow 验证，以及部分路由的 account / attempt / observe 覆盖。这些场景目前的处理方式见 §2 和 §5：Go 把请求交回 Node，WebSocket 以 426 让客户端回落 HTTPS。都不是静默绕过插件。

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
| WebSocket 明确拒绝 | `b70f64dd` | 见 §2 |

## 2. 路由 × 能力覆盖

Go 侧没有插件端口。活跃代次里只要有任何网关类贡献（request / account / attempt / observe），Go 承接的路由（含 WebSocket 升级）一律交回 Node（`shouldDeferToNodeForPlugins`）。下表是 Node 侧的实际覆盖情况。

| 路由 / 处理器 | request | account | attempt | observe | catalog |
| --- | --- | --- | --- | --- | --- |
| `/v1/*` 通用透传（`handleUpstreamPassthrough`：claude、gemini、agy、opencode 等） | ✓ | ✓ | ✓ | ✓ | ✓ |
| codex `/v1/responses`、`/v1/chat/completions`（`handleCodexChatCompletions`） | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/v1/images/generations`（独立选号循环） | ✓ | ✗ | ✗ | ✗ | ✓ |
| Fabric 远端节点转发（`tryFabricGatewayRoute`） | ✓ | ✗（由远端节点选号） | ✗ | ✗ | ✓ |
| `/v1/models` | — | — | — | — | ✓ |
| codex Responses WebSocket | 有 request / account / attempt 插件时回 **426**（`plugin_websocket_unsupported`）。codex 遇到 426 会在本会话内回落 HTTPS（见 codex-rs `core/src/client.rs`，只有 `UPGRADE_REQUIRED` 触发 `FallbackToHttp`）。只有 observe 插件时不拒绝，但 WS 尝试没有观察事件 | | | | |

上表中 ✗ 表示该路由不经过对应阶段，属于已知缺口（§5），不是由插件明确拒绝。

## 3. gateway.attempt 语义

- **插件收到的输入。** 插件 handler 收到 `{ provider, model, attempt, accountRef, authType }`，上下文多一个 `next()`。`next()` 经反向调用 `gateway.next` 执行内层（下一个中间件；最内层是真实的上游尝试），**在提交点返回**摘要：`{ committed, outcome, status?, error?, stopped?, rejected? }`。
  - 提交点指响应头已写给客户端。流式请求是第一帧回答输出写出时（codex 路径会扣住 `created` / `in_progress` 前导帧，等首个回答帧通过提交闸门才写头，因此提交前的额度拒绝仍能换号；已由端到端测试确认摘要的 `committed` 只在上游应答后出现）；非流式请求是整个响应结束。
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

- **macOS**（Node 22.16）：插件全套（M0 + M1 + M2 + attempt + 反向 RPC，共 73 项）全部通过。另外，引用了选号循环和两个调用方的 33 个网关测试文件（599 项）跑出 596 通过、0 失败。
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
| WS 跨升级保持合法归属 | **未完成**：网关插件活跃时 WS 以 426 让客户端回落 HTTPS（端到端测试覆盖 426 与停用后恢复） |
| Node/Go 命中同一 instance/generation | 以「Go 交回 Node」满足：插件活跃时 Go 不处理任何网关请求。**Go 原生插件端口未完成** |
| shadow 验证真实协议 | **未完成**：只用假上游验证过 claude 透传与 codex native Responses 流式。按约束，测试插件不装到用户的真实网关上 |

变异检验：

- 去掉父调用的挂起计数后，「70 个尝试停在 `next()`」测试在第 65 个处失败；恢复后通过。
- 这次检验还暴露了一个真实缺陷：宿主取消（dispose / cancel）一个停在 `next()` 的 handler 时，反向调用要等到 deadline 才结束，最长 10 分钟。已修复：反向调用改为跟随 handler 的 abort signal。
- 去掉 Go 客户端对反向调用的拒绝后，一致性测试会等到 deadline。

每次提交前，都在干净 worktree 里跑过插件全套。干净 worktree 只含本次提交，不含工作区里其他会话的改动。

## 5. 已知限制

1. **Go 没有插件端口。** 插件活跃时所有网关流量走 Node，Go 承接的性能优势在此期间不生效。
2. **Responses WebSocket 未接入插件阶段。** 要按 `response.create` 取租约、在 WS 桥里重新选号并重放上下文，需要改造 `codex-responses-session.js` 的状态机，目前以 426 回落 HTTPS 代替。
3. **images 与 Fabric 远端路由只经过 request 阶段。** 它们有各自的选号逻辑，或者由远端节点选号。
4. **route policy 只能对账号排序。** 规划里「提议模型选择」没有实现；改模型目前只能经 gateway.request 改写 `model` 字段。
5. **observe 事件不含 token 用量。** 只有尝试级摘要，用量仍以网关自己的用量库为准。
6. **Windows 偶发一次失败。** `through aih server: a catalog plugin alias routes to its target…` 在 Windows 全套运行中失败过一次，当时没有采集到细节；随后 5 次重跑（单文件和全套）全部通过。暂按偶发记录。
7. **其他。** M1 报告中的秘密配置、插件私有状态、Web 管理界面等限制不变。
