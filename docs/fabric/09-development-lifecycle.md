# AIH Fabric Development Lifecycle

## 目的

Fabric 不能再按“先写一个入口，后面再解释”的方式推进。每个能力必须先有用户能看懂的产品流程、网络路径、数据落点、验收证据，再进入实现。

本文定义从立项到开发、验收、复盘的标准流程。后续任务如果跳过阶段门，不能标记为完成。

## 阶段门

| 阶段 | 目标 | 必须产物 | 数据落点 | 通过条件 |
|---|---|---|---|---|
| G0 Problem Intake | 明确要解决哪个真实使用问题 | 一段问题陈述、用户场景、非目标 | task brief 或设计文档 | 用户能判断“这是不是我要的” |
| G1 Topology Discovery | 明确设备、server、node、relay、网络约束 | 拓扑图、角色表、现有资产清单 | `docs/fabric/01-network-topology.md` 或 evidence | 能解释公司管家里、家里管公司的流量路径 |
| G2 Options and ADR | 比较方案，不靠猜测拍板 | 方案矩阵、取舍、ADR 摘要 | 设计文档或 ADR 文件 | 至少说明一个更简单方案为什么不够 |
| G3 Design Freeze | 冻结本轮要做什么、不做什么 | 流程图、ER 图、协议、线框、测试计划 | `docs/fabric/*` | reviewer 无 block，用户能按文档理解产品 |
| G4 Implementation Brief | 把设计拆成可执行小任务 | 任务模板、文件范围、验收命令、回滚方式 | `docs/fabric/06-implementation-plan.md` 或 task note | Codex implementer 不需要重新设计 |
| G5 Code and Unit Evidence | 做最小边界内实现 | 代码、单元测试、CLI smoke | git diff、test output | 目标测试通过，无无关扩散 |
| G6 Runtime and Network Evidence | 证明真实环境可用 | VPS/家里/公司/手机实验记录 | `docs/fabric/evidence/*.md`，后续写入 `evidence_runs` | 指标、失败原因、命令可复现 |
| G7 Release Readiness | 判断能否给用户使用 | 发布检查、已知限制、回滚步骤 | current status/release note | 用户知道怎么启动、怎么排障 |
| G8 Postmortem and Update | 把失败和新事实写回设计 | 复盘、错误码、指标更新 | evidence、test plan、ADR | 同类问题下次不再靠口头记忆 |

## 任务模板

每个 Fabric 开发任务必须包含：

- `problem`: 用户要完成的真实动作。
- `designRefs`: 关联的设计文档和章节。
- `scope`: 本次明确要做的最小行为。
- `nonGoals`: 本次不做的行为，避免隐性扩张。
- `topology`: 涉及的 client/server/node/relay/runtime 路径。
- `dataWrites`: 会写入的配置、registry、session event、audit event、evidence run。
- `files`: 预期变更文件范围。
- `acceptance`: 自动化测试、CLI smoke、真实网络或 runtime evidence。
- `rollback`: 如何关闭、回退或绕过新能力。
- `owner`: 主执行 agent。
- `reviewer`: 架构/产品 reviewer。

## 追溯规则

- 每个跨进程请求必须带 `traceId`。
- 每个网络实验必须有 evidence 文件，正式实现后写入 `evidence_runs` 和 `network_measurements`。
- 每个远程写操作必须写 `audit_events`。
- 每个 agent session 必须有 `sessionId`、单调递增 `seq` 和 `resumeToken`。
- 每个 release 结论必须能追到设计文档、测试命令和真实 evidence。

## Agent 分工

| Agent | 什么时候用 | 输入 | 输出 |
|---|---|---|---|
| 主 Codex | 全程 | 用户目标、仓库事实、其他 agent evidence | 最终决策、文档整合、实现边界 |
| `aih-claude-architect-reviewer` | G2/G3/G7 | 设计包、源码审计、evidence | findings、open questions、verdict |
| `aih-claude-frontend-worker` | G4/G5/G6 的复杂客户端 UI | UI 线框、文件范围、真实浏览器 smoke 目标 | 前端 patch、交互风险、浏览器 evidence |
| `aih-codex-implementer` | G4/G5/G6 | 已冻结任务、文件范围、验收命令 | 代码、测试、运行证据、已知缺口 |

使用规则：

- reviewer 不能直接改变产品方向，只给阻塞项和最小修正建议。
- 前端 worker 负责复杂 Client UI 和交互状态；主线程不得把前端体验问题全部自己吞掉后只给代码。
- `aih claude` 作为非交互 worker 使用前，必须具备任务输入、文件范围约束、结果回收和 evidence 输出；否则只能作为交互 TUI，不应伪装成已集成的多 agent 流程。
- implementer 不能跳过 `designRefs`，不能把 transport、session、runtime 写成一个大文件。
- 主线程负责合并结论，并把证据写回文档。

## Ready and Done

Definition of Ready：

- 用户动作清楚。
- 拓扑清楚。
- 数据落点清楚。
- 传输候选清楚。
- 验收方式清楚。
- 不做范围清楚。

Definition of Done：

- 用户能按文档完成动作。
- 自动化测试通过。
- 真实 runtime 或网络 evidence 存在。
- 失败时能看到错误码、trace、server/node/transport/session。
- 设计文档、测试计划和当前状态已更新。

## 为什么必须这样做

旧 Control Plane/remote node 已经证明一个问题：代码能跑、测试能过，不等于产品能被用户理解。Fabric 的核心验收不是“某个接口返回 200”，而是用户能从任意设备选择 server、node、project、runtime，并稳定进入原生 TUI/GUI 能力边界内的会话。
