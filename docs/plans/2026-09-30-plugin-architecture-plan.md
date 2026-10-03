# AIH 插件化规划：DSH / Cordis 主线与网关发布治理

日期：2026-09-30。状态：建议方案，尚未实现。范围来自用户要求的插件化规划及新增 DSH 参考要求。

源码基线、比较依据和吸收优先级见 [三方比较](../architecture/codex-proxy-rs-dsh-comparison.md)。本规划记录新增扩展需求下的设计取舍；历史文档中“当时不引入动态插件”的范围结论仍保留，不代表本次新需求被拒绝。

## 1. 目标与边界

目标是让新能力可以独立开发、安装、配置、启停和升级：新增观察/策略、工具、界面贡献、上游适配器及新 Provider 时，通过稳定扩展合同接入，逐步减少对宿主大文件的改动。

插件可替换的是具体能力实现，宿主继续拥有账号身份、凭据刷新协调、模型授权、命令幂等、持久会话、路由安全、发送与交付水位及用量事实。插件的账号/会话操作必须调用这些公开用例。

第一批利用现有 Node 公开宿主 + Go 数据面拓扑。插件化不改变公开端口和路由所有权，也不把 Go 路由故障隐式回退到 Node。独立 Go 宿主接入插件的能力列入 M5 验收，不能提前宣传具备。

## 2. ADR：复用什么、由谁拥有

### ADR-P1：Node 插件生命周期优先复用 Cordis

采用 DSH 使用的 Cordis apply / inject / effect / fiber 生命周期。通过独立 ESM 边界接入，现有 Node CommonJS 不需要整体转换。正式依赖固定精确版本和制品完整性，P0 核对源码与分发对应关系。

| 方案 | 收益 | 成本 / 决定 |
| --- | --- | --- |
| Cordis 生命周期 + AIH 窄服务适配 | 已有依赖跟踪、作用域、异步清理及开发生态 | 需要 CJS/ESM 接缝和宿主服务代理；建议采用 |
| 整体嵌入 DSH 应用 | 获得现成 Agent 与界面组合 | 将引入另一套 SessionStore、Agent loop 和应用依赖；不作为现有 AIH 的默认迁移方式 |
| 自研通用插件框架 | 可以完全定制 | 重做依赖、资源回收、诊断与热替换；当前没有证明比复用成本更低 |
| 仅继续添加函数 hook | 简单，现有行为可复用 | 无法覆盖安装、版本、进程故障与服务依赖；作为被适配的旧入口保留 |

若 P0 证明 Cordis 的启动/卸载或 CJS/ESM 集成成本不满足约束，先修正接缝或记录替代 ADR；不能默默改成另一套自研框架并继续宣称采用 DSH。

### ADR-P2：插件合同独立，Go 通过 Adapter 接入

SDK 只定义 manifest、能力、配置和通信 DTO。Go 的领域层依赖窄端口；Node/Cordis 细节位于插件 Integration Adapter。复用现有 Coordinator、Recruiter、RouteCatalog、SessionActor 和 Provider driver 接缝。

默认采用受监督的 Node Plugin Host 子进程，内部运行 Cordis。Node 宿主和 Go Core 都通过本机认证 RPC 调用它；公开网络请求不能自报插件身份或 generation。P0 从 stdio broker 和本机 socket 两种方式中确定一个跨平台传输，实现同一线合同，不同时维护两套业务 RPC。

建议本机 socket：POSIX 使用私有 Unix socket，Windows 使用 named pipe；进程启动与停止沿用 AIH 监督方式。数据采用 JSON 元数据 + 二进制分块，不把图片和完整 SSE 转成无界 base64 JSON。元数据初始上限 64 KiB；帧/缓冲/并发/超时上限在 P0 测量后写入合同。

第一版以一个插件宿主进程作为进程故障单元。Cordis 可以隔离普通加载/回调异常；process.exit 或 CPU 阻塞会影响这个宿主中的多个插件。不得据此声称每个插件都有独立进程隔离。出现实际隔离需求后，可按 bundle 拆宿主进程，公开合同保持一致。

插件以宿主用户身份运行。进程隔离、API 作用范围和 iframe 都不等于完整 OS 安全沙箱；可执行插件来自明确接受的可信制品。SDK 回调仅开放必要数据，不默认暴露全部环境、凭据、数据库和内部模块。

### ADR-P3：一份控制配置，按请求绑定发布代次

当前 Node 控制面负责插件管理用例；PluginControlStore 使用现有 app-state.db 的受控持久化入口，不新建插件数据库。Go 只接收经过验证的插件发布投影。插件配置后续迁入 Go 时按单独迁移方案切换唯一写入 owner。

账号和用量仍走原有领域存储与迁移合同；插件管理器不能直接把 app-state.db / aih.db 当作可任意读写的公共服务。

发布代次是不可变的运行投影，不是第二份可编辑配置。Node 与 Go 的 active / ready 是观测状态；持久配置及 revision 是管理事实。缓存、下载目录和存活进程不能替代接受制品和选用版本的事实。

## 3. 运行拓扑与模块落点

~~~mermaid
flowchart LR
  Client[客户端] --> Node[现有 Node 公开宿主]
  Node --> Go[既有 Go 数据面]
  Manager[插件管理用例 / 唯一配置] --> Host[Node Plugin Host / Cordis]
  Manager -->|准备发布投影| GoAdapter[Go 插件 Adapter]
  Go --> GoAdapter
  GoAdapter -->|带代次的窄合同调用| Host
  Node --> Actor[SessionActor / 既有扩展管线]
  Actor -->|带代次的扩展调用| Host
  Host -->|公开用例回调| Domain[既有账号 / 模型 / 会话服务]
~~~

以下是建议新增的职责目录，名称在 P0 定稿；不是已经存在的实现。

| 模块 | 单一职责 | 依赖约束 |
| --- | --- | --- |
| contracts/plugins/ | manifest / RPC / 各能力 schema、兼容版本及公共错误 | DTO 可生成到 Go / Node / Web；不包含业务执行或凭据 |
| lib/plugins/sdk/ | Cordis 窄服务类型、插件开发入口及线合同客户端 | 不导入 server.js、Store、页面或内部 Provider 实现 |
| lib/plugins/host/ | ESM Cordis Context、fiber、服务代理、effect、运行诊断 | 单独进程；不持有账号或 SessionActor 的第二套真相 |
| lib/plugins/control/ | 安装检查、制品接受、配置 revision、准备/启用/停用/升级用例 | 复用 app-state 持久化入口与监督服务；私有数据访问需带 owner |
| application/pluginruntime/ | Go 发布投影与执行所需窄接口、能力结果验证 | 不依赖 Cordis、OS socket、HTTP、Node 模块 |
| internal/adapters/pluginruntime/ | 本机 RPC、协议校验、超时/取消/帧资源回收 | 实现应用端口；不拥有选号、凭据刷新或费用策略 |
| web/src/features/plugins/ | 插件管理受控组件、设置 schema 渲染、运行状态 | 不把面板继续堆入 Accounts.tsx；遵守现有视觉与 Web 验证门禁 |

## 4. 合同与扩展面

### 4.1 插件身份和版本

制品至少声明 manifestVersion、稳定 pluginId、插件 version、宿主兼容范围、RPC protocolVersion、entry/runtime、平台目标、配置 schema、私有状态 schemaVersion 和贡献项及其能力版本。

控制面实例另持有 instanceId、artifactDigest、enabled、配置、secretRefs、作用范围与 revision。实际发布使用 generation；重启运行使用 incarnation 区分同一代次中的进程重建。它们分别表示制品、配置、发布和进程身份，不能合并成“一个 version”。

安装前检查路径遍历、摘要、入口、目标平台、版本、重复 ID 和能力声明。进程握手返回的能力必须与被接受的清单一致。配置未知字段/非法类型按 schema 明确处理，敏感字段只保存引用和必要的受控秘密，不回显明文。

身份冲突、缺失必需服务、循环依赖、不支持的能力版本在候选准备时失败，并列出诊断。不能靠加载先后顺序或 silently override 解决。

### 4.2 分阶段开放的扩展点

| 阶段 / 扩展面 | 插件可以做什么 | 宿主继续保证什么 |
| --- | --- | --- |
| M1：观察、窄服务、CLI 命令 | 接收低敏事件、注册插件自有命令/服务、持有私有状态 | 观察不能 veto；卸载可等待；服务名称和版本有明确 owner |
| M2：gateway.request | 在选路前变换允许字段，或明确拒绝请求 | 身份/授权/幂等字段不可改；变换后重新校验；native passthrough 保留原始 wire |
| M2：route / account policy | 对已授权候选排序，提议模型/账号选择 | 插件不能扩大候选范围；账号资格、精确钉选与 continuation owner 最终由宿主检查 |
| M2：gateway.attempt / observation | 观察尝试、参与允许的失败恢复策略 | next 至多一次；发送和交付水位控制重放；不能自行发起无界重试或重复计费 |
| M2：model catalog | 声明指向已存在目标的模型别名 | 列表、详情和请求使用同一有效目录，目标能力/访问范围不能被别名扩大 |
| M3：chat.prepare / beforeCommand | 复用已存在的可等待 waterfall / serial 合同 | SessionActor 的命令身份、日志幂等、持久 timeline 和失败状态保持单一 owner |
| M3：tool / approval | 注册宿主拥有执行入口的工具，或在原生审批请求前决策 | 执行前拒绝必须真的发生在副作用前；通知型事件钩子只观察或控制持久化 |
| M3：ui contribution | 贡献导航、会话动作、侧栏、外部插件页面 | React 内置贡献和外部 iframe 分开；宿主认证、会话 scope 和桥版本持续复核 |
| M4：upstream adapter / provider | 注册完整 Provider 能力，接入真实请求和生命周期 | 账号身份/认证、模型目录、协议、失败分类、用量、native 能力分别按合同校验 |

原始 HTTP/WS 字节中间件需要额外定义 header、帧顺序、背压和提交语义，在 M2 完成受影响协议验证后开放。没有明确需求的总入口认证接管、远程市场自动更新和任意根页面替换暂不进入第一批；扩展目录明确列为未提供，不能用空实现表示支持。

### 4.3 调用语义

观察者是 best-effort，各 listener 的同步异常和异步 rejection 都可观测，后续观察者继续执行；队列满时采用明确的丢弃/计数策略，不积压无界业务正文。

策略是可等待的 serial，默认错误/超时拒绝其参与的请求；原生默认策略只有在贡献声明允许委托且恢复仍满足宿主边界时接管。数据变换是 waterfall，每次变换后验证身份不变及 payload 有效。中间件是单次 next 的洋葱组合，返回顺序与进入顺序相反。

顺序在准备时编译为稳定列表。依赖关系决定服务是否就绪，明确的阶段 order 与稳定 instanceId 解决同阶段顺序；不让运行中的注册 Map 变化改写当前请求链。

所有调用带 invocationId、generation、实例身份、作用范围、deadline 和取消关联。子调用继承剩余预算，检测回调递归，不能重置重试/等待时钟。流式资源由实际交付持有，EOF、取消和错误共享清理路径，不能为了跨进程调用把整个答案先缓冲下来。

## 5. 配置发布、升级和回退

1. 读取当前配置及 revision，生成候选；安装只增加已接受制品，不自动替换运行中的版本。
2. 校验配置、服务依赖、manifest/能力/平台与私有状态兼容性。准备发生在外部 IO 阶段，不长期持有数据库事务。
3. 候选在新 Cordis Context / generation 中准备；默认准备期间禁止会产生业务副作用的 host callback。需要迁移时先排空对应状态 owner，再执行显式迁移协议。
4. Go 接收新投影并确认可调用；Node 的 SessionActor 扩展入口也确认准备成功。所有受影响执行面就绪前，新请求继续使用当前代次。
5. 事务内通过 expectedRevision 比较提交配置及发布目标；Node 公开入口随后发布该代次。内部转发带经过验证的 generation，Go 不自行挑选“最新版本”。数据库提交与内存切换间的崩溃窗口由持久发布目标重建；重建前停止受影响新请求。
6. 在途逻辑请求/模型回合继续持有旧代次；旧 WS 每个新 response.create 获取新请求代次，已有 upstream continuation 保留原 owner 绑定。无法安全继续的场景明确返回恢复要求。
7. 引用数归零后 await dispose，回收 listener、service、timer、watcher、socket、子插件与 RPC 资源。超过排空时限按明示取消策略结束，并记录未确认副作用，不透明重放。

这是一个公开入口负责路由代次的发布协议，不宣称跨进程共享一次原子内存写。独立 Go 入口必须实现同样的发布协调或明确拒绝不支持的插件配置。

私有数据格式可逆时才能自动切回原制品并恢复对应配置。不可逆迁移失败时需要停用和可恢复的数据快照/补偿；“回退二进制成功”不能当作数据回退成功。下载、候选启动、迁移或并发校验失败分别报告原因。

停用阻止新调用，排空后关闭资源，保留配置、秘密和私有状态。删除只作用于具体确认的配置/制品；被在途调用引用的版本不能移除。插件卸载不能顺带删除账号、历史会话或其他插件资源。

Cordis 开发 HMR 可用于隔离开发实例；生产配置变更走上述候选发布流程，不能直接 restart 当前 Context 绕过在途代次。

## 6. DSH 与其他生态的兼容范围

| 对象 | 可以复用的部分 | 需要另做的适配 |
| --- | --- | --- |
| 基础 Cordis 插件 | apply / inject / effect、Context、服务类型与生命周期 | 服务名称/版本、包解析、公开 AIH 服务和平台支持 |
| DSH 观察/策略插件 | 纯策略函数与 Agent 事件机制 | agent scope、事件字段和真实调用阶段；不能冒充 DSH Agent 实例 |
| DSH tools / skills / UI 插件 | 工具定义、技能资源、UI slot 设计；按服务依赖逐个评估 | 执行器、审批、工作区、会话与 slot host；没有服务时明确不兼容 |
| DSH Agent loop / session 插件 | 后续可成为完整执行器 Adapter 的候选 | 与 AIH 的 SessionActor / timeline / native identity 形成明确映射；不双写两套会话真相 |
| codex-proxy-rs 插件 | 能力合同、制品、版本与 IPC 机制可借鉴 | 宿主 API 和线协议不同，不直接安装其插件包 |
| MCP Server | 在工具层作为已有生态接入 | MCP 工具接口不提供 AIH gateway / provider / UI 插件生命周期，二者不能混称 |

兼容报告按精确包版本及其所需服务给出 supported / needs adapter / unsupported，不能使用“兼容 DSH 全生态”作为笼统目标。

## 7. 实施阶段与完成门禁

| 阶段 | 具体交付 | 必须取得的验收证据 |
| --- | --- | --- |
| M0：合同和技术验证 | 固定 Cordis 制品；确定 ESM/CJS 接缝、跨平台传输、帧上限、公共服务与能力版本；生成 DTO；本地最小 sample | Node 22 受支持环境加载/卸载；依赖缺失/恢复与循环诊断；异步 disposer 完成；Go↔Node 往返、取消、版本不兼容和有界大 payload；记录空链及启用插件的 p50/p95/p99 基线 |
| M1：安装和生命周期 | 离线插件包、摘要校验、manifest/schema、SDK apply；受监督 Plugin Host；validate/list/enable/disable/doctor；运行状态 | 外部目录的插件仅依赖 SDK；安装→配置→启用→调用→停用→重启后恢复闭环；监听器/定时器/服务清理；普通异常与宿主进程崩溃诊断；坏包无运行副作用 |
| M2：网关接线与发布 | observation、request、route/account 策略、attempt、catalog alias；revision CAS、generation 准备/发布/排空 | Node/Go 均命中同一 instance/generation；连续 SSE 与 WS 操作跨升级保持合法归属；候选失败不覆盖当前版本；scope 越界拒绝；单次 next；取消/背压/发送后拒绝重放；shadow 验证真实协议 |
| M3：Chat、工具和界面 | 既有 ChatRuntimeExtensionPipeline → SDK 适配；真实审批/工具能力；少量 UI slot；插件管理组件 | 命令幂等和模型顺序维持；原生审批拒绝后 marker 未执行；不支持 veto 的 driver 明示能力缺失；页面刷新、启停和 bridge 撤销；Web 全 build、限改文件 ESLint、相关单测及真实页面验收 |
| M4：完整 Provider 插件 | 内置 Provider 以现有注册表 Adapter 暴露；新增 Provider 的 metadata/认证/目录/路由/usage/UI；动态定义有效快照 | sample Provider 不修改中央路由/客户端 renderer；未知/冲突 Provider 拒绝；静态 API Key 和受支持 OAuth 生命周期；模型列表与真实推理一致；scope、取消、失败分类和卸载后记录保留；原生 CLI 仅对声明且实际验证的能力开放 |
| M5：开发者发行和部署闭环 | SDK 独立发布、模板和 conformance harness、package/verify/doctor；至少两个外部示例；版本切换/私有状态迁移与回退；独立 Go 宿主的插件协调 | 从干净外部项目安装 SDK 并打包，不引用 AIH 源码；安装/升级/回退及宿主重启；锁定包和兼容矩阵；POSIX 与 Windows 实机；独立 Go 与监督拓扑使用相同能力合同；未提供能力明确拒绝 |

M4 的实际障碍需要明确消除：

- core/providers 和 lib/provider-catalog 当前读取内置/生成定义。增加经过验证的插件定义层，保持一份有效 Catalog；宿主内置 ID 禁止覆盖，停用后保留被账号引用的身份记录。
- core/inference/protocol.go 的 Canonical ProviderID.IsValid 当前限定 Codex / Claude / AGY；新 Provider 不能仅靠 manifest 就贯通。改为与已验证注册事实配合的身份校验，同时保留真实协议拥有权约束。
- 认证、模型发现、quota/usage、运行态、会话驱动和 Web 展示不是同一个接口。采用分能力端口，未实现的 native/runtime 能力明确缺席。
- 数据库存储中的 provider_id 有格式约束。插件 Provider ID 采用满足现有约束的稳定命名，不复用可变 instanceId；变更前验证存量数据与迁移合同。

多人网关吸收项作为独立后续工作：Client Principal 与授权范围 → RPM/并发及公平容量等待 → 当次费用事实与幂等账本 → 用户用量页及插件窄策略。它们不作为插件底座的前置部署依赖。

## 8. 验收方法与交付约束

先验证没有插件时的行为和热路径；空链不启动插件 RPC。每个接入阶段用本地确定性 fixture 检查字段保真、顺序、资源回收和失败，再按影响范围验证真实 native 或上游协议。仅记录 manifest、build 或测试文件存在不构成完成。

M0 冻结性能门槛后，后续阶段沿同负载比较；报告中分别记录无插件、轻策略、流式观察和大 payload 场景的延迟、吞吐及内存，不预设未测量的优越性。

Node 专项覆盖 lifecycle / pipeline / SessionActor；Go 专项覆盖应用端口、选择与投影、RPC、race 和取消；涉及 canonical 编解码必须运行 gateway shadow，并取得真实协议证据。Web 有任何源码改动都必须完成 full build、相关单测、限改文件 ESLint，以及真实页面检查。

备份与恢复要包含插件配置、被引用制品、秘密和私有状态版本；恢复先检查兼容性再启用。实际实现涉及 schema/真实账号/Server 配置时，在相应交付步骤遵守仓库确认与宿主环境规则。本次规划不执行这些变更。

## 9. 设计模式与原则审查

下列是本规划选择的模式，当前没有相应新增运行代码。

| 规划模块 | 模式 | 解决的具体问题 | 验证要求 |
| --- | --- | --- | --- |
| lib/plugins/host / SDK、Go pluginruntime Adapter | Adapter | Cordis / RPC 差异留在集成边界，领域服务只接受稳定类型 | 外部 sample 不导入宿主内部模块；Node/Go 共用合同 conformance |
| 能力注册与有效 Catalog | Registry + Strategy | 新策略/Provider 按能力注册，避免扩大中央 switch | 新 sample 通过登记接入；重复和无效能力明确拒绝 |
| request / attempt / Chat stages | Pipeline / Chain of Responsibility | 变换、策略、中间件有明确顺序和不同失败语义 | waterfall 校验、serial 等待、next 一次、观察者异常隔离 |
| generation 发布与排空 | 不可变快照 / Read-Copy-Update 思路 | 配置切换不改变在途请求链 | 并发 revision、旧流持有、跨进程代次和排空测试 |
| Cordis effect / fiber | Disposable scope | 注册和资源随 owner 回收 | 卸载等待、依赖恢复、watcher/订阅/子插件无残留 |

SOLID：管理用例、领域裁决、传输和持久化各有 owner；Go 与 SDK 采用分能力小接口。KISS：先一个 Plugin Host 和一套线合同；现有服务透过 Adapter 接入。DRY：复用 Provider 合同、Coordinator、SessionActor、凭据刷新与用量用例。YAGNI：先做有验收场景的挂载点，市场、多宿主隔离和总入口替换按实际需求再评估。

本次规划完成的证据是固定源码比较、现有接缝核查、阶段交付/验收定义和文档一致性检查。实施完成必须逐项取得 M0–M5 的运行证据，不能把规划状态改写为已实现。
