# AIH Chat Harness：源码依据、决策和交付清单

更新：2026-09-15。状态按后端、页面、持久化和真实验收分别判定，组件存在不能代表能力完成。

最新增量：Work 分支命令、子会话事务、消息入口和父会话导航已接通，见下方「Work 产品接线」；
审批、压缩切口、原生 active goal continuation 的完整语义与真实 1M 持续会话仍未完成；AIH 侧的 goal
set/get/clear 控制面已接通。历史验收段落保留当时的范围和结果，
不能将其中的「未接入」或「已验」脱离日期当成当前整体状态。

## 固定参考来源

| 项目 | 本次读取的源码提交 | 关键源码与吸收点 |
| --- | --- | --- |
| DeepSeek Harness | `aa8262ec091698bae9a6b04773a6b5b06ad4aef2` | `packages/core/session/src/index.ts` 的 `SessionStore.fork`：不可变 seed、父会话、边界校验；`packages/api/session-controller/src/commands.ts`：从消息锚点定位已完成回合；`packages/compaction/compaction/src/checkpoint.ts`：压缩事务和检查点来源关联 |
| Pi | `4bd3f48df0b14c82e8df2640645e94f82f125f44` | `packages/coding-agent/src/core/session-manager.ts` 的 `branch/createBranchedSession`：保留原路径、独立持久分支；`agent-session.ts` 的 `_checkCompaction`：模型窗口、压缩后的旧 usage 隔离、溢出最多恢复一次；会话级 system prompt |
| Codex | `968835997714baaff199cfed5f89a2c65d8ca77d` | `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`：fork 按回合、rollback、原始 Responses items 注入；执行器负责流、原生历史和压缩 |

参考仓库位于相邻 clawdcodex 的 `reference/repos/`。只更新远端引用并用 `git show <commit>:<path>` 读取，没有覆盖其工作区。上述为源码版本，不声明等同于 npm 分发或本机运行版本；本机协议另以 native 测试验证。

## ADR：AIH 掌握会话语义，执行器可以替换

选择：继续使用现有 SessionActor、命令日志、canonical timeline、账号路由，新增消息分支和会话指令的领域能力。当前 Codex app-server 是执行适配器，不是 AIH 的账号域或完整 harness。

| 方案 | 收益 | 代价与决定 |
| --- | --- | --- |
| AIH 领域层 + 现有 Codex 适配器 | 复用已接通的流、停止、恢复、网关账号隔离、原生压缩 | 仍依赖本机 Codex；Responses 兼容性必须逐 provider 验收。本次采用 |
| 切换 Pi 内核 | 轻量 agent loop、明确的模型和会话扩展点 | 重接 native identity、事件和恢复；不能仅为替换名称迁移。保留为后续适配器候选 |
| 整体嵌入 DeepSeek Harness | 完整事件、插件和 compaction 体系 | Cordis 和其会话持久化会引入第二套领域真相。吸收机制，不整体替换 |
| 全部自己重写推理循环 | 完整控制 | 需重做协议、流、上下文、停止和恢复，当前无必要 |

重新评估条件：Codex 协议限制无法满足精确历史、模型兼容持续失效，或引入 Pi 的端到端维护成本已低于适配成本。不得宣传所有 provider 已具备同等能力；同一 Chat 命令契约与每个 provider 的真实推理能力是两回事。

## 消息操作语义

- 分支：服务端从完整持久 timeline 定位所选消息，复制截至该消息的精确前缀到独立会话；保留父会话、消息锚点、原账号、模型和角色。源会话不变。
- 重新生成：从目标 assistant 对应的 user 输入之前建立独立版本，再提交原输入；原回答可回看。不是把旧回答送回模型后追加“再回答一次”。页面切到新版本并提供父会话入口。
- 源正在运行时拒绝消息操作；未知锚点、缺失附件、无法无损转译的历史明确失败，不能默默丢上下文。
- 使用服务端持久内容，不信任浏览器提供的消息/账号/附件路径。命令 ID 保证请求重放不重复创建或执行。
- Chat 禁用工作区工具；分支历史转换器保留消息角色和图片/文档输入，不把工具执行伪装为普通文本。Work 模式的工具分支需要单独的无损协议契约。
- 与 DSH 的整回合取整不同：用户要求“截至消息”，AIH 不把同回合中锚点之后的消息带进分支。与 Pi 的原树移动指针不同：用户要求独立会话。

## 上下文和角色

- Chat 默认通用助手，可选会话级角色/指令；保存后下一轮生效并被分支继承。工作区安全策略继续由 harness 控制。
- 区分累计 token、单轮 token 和当前模型上下文；使用模型目录的真实窗口。压缩后不沿用压缩前 usage。
- 手动压缩始终可发现；前后端共享实际 compact 命令，展示进行中、成功和失败。
- 自动压缩复用执行器的模型窗口阈值和压缩能力，AIH 暴露策略及观测；不叠加第二个无界自动重试循环。

## 交付矩阵和执行顺序

| 能力 | 后端 | 页面 | 持久化/验证 | 状态 |
| --- | --- | --- | --- | --- |
| Provider 分组与图标 | 账号固定绑定 | 已接通 | `ed504dfd`，真实 Kimi 验收 | 已交付 |
| 单轮运行时间、首字时间、TPS | 后端测量 | 跟随回答 | reload 与停止验收，`ed504dfd` | 已交付 |
| 精确消息分支、重新生成 | immutable seed + lineage 事务、幂等命令、独立原生 thread | 消息按钮、返回父会话 | 精确 prefix、附件归属、重启重放和 Kimi 页面通过 | 本批已验 |
| Chat role | 持久化校验、执行前读取并注入 | 会话设置，下一轮生效 | reload、原生 resume、分支继承和 Kimi 回答通过 | 本批已验 |
| 上下文量与手动/自动压缩 | 当前用量持久投影；native 单一自动循环 | 紧凑指标、压缩入口、50–90% 阈值 | 自动阈值、失败、reload；Kimi 手动压缩后续聊通过 | 本批已验，覆盖边界见下 |
| 命令队列、停止与故障恢复 | 正常结束与停止/失败分开；持久暂停、run 边界校验、停止意图恢复 | 运行中发送入口、队列暂停状态 | 服务级、原生和真实 Kimi 停止/恢复已验；见队列专题 | 本批已补齐已发现缺口，持续审计 |
| 工具输出、工具配对、审批、并行提交顺序 | 已补终态收敛、未知结果保护、callId 配对和模型顺序提交 | 未确认结果显示“结果未知” | 进程退出、历史导入、乱序完成和原生并行工具已验；见工具配对专题 | 本批已验，Work 压缩/分支边界保留 |
| 扩展点、preset、技能、预算和调度 | `ChatRuntimeExtensionPipeline` 接入 SessionActor | 非本批 UI 目标 | waterfall/serial/observer、准备失败幂等和事件钩子顺序已验；工具执行前阻断仍未具备 | 工作区已实现并验；preset/技能产品能力未引入 |

本批先完成前三项缺口的后端→前端→native→真实页面闭环，再修正旧矩阵证据。长期专题保留明确边界，不把“全面研究”解释为复制所有插件或添加未要求的 Graph/Diff 产品。

### 扩展点契约（2026-09-13）

已把 Pi/DeepSeek Harness 的三类接缝吸收到 provider-neutral 的
`ChatRuntimeExtensionPipeline`，入口位于 `SessionActor` 的共同命令边界，所有 provider
复用同一套语义：

- `prepareNextTurn(command, context)` 是可等待的 waterfall。每个扩展可以返回新的命令，AIH
  会校验 `commandId`、`sessionId`、命令类型不变，并重新执行 payload 校验。扩展接收副本，
  不能通过原地修改逃过身份比较。准备失败保存原始命令为 `failed`，相同 ID 不重跑准备。
- `beforeCommand(command, context)` 是可等待的 serial 阶段。策略、预算或调度检查可以明确
  拒绝本次执行；拒绝会沿既有命令状态机落为 `failed`，不会进入 provider。
- `beforeToolCall(event, context)` / `afterToolCall(event, context)` 当前围绕**工具事件持久化**，
  只接收 canonical `tool`、`shell`、`file_change` 项。前者在开始事件写入前，后者在完成事件
  写入后；两者在同一写入链内等待，raw output 释放的排队事件也经过该链。它们不是 Pi 的
  原生执行前拦截器：收到 Codex `item/started` 时工具可能已执行，不能据此承诺阻断副作用。
- `observe(event, context)` 是 best-effort listener。同步异常和异步 rejection 都通过可注入的
  `extensionObserverErrorSink` 观察，不会终止模型回合；扩展可 `unregister` 清理自身。

该契约只负责扩展生命周期，不替换 `SessionActor`、SQLite 命令日志、canonical timeline 或
provider driver。当前没有为对齐命名引入 Cordis、第二个 inbox 或第二套 agent loop。测试覆盖
注册顺序、waterfall 变换、串行等待、观察者异常隔离、卸载、身份篡改拒绝和准备阶段失败后的
命令状态；Codex 工具事件还覆盖 `beforeToolCall`/`afterToolCall` 的持久化前后边界和策略拒绝。
默认未传扩展时行为保持不变。最新验证与仍开放的限制见下方 2026-09-13 集成验收。

## 验证要求

领域测试检查精确前缀、原会话不变、历史超过首屏、幂等、附件所有权和源忙碌拒绝；native 测试以空 HOME 和本地确定性模型检查实际模型输入、独立 thread、角色及压缩。Web 完整 build、限改动 ESLint、相关测试；真实 Kimi 页面验证操作、刷新、继续聊天和错误反馈。最终记录证据后才更新完成状态。

## 本批验收记录（2026-09-10）

- Node 全量串行：`node --test --test-concurrency=1 test/*.test.js`，6520 tests，6507 pass、13 skip、0 fail。先前并发全量有一项 native API-key route 的 6000ms timeout，串行通过；此后仅补充领域边界测试，未修改运行时代码。
- 消息领域：`node --test test/chat-runtime-branch.test.js`，9 pass，包括用户消息锚点不带入同回合答案、两账号附件隔离、事务失败无残留、重复命令与重启、role 运行中禁止修改。
- 原生执行器：`AIH_TEST_CODEX_EXECUTABLE=/Users/model/.codex/packages/standalone/current/bin/codex node --test test/chat-harness.native.test.js`，5 pass；覆盖 Codex OAuth 形态、Codex API Key、Claude、AGY、Kimi 的接线路径。使用空 HOME 和本地确定性模型，**不是五个真实上游的验收**。
- 自动压缩：Kimi 本地原生测试把用量置为 850000，低于 996147 窗口但高于 80% 阈值；下一轮触发 native 压缩，AIH 没有另发手动 compact RPC。另验证压缩失败可见、状态可恢复。恢复专项 13 pass。
- Web 相关测试：217 pass、0 fail；限改动 ESLint 通过；Node 22 下 `cd web && npm run build` 全量编译通过。日志分别为 `/tmp/aih-harness-web-final.log`、`/tmp/aih-harness-eslint-final.log`、`/tmp/aih-harness-build-delivery.log`。
- 真实 Kimi：从候鸟科普验收会话第一条回答分支，只保留该轮；设置“科普编辑”角色后下一轮按角色回答；重新生成产生独立版本；手动压缩、刷新、继续问上文均通过。原用户 Canvas 会话没有被用于本批操作。
- 页面复核：账号菜单按 Provider 分组并显示图标；每条回答保留用时、首字时间与 TPS；设置/压缩为紧凑图标；没有大块 Alert 和粗左侧状态条。
- 最新后端重启后复核：`/readyz` 为 ready，账号数与重启前一致；三个验收 snapshot 均 HTTP 200、idle、消息 ID 无重复，角色/lineage/metrics 保留。压缩后续聊的当前占用为 3077/996147，`stale:false`；浏览器刷新后实时连接正常。

真实会话身份（均为本机验收数据）：

| 对象 | sessionId | 已观察结果 |
| --- | --- | --- |
| 验收来源 | `session-6b185607-6172-4707-a9cb-7e81bceb2e00` | 原历史完整保留 |
| 消息分支 | `session-7a54d3c5d068e77a081d41ce8bfd1a7580d9cb1862d1198db409bcec6812aa79` | 不含源后续三轮；角色回答用时 9305ms、首字 5329ms |
| 重新生成版本 | `session-96c18b7775e2f3a8f84a0325340f6b506a9102398cabb601e5bce17b452193a0` | 独立 thread；新回答用时 6051ms、首字 2668ms；压缩后续聊用时 7372ms、首字 2674ms |

只读复核入口：`GET http://127.0.0.1:9527/v0/webui/chat/sessions/<sessionId>/snapshot`，管理凭据仅内存使用，不写入日志。响应 `{ok:true,snapshot}` 包含 `policy.lineage`、`policy.systemPrompt`、`policy.contextState` 和消息 metrics。验收快照保存在本机 `/tmp/aih-harness-browser-evidence.json`，不提交对话全文和凭据。

边界：当前累计统计按已加载 timeline 汇总并标明 partial；当前上下文来自持久投影。压缩完成到新 usage 到达之间显示“上下文已压缩”，不伪造占用。Codex OAuth 首轮若无已知模型窗口，采用 native 默认阈值；获得窗口后再应用设置。Work/tool 历史不能无损重建时明确拒绝。尚未逐个验证所有 provider 的真实上游。

### Work 历史可逆性与 1M 上下文边界（2026-09-13）

- `history-reversibility.js` 将“可显示”和“可无损重建”分开判定。已完成且输入形状受支持的
  user/assistant 消息可以重建。reasoning 必须有匹配的私有原始 Responses 项；缺少该证据的旧历史，
  以及 notice/error，返回 `native_item_shape_not_persisted`。工具卡即使已有 `callId` 和文本结果，也因 canonical
  投影未保存原始 Responses `type/namespace/media` 形状而明确返回 `raw_call_shape_not_persisted`。shell、
  file change、审批和 unknown 结果不会被伪装成普通文本。
- `budgetHistoryItems` 以历史单元裁剪。`function_call` 与对应 `function_call_output` 是不可拆分单元，孤立
  call/result 会被丢弃，且仍保留连续消息尾部；这吸收了 DeepSeek Harness 的 tool-pairing invariant。
- 1M 输入继续由两道独立闸门保护：`turn/start` 的字符传输上限，以及按真实 `model_context_window` 计算的
  token 预算。窗口未知时不猜测；传输超限可分段注入，token 超预算会裁剪附件并披露。
  裁剪不是无损压缩；尚未完成真实 1M 多轮、反复压缩、断线恢复和分支的完整验收。
- 历史 seed 裁剪现在保留开头连续的 system/developer 指令，并从剩余预算中扣除其 token；工具
  call/result 仍作为不可拆分单元。Work 合并原生与继承历史时只排除显式 `stale`、`rollback`、
  `rolled-back`、`superseded` 标记，未知状态保持原样，避免把回滚副作用带入子会话，也避免猜测性
  丢弃未来协议状态。
- Chat 分支会保留 `contextCompaction`、`context_compacted` 和 `codex_warning` 这些公开元数据，
  但不会把它们伪装成可注入的 Responses item；连续两次高用量自动压缩后，仍可定位 assistant
  锚点并创建分支继续对话。

### Codex 分页历史与恢复 hydration（2026-09-13）

- `codex-history-pages` 负责分页，`codex-session-history` 负责投影。先校验绑定的 thread，再读取
  `thread/turns/list` 的 `data` 与 `itemsView:full`。固定源码明确区分 turn/item 游标，item 游标绝不
  传给 turns 接口；含摘要或 initialTurnsPage 时从完整 turn 流起点补齐，不能只取旧页保留近期摘要。
- 纯 full 近期 turns 可通过 turn backwards cursor 读取较旧记录，包括锚点。分页记录优先，但原生
  resume 中尚未写入分页存储的运行中工具仍需合并保留；临时 user item 通过 clientId 与持久 ID 对齐。
  缺页、缺身份、重复 turn、摘要伪装 full、游标循环和页数超限明确失败。空页带 next cursor 继续读取。
- 恢复先补齐历史，再定位精确回合、持久导入，最后报告恢复成功。清除已消费的分页标志，导入不再读
  第二份变化中的快照。WebSocket 重连提供仅限同 thread 历史读取的临时端口，避免普通 RPC 等待重连、
  重连又等待 RPC 的死锁；端口不能发 turn/start，回调结束即失效。分页中再次断线仍走重连重试。
- snake_case 为容错单测覆盖；不宣称是独立发行版协议。上述实现不把 typed ThreadItem 转成 raw
  ResponseItem，也没有补齐 Work 工具、审批、多模态和所有压缩切口的可逆历史。

### 原始 reasoning 的私有持久化（2026-09-13）

- 真实 native 回归发现：一律拒绝 reasoning 会让五条 Chat 分支场景全部失败。现从
  `rawResponseItem/completed` 保存真实 Responses reasoning，保留 `encrypted_content`、结构化
  summary/content 和 metadata；绝不从 typed summary 猜造加密内容。
- `NativeResponseItemRepository` 使用既有 SQLite 下的私有表，按 session/item 归属，校验 native
  thread 与绑定一致。同 ID 同内容幂等，冲突拒绝。原始内容不进入公开 timeline、snapshot、SSE。
- 分支将所选前缀的 reasoning 一起放入 seed，并在子会话事务内复制私有证据，允许重启后再次分支。
  没有收到 raw 通知的旧历史、离线遗漏的原始项仍不能无损重建；完整 Work 分支继续未开放。
- 本机 codex-cli 0.154.0-alpha.3 + 临时 HOME + 本地确定性模型已经验证：分支下一请求保留原始
  encrypted_content，公开 snapshot 不包含该字段内容；五条 Chat 路径均通过。它不是五个真实上游验收。

### 2026-09-13 集成验收

本轮先复现分页/恢复 10 项失败、准备边界 3 项失败及异步钩子乱序，再进行修复。真实 native 验收
另发现并修复重连自等待死锁和 full resume 的未落盘工具丢失。

- 最终全量：`node --test --test-concurrency=1 test/*.test.js`，6746 tests、6721 pass、25 skip、0 fail，
  `/tmp/aih-harness-continuity-full-final.log`。首次全量失败包含旧夹具缺少 thread id、表清单未更新及一次
  账号并发注册 SQLite 锁冲突；夹具/清单修正，账号注册独立复测 11 pass，最终全量无失败。
- 真实原生执行器：`AIH_TEST_CODEX_EXECUTABLE=/Users/model/.codex/packages/standalone/current/bin/codex
  node --test test/chat-harness.native.test.js test/chat-harness-tools.native.test.js`，17 pass、0 skip、0 fail，
  `/tmp/aih-harness-continuity-native-final.log`；执行器版本 0.154.0-alpha.3。本地模型、临时 HOME、无真实凭据。
- 上下文/存储专项 71 pass，`/tmp/aih-context-store-final.log`；WebSocket 专项 6 pass，
  `/tmp/aih-history-transport-final.log`；本批 36 个改动/新增 JS 文件语法检查和 `git diff --check` 通过。
- 本批没有改动 web 源码，没有重启/部署 9527；只读 `/readyz` 为 ready。未将 native 本地模型测试写成
  真实 provider 或浏览器验收，未提交推送当前工作区。

### 2026-09-14 压缩后分支回归

- 真实本地 Codex Harness 联合回归：`test/chat-harness.native.test.js` 与
  `test/chat-harness-tools.native.test.js` 共 **31 pass、0 fail**。Kimi 接线路径额外完成两次
  850000-token 高用量自动压缩、压缩后 assistant 精确锚点分支、分支继续、停止/队列恢复和压缩后续聊。
- 首次回归暴露 `codex_warning` 元数据被错误当成不可逆历史，导致压缩后 Chat 分支拒绝；现已将
  `contextCompaction`、`context_compacted`、`codex_warning` 保留为公开提示但从 child seed 排除，
  修复后 Kimi native 场景通过。该证据仍使用临时 HOME 与本地确定性模型，不代表真实上游 1M 容量验收。
- 串行 Node 全量回归：**6971 tests，6932 pass、39 skip、0 fail**，日志为
  `/tmp/aih-harness-continuation-full.log`；本轮未部署、未重启 9527、未提交或推送。

上下文溢出继续暴露三个问题：旧转换器只接受 raw `message`，把 native `userMessage/agentMessage`
全部丢掉；替换 native thread 后持久 activeTurn 仍锚定旧 turn；已注入的分支 seed 不一定出现在
typed turn 列表中。现在 `codex-history-seed` 共用分页读取，按明确形状转换消息、图片和有私有证据的
reasoning，合并 AIH 原始分支 seed 并按 item ID 去重；替换 thread 在事务中核对旧 thread/run/turn
后清除旧锚点，才提交重试。仍然最多自动重试一次。没有原始证据的工具、reasoning、压缩项和未知
多模态结构明确失败，不再用空历史掩盖缺失。未知模型窗口不伪造 1M 默认值。

本地确定性模型在 AGY 接线路径主动返回一次 context_length_exceeded，真实 Codex 创建新 thread
重试；断言新请求包含原分支回答及相同 encrypted_content，不含分支切口之后的源消息，并在重启后
继续验证 seed 不重复。此证据验证溢出恢复的协议与状态流程，不等同于真实上游 1M 容量压力验收。

当前仍开放的集成项（不能用全量测试通过代替验收）：

| 项目 | 当前证据与缺口 | 下一步证明 |
| --- | --- | --- |
| Work 完整历史与分支 | 带 ID 的 raw、精确切口、持久 fork/inject 检查点、用户消息映射、服务命令和 UI 已接通；隔离真实原生场景及浏览器已验 | 继续审批及压缩切口、原生 active goal continuation、多用户 steering 映射边界及真实 Provider 验收 |
| 扩展执行前控制 | 命令前检查有效；工具钩子目前在通知/持久化层 | 执行器提供真正可等待的执行前入口，native marker 证明拒绝后没有执行 |
| 1M 持续会话 | 窗口预算、原生压缩、溢出一次恢复已覆盖；本地确定性模型已验证连续两次自动压缩后分支继续 | 仍缺真实 1M 上游容量压力；需继续区分裁剪损失与摘要损失 |
| 各 Provider 与第二 adapter | 共用命令及 Codex adapter；真实上游能力未逐项闭合 | reasoning/图片/停止/压缩/恢复逐 provider 的真实矩阵，决定 Pi adapter 是否必要 |

这些条目仍有后续工作；代码提交与当前运行的 9527 是两项独立证据，不能表述为全部 Harness 集成完成。

### Work 产品接线（2026-09-14）

- `chat-runtime-service` 已把 `session.fork` / `turn.regenerate` 分派到 Work 原生计划、检查点和
  `work-branch-repository` 子会话事务。原生 fork/resume 不发送 raw 时，`codex-rollout-turn` 从
  经账号身份验证的本地 rollout 读取 exact turn 的落盘证据；不把缺失通知当成完整历史。
- 消息按钮使用服务端命令目录；目录检查当前 driver 的 `historyBranch` 端口，避免旧 capability
  snapshot 或 provider 名称硬编码决定入口。工具卡、审批回答投影及非终态消息不提供分支按钮。
- Work 返回 `id = nativeThreadId`、`runtimeSessionId = AIH sessionId`，保留项目与账号。精确 AIH
  identity resolve 校验 provider/account/project/native；查无结果直接失败，不创建会话或更换凭据。
  原生分支禁止被另一个账号接管；普通 Work 会话原有显式更换执行凭据的行为保留。
- 父会话链接先解析持久 lineage 的 AIH ID，再导航到原生 ID + projectPath。目录合并、原生
  adoption、项目快照与硬刷新均保留分支身份；旧 native-only 记录不能覆盖已确认的账号和 AIH ID。
- 错误响应携带由持久 command/operation 推导的 `commandRecovery`。只有明确 `new_command`
  才清除浏览器命令 ID；`resume`、未知 HTTP 失败和丢回执均复用原 ID。恢复只查找原生回执，
  不重新执行 fork/inject；UI 使用紧凑中文消息解释尚待确认的结果，不把内部错误码作为产品提示。
  Chat 重新生成的子会话已提交、子 turn 尚未被接收时也保留原命令，修复运行时暂不可用后另建
  子会话的窗口。Chat/Work 共用 `branch-session-identity` 计算确定性子 ID。

### Codex active goal 投影（2026-09-14）

- Codex 的 `thread/goal/updated` / `thread/goal/cleared` 不再作为静默通知丢弃，统一映射为
  `session.goal.updated` / `session.goal.cleared`，并由 `EventRepository` 投影到持久的
  `policy.contextState.goal`。刷新和重开数据库后目标状态仍可见，前端会话度量条以紧凑目标标识显示。
- Work 分支继续使用 `deferGoalContinuation: true`；带 lineage 的子会话恢复时读取
  `thread/goal/get`，把原生继承的 goal 重新同步到 AIH。普通无 goal 会话不增加每轮探测 RPC，
  旧版 app-server 不支持 goal 查询时也不会阻断回合。
- 当前已补齐共同命令契约 `session.goal.set/get/clear`：目标写入 AIH 的 `contextState`，以
  `session.goal.updated/cleared` 事件持久化，命令幂等、空闲态变更和能力目录均受同一边界控制。
  Codex 目前以 `emulated` 能力暴露该控制面；该控制面尚未调用原生 `thread/goal/set` RPC，也不会把
  AIH 投影误称为所有 Provider 的原生 active-goal 调度器。原生 Codex goal 的读取/继承仍由
  `thread/goal/get` 和通知链负责，后续若其他 Provider 提供真实 goal API，只需在 driver capability
  中升级为 native。

验证证据：

- Node 定向 60 pass，日志 `/tmp/aih-work-ui-backend-final.log`。首次全量串行 6853 tests、
  6814 pass、39 skip、0 fail（`/tmp/aih-work-ui-full.log`）；随后发现并补充上述 Chat 子回合
  提交前失败窗口，最终结果另记，旧全量不能当作覆盖该最后补丁。
- 真实 Codex 进程专项 5 pass：Work assistant/user 切口、regenerate、fork/inject 丢回执、legacy。
  使用 codex-cli 0.154.0-alpha.3、临时 HOME 和本地确定性模型，不访问真实上游；日志
  `/tmp/aih-work-ui-native.log`。
  最后补丁后的完整 Chat/Work 原生联合 31 pass、0 skip、0 fail，日志
  `/tmp/aih-work-ui-native-final.log`；运行时组装/Actor/扩展专项 34 pass，
  `/tmp/aih-work-ui-wiring-final.log`。
- Web 相关 202 pass、26 个新增/改动 TS/TSX 文件 ESLint 通过、Node 22 完整
  `cd web && npm run build` 通过；日志 `/tmp/aih-work-ui-{web,eslint,build}-final.log`。
  首次构建使用了不兼容的 npm 子进程 Node，报 `No such module: http_parser`；固定 Node 22 后通过，
  没有修改依赖或掩盖编译错误。
- 5194 隔离浏览器使用实际 `CanonicalChatRuntime` / 消息组件连接 5195 测试 HTTP 服务和真实
  Codex 进程。点击中途 assistant 分支后故意返回 503，刷新再点仍是同一 command ID、唯一子会话。
- 本次 active goal 增量定向 Node **103 pass、0 fail**（含 Codex canonical、driver、分支和持久
  context projection）；Web event parser **18 pass、0 fail**，改动文件 ESLint 与 Node 22
  `cd web && npm run build` 均通过。
  分支仅含 cut 前工具和消息；重新生成、父会话链接、继续输入、硬刷新和 390px 移动端已检查。
  marker 始终是 `before\nafter\n`，旧工具没有重跑；共 5 次模型请求（原会话 3、重新生成 1、
  分支继续 1）。截图 `output/playwright/work-branch-{desktop,mobile}.png`。
  隔离页面外壳、账号展示和本地模型是测试 fixture；未模拟用户登录、未写用户会话。
  浏览器两条错误分别为 fixture favicon 404 与故意注入的 503，没有组件异常；此次未重启 9527。

设计边界：`MessageOperation` / command recovery → 幂等命令 → HTTP 状态不能决定原生操作是否执行 →
丢回执后刷新重试与唯一子会话；`session-resolution-coordinator` / `branch-navigation` → Adapter →
统一会话与原生目录身份显式转换 → 两账号/错误路径单测及父链接点击；`project-selection-policy` →
投影合并 → 原生目录刷新不能丢 canonical metadata → hydration/目录与恢复测试。
SOLID 保留编排、事务、driver 和页面边界；DRY 复用目录与解析；KISS/YAGNI 不增加第二个会话库、
执行循环或插件平台。后续审批、压缩切口和原生 active goal continuation 专题不因本批入口接通而视为完成。

设计边界：`codex-history-pages` → Adapter + Map/Set → 协议补全和投影分离、身份去重 → 分页回归；
`codex-app-server-json-rpc-client` → scoped port → 重连内读取不解除普通命令屏障 → WebSocket 故障注入；
`native-response-item-repository` → Repository + transaction → 私有原始证据与分支同事务 → 两账号/重启/二次分支；
`SessionActor` / bridge → Command + 串行管线 → 失败命令幂等、异步钩子不乱序 → 扩展专项。
`codex-history-seed` / `session-repository` → Adapter + compare-and-swap transaction → 历史重建与精确
换绑分开，防止旧回调改写新运行 → 原生溢出、旧 run/turn 拒绝与分支 seed 去重测试。
SOLID 保留领域、协议、持久化和执行边界；DRY 共用恢复入口；KISS/YAGNI 不引入第二个会话库或执行循环。

### Work 分支原始证据与精确切口（2026-09-13，继续集成中）

固定 Codex `968835997714baaff199cfed5f89a2c65d8ca77d` 的
`codex-rs/app-server-protocol/src/protocol/v2/thread.rs:508` 表明原生 fork 只有
`lastTurnId`（包含整回合）和 `beforeTurnId`（排除整回合），没有消息级切口。
不能直接把 AIH 的“截至这条消息”映射成包含该回合的最后一项。

本机 `codex-cli 0.154.0-alpha.3` 的新增原生测试已证明：

- legacy 和 paginated 两种历史模式均可按回合创建独立 fork；`forkedFromId` 指向源，源 rollout
  字节不变；创建 fork 不触发模型请求。设置 `deferGoalContinuation:true`，不让 fork 自动启动 goal。
  当前 fixture 未创建 active goal；active goal 的实际等待语义仍需专门原生测试。
- 关闭服务并重启 Codex 后，两个 fork 继续时，模型输入保留源回合的真实 call/result 和相同加密
  reasoning，排除源后续消息。marker 只写一次，未重放旧工具。
- **legacy typed 历史实际漏掉 exec 工具并重写 message ID**，但下一次模型请求的 raw 历史仍有
  call/result。因此 typed “最后一条消息”不等于安全整回合切口；不得根据文本猜配身份。
- 回合中途消息使用 `beforeTurnId + thread/inject_items(raw prefix)`：保留切点前的工具结果、
  图片及 `commentary` phase，排除同回合后续工具和最终回答，源 timeline 不变，旧工具不重放。
  该路径已由 `codex-history-fork-plan` 规划模块驱动原生探针，尚未接到产品分支命令。

执行中的真实落点：

- `native-response-item-repository` 扩展原 reasoning 私有表，保存带 ID 的全部 raw 通知，包括
  消息、工具调用/结果、结构化媒体及未知类型；保存不等于允许注入。新增 native turn 和顺序字段，
  旧表升级保留旧 reasoning，但不伪造缺失的回合顺序。按 session/thread/turn 读取，跨账号拒绝。
- `chat_runtime_native_history_coverage` 在同一 SQLite 记录 `recording/complete/incomplete`。
  正常起止通知可标完整；缺 ID、记录失败和恢复/重连将该回合标不完整，后来的完成通知不能洗掉 gap。
  raw 和 coverage 均不进入公开 timeline/snapshot/SSE。
- `codex-session-event-bridge` 同一写入链保存 raw，再释放依赖它的排队工具事件；不能因保存 raw
  提前 return，绕过 tool order coordinator。工具 hooks 仍是事件持久化钩子，不能阻断原生副作用。
- `codex-history-fork-plan` 用 Map/Set 校验身份和 call/result，要求精确 raw 锚点及完整采集。
  只有 typed 与 raw 均以该 assistant 消息结束才用整回合 fork；其它已支持切口从该回合之前 fork
  并注入原始前缀。不完整调用、未知类型、重复/冲突 ID 明确失败。用户 typed/raw ID 的持久映射仍缺失。
- 新增图片探针复现 Codex `features.omit_app_server_notification_media=true` 时，模型收到图片、
  raw 通知却不含图片。固定源码 `notification_media.rs` 和 `features/src/lib.rs:1480` 解释此行为。
  `codex-native-history-policy` 为 AIH 的 start/resume/recovery/overflow replacement 显式设 false，
  不修改宿主配置。原生重放同一测试后，私有记录及 child 下一请求均保留相同图片字节与 detail。

尚未完成：Work 分支服务端编排、原生 fork/inject 与 AIH 事务间的幂等恢复、用户消息映射、审批与
压缩切口专项、Web 操作入口及真实页面。以上探针不是 Work 产品能力已交付的声明。

#### fork/inject 丢回执与持久检查点（2026-09-13，后续增量）

上段的 fork/inject 幂等恢复现已有独立实现及原生联合证据，尚未进入公开分支 handler：

- `branch-operation-repository` 将操作计划和 `prepared → fork_pending → forked →
  inject_pending → ready` 保存在同一个 AIH SQLite 数据库；无注入项的整回合分支从 forked
  直接到 ready。命令、账号、源 thread、精确消息切口与计划不可被重试覆盖，阶段更新执行事务校验。
  raw 计划和回执不会进入公共 timeline、snapshot 或 SSE。
- `native-branch-operation` 在 RPC 之前保存 pending；重启见到 pending 只找原生证据，绝不重放
  创建或注入。无回执、部分写入和冲突保持未确认状态。这里只证明应用进程退出恢复；不是断电
  耐久性、任意外部工具 exactly-once 或 Work 产品交付声明。
- `codex-branch-operation-port` 将通用操作映射为 `thread/fork`、`thread/resume` 和
  `thread/inject_items`；fork 带命令与会话派生的 SHA-256 threadSource，resume 仅针对已确认
  子身份，核对返回 thread ID 并拒绝 active 子 thread。媒体通知保持完整，fork 传
  `deferGoalContinuation:true`；active goal 在恢复/续聊时的实际行为仍需专项验证。
- 本机 `0.154.0-alpha.3` 的 legacy `thread/read` 不返回已保存的 threadSource；两种模式的
  `thread/list`（包括 `useStateDbOnly:true`）都可能遗漏尚未收到新用户输入的 fork。
  `codex-fork-receipt` 因此只读已验证 runtime home 的 rollout `session_meta`，按完整操作标记
  与 `forked_from_id` 找回；不按标题、文本或 cwd 猜身份，也不 resume 候选线程。
  限定 sessions/archived_sessions 路径和年月日层次，拒绝符号链接、重复原生身份、损坏或超过
  1 MiB 的元数据头；不把整份历史读入内存。该本地适配能力不代表远程文件不可达的执行器也支持。
- 注入回执按原始 item ID、完整内容和连续原序比对目标 rollout；重复、改写、插入后出现新的
  模型输入/压缩/回滚均不能当作本次注入的完成证据。缺失不表示请求从未执行，部分写入不允许
  直接重试。逐行核对只返回 complete/incomplete/absent 或错误，不公开原始内容。
- 原生全回合 fork 覆盖 legacy/paginated × 正常回执/丢回执/丢回执后 SIGKILL 重启，共 6 场景。
  中途 assistant 消息分支覆盖注入正常/丢回执/AIH SQLite 重开加 Codex SIGKILL 重启，共 3 场景；
  后三项直接执行持久操作编排与 Codex 适配器。图片字节与 detail、工具 call/result、commentary
  消息均保留，后续源工具和最终答案排除，工具 marker 不重跑，源快照保持不变。

仍需把 ready 操作与子会话、lineage、timeline 和附件的事务提交连接起来，并处理公开命令重放、
嵌套分支、用户消息原生 ID 映射及 Work UI。不可将这个检查点模块单独视作完整 Work 分支。

模式：`branch-operation-repository` → Repository + 状态机 → 复用 AIH 唯一数据库持久化跨 RPC
检查点 → 重启、重复命令、账号/计划冲突测试；`native-branch-operation` → Ports and Adapters
编排 → 隔离 provider 协议与阶段推进 → 故障注入和真实原生联合测试；`codex-fork-receipt` →
只读 Adapter → 弥合 legacy API 元数据缺失 → 两账号、链接拒绝、部分写入及两种历史模式测试。
SOLID 将文件读取、状态与 RPC 分开；DRY 共用回执验证；KISS/YAGNI 没有引入第二会话库或通用任务引擎。

本增量验证：定向 66 pass（`/tmp/aih-branch-operations-targeted-final.log`）；原生 Harness
联合 26 pass、0 skip（`/tmp/aih-branch-operations-native-final.log`）；全量串行
`node --test --test-concurrency=1 test/*.test.js` 为 6793 tests、6759 pass、34 skip、0 fail，
227.6 秒（`/tmp/aih-branch-operations-full.log`）。全量与 26 项原生结果早于最后新增的同 ID
双路径歧义保护；该保护在上述 66 项定向用例及 9 项分支原生场景中重新验证
（`/tmp/aih-branch-receipt-guard-native.log`）。47 个新增/修改 JS 的 `node --check`
及 `git diff --check` 通过。本轮未修改 Web 源码、未部署/重启 9527、未提交推送。
本批只使用临时 HOME 和本地模型；未重启/部署 9527、未提交推送。

最终验证：

- 全量 `node --test --test-concurrency=1 test/*.test.js`：6760 tests，6732 pass、28 skip、0 fail，
  `/tmp/aih-work-evidence-delivery-full.log`。本轮先发现恢复夹具未提供 bridge 的访问错误并修正；之后
  发现断线测试只等待服务端 close，未等待客户端收到 EOF 就释放 gate 的竞态，修正为双端 close 屏障。
- 原生 `AIH_TEST_CODEX_EXECUTABLE=/Users/model/.codex/packages/standalone/current/bin/codex node --test
  test/chat-harness.native.test.js test/chat-harness-tools.native.test.js`：20 pass、0 skip、0 fail，
  `/tmp/aih-work-evidence-delivery-native.log`。其中新增三个 Work fork 探针包括图片原始通知完整性。
- 恢复/原始记录/切口/driver 专项 54 pass，`/tmp/aih-work-evidence-targeted-final.log`；断线传输专项
  6 pass，`/tmp/aih-work-reconnect-final.log`；40 个改动/新增 JS 的 `node --check` 和 `git diff --check` 通过。
- 本轮没有 web 源码变更，没有执行 Web build 或浏览器产品验收；没有把这些原生探针写成上游 Provider 验收。

设计边界：私有 Repository + transaction 保持原始证据与公开投影分离；coverage 状态机拒绝
把恢复后的部分记录当完整；纯 fork planner 把边界判定与 RPC/会话事务分开；native history policy
集中协议参数。对应隔离/重启/迁移/故障注入单测以及真实 native marker、图片输入断言。
SOLID 保留协议、领域及持久化边界；DRY 复用分页与媒体策略；KISS/YAGNI 没有新增第二个会话库或 agent loop。

## 后续吸收专题：先验证差距，再实现

以下使用本页固定 SHA；顺序按风险和依赖排列，不作为本批已完成能力。

| 顺序 / 专题 | 固定源码依据 | AIH 当前落点与差距 | 实施与验收 |
| --- | --- | --- | --- |
| 1. 队列与运行中补充输入 | Pi `packages/agent/src/agent-loop.ts:167–198,255–266`：区分 steering 和 follow-up；耗时 prepare/compaction 后补取输入，避免一轮双取 | `automatic-queue-boundary-strategy.js` 已区分工具/回合边界；需验证压缩、停止、断线与入队竞态 | 先建立状态表；按 command ID 证明输入恰好消费一次；覆盖压缩中输入、连续停止/续跑、重启后队列顺序，再决定是否补实现。**验证已完成(2026-09-12)**:既有用例已覆盖「完成后迟到输入重放仍只入队一条」;本次补 `test/chat-runtime-queue-exactly-once.test.js` 3 项,走客户端真实路径 `dispatchCommand({type:'queue.add'})`,覆盖此前空白的三个窗口——压缩期间重放、连续停止之间重放、重启后重放且队列顺序逐条一致。**三项全过,exactly-once 成立,无需补实现**;幂等由 `command-repository.js:15` 的事务内 commandId 去重保证 |
| 2. 持久化与副作用恢复 | DSH `packages/session/session-persistence/src/handle.ts:46–109`：连续前缀、append 可见性、flush 耐久性分开；Pi loop 的执行与结果收集分开 | `recovery-repository.js` 已对未知执行结果关闭自动重放；本批分支事务只保证会话/seed/附件一起提交，不能等同外部副作用 exactly-once | 在 intent 记录、实际执行、结果落盘三个位置注入进程退出；证明未知副作用不自动重做，页面能区分可重试与需要核对；先审计现有 storage barrier，不另造存储。**验证已完成(2026-09-12)**:三个注入点已全部有证据。前两点由既有用例「restart converges orphaned leases…」覆盖——**意图已记录未执行**(leased)重启后回到 `queued` 可安全重试,**已执行结果未知**(running)重启后置 `failed`,且 `driverCalls === 0`;可重试与需核对因此在状态上天然可分。本次补第三点 `test/chat-runtime-recovery.test.js`「结果落盘后重启」:已 `completed` 的条目状态不被恢复流程改写、不回落待办、driver 零重放。**未知副作用不自动重做成立,无需补实现**。附带观察(未断言):该人造 seed 下会话态重启后仍为 `running`,是否该收敛属会话态设计,不在本条范围 |
| 3. 工具配对、压缩切口与分支 | DSH `packages/compaction/compaction/src/tool-pairing.ts`、`packages/compaction/compaction-basic/src/region.ts`、`checkpoint.ts`：不能拆 call/result，保留首条 system 和 checkpoint 来源；Pi `agent-loop.ts:547–555`：并发执行后按原序提交结果 | Chat 禁用工具；Work 已展示工具，实时和历史均使用 canonical callId 契约 | 已完成 callId ↔ canonical itemId 归属、乱序结束和模型顺序提交；压缩/分支仍须证明不会丢审批、结果和多模态内容后才开放 Work 分支 |
| 4. 扩展点与错误隔离 | DSH `packages/core/agent/src/dispatch.ts:65,120–147`：通知监听器失败隔离，serial 可等待，waterfall 可变换；Pi `agent-loop.ts` 的 `beforeToolCall/afterToolCall/prepareNextTurn` | AIH 有显式 factory、driver registry、命令 handler；尚无统一的上述扩展契约 | 先列出现有真实扩展需求；只加入所需窄接口，验证观察者异常不终止模型回合、策略钩子可明确拒绝、卸载可清理；不为对齐名字引入 Cordis |
| 5. Provider 能力与第二执行适配器 | Codex `protocol/v2/thread.rs` 的回合级 fork 与 raw items；Pi 可替换模型/loop；DSH 会话持久域独立 | `chat-harness-gateway.js` 固定账号，`capability-command-catalog.js` 暴露能力；统一命令不代表模型等价 | 逐 provider 记录模型窗口、reasoning、图片、停止、压缩、恢复的真实结果；某项协议限制持续存在时再接 Pi adapter，用同一契约套件比较，不同时维护两个 session 真相源。**前置实测已完成(2026-09-12)**:见 `docs/architecture/provider-capability-matrix.md`——7 家静态窗口/模态全部命中真实元数据;实时可达仅 2/7(claude、agy 200),其余五家分别为额度耗尽/模型冷却/计费封锁/鉴权失败/上游限流,**均为账号侧状态,非网关缺陷**;停止语义在可达两家实测中断后 ≤3ms 结束、无挂起。reasoning 回传、图片输入、压缩/恢复仍空白,原因已在该文 §4 列明 |

完成标准按“固定源码 → AIH 差距 → 最小实现 → 持久化/错误边界 → 原生协议 → 真实页面”逐项闭环。Graph/Diff 与用户剔除的虚拟列表不借本计划重新立项。

## 设计边界与自审

- `session-branch-repository.js` → Repository + transaction → 子会话、seed、lineage 和附件归属原子提交 → 精确前缀、两账号隔离、失败回滚与重启测试。
- `session-actor.js` / `message-operation.ts` → Command + 幂等键 → 网络应答丢失或重启后复用同一操作身份 → 后端重复命令/恢复与前端丢应答测试。
- `codex-session-driver.js` / `chat-context-state.js` → Adapter + 持久投影 → 执行器和 AIH 会话域分离，reload 不复活压缩前用量 → 5 条原生路径与真实 Kimi 验收。
- SOLID：历史转换、事务、投影、执行各自负责单一边界；KISS/YAGNI：不引入第二个 agent loop 或插件框架；DRY：提交/压缩共用 settings，角色与窗口以持久 policy/模型目录为来源。
- 本批使用 self-review，未启动子 agent；按已有提交推送授权进行范围受控交付，另外两个会话的 Codex streaming 改动排除。

## 队列专题：停止、压缩与补充输入（2026-09-10）

参考本页固定 Pi `agent-loop.ts:167–198,255–266` 与 DSH `packages/api/session-controller/src/commands.ts:493–510`。Pi 分开运行中 steering 和结束后 follow-up，并在耗时准备后再次检查输入；DSH 的取消明确 `keepInbox:true`，取消当前任务而保留未消费消息。AIH 复用自己的持久队列，不引入第二个 inbox。

发现并修复的具体差距：

1. Actor 的停止单测通过，但服务层把 `turn.interrupted/turn.failed` 当成自动执行下一条的边界。新增完整服务链测试在旧实现上复现停止后启动次数从 1 变 2；现在只由正常完成继续，停止/失败/丢失运行均持久暂停待办。
2. 结束后调度检查已完成，才收到浏览器排队请求时，旧实现没有第二个触发点。现在正常完成和延迟到达的消息共用原 run 的幂等 dispatch，保证不丢消息、不一轮双发。没有运行过的新空会话队列仍由显式执行开始。
3. 调度回调迟到时，可能把旧工具/回合边界的输入送进新一轮。协调器与 Actor 内分别核对 run 身份；停止/恢复阶段不接受旧边界插话。
4. 重启恢复原先重置 `interruptRequested:false`。现在停止意图持久化，恢复同一个 native turn 后只重发取消请求，不发新的模型任务；原生直接报告 interrupted 也会暂停队列。
5. 运行中工具栏原先只有停止图标，输入提交依赖回车。现在有待发文本时同时提供纯图标发送；Chat 默认“本轮结束后”，压缩/启动/停止/恢复时只允许排队，Chat 不展示没有工具执行的“工具完成后”。输入法正在选字时回车不提交。

| 状态/动作 | 下一步行为 | 持久与恢复规则 |
| --- | --- | --- |
| 正常回答结束 | 按 FIFO 自动执行一条 after-turn 消息 | 同 run 的重复边界不重复启动 |
| 正常结束后迟到的入队请求 | 若仍是该边界且无新运行，继续队列 | 旧边界不得越过新运行 |
| 停止、原生取消、回答失败 | 留住待发消息并暂停 | 刷新/重启保留暂停和队列顺序 |
| 用户点击“现在执行”或发送新消息 | 明确恢复执行；成功后继续 FIFO | 事务内恢复队列状态 |
| 压缩中排队 | 等待压缩成功后执行 | 压缩失败则暂停；对原已暂停队列手动压缩不擅自恢复 |
| 停止请求尚未完成时重启 | 恢复同一原生身份，重发取消 | 不重新生成，不消费待办 |

真实 Kimi 验收会话为 `session-cb15fa41-b7e1-4980-a2c0-702200d1f832`：长回答运行中点击发送加入待办，点击停止后约 29 秒的部分回答保留；刷新后仍显示“已暂停，待发消息已保留”；点击“现在执行”才得到 `QUEUE_RESUMED_OK`，用时 3800ms、首字 3018ms。已检查实际截图，队列状态为紧凑行内说明，停止保持纯图标。

压缩中的真实页面仅提供“本轮结束后”，输入后出现发送图标；点击发送时压缩已结束，命令日志确认走普通 `turn.submit`，随后得到 `COMPACT_QUEUE_OK`，用时 10254ms、首字 7369ms。snapshot 为 idle、队列为空、上下文 2821/996147、stale=false。该页面验证证明压缩期间可保留输入、结束后可发送；严格“入队发生在压缩结束之前”的边界由本地 native 的确定性 gate 证明，不依赖手动点击速度。

测试证据：`test/chat-runtime-automatic-queue.test.js` 覆盖停止/原生取消/失败、迟到输入、旧边界、压缩、顺序；`test/chat-runtime-recovery.test.js` 覆盖停止中重启和持久暂停；`test/codex-session-driver.test.js` 验证恢复只取消原 turn；`test/chat-harness.native.test.js` 5 条路径通过，其中 Kimi 本地原生模型验证暂停后不发请求、重开服务后显式恢复，以及压缩后自动消费待发消息。该原生证据不等同所有上游实测。

最终验证（本专题）：全量 `node --test --test-concurrency=1 test/*.test.js` 为 6531 tests、6518 pass、13 skip、0 fail（`/tmp/aih-queue-full-final.log`）；相关 Web 测试 186 pass（`bun test web/src/chat-runtime web/src/features/chat-runtime`）；5 个改动 Web 文件的 ESLint 通过；Node 22 下 `cd web && npm run build` 通过，日志为 `/tmp/aih-queue-{web,eslint,build}-final.log`。首次全量只失败在旧事件序列断言缺少新增的 `session.policy.changed`；补齐该断言后全量通过，没有屏蔽用例。

设计模式：`automatic-queue-boundary-strategy/session-queue-lifecycle` → Strategy + Command → 将调度意图和 Actor 内并发校验分开 → 旧边界与停止回归；`store/recovery-repository` → 事务与状态机 → 暂停、停止意图和队列归属持久一致 → 重启/FIFO测试；`composer-policy/QueueDock` → 持久状态投影 → 页面反映服务端真实暂停而非本地推测 → Kimi 刷新验收。SOLID 保持调度、存储、执行与渲染边界；DRY 复用 policy/命令日志；KISS/YAGNI 不增加单独队列引擎或后台重试循环。

## 恢复专题：工具结果未知与终态收敛（2026-09-10）

源码依据：固定 DSH `aa8262ec` 的 `packages/core/session/src/repair.ts` 使用 Map 按 callId 配对，区分 `TOOL_NOT_STARTED` 与 `TOOL_OUTCOME_UNKNOWN`，只为没有结果的尾部调用生成收尾记录；`packages/core/agent/src/consumed-work.ts` 从持久 inbox/turn 事件判断输入是否真正被消费。AIH 吸收其“未确认结果不能当成成功”的原则，保留自己的命令日志、事件库和执行 Adapter。

实际复现：旧 `RecoveryRepository.fail` 清除了 activeTurn，但未关闭工具 timeline；普通停止/失败的 `TurnMetricsRepository` 仅收尾消息和思考。`thread/read` 导入终态回合时，显式 `inProgress` 工具也仍显示 running。新增故障注入测试在修改前 7 fail、1 pass，证明这些缺口。

本次实现：

- `timeline-settlement.js` 统一收尾策略：已有 completed/failed/cancelled 结果保持原样，仍在运行的 tool/shell/file_change/subagent/command/terminal 标为 unknown，保留参数、部分输出和原始事件，不伪造 exitCode 或 tool result。规则同时用于本地回合终态和原生终态历史。
- 收尾、回答 metrics、暂停队列与 run.lost 在同一 SQLite 事务内提交；run.lost 时也保留耗时/首字时间，压缩状态不再无限 running。即使执行器报告回合 completed，只要存在未知工具结果，待发消息仍暂停。
- 重复恢复不重复追加工具收尾；过时的 running/unknown 历史不能覆盖已记录结果，也不能让 unknown 重新转圈。之后取得明确完成/失败/取消结果时，才解除该工具的未知状态。
- failedTurn 的 unknown 标记从持久日志进入 snapshot/SSE；未确认的回合不提供一键重试，服务端也拒绝该重试命令。普通无未知工具的失败仍按原规则可重试；用户核对后仍可显式发送新消息。
- 前端复用 EventBlock 的紧凑状态、折叠详情和 TurnFeedback 行内文案，显示“结果未知”，不增加大块告警和粗左侧装饰条。

持久化边界：`app-state-store.js` 当前为 WAL + synchronous NORMAL，事务保证本地原子性；已验证应用进程退出后的记录保留，**未验证断电耐久性**。Codex 的 item/started 通知是事后观察，不是 AIH 控制的“先落 intent、再执行”屏障。没有通知或没有结果均不能证明外部操作未执行，因此本次不声称外部副作用 exactly-once、不将 unknown 伪装成 TOOL_NOT_STARTED，也不向模型注入合成工具结果。执行器自身的恢复语义、独立原生进程被杀的工具结果窗口和 Work 历史配对仍是后续专题。

验证：

- `test/chat-runtime-tool-recovery.test.js` 9 pass：四类回合终态、明确结果保护、历史乱序、事务回滚/幂等、压缩收尾；真实子进程分别在记录调用后、写入 marker 后、结果落盘后直接退出且不关闭数据库，再由服务恢复。marker 最多写一次，startTurn 没有重发，snapshot/分页/重新打开数据库状态一致。
- Node 全量串行 6540 tests、6527 pass、13 skip、0 fail；原生 Harness 本地模型五条路径 5 pass，不等同所有真实上游的工具故障验收。日志 `/tmp/aih-tool-full-final.log`、`/tmp/aih-tool-native-final.log`。
- Web 相关测试 188 pass；8 个改动文件 ESLint 通过；Node 22 下完整 `cd web && npm run build` 通过。日志 `/tmp/aih-tool-{web,eslint,build}-final.log`。
- 浏览器 9527 真实 Kimi 会话刷新后实时连接恢复，账号菜单具有 ChatGPT/Codex、Kimi、Claude 等分组；三个回答的计时保持 28906/3183、3800/3018、10254/7369 ms，context 2821/996147、stale=false。snapshot API 为 HTTP 200，服务 ready，账号数不变。
- 新增 unknown 组件使用真实进程退出测试快照在 5192 隔离预览，实际浏览器确认折叠/展开、结果未知标签、行内说明及没有重试按钮。该证据是组件视觉验收，未冒充用户会话中的真实上游故障；未修改用户会话/注入登录态。临时预览和测试数据不提交。

设计模式：`timeline-settlement` → 状态机/投影 → 将终态规则集中供实时和历史路径复用 → 四类终态、乱序历史测试；`store/recovery-repository` → Repository + transaction → 状态、metrics、队列与终态同时提交 → 进程退出/回滚/幂等测试；`TimelineItemView/projection-state` → 持久事件投影 → SSE 与刷新呈现一致结果 → Web 测试与隔离页面验收。SOLID 保留持久化、策略、Adapter、UI 边界；DRY 共用终态策略和 turn timeline 查询；KISS/YAGNI 不添加第二套存储、执行器或自动重试机制。采用 self-review，按本会话既有授权提交推送，排除两个其他会话的 streaming 改动。

## 原生执行器专题：真实工具与离线历史恢复（2026-09-10）

继续使用上述固定源码：Codex `96883599` 的 `codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts:49–53` 明确 commandExecution.processId 为 `string | null`；`core/tests/suite/tool_parallelism.rs` 通过本地 SSE 模型驱动真实工具，`app-server/tests/suite/v2/thread_resume.rs` 验证原生 thread 恢复。DSH `repair.ts` 的已记录结果优先原则指导 AIH 恢复顺序。实际安装执行器单独记录为 **codex-cli 0.154.0-alpha.3**，不将该发行版与固定源码 SHA 混为一谈。

本轮真实 native 测试发现两个旧单元测试没有覆盖的缺口：

1. 实际命令已写入 marker，但 `item/started.commandExecution.processId` 为字符串 `3071`，AIH 后端只允许非负整数，抛出 `timeline_detail_invalid` 导致回合失败。后端与 Web 契约现在无损接收 opaque string，继续兼容旧数字记录；null 仍由已有适配器省略。没有将标识符强转为数字或丢弃字段。
2. AIH 离线期间，resident app-server 已完成工具和答案；恢复只提取 `thread/resume` 的 status，未导入同一响应中的历史。结果是工具被误置 unknown，最终答案缺失。现在先校验精确 native turn，再将返回历史事务导入，最后开放恢复结果。新答案获得对应 AIH turnId，补齐回答用时；没有观察到的首字时间保持缺省。历史 eventId 不因 turnId 映射改变，其他 native turn 不会被错误绑定。

验证使用独立临时 HOME/项目、无真实凭据、本地确定性模型。模型从实际 tools/additional_tools 读取协议：本机 alpha 执行器提供 `functions.exec`，内部真实运行 `exec_command`。命令先写 marker，再等待 release 文件；只在这些测试拥有的目录写入，退出时释放等待并清理测试进程。三条原生场景：

| 场景 | 故障/恢复动作 | 结果证据 |
| --- | --- | --- |
| AIH 离线，native 完成 | 关闭 AIH service/client；释放工具；观察 native thread 已 completed；重开 AIH | marker 仅一行；模型共两次请求；工具 completed + exitCode=0；最终 TOOL_PROBE_DONE 补回，有用时、无伪造首字 |
| native 执行器中途退出 | 写 marker 后 SIGKILL 测试拥有的 app-server；同 HOME 重启并恢复 | marker 仅一行；模型仅一次请求；工具 unknown，无伪造 exitCode；队列暂停，没有重放 |
| 重连时工具仍运行 | 保持 release gate，重开 AIH；核对原 nativeTurnId，再释放工具 | 恢复 running；后续同一工具只出现一次 completed；marker 仅一行，模型共两次请求 |

`test/chat-harness-tools.native.test.js` 三条真实工具场景全部通过，与既有五条 Chat native 路径合计 8 pass（`/tmp/aih-native-recovery-native-final.log`）。原生工具 fixture 的身份验证绑定临时 codexHome 与测试账号 hash，不复用用户凭据；旧测试模型硬编码和身份断言失败均先修正，只有之后真实复现的错误用于产品结论。

领域验证包括历史导入完成前不开放恢复成功、导入失败取消绑定、拒绝 foreign thread、只映射 exact turn、稳定 eventId、字符串/数字/null processId。相关 Node 86 pass；Web 189 pass、3 个改动文件 ESLint、Node 22 完整 build 通过，日志 `/tmp/aih-native-recovery-{focused,web-final,eslint-final,build-final}.log`。

全量串行回归为 6547 tests、6532 pass、15 skip、0 fail（`/tmp/aih-native-recovery-full-final.log`，运行时包含新增两条 opt-in 场景）；随后补充的“仍在运行时重连”场景通过 8 条 native 联合验证，并单独验证无 opt-in 时三条新 native 用例全部 skip，不触发真实工具。最后未改变产品运行时代码。

真实浏览器使用以上两份原生执行后的 recovered.json 做隔离组件验收：已完成工具和 TOOL_PROBE_DONE 可见，回答用时 0.3秒；被杀工具显示“结果未知”，展开保留命令与核对说明，无持续转圈、大块告警或粗左色条。此证据是实际组件读取原生结果，未冒充真实上游模型验收，也没有把测试快照写进用户会话。

设计模式：`codex-session-history-sync/codex-turn-recovery` → Adapter + 持久投影 → 先补回执行器的已记录事实再收尾 → 三条 native 场景和持久化 gate 测试；`timeline-detail-contract` / Web parser → 边界适配 → 无损保留原生标识且兼容历史记录 → 原生 processId、DTO与完整 build。SOLID 将原生恢复、转换和存储分别留在已有模块；DRY 复用 history projector/sink；KISS/YAGNI 未新建执行引擎或第二套历史库。

后续边界仍开放：底层 WebSocket 自动重连（不重开 AIH service）需要单独验证漏通知后的补齐；Work 压缩切口、分支无损重建和各真实 Provider 的能力矩阵仍未整体完成。本专题证明三个具体 native 场景，不外推所有版本/所有工具/所有平台。

## 工具配对与模型顺序提交专题（2026-09-12）

本专题已完成并纳入当前实现。Codex 的 raw Responses item 只作为内部排序证据，不直接写入公共事件库；`CodexToolOrderCoordinator` 先按模型产生的 raw call 顺序建立槽位，再把实际并行执行中乱序到达的 typed lifecycle 延迟到对应槽位可释放时写入。因此工具可以并行执行，历史仍保持模型顺序。raw output 到达时会释放没有 typed lifecycle 的调用槽位；terminal、cancel 和 cleanup 会 flush 尚未观察到的槽位，并等待真实事件 sink 的持久化 Promise 完成。

实时追加和历史导入共用 `tool-history-integrity` 的归属约束：每个已识别的工具 call 必须有明确 `callId`，同一 `callId` 只能拥有一个 canonical `itemId`，同一 item 不能中途改挂另一个 call。缺少协议身份或身份存在歧义时直接透传/标记未知，不按到达顺序猜配，也不伪造 callId；旧历史中没有 callId 的 item 只允许按兼容规则收尾。这样可以同时保护实时流、批量历史导入、进程退出和恢复路径。

这里吸收的是三个独立事实，而不是把不同 harness 的实现混成一个循环：DeepSeek Harness 的 repair/compaction 逻辑坚持“已记录的明确结果优先”，只有没有结果的尾部调用才进入未知收尾；Pi 将工具执行并发化与结果按模型顺序提交分成两个机制，执行完成顺序不决定持久化顺序；AIH 在 Codex Adapter 中复用这两个边界，但保留自己的事件库、命令日志和会话域。

验证覆盖 Codex raw call A/B、typed B→A、同一工具后续 update、raw output 跳过空槽、terminal/cancel/cleanup flush、实时追加与批量历史导入的 callId 冲突，以及本地确定性模型驱动的真实并行工具。相关入口为 `test/codex-tool-order-coordinator.test.js`、`test/chat-runtime.timeline-import.test.js`、`test/chat-harness-tools.native.test.js` 和 `test/codex-session-driver.test.js`。

固定源码与本机发行版继续分开记录：Codex 源码 pin 为 `968835997714baaff199cfed5f89a2c65d8ca77d`，DeepSeek Harness 为 `aa8262ec091698bae9a6b04773a6b5b06ad4aef2`，Pi 为 `4bd3f48df0b14c82e8df2640645e94f82f125f44`；本机实际执行器为 `codex-cli 0.154.0-alpha.3`。源码提交用于解释协议和设计依据，发行版只用于本机 native 验证，不能互相替代或推出所有版本均有相同行为。

Codex raw/history 仍有明确边界：raw item 不是完整的 Work 历史；`thread/resume` 只能在精确 native turn 锚点和可转译 item 上恢复已记录结果；不支持的 Work 工具变体、审批事件、多模态结构、压缩切口或分支前缀无法无损重建时，必须保留未知状态或明确拒绝。工具配对完成不等于压缩和分支已经具备完整 Work 语义，也不等于所有 provider 的工具、模型窗口、reasoning、停止和恢复能力等价。

## 自动重连专题：先恢复历史，再接收实时事件（2026-09-10）

固定 Codex `968835997714baaff199cfed5f89a2c65d8ca77d` 的 `codex-rs/app-server/src/thread_state.rs:59–60` 明确说明 `SendThreadResumeResponse` 原子地返回历史并订阅后续更新；`request_processors/thread_processor.rs:4517–4550` 将恢复请求交给同一个 thread listener 排序。结合固定 DSH `repair.ts` 的已有结果优先原则，AIH 必须在这一快照落库后才消费后续实时事件。发行版验证仍为 codex-cli 0.154.0-alpha.3，与源码 pin 分开记录。

故障复现保持 AIH service 和原生执行器存活，只终止测试客户端的 WebSocket。原生工具先写 marker，再由 gate 放行；独立只读连接确认 native turn 已 completed 后，才允许 AIH 自动重连。旧实现忽略 `thread/resume` 响应，而且 Driver 设置 `excludeTurns:true`，导致 AIH 一直 running、缺失答案；新测试在旧实现超时失败，日志 `/tmp/aih-reconnect-before.log`。

本次改动：

- transport 新增可等待的 `onReconnectResume` 恢复钩子，与旧 `onReconnectRecovered` 观察通知分开；关键历史写入失败传给原 binding，其他会话继续恢复，不能吞掉异常后报恢复成功。
- Driver 请求完整恢复历史，复用 `CodexTurnRecovery.restoreSnapshot` 的精确 native turn 锚点和既有 history projector/sink。补齐工具结果与回答后才结束回合；仍在运行的回合保留相同身份，继续处理原工具结果。
- 一个客户端同一时间只运行一个重连流程；按 binding 暂存恢复期间的通知/服务端请求，历史导入完成后顺序交付。再次断线丢弃旧连接缓冲，再从新快照恢复；替换/解绑的旧回合不能把缓冲事件交给新 binding。
- 普通 RPC 等待重连完成后发送，停止仍携带原 threadId/turnId，不重新执行工具。关闭中的异步拨号不能复活已销毁 client；旧 socket 的迟到消息不能污染新连接。

验证：相关 Node 测试 61 pass（`/tmp/aih-reconnect-focused-final.log`），覆盖持久化 gate、连续断线、binding 替换、导入错误隔离、精确锚点及旧观察者兼容。真实 native 联合测试 11 pass（`/tmp/aih-reconnect-native-final.log`）：新增自动重连补全离线答案、运行中重连后接收唯一结果、重连期间停止原工具并保留队列。三个场景 marker 均只有一行；正常结束模型请求两次，停止时一次；全部在临时 HOME/项目和本地模型执行，不访问真实上游或用户凭据。

真实 9527 Kimi 页面复查确认账号菜单 Provider 分组与图标、每轮用时/首字/TPS、会话汇总和上下文占用仍保留；本次没有修改 Web 源码。页面验证用于检查既有功能呈现，故障恢复的证据来自上述真实原生执行器，不冒充在用户会话中断线。

最终全量串行回归 `node --test --test-concurrency=1 test/*.test.js`：6557 tests、6538 pass、19 skip、0 fail（`/tmp/aih-reconnect-full-final.log`）。其中 opt-in 原生场景在独立的 11 pass 联合执行中验证。真实 snapshot API HTTP 200、idle，上下文 2821/996147，三轮计时 28906/3183、3800/3018、10254/7369 ms 保持；ready=true、账号数不变。暂存范围 7 个文件，diff check 与 gitleaks 通过。

设计模式：`codex-app-server-json-rpc-client` → 状态机 + 顺序缓冲 → 单次重连、先快照后增量、按 binding 隔离 → transport gate/连续断线/替换测试；`codex-turn-recovery/codex-session-driver` → Adapter + 持久投影 → 重启与自动重连共用精确恢复边界 → Driver 与三条新增 native 测试。SOLID 分离 transport 排序和会话事实；DRY 复用历史恢复；KISS/YAGNI 没有新增执行器、数据库或自动重放工具。按现有授权采用 self-review 后 scoped commit/push，排除其他会话的两个 streaming 文件。

仍待继续：`turn/start` 已被原生接收但 RPC 回执丢失的启动窗口、交互审批重放矩阵、Work 压缩切口与分支无损重建及各真实 Provider 能力矩阵。本专题不声称这些边界均已完成，也不声称外部副作用 exactly-once。

## 启动回执丢失：按持久输入锚点找回原回合（2026-09-11）

固定 Codex `968835997714baaff199cfed5f89a2c65d8ca77d` 的 v2 app-server 协议允许客户端在 user message item 上携带 `clientUserMessageId`；AIH 将自己的持久 `runId` 写入该字段。结合固定 DSH `aa8262ec091698bae9a6b04773a6b5b06ad4aef2` 的 consumed-work 原则，`turn/start` 的连接中断不能直接解释为“输入未消费”：请求可能已经被 native 执行器接受并执行，只是 RPC 回执没有返回。

因此提交协调器只对明确 RPC 拒绝立即失败；遇到 `codex_app_server_disconnected` 时等待 transport 的同一轮自动恢复，绝不再次发送输入。恢复通过 `clientUserMessageId == runId` 在 `thread/resume` 的 durable history 中查找精确 native turn，先导入历史并持久化 `nativeTurnId`，再继续运行、完成或取消。不会借用“最新一轮”：找不到或出现多个匹配时，本轮以 `codex_turn_start_outcome_unknown` 收尾，`outcomeUnknown=true`、`retryable=false`，停止意图也不能把未确认执行伪装成已成功取消。

验证覆盖三类已接收场景：原回合仍运行、离线期间已完成、断线后用户点击停止；marker 均只写一次，`turn/start` 只发送一次。另覆盖找不到锚点时刷新后仍保留结果未确认并拒绝一键重试。该边界避免 AIH 主动制造重复副作用，但不宣称外部系统 exactly-once；用户仍需在结果未知时核对实际文件或外部状态。


### Goal 来源与 Work 恢复修正（2026-09-15）

纠正先前“原生 goal set/clear RPC 不存在”的结论：固定 Codex `96883599` 的
`request_processors/thread_goal_processor.rs` 实现了 set/get/clear。本机
`codex-cli 0.154.0-alpha.3` 的隔离进程也实测 set(paused)/get/clear 成功。
原生 set(active) 会触发独立自动续跑，当前 AIH 仍按一个 native turn 管理回合；因此
能力继续标记 emulated，不能仅接通 RPC 就声称原生 continuation 已集成。

本次修正：

- goal 事件在 Chat 和 Work 共同持久化；`goalSource` 明确区分 AIH 与原生，clear 同时清除来源。
- `CodexSessionGoalSync` 在每次恢复时读取实时 policy；继承的 AIH goal 不接受原生空状态或
  原生恢复时主动发出的 cleared 通知，避免分支继续输入时目标消失。
- 重启恢复和 WebSocket 自动重连共用 goal 同步端口；重连使用恢复专用 client，避免在
  `waitForReconnect` 内请求普通 client 形成等待环。持久化完成后才开放恢复结果。
- 原生读取失败保留上次状态；缺失 goal 字段、异账号 thread 或非法形状明确失败。
  旧读取不能覆盖更新的通知；持久化失败不能缓存为“已同步”。
- 真实 Work 场景完成 native paused goal 创建/读取、AIH 离线时 clear、重启补齐；marker
  始终一行，模型仅两次请求。另一真实 Work 分支保留 AIH 目标、预算与来源并继续输入成功。

设计模式：`codex-session-goal-sync` → Adapter + 顺序版本校验 → 隔离原生元数据同步与
AIH 生命周期 → driver、持久化 gate、乱序通知、异账号拒绝及真实 Work 恢复/分支测试。
`chat-context-state` → 持久投影 → goal 不再受 Chat-only 上下文指标限制 → Work 事件与重开库测试。
SOLID 分离协议同步与投影；DRY 复用重启/重连恢复端口；KISS/YAGNI 未增加第二个自动执行循环。

本次提交前验证：

- Node 全量串行回归：7012 tests、6971 pass、41 skip、0 fail；日志
  `/tmp/aih-all-delivery-node-final.log`。随后新增的网关启动身份边界测试单独验证：
  身份校验、启动参数、常驻连接与模型目录共 60 pass，日志
  `/tmp/aih-all-delivery-identity-final.log`。
- Chat/Work 真实原生联合回归：33 pass、0 skip、0 fail，日志
  `/tmp/aih-all-delivery-native.log`；均使用临时 HOME、本地确定性模型，不使用用户凭据或真实上游。
- Web 全量测试 517 pass；40 个改动脚本文件 ESLint 通过；Node 22 下完整
  `cd web && npm run build` 通过。日志分别为 `/tmp/aih-all-delivery-web-final.log`、
  `/tmp/aih-all-delivery-eslint-final.log`、`/tmp/aih-all-delivery-build-final.log`。
- Provider Go 测试、`npm run providers:check`、`npm run models:check` 均通过。
- 本轮浏览器通道因原生服务不可用未能重新验收；没有重启或部署 9527。
  既有页面验收保持原日期，不以本轮构建和单测替代真实页面证据。

按本会话的 all 提交推送授权进行 self-review，并将 CodeBuddy 家族接入单独提交；
`undefined/` 中的安装缓存与二进制保留本地，不提交。原生 active goal 自动续跑、
真实 1M 持续会话与逐 Provider 上游能力矩阵仍是开放项。
