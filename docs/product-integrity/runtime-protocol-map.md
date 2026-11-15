# M2/M3：canonical / native 能力与运行协议边界映射

## 1. 范围、快照与证据边界

| 项目 | 本次记录 |
|---|---|
| 批准计划 | [产品完整性优化计划](../superpowers/plans/2026-11-14-product-integrity-optimization.md) 的 M2 原生适配与 M3 推理边界；不是整个 M2/M3 的验收 |
| 源码时点 | 2026-11-15 00:32（Asia/Shanghai）收尾静态复核。审计开始 HEAD `0e1a38ddcb9f`，写入时 `2d6b82456e46`，并行会话又推进至 `4fe01f81de8c`；依据是 **HEAD + 当前未提交/未跟踪源码**，不是纯提交快照 |
| 唯一写入 | `docs/product-integrity/runtime-protocol-map.md`；其他实现、计划及同目录文档均只读 |
| 执行边界 | 仅读源码、Git 状态/diff、JSON 声明及文件摘要；未运行测试、构建、CLI/help、Provider、推理、HTTP、GUI；未创建分支/worktree、暂存、提交、修改账号/auth/config |
| 全表状态 | **`source_audited / runtime_not_verified`**。声明存在、入口接线、静态投影、原生版本支持、实际执行成功是不同证据，不按表格行数计算完成率；后续用户提供的实时观察单列第 9 节，不升级原审计表状态 |
| 不重复的工作 | 命令词、别名、flag、help/补全/公开 CLI 分派详见 [CLI 合同映射](cli-contract-map.md)，本页只保留说明协议或身份所必需的入口形态 |
| 延后边界 | 账号导入、登录、刷新、去重、停用/删除、凭据写回与跨账号生命周期的深入审查另开任务。本页只审查“选定身份是否交给执行器”，不读取真实凭据 |

本轮没有核对已安装 CLI 版本、可执行文件、服务运行态或上游能力。源码注释中的历史“实测”、ACP 表中的 `verifiedAt`、批准计划中前轮的 Fast / Ultrafast 验收，均不升级为本轮运行证据。

### 权威来源与不能互换的概念

1. [core/providers/builtins.go](../../core/providers/builtins.go) 是内置声明；[manifest.json](../../contracts/providers/manifest.json) 标记 `schemaVersion: 2`、`generatedFrom: core/providers/builtins.go`。本轮只核对关键声明，不执行生成器。
2. manifest 有 **16 个 Provider，14 个 `clients.cli=true`**。`workbuddy`、`workbuddycn` 仅声明 Desktop 客户端；有 `cli` 配置块、可复用家族实现，不等于对用户分发独立 CLI。
3. 会话数据在 `nativeBoundary.sessions`、`sessionSync`、`capabilities`，没有一个能够概括全部执行能力的顶层 `session` 字段。`session_history` 是历史读取；`session_runtime` 是控制面登记；`account_session_store` 是存储作用域，三者不能互相推导。
4. [core/providers/model.go](../../core/providers/model.go#L34) 明确 `acp_session` 登记的是 **Node 布局表的 ACP 入口**；不保证 Go chat runner 已接 ACP。`nativeBoundary.runtime` 的类型 `NativeResourceRuntime` 只描述**资源管理**的 bundled execution lane，不是所有聊天/CLI 启动器自动继承的执行策略。
5. `gateway=active/deprecated` 是自动候选生命周期；`relayHosts` 是宿主 + 入口能力；CLI `GatewayStrategy` 是客户端启动策略；WebUI `CapabilitySnapshot` 是命令/渲染能力。这四份语义不能合并成一个“支持”布尔值。
6. [lib/provider-native-capability-registry.js](../../lib/provider-native-capability-registry.js) 只是 manifest 的只读投影；`nativeBoundary` 没有逐能力版本/发现时间。ACP 布局另有 `verified/evidence/verifiedAt`，不能把其历史证据推广到其他能力或当前安装版本。

## 2. 当前方向与 owner：四条执行通道分开记账

### 2.1 HTTP canonical 通道（4 个 Provider）

```text
客户端协议
  -> clientprotocol decoder / request-scoped Exchange
  -> core/inference.Request（独立 ClientProtocolID / ProviderID / ProtocolID）
  -> inferencegateway 路由、账号招募、能力/重试策略
  -> Provider adapter 编码 + 上游 transport + decoder
  -> core/inference.StreamEvent / Usage / ResponseFailure
  -> 原入口自己的 renderer / aggregator
```

- [inferencehttp.New / newProtocolRegistry](../../internal/host/inferencehttp/module.go#L55)：Responses、Chat Completions、Anthropic Messages 进入 registry；Gemini `generateContent/streamGenerateContent` 使用独立注入的 Gemini adapter/handler，不能误报为“Gemini 未注册所以不可用”。
- [clientprotocol.Registry / Exchange](../../internal/adapters/clientprotocol/registry.go)：按 **客户端协议**选 renderer，不根据最终账号厂商猜响应形状；未注册协议不默认降级到邻近协议。
- [core/inference/protocol.go](../../core/inference/protocol.go)：canonical Provider/上游协议当前仅 Codex、Claude、AGY、Gemini；这是明确的领域范围，不是全 16 Provider。
- [aihserver/inference.go](../../internal/host/aihserver/inference.go#L148) 实际装配 `codex/responses`、`claude/messages`、`agy/codeassist.Adapter` 与 `agy/codeassist.GeminiAdapter`。AGY/Gemini 共享部分实现不表示账号或 wire envelope 相同。
- [routeownership.Contract](../../contracts/routeownership/contract.go#L101) 将上述 HTTP 推理入口及 WebUI chat sessions 标为 Go owner；这里只确认**源码 owner 声明与组合根**，不证明当前进程/部署已经采用该版本。

Gemini 的 `Execute` 还包含 `executeStandardAPI`（API-key / 自定义 base URL）分支，但同文件 `SupportsCredential` 当前只检查 `geminiAccessToken`。不能把这个分支存在当作 API-key 已穿过所有调度门控的证明；该凭据门控的深入核对交给后续账号任务。本页保留这个方向差异，不尝试登录或发请求探测。

### 2.2 HTTP relay 通道（12 个 Provider，入口限定）

```text
/v1/chat/completions
  -> relaycore / codebuddyfamilyrelay（账号所属 Provider 分派）
  -> 各 Provider rewrite / wire transport / response transform
  -> Chat Completions 响应或流 + 旁路 usage / degradation
  -> 不能认领时交给 canonical handler（不是自动获得另一 Provider 的支持）
```

[relayModuleSpecs](../../internal/host/aihserver/relay_modules.go#L51) 登记 Cline、Grok、Kimi、OpenCode、Qoder/CN、ZCode、Kiro；家族四支由 `codebuddyfamilyrelay` 登记。[composition.go](../../internal/host/aihserver/composition.go#L1679) 把它们接入同一 handler，并设置 `Fallback: inference.handler`。

这是**已存在且显式声明的架构例外**：这些 Provider 不创建 canonical `RouteRule`，不能承诺其响应全部经过 `core/inference.StreamEvent`。manifest 对 Go 的 relay 能力只列 `gateway.openai.chat_completions`；不能据此宣传它们在 Responses/Messages/Gemini 所有入口上均可用。Node 的 [resolveRelayHost](../../lib/providers/index.js#L88) 同样要求入口匹配；Kiro 未声明 Node relay。这里只记录边界，不把已有 relay 批量重写为 canonical。

### 2.3 原生 CLI 启动：意图与 provider 差异分离

[ParseLaunchIntent](../../application/providerlaunch/intent.go#L46) 明确区分 `native_direct` 与 `gateway_relay`，独立保存 `ClientProviderID`、`RelayProviderID`、显式账号及透传参数。[Service.Plan](../../application/providerlaunch/service.go#L66) 只选一个 planner，失败不静默改认证模式。

- Native：`Planner.Build` 校验 selection / credential binding / strategy 的 Provider 与 AccountRef 一致性 → `clilaunch.Strategy` 返回描述 → [providercli.Runner.Run](../../internal/runtime/providercli/runner.go#L117) 执行官方进程或 PTY。账号全生命周期不在这里展开。
- Go 组合根 [aihcli/app.go](../../internal/host/aihcli/app.go#L250) 登记 12 个独立策略加家族四支；**GatewayStrategy 实际只有 Codex、Claude**。manifest 的 `gateway_profile` 或 `gateway=active` 不能当作其他 Go GatewayStrategy 已实现的证据；公开入口是否转 Node 另见 CLI map。
- Codex 当前 OAuth launch strategy 已走账号配置投影 + direct process，不是仅因 runner 还保留 `RuntimeKindCodexExternalAuth` 就认定当前 OAuth 必走 external-auth。[Codex strategy](../../internal/adapters/codex/clilaunch/strategy.go#L85)
- Claude 可选 direct 或 refreshable OAuth proxy；由 [Claude strategy](../../internal/adapters/claude/clilaunch/strategy.go#L68) 决定。Runner 的 Claude Gateway proxy 与 Native OAuth proxy 也不是 HTTP canonical decoder 的替代物。
- [validateManagedArguments](../../internal/runtime/providercli/arguments.go#L14) 保护托管账号/路由参数，保留模型、sandbox 等其他原生参数；“不改官方二进制”不等于“所有参数可覆盖托管边界”。

### 2.4 WebUI canonical chat 与原生会话

这里的 canonical 是 `chatruntime.Command / EventEnvelope / TimelineItem`，**不是** `core/inference.Request / StreamEvent` 的同一个 schema。

[defaultDriverRegistry.Resolve](../../internal/runtime/chatruntime/service.go#L1076) 的当前方向：

- `IsChatSession` → `CapabilityRoutedChatDriver` → 满足普通 relay chat 条件走 `GoChatDriver`；否则 fallback 到 **Go `CodexSessionDriver` / app-server**。`CreateNodeEntry`、`attachments_require_node` 等历史名称不能当成当前进程仍归 Node 的证据。
- Codex 原生会话 → `CodexSessionDriver` → stdio JSON-RPC app-server → `CodexSessionEventBridge` → store/publisher。
- 其他 Provider → `NativeSessionDriver` → 默认 `execNativeTurnRunner` → command builder → raw stream process；只有 slash 且 PTY 可用才选择 PTY。**不会因为 transport 表有 ACP/desktop 声明而自动选择对应 runner**，详见 F02/F03。
- [BuildWebUIChatRuntimeService](../../internal/host/aihserver/webui_chat_runtime_routes.go#L30) 未注入替代 `NativeRunner`；因此本页对默认 runner 的结论有组合根依据，不只是讨论可替换接口。
- Node [native-session-chat.js](../../lib/server/native-session-chat.js#L133) 仍有 ACP approval/session 与 ZCode Desktop 分支；源码存在不证明上述 Go 默认路径会委托它们。

Codex peer 拆分后的当前边界也已读入：[pool](../../internal/runtime/chatruntime/codex_client_pool.go) 按 scope/fingerprint 租用；[connection](../../internal/runtime/chatruntime/codex_rpc_connection.go) 合并连接与 initialize；[dispatch](../../internal/runtime/chatruntime/codex_rpc_dispatch.go) 用有界队列保持通知顺序；[turn handle](../../internal/runtime/chatruntime/codex_turn_binding.go) 绑定连接代次；[release](../../internal/runtime/chatruntime/codex_thread_release.go) 用 thread/unsubscribe 与 closed 事件收口，失败关闭该代连接。这些是静态保护点，不是并发、迟到事件或进程清理已验收。

### 稳定意图 / 原生协议 / 当前 owner

| 稳定意图 | 原生或 wire carrier | 当前源码 owner / 不可混淆点 |
|---|---|---|
| 选择执行模式与身份 | Gateway endpoint 或原生 credential/environment/projection | `providerlaunch` 决策，`clilaunch` 适配，`providercli` 执行；不让 renderer 猜账号 |
| 选择模型、reasoning、服务档 | CLI 原生参数；HTTP `reasoning/thinking/service_tier`；Codex RPC `model/effort` | 模型目录/effortalign + 对应 adapter；速度与推理强度是不同轴 |
| 开始/恢复/分叉会话 | Provider session/thread/conversation ID；原生恢复入口；RPC `thread/*` | Node `provider-resume` 管持久 CLI 恢复，Go sessionchat 管 WebUI argv，Codex driver 管 RPC；不能把一种“最近会话”语义泛化 |
| 发送一轮、补充输入 | RPC `turn/start` / `turn/steer`；Claude stream-json stdin；ACP `session/prompt`；PTY 输入 | 不同 transport 的输入所有权不同；有 command handler 不等于支持中途 steer |
| 工具/审批/问题 | canonical tool identity；RPC server request；Claude permission tool；ACP permission | HTTP tool renderer 不执行工具；原生 agent/审批桥执行或确认；`[tool:name]` 文本不能替代结构化工具事件 |
| usage/响应终态 | provider usage / terminal event / exit status | 上游 decoder、relay usage tee、chat driver 各自负责；进程 exit 0 不等于模型成功终态 |
| 取消/释放 | request context、RPC `turn/interrupt`、process Abort、thread unsubscribe/lease release | 取消 ACK、停止输出、进程释放、子进程树清理需要分别证明 |
| 独立审查意图 | 不要求存在字面名为 `advisor` 的工具 | 按仓库 intent resolution 链；本轮采用显式 `self_review`，没有调用 subagent，也不宣称独立审查 |

## 3. 16 Provider 矩阵：声明、wire 与可执行边界

所有行均为 `source_audited / runtime_not_verified`。`C` = Go canonical，`R` = Go 限定入口 relay；`N` = Go 默认 NativeSessionDriver；`D` = Go Codex RPC driver。`N` 表示**会分派到该实现**，不表示该 Provider 已能成功执行。

能力缩写严格对应 manifest：`K` API-key/token account、`M` model catalog、`Q` quota usage、`Rtm` session runtime、`GP` gateway profile、`H` session history、`S` account-scoped session store、`U` usage scan、`A` ACP session。未列出就是该 manifest 未声明，不是对上游产品能力作否定。除 Gemini 为 `deprecated`（保留显式调用、不进自动候选），其余 `gateway=active`。

| Provider / CLI 声明 | manifest capabilities | 推理 wire / 当前源码 owner | WebUI 原生执行边界 | 会话身份与同步声明 |
|---|---|---|---|---|
| **codex** / 是 | K M Q Rtm GP H U A | C：Responses 变体；[codex/responses](../../internal/adapters/codex/responses/adapter.go)，另有 Responses WebSocket adapter | D：app-server JSON-RPC，不走 N 的 codex exec 分支；CLI native 策略为 `codex` | `state_*.sqlite`，hook/json_hooks；Node 恢复要求精确 thread、去重；RPC 另绑定 thread/turn |
| **gemini** / 是 | K M Q H U A | C：Gemini Code Assist；[GeminiAdapter](../../internal/adapters/agy/codeassist/gemini_adapter.go) 另有 standard API 分支，见下方门控说明 | N；transport 默认 PTY，但普通 turn 实际按 stream process 启动；ACP 由 Node 布局登记，F02/F03 | `sessions`，hook/json_hooks；持久恢复依赖已解析 session file，交互恢复与文件导入不是同一身份保证 |
| **claude** / 是 | K M Q Rtm GP H U A | C：Anthropic Messages；[claude/messages](../../internal/adapters/claude/messages/adapter.go) | N：stream-json；POSIX stdin 支持 steer；审批走专门 MCP callback，slash 才走 PTY | `projects/<project>/<session-id>.jsonl`，hook/json_hooks；有 ID 精确恢复，无 ID 的 Node fallback 是同 cwd 最近会话 |
| **agy** / 是 | M Q Rtm H U | C：AGY Code Assist agent envelope；[agy/codeassist](../../internal/adapters/agy/codeassist/adapter.go) | N 构造原生 print/conversation 输入；声明 PTY-transcript，但普通 turn 没接 transcript runner，F02 | workspace-scoped conversation，hook/agy_named_hooks；conversation ID 不能当 Codex thread |
| **opencode** / 是 | K M Rtm GP H U A | R：OpenAI-compatible Chat Completions；[opencoderelay](../../internal/transport/http/opencoderelay/provider.go) 去模型 namespace | N：run JSON；默认 v2 standalone layout，Go 构造器不做版本探测；confirm/plan 的 serve spawner 默认不可用 | `opencode.db`，hook/opencode_plugin；session 身份；v1/v2 目录布局不同 |
| **grok** / 是 | K M Q H S U | R：xAI Chat Completions；[grokrelay](../../internal/transport/http/grokrelay/provider.go) | N：single / streaming-json；不能把流事件形状相似当成 ACP 服务入口 | `sessions`，hook/json_hooks；精确 ID 恢复与 latest 分开；未声明 ACP |
| **qoder** / 是 | M H S U | R：客户端 WASM 签名 + zstd 请求、封装 SSE；[qoderrelay](../../internal/transport/http/qoderrelay/provider.go) | N：stream-json；builder 返回 `qoder`，Native launch 策略/manifest 为 `qodercli`，F04；ACP layout 与 capability 集合不一致，F01 | nativeStore 空（不等于无历史适配器），polling；有 ID / latest 区分；账号边界另有 `--config-dir` |
| **qodercn** / 是 | M H S U | R：同 Qoder adapter，区域 variant，不可混站点 | N：builder `qodercn` 对比声明 `qoderclicn`，F04；ACP layout 行为未验证推断，F01 | 同 Qoder，polling；不能将全球站入口证据当 CN 运行证据 |
| **kimi** / 是 | K M Q U GP A | R：Kimi Chat Completions 变体；[kimirelay](../../internal/transport/http/kimirelay/provider.go) 翻译 thinking/max tokens | N 命令构造集合不含 Kimi，start/resume 返回 unsupported；普通 Native launch 有 `kimi` strategy；ACP 另归 Node | `sessions`，sync unavailable；`provider-resume` 显式列为无通用重启恢复策略，不猜恢复 flag |
| **kiro** / 是 | M H S Q U | R：Coral GenerateAssistantResponse + AWS event-stream；[kirorelay](../../internal/transport/http/kirorelay/provider.go) | N start/resume 集合不含 Kiro；Native launch 为 `kiro-cli`；无 ACP 声明 | `data.sqlite3`，polling；TUI 内会话意图，不能泛化为 argv resume；manifest 原生配置含 effort 入口但 N 没有对应投影 |
| **zcode** / 是 | K M H Q U | R：`/v1/messages` + harness/设备字段，relaycore 转回 Chat Completions；[zcoderelay](../../internal/transport/http/zcoderelay/provider.go) | transport 声明 desktop-session；N 的命令集合含 ZCode 但 switch 无实现 → unsupported，F02；Node 保留 desktop runner | `cli/db/db.sqlite`，sync unavailable；Node 恢复使用 session ID，CLI 历史与 Desktop 会话不能因同名合并 |
| **codebuddy** / 是 | K M H Q U A | R：家族 `/v2/chat/completions`；[codebuddyfamilyrelay](../../internal/transport/http/codebuddyfamilyrelay/provider.go) | N：家族 stream-json；Native launch family strategy 为 `codebuddy`；审批 ACP 未被默认 N 接线，F03 | projects JSONL，polling；CLI session 与 IDE 独立存储，恢复前须识别来源 |
| **codebuddycn** / 是 | K M H Q U A | R：同家族，CN site variant | N builder 返回 `codebuddycn`，manifest/launch strategy 为 `codebuddy` + 站点环境，F04；资源 runtime 为 native-cli | projects JSONL，polling；站点/账号/session 三种身份不得混合 |
| **workbuddy** / **否，仅 Desktop** | K M H Q U A | R：家族 wire；provider 仍独立，不并成 CodeBuddy 账号 | N 有家族 argv 分支，但直接查找 `workbuddy`；Native launch family strategy复用 `codebuddy`。这两点都不证明独立 CLI 已安装；资源 lane 为 desktop-node | projects JSONL，polling；资源入口指向 Desktop bundle，不是通用聊天 runner 已连接 Desktop 的证据 |
| **workbuddycn** / **否，仅 Desktop** | K M H Q U A | R：家族 wire、CN variant | 同上，N 查找 `workbuddycn`；资源 lane 为 desktop-node；不要为凑“16 CLI”增加对外承诺 | projects JSONL，polling；保留 CN provider/site 身份 |
| **cline** / 是 | K M GP H S Rtm U A | R：OpenAI-compatible Cline endpoint；[clinerelay](../../internal/transport/http/clinerelay/provider.go) | 新建 N 用 JSON；续聊声明 ACP，但 N 普通续聊仍构造非交互 argv，F02/F03 | `data/db/sessions.db`，sync unavailable；Node 精确 session 去重，无 ID 不伪称恢复；没有安全 latest 动作 |

### 原生资源与会话能力的补充边界

- Codex / Claude / Gemini / 家族的 MCP、plugin、skill 声明各有原生格式和路径；OpenCode MCP 为 `json-opencode`，Cline 为 account-scoped `json-cline`。AGY/OpenCode 的 skills 是 `projection-only`，不能写成原生 skill 安装能力。
- Grok、Qoder/CN、Kimi、ZCode 等空 MCP/plugin/skill 项不允许靠相邻厂商布局猜测；Kiro 虽声明 MCP，也不因此拥有 ACP session runner。
- [NativeResourceRuntime](../../core/providers/model.go#L298) 与 [nativeresources/runtime.go](../../internal/runtime/nativeresources/runtime.go) 能解析 WorkBuddy bundled resource lane；本轮没有执行任何资源命令，未审其安装/权限生命周期。
- [provider-resume.js](../../lib/runtime/provider-resume.js#L288) 的恢复身份键与 [sessionchat/command.go](../../internal/runtime/providercli/sessionchat/command.go#L448) 的一次 WebUI 命令输入不是同一层。空 resume argv 表示普通重启，不是“恢复成功”；fork 要产生新身份，不能复用同一精确会话写入者。

## 4. Model / effort / speed：从展示到执行的投影

### 4.1 共有的表示规则

- 模型展示 ID、路由 `effectiveModel`、原生模型名分开；客户端协议与账号 Provider 也分开。模型同名不能证明同一账号权限或同一 wire 模型。
- `core/inference.ReasoningConfig` 区分 effort / budget / adaptive。当前 ladder 为 none、minimal、low、medium、high、xhigh、max、ultra；这只是 canonical 词汇，**不是每个模型都支持全部档位**。
- [effortalign.Apply](../../application/effortalign/aligner.go#L47) 从目标 Provider/model 元数据读取 ladder；未知 ladder 保留原意图，已知空 ladder 的处理有 F11 所述边界。只对已装配 aligner 的 Codex/Claude adapter 生效，不要宣传为全部 relay 的统一算法。
- Speed 是 `ServiceTier`，不是 effort。目录 [ServiceTierReader](../../application/modelmetadata/service_tiers.go) 自己明确“metadata 不是账号 entitlement 或 execution speed 证明”。

### 4.2 各通道投影表

| 范围 | 模型与 effort 当前投影 | speed / 版本边界 |
|---|---|---|
| Codex HTTP canonical | Responses decoder → `Request.Reasoning`；adapter 先 `effortalign.Apply` 再 `encodeReasoning`/request profile，写目标 effective model | [request_encoder.go](../../internal/adapters/codex/responses/request_encoder.go#L81) 将 `fast` 译为 `priority`，其他已接受 tier 原样交给 wire；不保证上游授权或实际速度 |
| Codex 模型发现 | [newCodexModelList / codexReasoningLevels](../../internal/transport/http/modelsapi/codex_projection.go#L88) 从 `AIHReasoningEfforts` 投影，不再固定空列表；不应重复修复已存在的 peer 改动 | [modelsapi.handler](../../internal/transport/http/modelsapi/handler.go#L169) 先查 exact codex/model tiers，priority→Fast；源码另有特定模型名的 Ultrafast 补位。空 lookup 会提前 continue；这是源码策略，不是本轮对厂商“最新支持”的验证 |
| Codex WebUI native | [CodexNativeModelCatalog](../../internal/runtime/chatruntime/codex_history.go#L1840) 从 app-server `model/list` 读 supported/default efforts；[BuildCodexTurnStartParams](../../internal/runtime/chatruntime/codex_adapters.go#L87) 写 `model`、`effort`、collaboration settings | 该 turn builder 无 serviceTier 参数；不能从 HTTP 模型页有 Fast 推导 RPC 每轮也收到 Fast。native catalog 缓存在实例上，需另核升级/失效策略 |
| Claude HTTP canonical | [encodeReasoning](../../internal/adapters/claude/messages/request_encoder.go#L470)：budget→enabled + budget_tokens，adaptive→adaptive，effort none→disabled，其他 effort→adaptive + output effort；校验预算/temperature | 不消费 canonical ServiceTier；不要把 Codex Fast 语义静默映射到 Claude；跨 provider 的服务档策略尚需单独合同决策 |
| AGY HTTP canonical | 目标 wire model + catalog thinkingLevel；[encodeRequest](../../internal/adapters/agy/codeassist/request_encoder.go#L121) 为 level 变体注入 thinkingLevel，并为输出预算留 reserve | 普通 canonical reasoning/budget 没有在该 encoder 中消费，见 F10；无统一 speed 投影 |
| Gemini HTTP canonical | [GeminiAdapter](../../internal/adapters/agy/codeassist/gemini_adapter.go) 构造 Code Assist 请求；客户端 Gemini decoder 只取已定义的采样/长度字段 | Gemini `generationConfig.thinkingConfig` 没进入当前 DTO，F10；不能把 response reasoning 能力推导成全量 request reasoning 参数支持 |
| Cline、Grok relay | `relaycore.BaseProvider.RewriteRequest` 默认保留原 body；模型由 relay 路由再投影 | 原字段透传不是经 canonical 校验/ladder 对齐；effort/tier 最终是否被上游接受未验证 |
| OpenCode relay | [RewriteRequest](../../internal/transport/http/opencoderelay/provider.go#L84) 去模型 provider namespace，其余字段按原始 JSON 保留 | 不等于 OpenCode 全部模型具备同一 effort/speed；原生 CLI v1/v2 layout 不由 HTTP metadata 决定 |
| Kimi relay | [AdaptChatRequest](../../internal/transport/http/kimirelay/provider.go#L226) 将 reasoning_effort→thinking.effort，none/off→disabled，max_tokens→max_completion_tokens；已有原生字段优先 | 未见独立统一 speed mapping；不覆盖原生 thinking 意图以强行统一 |
| Qoder / QoderCN relay | [deriveQoderModelRequest](../../internal/transport/http/qoderrelay/body.go#L296) 依模型条目的 IsReasoning 和显式关闭开关，effort 写入 provider 参数；不凭模型名称点亮 reasoning | WASM/目录版本是协议依赖；没有通用 tier 对齐承诺，也没有本轮运行证据 |
| ZCode relay | wire 为 Messages；harness 改写与 relaycore 按协议转换共同决定请求/响应 | 不能因入口叫 Chat Completions 就假定 reasoning_effort/service_tier 字段能原样落地；本轮未证明各变体全部参数保真 |
| Kiro relay | [parseChatRequest / RewriteRequest](../../internal/transport/http/kirorelay/provider.go#L113) 读取 model/messages/tools 数量，再编码 conversationState；不是 canonical ReasoningConfig | 未投影 effort/tier；工具/图片等降级由其 conversation encoder记录，不能用 reasoning 输出事件反证请求控制已支持 |
| CodeBuddy / CodeBuddyCN / WorkBuddy / WorkBuddyCN relay | [request_rewrite.go](../../internal/transport/http/codebuddyfamilyrelay/request_rewrite.go) 保留未改字段，补 system、归一 tool_choice；有损降级通过 `x-aih-degradations` 可见 | 原样保留 effort/tier 不等于厂商支持；必须逐 provider/site/版本验证 |
| WebUI 普通 GoChat 路径 | [GoChatDriver.execute](../../internal/runtime/chatruntime/driver_gochat.go#L247) 将 model/reasoningEffort 交给 in-process streamer，[webuichatapi](../../internal/transport/http/webuichatapi/handler.go#L822) 写 reasoning_effort；与 N 的字段集不同 | GoChatCapabilities 的 reasoning/tool unsupported 指输出时间线能力，不等于没有发送 effort；该请求结构未承载 speed；不能将原生 Codex capability 套给普通 chat |
| 非 Codex WebUI N 路径（表中所有 N） | 只传 `Model`；`NativeRunRequest`/StartOptions/ResumeOptions 没有 effort/speed；[readComposerCatalog](../../internal/runtime/chatruntime/driver_native.go#L1717) 即使有模型 reader 也返回空 efforts，当前组合根连 reader 也未注入，F08 | 不改官方 CLI 的原生能力声明；这里只能说明 AIH 该入口没有参数投影，不能宣传完整模型设置可执行 |
| 原生 CLI direct 路径（14 个对外 CLI） | 托管参数之外继续透传原生命令；模型/effort 的原生交互属于官方 CLI，而非 WebUI N 的字段集 | 不新增伪 `/effort` 命令、不把 slash 注入 prompt、不 fork 上游；当前安装版本和可用原生参数未验证 |

## 5. 必须保持的响应、事件、工具、用量、身份和取消不变量

以下是**验收合同 + 已见源码支点**，不是“均已通过”。HTTP canonical、relay、WebUI native 必须分别取证。

| 不变量 | 已见 owner / 静态保护 | 尚未证明或明确缺口 |
|---|---|---|
| 响应协议归入口 | `ClientProtocolID` 与 Provider/Protocol 分离；request-scoped Exchange 生成 renderer/aggregator | relay 不走同一 canonical 事件层；跨协议完整字段、HTTP/WS 等价、非流式/流式终值一致仍需真实请求 |
| 事件有序且终态唯一 | [attemptStream.Accept / FlushTerminal](../../application/inferencegateway/attempt_stream.go#L49) 要求每 attempt 序号从 0 连续，拒绝 terminal 之后的事件，先记录再发唯一终态 | WebUI EventEnvelope 是另一套 session 序列；不能拿 HTTP 事件序号替代。N 的成功终态不要求 provider terminal，F06 |
| 不把断流当成功 | Codex/Claude HTTP adapter 检查 EOF/terminal；Responses renderer 拒绝无 carrier 的 redacted thinking，而非伪造 encrypted_content | 需要验证上游断流、尾帧和 renderer 写失败；N 有 F06；错误展示不应泄漏 provider 原始敏感响应 |
| 工具身份/顺序/结果关联 | [ToolIdentity](../../core/inference/tool_identity.go) 分开 namespace/name；工具调用保留 call ID、参数增量与终值；AGY [toolNameMapper](../../internal/adapters/agy/codeassist/tool_names.go) 显式双向映射 | N 把 tool_use 变成文本，F05；HTTP tool 支持不等于原生 permission/question/工具执行能力 |
| usage 是累计快照，不重复计数 | [inference.NewUsage](../../core/inference/usage.go#L30) 校验缓存子集、reasoning 子集及溢出；attempt 保存最近 usage；relay [trackUsage](../../internal/transport/http/relaycore/handler.go#L837) 旁路结算 | N 只投影 input/output，F07；实时 timeline、历史扫描和最终记账是否去重不是本轮已验证内容 |
| 稳定身份不混淆 | Launch planner 对齐 AccountRef/Provider；Node 恢复精确键；Codex RPC 区分 thread/turn，pool key 为 runtimeScope+fingerprint | N 选定 AccountRef 未形成通用进程环境交接，F09；Codex [GetVerifiedAccountIdentity](../../internal/runtime/chatruntime/codex_rpc.go#L255) 可从绑定 AccountRef 返回 Verified=true / Assurance=runtime-home，connection 也采用该 assurance，不能冒充本轮取得了上游账号身份证明。刷新、切号、恢复状态机留待后续 |
| 审批能力必须有可执行通道 | Claude 专用 callback、Codex server requests；未知 approval mode/缺 transport 可报 unsupported | ACP/desktop native capability 声明比默认 runner 更宽，F03；确认/计划模式不能仅靠标签宣称成立 |
| 取消与资源释放可区分 | HTTP context/response Close；[Codex InterruptTurn](../../internal/runtime/chatruntime/driver_codex.go#L473) 发 turn/interrupt；N Abort 取消 context、kill 直接进程并关闭管道；pool/turn handle 另做 release | 取消 ACK 不是进程树消失证明；子进程/MCP、连接复用、迟到事件、等待审批/输入时取消均需真实验收。peer 正在改此区域，勿并行修复 |
| 已输出内容不能静默换号重播 | HTTP coordinator 依据 stream.Visible 限制重试；N 在有内容且有 session ID 时使用 continuation prompt，并显式发 account_switched notice | 两条重试策略不是同一个合同；原生会话能否跨账号继续、是否重复工具副作用需后续身份/生命周期任务取证 |
| capability 有来源且只承诺可执行部分 | manifest、ACP layout、RPC model/list、模型 metadata 各有来源；GoChat 明确将 tools/reasoning 等标 unsupported | native capability 表未逐 provider/transport 做同等门控，见 F02/F03/F05；版本、发现时间、缓存容量/失效仍未统一闭环 |

## 6. 高置信静态差异：待复现/方案，不是运行故障结论

状态统一：`static_discrepancy_confirmed / runtime_not_verified / no_fix_applied`。P1/P2 为排查优先级候选，不代表已观察到生产损害。下面只列能够沿当前源码定位的差异，不将“没查到”泛化成全产品不支持。

### F01 · P2：Qoder ACP 入口登记与发现能力不一致

- **证据**：[ACP_LAYOUTS](../../lib/runtime/acp-layouts.js#L139) 已有 qoder / qodercn，`buildAcpEntryArgs` 能构造入口；manifest 与 [builtins](../../core/providers/builtins.go) 两者都未给它们 `acp_session`，[qoder descriptor](../../lib/providers/defs/qoder.js) / [qodercn descriptor](../../lib/providers/defs/qodercn.js) 也没有 acp 能力。
- **精确影响**：问 manifest/descriptor 和问 ACP layout 会得到不同支持集合。Qoder 的历史 verified 行与 QoderCN 的 inferred 行也不能等价。
- **下一步**：先决定发现合同要表达“已登记/历史验证/本机可执行”的哪一层，再在声明/布局边界对齐；不能为消除差异直接把 CN 标成已验证，不能将其等同 Go ACP runner 已实现。

### F02 · P1：默认 Go native runner 不消费 transport 分派

- **证据**：[ResolveNativeChatTransport](../../internal/runtime/providercli/sessionchat/transport.go#L68) 声明 Cline resume=ACP、ZCode=Desktop、AGY/default=PTY；[execNativeTurnRunner.Start](../../internal/runtime/chatruntime/driver_native.go#L1806) 仅按 `req.Slash && pty.Available()` 选择 PTY，其余走 stream process，没有 ACP/desktop/transcript 分支。
- **确定差异**：Cline 普通续聊落入 [BuildResumeCommand](../../internal/runtime/providercli/sessionchat/command.go#L622) 的非交互形态，而不是 ACP；ZCode 虽在 official set，start/resume switch 无实现；Gemini/AGY 的 PTY/transcript 声明不约束普通 turn 的执行器。
- **下一步**：在 transport resolver→runner adapter 边界接真实 transport 或明确 unsupported；不要在大 driver 里继续增加厂商 if，也不要依赖旧 Node runner 的存在假定自动 fallback。需要新建/续聊各一轮的真实身份与终态证据。

### F03 · P1：审批 capability 的 spawner 名称不足以证明审批链可执行

- **证据**：[defaultApprovalTransports / ResolveNativeApprovalTransport](../../internal/runtime/chatruntime/driver_native.go#L43) 将 Gemini、Cline、家族、Qoder/CN 的 ACP permission 与 ZCode plan 声明为默认 `native-stream` spawner 可用；[StartTurn](../../internal/runtime/chatruntime/driver_native.go#L1230) 据此放行。默认 runner 只有 Claude 调用 `configureClaudeApprovalArgs`，并未用已解析 channel 选择 ACP/desktop executor。
- **精确影响**：capability 可返回 native/可接受 confirm 或 plan，但不等于已安装 permission request/answer 往返。不能据此断言某原生 CLI 一定绕过审批，实际可能阻塞、失败或采用自身默认策略。
- **下一步**：能力判定取真实 runner/channel 注册结果；未接线时 fail closed 或降为明确 unsupported。真实确认、拒绝、取消、过期 reply 和 plan 行为分别验证；保持当前 UI 结构，不加大提示块掩盖缺口。

### F04 · P1：WebUI argv builder 与 Native launch 的可执行名不一致

- **证据**：[sessionchat.BuildStartCommand / BuildResumeCommand](../../internal/runtime/providercli/sessionchat/command.go#L340) 对 qoder/qodercn/codebuddycn 返回规范 Provider ID 作 CommandName；[qoder strategy](../../internal/adapters/qoder/clilaunch/strategy.go#L19) 指定 `qodercli/qoderclicn`，[family strategy](../../internal/adapters/codebuddyfamily/clilaunch/strategy.go#L14) 指定 `codebuddy`，与 manifest binaryName 一致。[binaryResolver.Resolve](../../internal/runtime/providercli/binary.go#L22) 只做 `AIH_<PROVIDER>_BINARY` override/PATH 解析，不替换成 catalog binaryName。
- **精确影响**：没有额外同名 wrapper/alias/override 时，两条路径会查找不同可执行文件；本轮未检查安装态，不能报告“本机一定找不到”。WorkBuddy 的独立 CLI 更不能由该分支推定存在。
- **下一步**：聚焦可执行描述解析边界统一 binary 来源，保留地区环境与 bundled lane；获准后读真实解析路径/版本，再验证 argv，不以创建别名绕过合同问题。

### F05 · P1：`timeline.tool=native` 与实际工具事件投影不符

- **证据**：[NativeSessionCapabilities](../../internal/runtime/chatruntime/driver_native.go#L131) 广泛返回 `timeline.tool=native`；[ParseNativeStreamLine](../../internal/runtime/chatruntime/driver_native.go#L747) 对 Claude-style tool_use 仅产生 `[tool:<name>]` 文本，ID 只用于本地去重；[executeWithRetries](../../internal/runtime/chatruntime/driver_native.go#L1503) 将其当 assistant delta，没有完整 call identity / arguments / result 的工具 timeline。
- **精确影响**：默认 live stream 链丢失结构化工具语义；后续历史导入是否能补齐不在本轮证明范围，也不能据此把 live capability 标成完整。
- **下一步**：先明确 live 与 imported timeline 的合同，降级能力或在专门 stream adapter 保留结构化工具生命周期；真实多工具、同名不同 ID、失败/取消/恢复时核对关联，不重写工具执行策略。

### F06 · P1：N 的成功条件弱于协议成功终态

- **证据**：`ParseNativeStreamLine` 对非 JSON/未识别记录返回空；[startNativeStreamProcess](../../internal/runtime/chatruntime/native_stream_process.go#L148) 读流/等待进程，没有通用“已观察 provider terminal”成功门；[executeWithRetries](../../internal/runtime/chatruntime/driver_native.go#L1573) 以 exitCode=0、无 exit err、无 stream error message 结算 completed。
- **触发谓词**：非 Claude stream-json 特殊收口的路径，若未识别输出/缺终帧而进程正常退出，源码允许 completed；是否某当前 CLI 会产生此输出未运行验证。收尾复读时 peer 已补充 Claude stream-json 的 terminalDelivered / input.incomplete 门控；它只覆盖 usesStreamJSON 路径，不应在本发现中忽略或误删。F06 保持限定于其余缺少协议终态门的路径。
- **下一步**：按 transport 明确 terminal/EOF/exit 三者关系，在 decoder/executor 交界区分成功、未知、断流；不要把 exit 0 或空正文简单等价成成功/失败，也不要覆盖 peer 的尾帧 drain 修复。

### F07 · P2：native 实时 usage 被缩减，不能等同 canonical usage

- **证据**：[extractStreamUsage](../../internal/runtime/chatruntime/driver_native.go#L811) 只返回 inputTokens/outputTokens；缓存读写、reasoning 子集未带出；Gemini/Grok result 分支也没有同等 usage 投影。canonical [UsageInput/NewUsage](../../core/inference/usage.go#L5) 明确保留这些子集。
- **精确影响**：N live timeline 的 metric 表达力较弱，不足以证明成本/缓存/推理用量完整；**不据此断言最终历史扫描或账单必然错误**。
- **下一步**：由 provider decoder 保留 source、计数口径、未知值与累计语义；后续真实 final usage 对账，同时检查历史导入去重，不能用估算 token 冒充上游值。

### F08 · P2：非 Codex native 模型目录回调在默认组合根缺席

- **证据**：[BuildWebUIChatRuntimeService](../../internal/host/aihserver/webui_chat_runtime_routes.go#L47) 没传 `ReadProviderModels/ResolveDefaultModel`；[resolveNativeEntry](../../internal/runtime/chatruntime/service.go#L1170) 直接传给 NativeDriver；[readComposerCatalog](../../internal/runtime/chatruntime/driver_native.go#L1717) 在 ReadModels=nil 时返回空目录。即使有 reader，SupportedEfforts 固定空，NativeRunRequest 无 effort/speed 字段。
- **精确影响**：默认 N composer 目录与 catalog capability/其他模型页不是同一可执行合同；显式 model 字符串仍可能到 argv，不能说全部推理不可用。也不能顺手把官方 CLI 的 effort 支持删掉。
- **下一步**：先在组合根接只读模型端口并明确 per-provider 参数能力；只有执行器确能消费才展示可调档位，保留原生 CLI 逃生门。此项不重做已被 peer 修好的 Codex 模型列表。

### F09 · P1：选定账号到 native 子进程的身份交接不完整（仅边界审查）

- **证据**：N 接收 `NativeRunRequest.AccountRef`，但 [Start](../../internal/runtime/chatruntime/driver_native.go#L1842) 只据它解析 runtimeDir 并调用 config-dir args；当前该 flag 仅 Qoder/CN 声明。[startNativeStreamProcess](../../internal/runtime/chatruntime/native_stream_process.go#L43) 与 [startInteractivePTY](../../internal/runtime/chatruntime/driver_native.go#L1902) 均直接用 `os.Environ()`，未复用 `providerlaunch.LaunchPlan` 的账号环境/投影。[providercli.runNativeDirect](../../internal/runtime/providercli/runner.go#L200) 则有单独的账号绑定与投影交接。
- **精确影响**：可证明默认 N 没把 AccountRef 转成通用 provider-scoped 启动环境；实际使用了谁的凭据取决于宿主/文件/CLI，本轮没读这些状态，**不宣称已经发生串号**。
- **下一步**：优先限定执行 spec 的身份交接合同，避免 server 环境成为隐式账号选择器；后续独立账号生命周期任务再查凭据准备/刷新/写回。任何真实双账号验收需另行授权，不能在本轮探测。

### F10 · P2：Code Assist reasoning 请求控制的投影缺口

- **证据**：Gemini 客户端 [DecodeWithModel / generationConfigDTO](../../internal/adapters/clientprotocol/gemini/request.go#L103) 允许未知字段但没有 thinkingConfig，最终 `RequestInput` 不设 Reasoning；AGY [encodeRequest](../../internal/adapters/agy/codeassist/request_encoder.go#L121) 从模型目录 thinkingLevel 而非 `request.Reasoning()` 构造 thinkingConfig；Gemini adapter 的 `encodeGeminiInnerRequest` 也未消费该 canonical reasoning。
- **精确影响**：Gemini 入口携带的该字段不会被投影；其他入口已解出的 effort/budget 也不能据 capability=Reasoning 推定能到 Code Assist wire。输出 reasoning/连续性支持与请求强度控制是不同能力。
- **下一步**：分别定义支持的输入控制与输出能力，明确 unsupported/可观察降级；先确认真实版本和目标模型语义再决定映射，不为统一词汇伪造 thinkingLevel。

### F11 · P2：空 effort ladder 可丢掉混合 reasoning 的预算/模式

- **证据**：[effortalign.Apply](../../application/effortalign/aligner.go#L47) 在带非空 effort 且已知目标 ladder 无可对齐项时调用 `ReplaceReasoning(nil)`；canonical/Anthropic decoder 允许 budget/adaptive 与 effort 共存。该 aligner 已装配到 Codex/Claude adapter，不是未接线 helper。
- **精确影响**：对“budget/adaptive + effort + 已知空 ladder”的输入，删除的是整个 ReasoningConfig，不只 effort；注释中的“保留其它语义”没有在该分支执行。缺 metadata（found=false）的路径不会触发此分支。
- **下一步**：明确空 ladder 代表“无 effort 档位”还是“禁止所有 reasoning”，再决定保留模式/预算、拒绝或显式降级；不得只修显示档位而让实际请求静默丢预算。真实混合意图验收需单独授权。

## 7. 并行工作冲突与快照有效性

没有观察到 Git unmerged paths；下面是**编辑归属/快照冲突**，不是已发生 merge conflict。全部只读，没有对 peer 代码做修复或回退。

### 直接重叠：收尾读取摘要（非冻结快照）

| 路径（相对仓库） | 状态 | SHA-256 前 12 位 / 审查边界 |
|---|---|---|
| `internal/runtime/chatruntime/driver_native.go` | peer modified | `b278c5645272`；审批、stream 投影、runner、尾帧结算，与 F02–F09 重叠 |
| `internal/runtime/chatruntime/native_stream_process.go` | peer untracked | `b4af43858ad9`；进程/管道/取消，不使用 HEAD 中旧内联实现代替 |
| `internal/runtime/chatruntime/native_claude_input.go` | peer untracked | `eb1623061d27`；Claude stdin/steer/result 收口 |
| `internal/runtime/chatruntime/driver_codex.go` | peer modified | `436ff0af3ea8`；lease、turn binding、interrupt/release |
| `internal/runtime/chatruntime/codex_rpc.go` | peer modified | `2e80d671ff71`；当前已拆文件，不能只读旧单文件 |
| `internal/runtime/chatruntime/codex_client_pool.go` | peer untracked | `64b97a074ad6` |
| `internal/runtime/chatruntime/codex_rpc_connection.go` | peer untracked | `3e400ecbdbb0` |
| `internal/runtime/chatruntime/codex_rpc_dispatch.go` | peer untracked | `37222e663b72` |
| `internal/runtime/chatruntime/codex_turn_binding.go` | peer untracked | `4b1c4e326e01` |
| `internal/runtime/chatruntime/codex_thread_release.go` | peer untracked | `ce6db1f9a543` |
| `internal/transport/http/modelsapi/codex_projection.go` | peer modified | `933aeb41ebca`；reasoning levels 已有窄改动，不重做 |

其他关键读源摘要：manifest `aa6fea999a90`；builtins `c7fb2e973bad`；routeownership `255b12838c87`；launch intent `28f2ce1aa05e`；aihcli composition `bfebda50d7e7`；relay_modules `4117e6a5d561`；sessionchat command `20279a936d7e`；provider-resume `c77f0f741d55`。

相邻 peer 编辑还包括 `go.mod`、`internal/transport/http/{frontdoorapi,webuiauth,webuicontrolplaneapi,webuicontrolplanebootstrapapi,webuiassets,webuimanagementapi,webuiopenappapi,webuipublicalias,webuisessionwatchapi,accountrulesapi,upstreammappingapi}`、`lib/cli/complete/`、`lib/cli/services/shell/` 和 shell-router；本轮没有编辑或执行其中的测试。审计期间 server lifecycle 等相邻改动由 peer 落入新 HEAD，Codex/native-stream peer 源码也继续演进；均不是本轮提交。收尾重读了变化的 stream terminal、RPC/turn ownership 相关路径，以上发现以标明的函数与条件为限。

`docs/product-integrity/` 已有 CLI/web/shell/inventory 文档及证据文件、批准计划及 `scripts/product-inventory/` 也是 peer 工作，未改写、未重生成。源码继续变动时以**函数名 + 当前内容**重新定位；上述 hash 只是本轮证据锚，不是可重建发布物。后续修复必须先重新核对归属、暂存区和相关 diff。

## 8. 可执行的下一批工作包（本轮均未实施）

| 顺序 / 工作包 | 最小拟改边界与依赖 | 获批后需要的真实证据；退出条件 |
|---|---|---|
| 1 · Native 执行身份交接（F09） | 先与 chatruntime peer 约定边界；围绕 runner 输入的 launch spec/作用域接线，不在 driver 里重写账号库 | 使用授权的不同账号/作用域，核实际进程配置根与会话归属，不记录 token；错误身份必须阻止执行。账号刷新/导入/删除另任务 |
| 2 · transport / executable / approval（F02–F04） | `sessionchat` 声明→runner 选择→binary resolver→对应 ACP/desktop/PTY/stream adapter；capability 从真实接线导出 | 每种已声明且可用 transport 的新建、精确续聊、确认/拒绝、取消；分别核 provider/version/account/session/run。不可用的版本/平台保留 unsupported，不造 wrapper 假装支持 |
| 3 · 原生事件完整性（F05–F07） | decoder/stream executor 的窄接口；等待 peer 尾帧、stdin、取消拆分稳定后再改 | 真实文本+工具、usage、错误、缺终帧/断连、等待输入时取消；保留原始事件身份和最终状态摘要；无重复工具副作用、无挂住的子进程/读协程 |
| 4 · capability / model 参数闭环（F01、F08、F10、F11） | 先定支持语义，再动 builtins/ACP layout、组合根目录 reader、effortalign 与 provider encoder；不建第二套总 schema | 展示→选择→实际 argv/RPC/wire→回显模型/effort/tier；未知、不支持、混合 budget、版本变化分开验证；不能仅凭菜单出现就通过 |
| 5 · HTTP canonical / relay 协议验收 | 依现有四 canonical + 十二 relay 边界逐组排期，不批量迁移 ownership | 在批准的真实请求中记录入口协议、路由 Provider/model、tool IDs、终态、usage、取消和降级 header；HTTP/WS/聚合/流式分别记账；费用/网络调用需授权 |
| 6 · 原生版本与会话身份复核 | Node provider-resume 与 Go command/RPC 各自 owner；沿用 CLI map，不复制命令总表 | 核官方版本与可用入口、resume/fork 是否沿用/生成新 ID、旧版本/缺 binary 的失败恢复；Desktop-only 不强行计入 CLI 覆盖率 |

后续每项工作包都要记录：支持对象/版本/入口、原始意图、编辑边界、可观察失败、最小方案、真实验收、回退方式、运行态/提交/发布各自状态。不得凭本页静态矩阵直接标记 M2/M3 完成。

## 9. 追加运行观察：L01 · Codex 模型目录缺少 live parity

**观察时间：2026-11-15 约 00:48（Asia/Shanghai）。来源：用户提供的只读 live check；本次文档更新未自行请求 HTTP、检查运行进程或二进制。** 原 source map 仍是 documentation only。本项状态为 **`reported_live_parity_gap / independently_unverified / owner_investigation_pending`**，不与 F01–F11 的静态发现或整体验收混计。

入口路径沿用用户报告，不补写未经确认的主机、端口或路径前缀：

| 用户报告的观察 | 记录值 / 证据边界 |
|---|---|
| `/readyz` | HTTP 200，`ready=true`；只证明该次 readiness 响应，不证明模型字段或当前源码的运行一致性 |
| OpenAI `/models`，模型 `gpt-6.1-sol` | ladder 为 `low / medium / high / xhigh / max` |
| `/models?client_version=0.167.2`，同一 slug | `supported_reasoning_levels=[]`；speed 信息仍包含 `priority / ultrafast` |
| 当前源码 | 用户报告未提交 ladder 修复仍在；本次只读复核也确认 `codex_projection.go` 的 `newCodexModelList` 仍调用 `codexReasoningLevels(model.AIHReasoningEfforts)`，并由 helper 逐项输出 effort |
| 进程/制品时间线 | 用户报告 peer 约 00:46 重启 live process，binary 约 00:45 修改；二者均为 2026-11-15，未由本次文档更新独立复核 |

**当前结论仅限于缺少 live parity：** 标准模型目录已有 ladder，而带该 client version 的投影返回空 reasoning levels；speed 信息存在不代表 effort 投影也完整。现有源码修复不能据此记为已在 live 生效。反过来，重启时间和 binary 修改时间也不足以判断该进程运行的是哪份构建、由谁维护，不能直接归因为旧二进制、缓存、路由选择或修复被覆盖。

**后续 owner：主会话。** 由主会话安全核对运行进程所用 binary 的归属、构建来源与源码快照对应关系，保留 peer 状态；映射明确后，再按其授权边界补同一模型、同一服务上两种目录响应的一致性证据。本记录不授权覆盖 binary、构建替换、修改 runtime/config、重启、提交或追加推理请求，也不将此前 Fast / Ultrafast 的确认撤销为整体速度功能失败。

文档静态复核：16 行 Provider 与 manifest 集合逐项对应，CLI 声明计数 14；本地源码链接及行号范围已检查，未发现缺失路径。这里只核对文档及源码元数据，不是运行测试或协议验收。

**复核方式：`self_review`（静态对照 manifest、组合根、resolver、执行函数与事件投影）。没有独立 reviewer、没有真实运行验收。本轮交付的是协议边界与可行动审查队列，所有实现修复、运行验收和账号生命周期深入审查仍待后续工作。**
