# AI Home Node → Go 下一轮开发计划

> **执行说明：** 用户于 2026-11-14 明确批准按本计划实施 W0–W6 全部需求并完成提交。使用 `superpowers:executing-plans` 分工作包执行；遵守共享 main 安全规则，不创建分支/worktree。独立代码审查按仓库的审查能力链落实，审查代理不修改共享文件。任务以复现、最小修复、真实验收、复核、交付为一个闭环。

**Goal：** 先稳定 Codex 与服务生命周期，再逐域完成 Node → Go 的业务语义和运行时归属迁移，保留现有功能，不以“有 Go 接口”替代实际可用。

**Architecture：** 保持 client protocol → canonical request/intent → account/model router → upstream adapter → canonical result/events → renderer。对 HTTP/WS 原生透传保留明确的协议边界，但让强度对齐、账号选择、错误分类、取消和记账规则同源；Node 兼容层必须有明确责任和退出条件。

**Tech Stack：** Go、Node.js CommonJS、SQLite、HTTP/SSE/WebSocket、原生 CLI、React/TypeScript 管理界面。

**Spec：** 本轮用户提出的迁移回归修复与新开发计划、根目录 `AGENTS.md`、本计划的目标/验收约束。已有 `2026-11-14-product-integrity-optimization.md` 是另一份待审阅的全功能优化草案；本文件不覆盖它，也不把其中 TAB 优化优先级当作已获批准的决定。

**状态：** 已获批执行，尚未全部完成。计划初始盘点日期为 2026-11-14；当时 HEAD=`96eb20cb3`，共享 main 中有大量未提交、未跟踪的并行工作。HEAD 不是完整工作区或运行中二进制的内容快照。

## 1. 全局约束

- 当前已获批实施并提交；此前“只制定计划”是初始规划阶段的边界，不再是执行授权限制。按明确路径分批交付，不把全目标授权解释为覆盖并行工作或无边界的配置/数据破坏许可。
- 实施时不得回退、覆盖、顺带提交并行代码；改动路径发生交叉时先确认归属，再重新读取当前 diff。
- 不新增测试用例。验收使用真实命令、实际服务、真实原生客户端和业务操作；离线/隔离验证与在线验证分别记录。
- 不创建分支/worktree，除非用户对当次任务明确批准；不执行 reset/rebase/amend 来清理共享工作。
- 不记录密钥、完整凭据、私密会话内容。复制账号库、受控收费请求、宿主配置变更和共享服务重启需事先说明边界，并取得所需授权。
- 已授权的单次重启不能解释为后续任意破坏性操作许可；新的发布范围变化必须再次说明。
- 每个模块单一职责；`bin/ai-home.js`、`router.js`、`composition.go` 等大文件仅做接线，业务规则放到聚焦模块。
- 默认桌面验收，不新增移动端功能；保留并行会话已经实现的移动页面。UI 遵守 AGENTS.md 的提示容器、装饰条、语义图标约束。
- UI 必须在已有 Edge 的受支持后台连接中真实检查；禁止 AppleScript/osascript/Apple Events。连接或真机不可用就明确保留缺口。
- 提交、推送、加载运行态是独立状态。提交必须带显式 pathspec，提交前后核对暂存区和提交内容。

## 2. 本次盘点结论：事实与待核实项分开

| 范围 | 当前证据 | 对新计划的影响 |
|---|---|---|
| Codex 本轮回归 | 上轮真实执行记录已覆盖 set-default、effort fast、none 请求、服务重启；当前源码仍存在相关未提交实现 | 先集成与复核，不重新宣称“从零实现”，也不能因旧记录跳过新构建验收 |
| 工作区归属 | `cmd/aih/provider_effort.go`、`internal/host/aihdefault/content/codex/preferences.go`、`lib/cli/services/server/native-process.js` 尚未跟踪；其他账号/管理面代码同时在修改 | 首批交付必须完成路径归属、内容复核与明确交付状态，禁止全仓打包提交 |
| 命令接管 | `bin/ai-home.js` 已有 Go effort 入口；通用 set-default/unset-default 的 Go allowlist 未包含 Codex | “命令可用”不等于“命令已完整迁 Go”，后续单独做切换工作包 |
| 路由合同 | `contracts/routeownership/contract.go` 为定义源，生成文件为 `lib/generated/route-ownership.json`；本轮 `--check` 通过 | 旧历史路径不再作为当前唯一依据；生成一致性不是业务一致性 |
| 合同与运行语义 | 65 个合同条目中标记 Go 的为 61、Node 的为 4；health/readiness 仍标 Node，而当前 9527 的 ready 响应声明 Go 服务 | 先厘清公开入口、兜底处理器、实现 owner 三者，不能直接用合同占比当迁移完成率 |
| 扫描覆盖 | `collect-gateway-routes` 输出 Node endpoint=252、Go endpoint=65；其中仅 14 条 Node 数据面候选参与比较，missing=0 | 两侧采集范围不对称；该结果不能证明所有 WebUI、管理 API、WS 和 CLI 行为都对齐 |
| 在线状态 | 本轮只读 `/readyz` 返回 200、ready=true，model_count=224、route_count=448 | 只证明当时就绪，不能代表功能/错误路径/最新源码全部验收 |
| Fast 实际调度 | 上轮直连账号 41 上游发送 priority，完成响应仍报告 default | 本地不得伪报快速调度成功；区分请求层级和最终层级，不通过改写响应或换模型“验收” |
| 模型能力投影 | 当前 `codex_projection.go` 含 Ultrafast 的模型名规则；原生模型元数据读取器也已存在 | 必须审查两种来源的优先级、适用版本和失效条件；本计划不假定该规则正确或错误 |
| 凭据恢复 | 当前 resolver、模型刷新、凭据快照相关文件存在并行未提交修改 | 作为待审查/集成的在途工作，不另起一套实现或覆盖已有改动 |

所有数量都是 2026-11-14 当前工作区的采样，不作全仓覆盖率。执行每个工作包前刷新基点。

## 3. 优先级与实施顺序

| 顺序 | 优先级 | 工作包 | 完成门槛 |
|---|---|---|---|
| W0 | P0 | 现有修复收敛与证据账 | 每个改动有归属，每个结论有证据，已知残留与提交/运行版本对得上 |
| W1 | P0 | Codex 强度、速度档位与传输语义 | HTTP、WS、Canonical、resume/fork 不再因分支差异丢参数或发送非法强度 |
| W2 | P0 | 服务生命周期与配置写入可靠性 | 真实 start/status/restart/stop、子进程恢复、配置保留正确；不误杀其他服务 |
| W3 | P1 | Codex CLI 剩余 Node 接管与入口一致性 | 被迁移命令真正由 Go 承担且保留原有行为；help、补全、原生逃生门一致 |
| W4 | P1 | 账号凭据、刷新、模型与路由状态闭环 | 刷新并发、401 恢复、退出取消、SQLite 冲突不破坏凭据和模型快照 |
| W5 | P1 | 管理面/WebUI 高频链路迁移 | 登录鉴权、账号操作、作业、watch、会话和统计在真实页面端到端可用 |
| W6 | P2 | 剩余域切换、旧链路退出与发布验收 | 全部用户入口有归属与证据；无已知隐式双写/回落；跨平台缺口明确 |

建议首批只批准 **W0 + W1 + W2**。W0 的完整入口总账保留全迁移范围，首批完成不代表整个 Node → Go 完成。发现安全/凭据丢失或服务不可用时，立即作为 P0 处理，不等待阶段结束。

## 4. 每个工作包的具体边界

### W0：修复收敛与可追踪基线

**输入：** 当前 git 状态、已发生的复现记录、公开端点、命令路由、生成合同。

**输出：** 一个入口总账和首批交付清单；为每项记录入口、Node/Go 实现、数据读写者、配置优先级、运行版本、真实证据、遗留风险。

**定位路径：** `bin/ai-home.js`、`cmd/aih/run.go`、`contracts/routeownership/contract.go`、`lib/generated/route-ownership.json`、`scripts/collect-gateway-routes.js`、本轮 Codex 与 daemon 的 dirty 文件。

- [ ] 只读重查 `git status`、`git diff --cached --stat`、最近提交，区分本次修复、并行实现、未完成接线。
- [ ] 逐项恢复 set-default、effort、none、restart/status 的真实复现与验收证据，记录证据产生时的源码/二进制/PID。
- [ ] 盘点 CLI、HTTP、WS、后台任务、原生 hook、WebUI 的入口；缺少映射的入口直接进入未覆盖列表，不忽略。
- [ ] 对 health/readiness 等 owner 含义不一致处，按实际分派器核实后才修改合同；不机械把所有 Node 条目改成 Go。
- [ ] 对当前扫描器的动态路由、子路由和 WS 盲区建立清单，再决定补充采集器还是人工登记；不给出误导的完成百分比。
- [ ] 划定第一批可写路径及集成顺序。并行修改尚未稳定的共享文件不直接重写。

**真实验收：** 对每个报告中的原始命令重新执行；读出真实配置、在线目录、响应事件和服务就绪信息。输出中区分源码已改、已构建、已加载、已验收、已提交、已推送。

### W1：Codex 推理与速度设置全链路一致

**输入：** W0 的命令/协议总账、模型目录及现有对齐规则。

**输出：** 同一请求意图在所有支持路径下有一致的生效语义及失败结果。

**定位路径：**
- `application/effortalign/`、`core/inference/reasoning_effort_ladder.go`：强度对齐规则。
- `internal/transport/http/codexresponseshttp/`、`internal/transport/http/codexresponsesws/`：原生入口。
- `internal/adapters/clientprotocol/openairesponses/`、`internal/adapters/codex/responses/`：Canonical 解码与编码。
- `internal/runtime/codexmodelcatalog/`、`internal/transport/http/modelsapi/`、`lib/server/codex-cli-startup-policy.js`：目录与启动参数。

- [ ] 逐段检查强度和 service_tier 在 HTTP、WS 初始帧、后续省略 model 的帧、Canonical 别名、resume/fork 的处理位置；不得只验证首轮。
- [ ] 模型阶梯有依据时按同一规则对齐；保留未知模型/未知能力的显式状态，不把所有模型强制成 low。
- [ ] 规范模型元数据来源：精确模型匹配、版本、缓存有效期、来源与异常；原生内置能力不等同于当前账号权限。
- [ ] 检查 profiles、命令行 `-c`、CODEX_HOME、宿主配置的实际优先级；保留用户显式覆盖，不因过期缓存悄悄关闭 fast。
- [ ] 请求层级和响应最终层级分别观察。不能将最终 default 改写为 priority；不得以提示文案替代真实参数送达。
- [ ] 复核传输错误重试：限定次数和超时；客户端已收到输出、工具结果或取消后不得隐式重放整轮。重试不得重复记账或重复执行工具。
- [ ] 流式取消、空闲超时、断线重连、会话恢复、账号切换后的引用与 reasoning 数据都需验证清理边界。

**真实验收矩阵：** 原生 CLI + HTTP + WS + Canonical 别名；none/low/max 及模型不支持档位；fast 开/关；新会话/恢复会话；成功/取消/可控断连。只进行已批准的最小真实推理，不在生产账号上制造风控或额度耗尽。

**完成门槛：** 原始 none 错误不复发；用户设置不被无声覆盖；请求层级确实送达；最终层级如实展示；同一轮费用/usage 不重复。上游未给予 priority 单列外部能力限制，不误判为本地已提供快速调度。

### W2：服务生命周期与配置安全

**输入：** W0 的真实部署拓扑及 W1 可运行构件。

**输出：** CLI 状态、托管主进程、内部子进程、公开端口和构件身份一致。

**定位路径：** `lib/cli/services/server/daemon.js`、`native-process.js`、`autostart.js`、`lib/server/source-fingerprint.js`、`scripts/build-go-server.js`、`scripts/build-go-cli.js`、`cmd/aih-server/`；Codex 配置写入定位 `cmd/aih/provider_effort.go` 与 `internal/host/aihdefault/content/codex/preferences.go`。

- [ ] 复核原生进程识别、实际可执行路径、启动参数、公开监听及父子关系；不能凭 `aih-server` basename 就认领进程。
- [ ] 明确 Node 源码指纹和 Go 二进制/构建凭证分别证明什么；验证 Node 子进程不能替代 Go 构件的新鲜度证明。
- [ ] 检查 stop/restart 作用域：只操作当前 AIH_HOME/部署的服务，不停止其他实例或无关端口进程。
- [ ] 构建失败时保持旧服务存活；启动失败时提供实际原因，必要时回退已保存的构件与配置，不重写 git 历史。
- [ ] 配置写入保留注释、CRLF、profile、符号链接及权限；拒绝无效 TOML；并发修改时明确冲突，不覆盖他人新值。
- [ ] 核实 macOS、Linux、Windows 的托管服务和 PID 语义；已有自启报告作为历史证据，不能自动覆盖新实现。

**真实验收：** 获批维护窗口内 start→status→restart→status→stop→start；分别核实 PID、监听端口、readyz、指纹和实际请求；安全地检查子进程恢复和不同 AIH_HOME 的隔离。需要关机重启的跨平台验收单独安排，不在当前计划阶段执行。

### W3：Codex CLI 剩余迁移与发现性

**输入：** W0 的命令合同、W1/W2 已稳定的领域行为。

**输出：** 按命令交付 Go owner，Node 前门只转发，不重复解释同一业务规则。

**定位路径：** `bin/ai-home.js`、`cmd/aih/provider_default.go`、`provider_effort.go`、`run.go`、`internal/host/hostsync/`、`internal/host/aihdefault/`、`internal/runtime/codexhooks/`、`lib/cli/commands/ai-cli/router.js`、`lib/cli/commands/help/messages.js`、`lib/cli/complete/command-tree.js`。

- [ ] 整理账号 ID、账号引用、网关默认档、指定账号启动、set-default/unset-default、policy、home、version、set-mobile/unset-mobile 的现有语义。
- [ ] 先迁默认账号读写与宿主同步；账号指针、auth/config、App 重载必须有一致的成功/失败边界，不能宿主写失败但先宣布全成功。
- [ ] 未安装 App 正常跳过，安装但未启动、已运行、重载失败分别报告；不为了消除告警而隐藏真实错误。
- [ ] 命令与参数严格分派：管理命令不变提示词，`--` 后保留原生参数；参数非法不能悄悄回落另一套实现。
- [ ] 更新 help 和补全合同；真实 TAB 后执行的对象必须一致。shell 深度性能优化仍属于现有全功能草案，不夹带进本工作包。
- [ ] 每迁一个命令就移除对应重复业务逻辑或留下明确限时兼容边界，不一次删除整块 Node 路由。

**真实验收：** 逐命令验证 stdout/stderr、退出码、配置落点与实际账号；覆盖账号不存在、无服务、App 缺失、已有自定义配置、原生参数逃生门。默认账号切换使用获批账号并约定最终状态。

### W4：账号凭据、模型目录和路由恢复

**输入：** W0 中正在并行修改的凭据恢复文件及已确认的身份合同。

**输出：** 一条 authoritative 账号状态链，不因瞬时错误清空模型、反复刷新或覆盖较新凭据。

**定位路径：** `application/accountcredentials/`、`application/accounts/`、`internal/adapters/accounts/sqliteaccount/`、`internal/host/aihserver/credential_snapshots.go`、`internal/adapters/codex/responses/model_catalog.go`、`internal/adapters/accountruntime/accountrecovery/`。

- [ ] 与当前工作所有者核对 resolver/force-refresh/model-auth-recovery 改动，合并设计意图后再动代码。
- [ ] 明确同账号 refresh 去重、凭据版本/CAS、刷新失败保留旧快照，以及取消传播规则。
- [ ] 区分 401 失效、403 WAF/权限、429 配额、5xx/断网；不能把临时网络失败记成永久坏号。
- [ ] 模型刷新按成功快照原子替换；上游不可达不等于账号没有模型。目录与路由 generation 切换一致。
- [ ] 处理 SQLite busy/锁冲突的有界重试和错误回传，不能静默吞写失败或无限重试。
- [ ] 成功恢复后读模型、路由、quota、UI 状态都能观察到同一个账号版本。

**真实验收：** 获批真实账号正常刷新、可安全触发的续期、并发读写、取消、重启恢复；不能通过破坏真实 refresh token 制造失败。无法安全复现的故障列为未验收，安排隔离服务和受控网络环境，不冒充线上证明。

### W5：管理面与 WebUI 高频链路

**输入：** W0 的完整管理入口映射、W4 稳定的账号事实。

**输出：** 桌面页面上的用户操作与 Go 数据源闭环，不再只证明 endpoint 返回 200。

**定位路径：** `internal/transport/http/frontdoorapi/`、`webuiauth/`、`webuiassets/`、`webuicontrolplaneapi/`、`webuicontrolplanebootstrapapi/`、`webuisessionwatchapi/`、`webuiaccountjobsapi/`、`accountrulesapi/`、`upstreammappingapi/`，以及对应 `web/src/` 页面与客户端。

- [ ] 核对登录、会话/鉴权、静态资源、公开与管理别名、错误码，防止转发回环或越权绕过。
- [ ] 按业务旅程验收账号列表→详情→配置/规则→授权作业→模型刷新→实际启动；每个写入口只认一个 owner。
- [ ] 订阅/watch 验证初始快照、增量、重连、权限变化和关闭清理；不能列表已更新但流仍读旧 Node 缓存。
- [ ] 缓存与远端代理明确 key、TTL、失效、身份隔离和错误传播，不用 stale 数据伪装实时状态。
- [ ] quota/token/成本记录区分未知、未同步与零；与实际请求、重试、取消后的账本对照。
- [ ] 每次修改在真实桌面 Edge 检查加载、空状态、操作、结果和错误，遵守现有交互及 UI 约束。

**完成门槛：** API 操作、数据落盘、watch 更新、页面结果和业务请求一致；浏览器连接缺失不能以构建通过代替页面验收。

### W6：其余功能域、旧链路退出与发布

**输入：** W0 总账中尚未迁移/尚未验收的入口，以及 W1–W5 的交付证据。

**输出：** 每个声明迁移完成的功能都能独立在 Go owner 下工作；其余 Node 保留项有明确理由和后续计划。

**定位路径：** `contracts/routeownership/`、`lib/generated/route-ownership.json`、`scripts/collect-gateway-routes.js`、`scripts/package/`，以及总账识别的 Provider/SSH/出口/插件/MCP/hook/翻译/图像/桌面/备份安装路径。

- [ ] 对其他 Provider 和扩展域逐个建立文件级子计划，复用 W1–W5 的验收方法；不能用 Codex 通过推断其他 Provider 通过。
- [ ] 先消除双写/隐式 Node fallback，再切 owner；删除旧代码必须有调用图与实际流量证据。
- [ ] 更新唯一合同与生成投影，同步帮助和安装/升级说明；检查构建凭证、脚本路径及打包是否漏新文件。
- [ ] macOS/Linux/Windows 分别验证实际安装、升级、启动、配置保留、关闭与恢复；不可用平台明确记为未验收。
- [ ] 记录变更范围和回退构件，不用 reset/revert 并行代码作为故障恢复手段。

**完成门槛：** 总账全部叶子入口均有完成/保留/未验收状态；P0/P1 未关闭项不允许宣称全量迁移完成，不能因为清单中已做项全绿就删掉其余范围。

## 5. 建议执行节奏与依赖

1. **第一批：W0 → W1 → W2。** 先把用户刚暴露的链路稳定下来，修复集成错误，完成可复现交付。
2. **第二批：W3 与 W4。** CLI 和账号域各自有明确可写边界；遇到 composition/协议/数据库共同改动时串行集成，不默认派代理并行。
3. **第三批：W5。** 依赖账号事实和入口归属稳定，优先高频旅程，再覆盖总账中的其余页面。
4. **第四批：W6。** 按剩余功能分批迁移、真机验证和退出旧链路。

不在盘点前承诺总工期。W0 后按实际缺口、平台可用性与并行冲突估算每批工作量；每批都有可独立交付的成果，不继续堆积一整轮未提交修改。

## 6. 统一验收和交付门槛

### 每个工作包必须提供

- [ ] 原始问题、根因、保留行为、最终修改路径。
- [ ] 真实复现与修复后的命令/业务证据；记录时间、版本、运行 PID、账号脱敏标识与失败原因。
- [ ] 正向、失败、取消、重试、重启/恢复及相邻路径；未覆盖项单列，不补造结果。
- [ ] 参数最终送达、配置最终生效、响应终态、usage/费用、资源清理，而不只是 HTTP 200。
- [ ] 独立审查意图按 reviewer_subagent → native_review → self_review → plan_check → 显式 warning_noop；代理调用需符合当次授权，高风险缺审查不得悄悄放行。
- [ ] 编译、生成合同、差异检查；不以这些检查替代真实验收，不新增测试用例。
- [ ] 源码/构件/加载/验收/提交/推送的状态分别列出，已获授权的交付按明确路径小步完成。

### 实施时可复用的检查命令（按工作包边界执行）

```sh
# 只读确认当前边界
 git status --short
 git diff --cached --stat
 git diff --check
 go run ./cmd/route-ownership-manifest --check
 node scripts/collect-gateway-routes.js --json

# 待构建范围审阅通过后执行；构建结果不等于在线验收
 node scripts/build-go-server.js
 node scripts/build-go-cli.js

# 维护窗口获批后执行；随后再测真实业务
 aih server restart
 aih server status
 curl --max-time 10 -fsS http://127.0.0.1:9527/readyz
```

对于修改的 JS 逐文件运行 `node --check`；Go 编译错误优先定位本次/并行改动边界，不回退他人代码“换绿色”。

提交前必须检查完整暂存区，再按该工作包的实际路径使用 pathspec；提交后检查 `git show --stat HEAD`。提交按本轮用户授权执行；推送前核对远端与实际提交范围，部署/重启按风险边界另行核实。

## 7. 本轮交付与决策

初始规划阶段仅产出本计划和只读盘点；现在已进入执行阶段。已有全功能优化草案、其入口采集器与其它会话改动保持原样。执行证据和未完成项记录在 `docs/migration/2026-11-14-node-go-execution-ledger.md`。

**当前批准范围：W0–W6 全部工作包，包含完成提交。** 按第一批 W0/W1/W2 优先顺序推进，后续 W3–W6 仍在目标内；不能因为首批通过就标记全目标完成。原先 Codex 回归 goal 与本次用户新设的计划实施 goal 分开记账。
