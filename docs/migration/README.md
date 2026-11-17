# Node → Go 迁移总览

> 总控复核：2026-11-17 00:02–00:14（Asia/Shanghai）；原目标澄清为 2026-11-16 18:14–18:32。这是用户可读的目标与状态入口，不是新的平行开发计划，也不是实时仪表盘。详细需求继续以 [原 W0–W6 计划](../superpowers/plans/2026-11-14-node-go-next-development-plan.md)、[执行账](2026-11-14-node-go-execution-ledger.md) 和 [逐项证据审计](2026-11-16-requirement-evidence-audit.md) 为准；状态变化必须更新证据，不能把旧快照当现状。

> **后续快照更正（2026-11-17 00:23，非本监督执行发布）：**本页00:02–00:14记录之后，运行已变为Go PID `7686`、Node PID `7889`（私有 `59784`）；runtime identity/磁盘均为 `a460355e...`，内嵌 `a4c4d8070` 且 `vcs.modified=true`，旧stamp仍 `85851ec...` / `079a565d...`。下面 `93990/94287/5cc9...` 是前一观察快照，不再代表实时值；R0须补最新构件来源，不能凭dirty revision确认全部已加载。00:20通过既有单次SSH跳板核对远端main为 `a4c4d8070`，确认本页与此前Desktop/Terminal提交已包含；这只证明Git交付，不证明加载或Node退出。未更改全局SSH/代理配置。 文档收尾期间runtime identity再次变化，故不将该观察延长为持续运行断言；后续状态必须另附观察时间和发布owner凭证。

## 1. 总目标：迁移并退出旧实现，不是长期双轨

**AIH 的第一方业务、状态写入和运行调度逐域迁到 Go；Go 是最终主实现。Node.js 只能作为有负责人、必要理由和退出门槛的过渡兼容层，不能成为另一套长期维护的业务实现。**

目标包括 CLI、服务生命周期、HTTP/WS/SSE、后台任务、账号与配置、原生进程/桌面宿主、安装升级等原总账范围，不能缩减成“HTTP 网关换成 Go”。

- 新业务能力和迁移根修复优先落在 Go 的唯一实现。Node 只做尚未移除的协议/启动兼容接线，不能新增第二套选择、重试、凭据刷新、状态缓存或写账本规则。
- 迁移期保留既有功能，必要的 Node 安全/可用性修复仍可做，但必须说明为什么不能由当前 Go 路径解决，并登记对应退出项；不是放任旧实现无限增长。
- 过渡层的存在可以有理由，长期没有退出负责人和下一验收节点不可以。已完成 Go 切换的域不再以“悄悄退回 Node”掩盖故障。
- React/TypeScript 浏览器界面和前端构建工具不必改成 Go；第三方官方 CLI 自身需要 Node，也不等于 AIH 可以永久保留 Node 后端或 CLI 编排。
- 名称含 `node` 的“设备节点 RPC”不自动等于 Node.js 运行时。退出清单应基于实际进程、依赖和调用图，不做字符串式删除。

## 2. 为什么现在还会看到两种方式

原计划已经要求业务语义、实际运行归属迁移和 Node 退出条件；方向不是这次才确定。当前仍存在不同层级的事实：Go 已承接的业务、尚需 Node 的兼容入口、已提交但未加载的新实现、未执行的页面/平台验收。

这些工作如果只分别汇报“已实现/已提交”，而没有统一展示“旧路是否还必需、何时能移除”，用户就无法判断是否在向终点收敛。**不能以局部修复数量、Go 文件数量、接口数量或路由合同占比代替迁移进度。**

## 3. 带观察时间的状态（运行更新见页首）

| 范围 | 已有事实 | 尚未证明/下一门槛 |
| --- | --- | --- |
| 正式服务 | 00:02 实查 9527 为 Go PID `93990`，监督 Node PID `94287`（私有端口 `61740`）；ready=true，模型数229 | Go 前门已运行但第一方 Node 必需依赖未退出；旧 `5919/6656` 仅历史快照，不得沿用 |
| 正式构件与当前源码 | runtime identity 与磁盘 SHA-256 均为 `5cc9d8a9...`；内嵌 `cef00368e` 且 `vcs.modified=true`。同目录 stamp 却仍为 `85851ec...` / `079a565d...`；源码核查基线 `297a08c08`；W0状态卡后续提交 `2238d97e2` | 当前 exact 构建输入/加载范围待发布 owner 证明；不把旧“未加载”当现状，也不把 dirty revision 当逐域已加载。不得重写 stamp 伪造来源 |
| CLI | 当前 `aih` 安装入口仍指向 `bin/ai-home.js`，其中存在 Go 转交路径；原执行账记录了部分标准 CLI 真机验收 | 仍需清点尚由 Node 调度的叶子命令及启动包装，不能只验证被转交命令后宣布 CLI 全迁移 |
| native WORK | `e036cf01f`、`72631a417` 已有本人源码/证据 checkpoint，隔离实际业务验收及明确剩余矩阵 | 不是完整 native/跨平台验收，也不代表正式服务采用；以该 owner 的最新回执为准 |
| Desktop 安全准备 | `ff93cfa48` 已提交原生 Claude 配置准备及保留用户配置的修复 | 安全 prepare 不等于完整桌面效果、权限和 Node 宿主退出；M owner 需列精确残留 |
| Terminal | `0af25e9db` 已本人提交；真实隔离 Go/PTY、Node 代理/SSE、完整90秒失活恢复有证据，5路径索引已清 | “当时正式未加载”是13点历史；当前 dirty构件不能精确归因该提交，Edge验收缺口也未关闭；不称上线/迁移完成 |
| 迁移范围 | 原计划保留 W0–W6 共 42 项要求和 7 个共用交付门禁；当前逐项审计仍未判定总目标达成 | 不删除未覆盖项，不把 pending/unverified 改名为 done |

当前生成合同为 67 个条目，其中 65 声明 Go、2 个历史聚合条目声明 Node。聚合与叶子范围不同，而且不能覆盖所有 CLI/作业/宿主/安装行为；**这不是“迁移完成 97%”的证据**。历史文档中更早的条目数或 PID 只代表当时快照。

### 分立交付状态：不把 Git 绿色当运行迁移绿色

| 域/证据 | Source commit / 本人索引 | Push | 构件 / Loaded | 真实验收 | Node 停用 / 删除 |
| --- | --- | --- | --- | --- | --- |
| W0/Codex/WORK | `987a3d026`、`e036cf01f`、`72631a417`；本人57项旧索引已同步；退出卡 `2238d97e2` | owner已有推送回执；不是当前远端HEAD快照 | private WORK `f915dfa3...` 已验；共享 `5cc9...` 的 exact 来源缺口未关 | 固定账号Claude、模型/错误/别名有证据；AGY认证、Capture、globalClaude、全transport矩阵仍Partial | 完整域Node-off未验，未删除 |
| M/Desktop/配置 | `ff93cfa48`；10源码+12证据，原84项与本组索引本人已收口 | 00:08本地 `origin/main=297a08c08` 的push reflog及祖先关系已包含；00:03实时远端查询失败，不声称当前服务器ref | isolated Go prepare与CLI构件已验；当前共享/标准CLI exact加载另核 | JSON/ownership/锁/恢复/noop/预取消已验；GUI、Windows实际行为、spawn边界未全验 | Node入口/helper仍在，未停用/删除 |
| Terminal | `0af25e9db`，精确5路径已交/本人索引清 | 原owner未自己push；00:08本地tracking/push reflog已包含该SHA；实时远端查询失败另记 | matched private候选 `c30241b2...` 已验；不能把共享dirty构件当该候选 | 原PTY身份/环境/目录/90秒与背压有证据；Edge DOM未关 | 后端恢复核心Go，Node代理/入口未退 |
| 普通Chat | `85851ec39`，证据 `906a38799`；9项旧索引均disk==HEAD，仍待原owner同步 | 有此前推送回执；当前远端查询失败 | 旧批准构件 `079a...` 是历史；当前为 `5cc9...`，两者不互借证据 | 既有Edge真实两轮/用量归普通Chat；不代表native WORK或本次构件复验 | Node全局projection/远端transport依赖未关 |
| 其他域与整体 | 原42项+7门禁不删；本页不替owner代交业务 | 未逐域核实即未知 | 无exact artifact凭证即未知 | 没有真实矩阵即Partial/未知 | 没有调用归零和Node-off证据，不判退出 |

**远端查询边界：**2026-11-17 00:03 `git ls-remote origin refs/heads/main` 失败（连接关闭），未修改SSH/代理配置。00:08本地 `origin/main` 的 `update by push` 已到 `297a08c08`，且包含Desktop/Terminal提交；这是本地交付日志与tracking证据，不等于这次实时远端查询成功。上表保留各owner回执的时间语义，不把13点“未push”沿用为当前未交。当前新文档/功能的源提交也不倒推已在共享服务运行。

### 逐域 Node 残留与退出卡（总控入口）

卡内“已核对源码”只证明可达调用，不等于本轮实际流量；“待owner确认”不是自动接管。每次交付须明确消除下面哪条第一方Node必要依赖。子域完整条件仍由原W0–W6、详细账和owner证据约束。

| 卡/原域/负责人 | 当前真实入口与Go唯一目标/写者 | 仍必需或条件可达的Node残留及caller | 下一个切换→断依赖→删除节点与阻碍 |
| --- | --- | --- | --- |
| **R0 构件与服务，W0/W2/W6**；监督`01a1df63`核对，当前发布owner待确认 | 当前Go93990→Node94287；Go启动 `cmd/aih-server/run.go` → `internal/runtime/nodesupervisor/supervisor.go`；目标是Go单服务运行链，不另立Node守护实现 | 监督器实际执行 `bin/ai-home.js server serve`；`router.go` 未命中路径转 `frontdoor`，Node不是已退出的空壳 | **先**找出最新运行构件（00:23为a460355e）的构建输入/批准记录/正确stamp，做可复核artifact关联；再按下面各域完成Node-off，最后改默认拓扑与包。来源缺口未关、未授权重启；本页不执行切换 |
| **R1 公开CLI与Codex，W1/W3**；W0 owner`01a1d99a`，Desktop effect与M协调 | `aih`当前symlink仍指 `bin/ai-home.js`；目标复用 `cmd/aih`、`aihcli`、`codexpreferences`、`codexdefault` 的唯一事务/状态写者 | `bin/ai-home.js` fast dispatch + `lib/cli/app.js`；default-command输出/Desktop effects；artifact-hooks→`host-sync.js`仍有条件配置/凭据写者，不能泛称只转发 | 先逐命令转Go公开入口并退条件host writer；证明default/effort/credentials更新不经Node仍不复活旧值，保留help/TAB/逃生门/失败清理，再删对应旧业务。缺跨入口/平台矩阵 |
| **R2 Codex wrapper/stdio/RPC，W1/W3**；W0 owner`01a1d99a` | Go `codexexecintent`/`codexexecpreflight`/`codexlocalappserver`/`codexappserverws` 已交；lease、线程选择、tier与取消只保留Go规则 | installed wrapper由 `codexhooks/wrapper.go` 生成但仍调 `codex-app-server-stdio-proxy.js`；Node launcher/privatepipe/helper生命周期，以及rollout path条件writer仍可达 | Go接住安装wrapper和stdio语义，优先官方API；在旧Node proxy不可用下真验TUI/exec/resume/断线/引用/lease，再断旧入口及writer后删除。公共与caller-local参数矩阵不能互借 |
| **R3 本地native WORK/session/composer，W0/W1/W5**；W0 owner`01a1d99a` | `worknative`→Go账号selector/resolver/strategy，`chatruntime/{driver_native,native_model_*}`→Go进程/终态；审批 `__mcp-approve` 已Go。目标统一Go session与Capture链 | Node同名文件不必然第二owner；self-base缺失且node-base存在的approval fallback仍有条件路径；远端入口另见R6 | 先用来源冻结的private服务不启动AIH Node，验本地创建/目录/发送/stream/取消/审批/恢复/清理；再移除非必需fallback。AGY无账号、globalClaude参数、Capture与缺transport独立阻塞，不回退Node伪实现 |
| **R4 账号/凭据/模型/别名，W4/W5**；W0认领model admission，跨域policy/wildcard归属由监督确认 | Go `accountcredentials.Resolver`、`application/accounts/models.go`、`sqliteaccount/model_{store,transaction}.go`、`inferencecatalog`/`model_route_view` 是目标规则/存储入口 | `go-core-host.js` 启动reconcile→`go-account-sync.js`仍可决定enabled/default/model policy；空alias一次性播种和 `wildcard-alias-expansion.js` 展示来源依Node。单库≠单writer | 先给旧表迁移完成凭证、把wildcard来源和policy决策迁Go；真实副本验证清空不复活/冲突取消无迟到写/重启无需投影，再停timer/播种/旧writer后删。真实OAuth轮换输入和跨域owner确认尚缺 |
| **R5 Desktop/hooks/backup，W3/W4/W6**；M owner`01a1da12` | `claudedesktopconfig` + `configsnapshot`、Go `__claude-desktop-config`、toolkit hooks、`backupaccounts`/`remotebackup` 为各自Go写入口；不新增Node版publisher/备份规则 | Node `claude-desktop-inference.js`→Go privateCLI；`provider-session-hook-config.js`→`provider-hook-go-adapter.js`；backup `core-accounts.js` RPC/pipe；`bin/claude-desktop-credential.js`仍Node helper。适配在用不等于已退出 | 先由owner确认完整caller及Node-off配置/备份/恢复/失败journal/凭据helper矩阵，再统一到Go入口；关闭JSwriter/默认caller后才删adapter/包依赖。目前GUI/Windows/spawn边界未全验；卡的跨M细节待本人回执 |
| **R6 普通Chat/页面静态与remote，W2/W5**；Chat owner`01a1dfb7`（未注册peer），跨remote/部署由监督定owner | Go `webuichatapi`/`gateway_catalog`已承接普通Chat；`webui_assets.go`可托管静态；目标Go端到端HTTP/WS/SSE、profile鉴权与传输，不迁移React本身 | Go `remote_webui_proxy.go` 对server-id请求先frontdoor→Node `webui-server-proxy.js`；部分autostart Go-first未传web-dir，static可落 `web-ui-router.js`，实际每请求依赖未测 | 统一web-dir与remote-profile Go transport，不再加Node会话/路由/重试规则；Node-off验静态深链、401/404、两真实服务的remote请求/取消/SSE不落本机，再撤代理。原Chat writer10588存活而peer无入口，9旧索引仍本人待办 |
| **R7 Terminal，W2/W5**；原保活/退出卡owner`01a1e2ab`；失效条目UI owner`01a1e50f`（六路径源码`fb9b90405`已交，报告`bd1c4f9df`；最终验收阻塞） | `router.go`仅挂Go管理prefix→`webuiterminalapi`→一个`terminalsession.Service`/tmuxStore，唯一PTY/session状态写者在Go；浏览器渲染看门狗不是第二后端 | 浏览器`api.ts`请求 `/v0/webui/terminal/*`，当前fallback经 `web-ui-router.js`→`webui-terminal-routes.js`→`go-core-host.js`回同一Go；账号旧launch caller和remote proxy仍在。`sessions.go:ensureAihShimDir`生成的`.runtime-bin/aih`实际exec Node+`bin/ai-home.js` | 先协调Go `/v0` terminal alias保留鉴权/字段allowlist/禁止任意launch/remote隔离，再把终端内shim接Go标准CLI；Node桥和第一方Node PATH不可用时真验open/attach/mux/input/resize/close/90秒背压/退出不换shell，最后据完整调用+运行证据删旧adapter/export。exact加载和Edge仍缺，不盲删共享proxy。失效条目UI六路径源码与报告已交，最终确切树Edge及enabled生命周期仍有未闭门禁；当前后续TSX/CSS差异保留待owner解释，不计Node-off完成 |
| **R8 其余Provider/插件/后台/安装，W6**；监督列叶子后指定现有owner，未ACK不虚构归属 | Go provider Catalog/manifest、plugin control CAS、scheduler、安装生命周期是目标；`router.go`已显示Go插件install/CAS/trust写入口 | plugin runtime host与部分候选仍Node；Go `nodeOnlyProviderIDs`按Catalog声明派生；`scripts/package/bundle.js` launcher仍必需Node，build-release嵌Node runtime/modules | 按真实provider/extension/任务/安装leaf建卡：承接Go缺口→停相应Nodecaller/host→业务及安装升级恢复真验→删旧包装依赖。不能把67合同覆盖当全部leaf。无owner/流量证据是开放缺口，禁止广删 |

**哪些同目标、哪些停扩：**上面已交的Go账号事务/native执行/配置prepare/PTY核心继续收验收；浏览器必要React逻辑保留。禁止为同一已迁业务再扩Node版selector、credential刷新、publisher、retry/cost写者；迁移紧急兼容修复须给实际caller/原因/退出卡，不能凭“兼容”无限留存。没有旧调用归零证据时先不删除，但“暂不删”也不是允许继续双轨新增。

**终端协议问题归属与源码检查点（2026-11-17 00:46 owner回报，00:56监督只读复核）：**原owner `01a1dfb7-34fe-7582-ab9b-ad8b8e55f2d6` 已自行提交 `ec0da8192`，精确9路径、161增/33删：`terminalsession/{protocol.go,protocol_input.go,service.go}`、`webuiterminalapi/{handler.go,sessions.go}`、`lib/cli/services/pty/switch-draft.js`、`lib/server/webui-terminal-routes.js`、`web/src/components/chat/terminal-input.ts`、`web/src/services/api.ts`。监督确认该提交在main、9个磁盘blob均与提交相同；暂存区仍是旧投影，由原owner自行收口，监督不代stage。此确认取代先前“协议writer待确认”，不触碰失效条目UI四路径。

- **源码已交，不等于上线全闭环：**owner回报SSH/真实Go/tmux/Edge组件/CLI草稿验收通过及共享Go已拦截原始复现；详细报告与确切构件证据待交，监督本轮未重跑这些操作，不扩称已验证所有分片/多viewer/鼠标回包场景。
- **前端与wrapper分列：**owner报告正用标准 `build-locked` 在当前共享源码构建前端以补齐 `protocol` 来源字段；监督仅观察、不并发Web build、不替换terminal模块或重启Go。构建与字段实际生效证据未收到前保留待回；既有wrapper不会自动热更新，CLI wrapper加载/重开后的行为不能借Go拦截证据代替。
- **归属和发布边界：**协议修复、原 `0af25e9db` 保活、失效条目UI和Node-off迁移各自记账；不拿旧 `85851ec` 限定候选覆盖当前共享构件，不把当前共享源码构建自动认定为纯提交来源。任何后续正式替换仍须确切范围、构件配对与相应批准。

**R7 失效条目UI：源码检查点已交、最终验收仍阻塞（owner 01:40回执；监督2026-11-17 11:03–11:04复核）：**原四路径在职责拆分及controlled cleanup门禁后扩为六路径，新增范围已由原owner在 `pm-b4078842` 报告并由 `pm-4abaa440` 精确确认。本人源码 `fb9b90405`、报告 `bd1c4f9df` 已包含于本次实时核对的远端 `main=a9d4361f6`；历史两次直推失败不再据为当前未交付。唯一源码pathspec为 `web/src/features/web-terminal/web-terminal-context.tsx`、`web/src/features/web-terminal/use-terminal-directory.ts`、`web/src/features/web-terminal/use-terminal-availability.ts`、`web/src/pages/TerminalSessions.tsx`、`web/src/pages/TerminalSessions.css`、`web/src/components/chat/ShellTerminalPanel.tsx`（仅controlled cleanup/notifyParent窄hunk）。

01:40回执的“全部clean”只代表当时；11:03源码比对其余四路径与该检查点一致，`TerminalSessions.tsx/css` 出现后续物理差异，归属/新scope需原writer再确认，监督不清除、不覆盖、不暂存。静态审查和六路径隔离构建属于该检查点；较早Edge树的2stale/1live、保存身份保留及同key恢复不是最终六路径完整Edge验收。当前状态记为 **source checkpoint完成／后续差异待归属／最终验收blocked**，不是“未开始”，也不是原故障线上闭环。

- 保留持久 `state.tabs` 的原key、server、任务身份和草稿，仅派生interactive/unavailable集合；Global host使用的 `manager.tabs` 不得在离开总览后又自动attach已隔离条目，失效列表仍须有可见、可查入口。
- context统一持有单个enabled目录hook，页面复用同一观察结果，避免双份8秒轮询；启用/停用cleanup、切server、旧请求代次、A→B→A和新增saved tab须纳入本人验收，不能因缓存成功目录配上旧404而误判。该项为实现/验收约束，不是本轮已通过证据。
- 只用对应server/目录代次的**成功且非空native目录**及针对原key的404隔离native条目；loading、请求失败、鉴权失败、旧代次、web durable未列出不作为死亡证明。同一key回归可恢复live；禁止同名替换、清存储或草稿、自动创建空shell，恢复依用户显式操作。
- 紧凑失效列表不使用大块Alert或左彩条；长身份须保留全文的可访问查看方式，不能只剩不可区分的label。
- 已协调的ShellTerminalPanel仅controlled cleanup/notifyParent窄hunk，不代表接管整组件；不改Global host、api/auth、protocol或Go，后续扩大须先报路径。隔离构建、六路径源码提交、最终Edge与正式loaded分别记账；原 `0af25e9db` 保活、协议复发修复和Node-off迁移不互借完成证据。
- owner明确保留两项后续发现：`use-terminal-directory.ts` 的enabled停用未使在途请求失效，`refresh` 没有enabled检查。监督只读核对到当前hook仍与该检查点一致；这是源级未闭门禁，不虚构真实页面复现或修复。19条同基线TypeScript诊断也不报全量通过。
- 本段只纠正状态与责任：不把延迟指派或源码已提交当作恢复blocked目标/新writer/正式替换重启授权。必须收到原owner的新状态或明确恢复请求后，才按对应scope推进未验项。

**当前Node退出总状态：未达成。**这些卡是下一可执行退出节点，不是另一套平行需求；W0–W6完整42项和共同7门禁继续有效。跨域未确认owner由监督落实认领，不能发消息排队后写成已接手。

### W0–W6 的总体门禁

下表承接执行账的未完成状态，不重验或抬高其他 owner 的结论。

| 工作包 | 方向 | 仍需收口的重点 |
| --- | --- | --- |
| W0 | 唯一入口/归属/证据账 | 补齐 CLI、WS、任务、hooks、页面叶子及正式版本关联 |
| W1 | Codex 参数与传输语义统一 | metadata 来源/版本、取消/重连/账号切换完整矩阵 |
| W2 | Go 服务生命周期 | 三平台安装/升级/托管恢复及授权正式加载，不保留两套守护主实现 |
| W3 | Go CLI/启动入口 | 逐个退出剩余 Node 调度；帮助/补全/默认配置/桌面实际效果 |
| W4 | 单一账号/凭据/模型状态链 | 真实 OAuth 轮换/re-key、剩余 writer、版本到 UI 的一致性 |
| W5 | Go 管理面和真实页面旅程 | 实际鉴权/写入/watch/显示/业务请求一致，补现有 Edge 验收 |
| W6 | 旧链路退出与全平台交付 | 消除隐式双写/fallback，停用并删除旧调用链，验证包装和完整发布 |

## 4. 接下来按什么推进

1. **收完在手 checkpoint，不再分叉扩功能。** 谁的改动谁负责明确路径提交和验证；监督不代交。W0/native、M/Desktop、Terminal 各自的 checkpoint 不相互覆盖，现有共享反向暂存不能 reset/revert 掉。
2. **监督汇总一张“Node 残留与退出”清单。** 每个仍需 Node 的实际入口必须有责任人和下一交付节点；未知项先标未知，不拿 broad route aggregate 伪装完整清单。
3. **按用户可完成的业务链收敛 Go。** 补齐当前 Go 缺口，复用一个领域实现和唯一写者，验证成功/失败/取消/重连/恢复/资源清理；只有完整链路可用才切默认入口。
4. **独立处理正式切换门禁。** 明确构件、范围、批准窗口和回退产物后再加载。提交、推送、构建、loaded、实际业务验收分别登记；本目标澄清不授权共享服务重启或修改凭据。
5. **每切完一域就落实退出，而非把退出永远放最后。** 查清调用图和实际流量，关闭旧入口/隐式回落和 Node writer，验证禁用该域 Node 路径仍可用，再删除不再可达的业务实现和相应包装依赖。保留回退构件，不保留两套默认业务 owner。
6. **完成整体退出验收。** 第一方标准安装/CLI/服务和业务链无需 Node 宿主；各平台与相关原生集成有真实验收。前端构建/第三方客户端依赖需单列，不混淆或偷偷缩减目标。

## 5. 所有 owner 用同一回执格式

| 必填字段 | 要回答的问题 |
| --- | --- |
| 原需求/工作包 | 属于原 W0–W6 哪一项，而不是新立一套目标？ |
| 当前实际 owner | 正式进程/入口现在到底由 Go 还是 Node 执行？版本是什么？ |
| Go 唯一实现/写者 | Go 接入口、领域实现和状态写者具体在哪？ |
| Node 残留 | 哪些文件/进程/调用还必需？只是适配还是仍含业务？ |
| 负责人/可写范围 | 谁本人提交，是否与他人文件或 composition 接线相交？ |
| 下一退出节点 | 下一次要交付 Go 补齐、默认切换、停旧链还是删除？ |
| 退出验收/阻塞 | 证明停用 Node 后业务仍成立的真实证据是什么？缺什么输入或能力？ |
| 分立交付状态 | source commit、push、构件、loaded、真实 accept、Node 停用/删除分别是什么？ |

**总控：** 现有监督会话 `01a1df63` 负责汇总；W0/native owner `01a1d99a`、M/Desktop owner `01a1da12` 和其他域 owner 提供各自卡片。没有回执或只有源码证据的域不得默认为完成。本文不抢占或改写 owner 的详细账，不授权代交、危险删除或绕过验收。

总控已在原会话请求一次性退出卡：W0退出卡已本人提交 `2238d97e2` 并回报推送，Terminal已回00:04本人卡并核实浏览器桥/CLI shim残留；M/Desktop补卡请求已发出，部分因忙碌/草稿排队；表中明确区分本人ACK、监督源码核查与待确认。不得把排队当确认，不重复发送已结案提交回执。现有HTML状态页仍是另一owner的待确认设计；本轮只给一个稳定文档入口，不新增服务、轮询或第二套看板数据业务。

## 6. 用户如何查看

- 本页看总目标、事实快照、下一步和退出标准。
- [执行账](2026-11-14-node-go-execution-ledger.md) 看 W0–W6 的各次交付；[逐项审计](2026-11-16-requirement-evidence-audit.md) 看 42+7 门禁缺口。
- [W0/Codex/WORK退出卡](2026-11-16-w0-native-node-exit-status.md) 看本域完整caller/writer/退役门禁；本页R0–R8汇总跨域责任，不替代owner卡。
- [native WORK](2026-11-16-work-native-execution-acceptance.md)、[Terminal](2026-11-16-terminal-keepalive-repair.md)、[Desktop](../reviews/2026-11-15-desktop-host-migration.md) 看精确验收边界；不能从一个域绿色推出全项目完成。
- 后续总控回报应说明“这次消除了哪个 Node 必要依赖、还剩哪些、有谁负责下一步”，不能只给 commit 列表或“继续调查”。

**本轮监督仅在既有入口补当前事实、逐域退出卡和交付门禁；未新增功能/测试、看板服务或周期任务，未更改路由/业务实现、数据库、正式服务或其他 owner 的工作。整体 Node → Go 迁移尚未完成。**

文档检查：本轮重新核对源码caller、runtime identity/进程/哈希/旧stamp与原42项+7门禁；9个相对链接、9张退出卡、引用路径及单路径提交边界检查通过。Newton独立只读复核给出APPROVE、无阻断文档问题，仅限入口信息提交；之后W0本人已提交的退出卡链接通过存在性与精确提交范围补核。不外推为源码/全部域/发布批准。完整流量、平台与Node-off矩阵未在本轮执行。
