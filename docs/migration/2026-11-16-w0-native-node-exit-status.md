# W0 / Codex / native WORK：Go 归属与 Node 退出状态卡

> 原 owner：`01a1d99a`；回报监督：`01a1df63`。源代码核对基线：`61e06beed`，运行态观察时间：**2026-11-16 23:57（Asia/Shanghai）**，文档整理／复核跨至2026-11-17。本文日期文件名沿用该观察快照。本卡承接原 W0–W6，不另立平行计划。状态是 **Partial**，不是文件数意义上的“迁移完成”。

## 1. 交付判据与本次范围

目标是：**已迁域不再必须调用第一方 Node 业务／写者，由 Go 单一实现负责**，不是 Node 和 Go 各有一套同功能。Node 兼容修复只能是迁移必要的最小接线，并有移除条件。

本次只读审计调用链、提交与标准构件，记录退出门槛；没有新增功能、测试、源码修改、凭据修改、共享服务重启或 Node 文件删除。仅提交本卡和原执行账追加段落。不触碰 M/Desktop、terminal 的实现、提交、暂存项或他人维护的 `docs/migration/README.md`。

前端 React/TypeScript 的构建依赖，以及第三方官方 CLI 自己的运行时，不等于允许长期保留 AIH 第一方 Node 编排。退役目标是停止依赖 `bin/ai-home.js server serve` 等第一方宿主，不是盲目卸载机器上的 Node。

## 2. 当前真实运行 owner：纠正早期快照

| 层次 | 当前已观测事实 | 不能推导的结论 |
| --- | --- | --- |
| 公开服务 | 9527 为 Go PID `93990`；`/healthz`、`/readyz` 均200，ready=true | 健康200不是 native 全流程或 Node-free 验收 |
| 兼容宿主 | Go 父进程下存在 Node PID `94287`，只读端口观察为 `127.0.0.1:61740` | Node 存在不表示所有路由都在 Node；也不能说第一方 Node 已退出 |
| 当前运行身份／磁盘 | runtime identity 与标准 `aih-server` 磁盘摘要均为 `5cc9d8a9518f184d562cbd3b466ce3a090249e259bbcd0210ff9c9c59a0e503a` | 不沿用历史 `5919/6656` 或 `079a565d...` 为当前状态 |
| 内嵌构建信息 | `vcs.revision=cef00368e4a4eb29193a14a0992983876d080427`、`vcs.modified=true` | 虽然 `e036cf01f` 是该 revision 的祖先，dirty 构件不能据 revision alone 证明与某组完整提交逐blob一致 |
| build stamp | 同目录 stamp 仍指 `85851ec39` / `079a565db2f1be7ae138b1006e55558f48c966909f00776a974c8a1e4cbfc644`，与当前构件不符 | 这是构件来源证据缺口，不据此推断功能故障；不自行改 stamp 冒充正确来源 |
| 标准 CLI | `aih` 安装入口仍指 `bin/ai-home.js`；标准 `aih-go` 摘要仍为 `cac088bb126e46453f1212c6a98f7cbfc52d9d36244b8cd1114c35f07e46ed99` | Go 叶子命令已交付不等于整个公开 CLI 入口不需 Node |

证据读取限安全白名单：`~/.ai_home/run/go-server-runtime.json` 的 pid/port/startedAt/binarySha256；`bin/native/darwin-arm64/aih-server.build.json` 的 source_sha/binary_sha256/built_at/target；`go version -m`、进程 pid/ppid/comm、监听端口和健康入口。未输出环境、管理密钥或完整进程 argv。本次低敏记录：`/tmp/aih-w0-native-runtime-owner-20261116.json`。

**结论：**早期验收文档中的“当时共享构件未包含 WORK”保留为当时事实。当前不能继续断言 WORK 必然未加载，也不能宣布已精确加载并完成业务验收；需由当前发布 owner 给出与实际哈希匹配的构建输入和来源凭证。本 session 不重启或替换构件来补这个缺口。

## 3. 各子域实际归属、Node 残留与退出门禁

### N1 · W1/W3：Codex default / effort 的规则已在 Go，公开入口及后台同步未全退

- **Go 唯一目标／已迁核心：**`cmd/aih/provider_effort.go` → `codexpreferences`；`cmd/aih/codex_default.go` 与 `internal/host/aihserver/codex_default_projection.go` → `internal/host/codexdefault` 的选择、配置／凭据事务、锁与恢复。
- **仍必需的 Node 条件路径：**`bin/ai-home.js` 转交 effort/default；`lib/cli/services/ai-cli/codex-default-command.js` 成功后保留 Desktop effect／输出适配。普通公开 `aih codex` 未命中管理快路径时仍落 Node app/router；generic native-launch allowlist 不含 Codex。直接 `aih-go codex` 有 Go planner/runner，但并非公开入口全切。
- **仍存 writer，不能称纯薄壳：**auth artifact 更新 → `lib/account/artifact-hooks/index.js` → `runtime-support-wiring.js` → `lib/account/host-sync.js`；后者仍有条件写 `config.toml` / `auth.json`。这是源码可达条件，不声称本轮真实发生写入。公开 default receipt 已阻断旧 default 写入，`go-account-sync.js` 对受管 Codex default 也跳过；不能用这项保护泛化为所有 host writer 已退。
- **下一切换：**把公开 Codex launch 与残余 host 同步调用接到既有 Go 单事务／锁边界，不再增加 Node 选择或写配置规则。Desktop effect 接口与 M owner 协调，不抢写其文件。
- **退出验收：**真实 CLI set/unset/effort/原生逃生、默认账号 credential 变化、caller 生命周期与失败清理保持；禁止第一方 Node writer 后，同样操作只由 Go 写入且无旧值复活，再退休对应 adapter/writer。当前未执行禁用或删除。

### N2 · W1：exec-resume tier 与 caller-local app-server 核心 Go；安装 wrapper 仍经过 Node

- **Go 目标／已迁核心：**`internal/runtime/codexexecintent`、`internal/runtime/providercli/launch_preparation.go`、`internal/host/codexexecpreflight`；caller-local `internal/host/codexlocalappserver` + `internal/runtime/codexappserverws`。UUID/name/last/profile/stdin 选择、tier 控制与 lease 不应重新复制到 Node。
- **Node 调用／RPC：**`lib/server/codex-default-cli-launcher.js` → `codex-exec-intent.js` 私有管道到 Go；Node 仍掌握前台 spawn/helper 生命周期。安装的裸 `codex` wrapper 仍调用 `codex-app-server-stdio-proxy.js`，见 `internal/runtime/codexhooks/wrapper.go`；Go 生成 wrapper 不等于 wrapper 的目标已 Go 化。
- **更深残留：**旧 stdio proxy 仍做 thread/list 可见性/cwd、resume 配置协调、stale steer→start、hydration 与响应改写；`codex-app-server-stdio-proxy-rollout.js` 仍可条件性 `UPDATE threads SET rollout_path`。不能把它当纯字节转发。
- **已不同于旧路径：**公共 WS app-server handler 和 WebUI Codex RPC 已在 Go。caller-local tier opt-in 与公共 WS 的 rewrite options 不同，不能借 local 验收宣称全部 RPC 入口同一语义。
- **下一切换／门禁：**将已安装 wrapper 和公开 launch 调向 Go；逐项承接仍可达 stdio 语义，优先官方接口而非另建 rollout writer。真实验证 exec/resume/TUI/app-server 的选中线程、参数优先级、取消、断线、helper退出和 lease；第一方 Node proxy 不存在时仍成立，才移除旧 proxy/RPC writer。现阶段不删除文件。

### N3 · W0/W1/W5：本地非 Codex WORK 执行、session 和 composer 是 Go owner

- **Go 目标／当前源码：**`internal/host/worknative` → account selector/credential resolver/provider strategy/projection；`internal/runtime/chatruntime/{driver_native,native_prepared_process,native_stream_process,native_model_*}` 负责选模、env、实际 executable、进程管道、事件、终态与 Capture。`internal/transport/http/webuichatapi`、本地 project/file/slash handlers 直接到 Go。
- **不是必需 Node RPC：**本地 command catalog/slash/file/attachment 的同名 Node 文件主要是兼容代理，不能据文件存在算第二业务 owner。Claude approval MCP 启动当前 Go 二进制 `__mcp-approve`，标准装配回 Go SelfBaseURL。
- **条件兼容残留：**`webui_chat_runtime_routes.go` 仅在 SelfBaseURL 缺失且 NodeBaseURL 存在时绕 Node approval ingress，再代理回 Go；标准 `cmd/aih-server/run.go` 已提供 SelfBaseURL，因此该 fallback 不是标准启动必需。
- **本域阻碍：**AGY 无注册账号，尚无认证后 inference/resume/Capture 真验收；global Claude WORK 已记录真实上游参数拒绝；缺失 transport/credential profile 必须在 Go 补齐，不以悄悄退回 Node 充当实现。Pinned Claude 成功只证明 account-bound native launch/request/output，不证明 file-projection/Capture 已执行。
- **下一切换／门禁：**先用来源可复核的 committed candidate，明确不启动 AIH Node 宿主，验本地固定账号创建/composer/submit/stream/取消/recovery/cleanup，再验 confirm/plan allow/deny/timeout。所有装配使用 Go callback 后退休 Node approval fallback。已有 isolated pinned 成功不是这套完整 Node-off 矩阵。

### N4 · W0/W2/W5：页面壳与远端选择仍可能强制依赖 Node

- **Go 已有能力：**`internal/host/aihserver/webui_assets.go` 支持静态资源，public local handlers 已 Go 挂载；无需重写界面框架。
- **实际部署残留：**`lib/cli/services/server/autostart.js`、`lib/cli/services/background/macos-launch-agent.js` 的 Go-first 参数有 `--front-door --supervise-node`，未传 `--web-dir`；webDir 空时 `/ui/*` 可落 Node `web-ui-router.js`。另一 supervisor 入口会传 web-dir，属于启动合同不一致。当前进程 exact web-dir 未从敏感 argv 抽取，故不冒称当前每个静态请求必经 Node。
- **条件必需的远端 RPC：**已装配 frontdoor 的部署中，`internal/host/aihserver/remote_webui_proxy.go` 对带 `X-Aih-Server-Id` 的 `/v0/webui/*` 先交 Node；frontdoor 缺失时直接进入本地 handler，并不自动获得 Go 远端代理能力。`lib/server/webui-server-proxy.js` 从 Go profiles 取目标后完成鉴权及 HTTP/SSE 传输。这是传输 owner 残留，不是应复制一套远端 WORK 业务。
- **下一切换：**部署 owner 统一 webDir 合同／缺资源行为；remote-profile transport 改为 Go。监督分配既有 owner；本 session 不碰 M/terminal 接线。
- **退役验收：**没有 AIH Node 宿主时 `/ui/`、深层路由刷新、JS/CSS及404正确；两台真实服务验证远端 sessions/composer/commands/events/files/cancel，错误目标绝不回落本机，再撤相关 Node 服务入口。页面与 remote 能力未因 private CLI 成功而关闭。

### N5 · W4/W5：模型／别名 Go 数据面不等于 Node 来源和 writer 全退

- **Go 目标／已交：**`application/accounts/models.go`、`internal/adapters/accounts/sqliteaccount/model_{store,transaction}.go` 承担事务与 writer admission；`application/inferencecatalog/protocol_view.go`、`application/inferencegateway/model_route_view.go` 为 WORK 提供同快照路由／模型视图。
- **Node 初始化来源：**`lib/server/go-core-host.js:349–410` 读旧 `model_aliases` 并尝试向 Go 播种；除本进程 revision 去重外，只有成功读到非空 Go alias 列表才跳过，空列表及读取失败均可能继续推送。这不是已完成安全的一次性迁移。wildcard `displayModels` 仍由 `wildcard-alias-expansion.js` 基于快照展开。Go 已有持久 alias 可直接恢复，不是每个 turn 都问 Node，但首次迁移与展示来源仍未完全 Go-owned。
- **仍可达策略 writer：**accountSync 开启时，`lib/server/go-account-sync.js:610–630,868–927` 的 Node reconcile 仍依据账号状态／模型设置向 Go 写 enabled、provider default 和 model policy。Codex ownership guard **仅保护 provider default 同步**，不覆盖 enabled 或 model policy；`go-model-policy-sync.js` 的策略规划没有该保护。Go 是持久化写入口，不等于 Node 已退出值的决策。本轮仅核源码可达性，未执行 reconcile 或统计实际写入。
- **凭据归属不能凭旧注释推断：**当前 `token-refresh-daemon.js` 的 OAuth 主动续期转调 Go；仍有原生凭据观察／host sync。Go resolver 另保留 `self/delegated` 条件开关及 provider exemptions；此轮未读取运行中进程环境，不声称 active delegated。迁移应去掉本域已迁写者的隐式 fallback，而非恢复 Node OAuth 业务。
- **下一切换／门禁：**由负责账号/模型域的 owner 将旧表迁移做成 Go 一次性、有完成凭证的过程；wildcard 使用唯一 Go 数据源；逐域撤 Node policy/default/projection 写者。真实 DB 副本验证非空不覆盖、主动清空不复活、冲突/取消无迟到写、重启无需 Node 投影，之后才能退休旧 timer/播种/writer。禁止为了“只有一个库”宣称已经只有一个 writer。

### N6 · W0/W2/W6：Go 前门不等于第一方 Node supervisor 已退役

`cmd/aih-server/run.go` 在 supervise-node 模式启动 `internal/runtime/nodesupervisor`；它实际拉起并重启第一方 Node server。已迁路由直接 Go，未匹配路由由 frontdoor 转 Node。不能按路由合同占比宣布退出。

下一节点是各域上面的独立 Node-off 门禁满足后，部署 owner 移除该域转发/旧 writer；所有剩余域都有 Go 落点后，标准安装和服务生命周期不再默认启 Node。三平台安装/升级/启动/保留配置/停机/恢复仍需真实验收。当前用户没有授权本次停共享 Node、移除 supervisor 或破坏性删除；本卡不执行这些动作。

## 4. 分立交付状态：不混写 loaded / accepted / deleted

| 子域 | Source | Push | 构件 | Loaded | 真实 acceptance | Node 停用 | Node 删除 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Codex effort/default、exec/tier | `0d9468ae1`、`54152c844`、`152893bee` 等本人 checkpoint，见原ledger | 已在 origin/main | 标准 CLI `cac088bb...` 有先前交付证据 | 标准 CLI artifact 可核对；当前共享 server 精确源码映射需补 provenance | 原 Mac/Win/Linux 具体操作已记录，不能扩大到全部公开 wrappers | 未完成；公开 launch、stdio hook 与条件 host writer 尚存 | 未完成，本轮未删除 |
| 模型 writer admission | `0159605bc` | 已在 origin/main | 先前 private production build | 当前共享 artifact 的该实现 exact load 未重新证明 | 真实锁竞争、取消、last-good及刷新证据见专文 | Node policy/source 写者未退 | 未完成，本轮未删除 |
| WORK native / composer | `e036cf01f` + `987a3d026`，验收 `72631a417` | 已在 origin/main | accepted private closure `f915dfa3dd19f5b73eed51cadc529f1bce4ea0fa713fc9be131ad00b7c0b305e`，非当前 shared hash | 旧未加载断言只代表旧快照；当前 dirty构件缺精确来源证明 | pinned Claude实回、catalog/invalid/alias/cleanup已实证；AGY/Capture/globalClaude/完整Node-off仍Partial | 完整入口未退出；核心Go不代表所有入口已退旧 | 本轮无Node删除 |
| 第一方服务／UI／remote | 已有Go handlers；不借用他域提交冒称归我交付 | 本卡不认证他域push状态 | 当前 shared `5cc9d8a9...`、旧stamp不符 | Go93990+Node94287确实存在 | 健康只读200；本轮未重新做页面、remote或费用请求 | Node supervisor、部分入口/remote仍存在 | 未完成，本轮未删除 |

上述已交提交/索引本人闭环保留：57项原stale已逐blob同步，Chat 9项及他人后续工作不代处理。文件数不是迁移百分比。

## 5. 下一切换与退役节点、责任边界

1. **R0 先补当前加载证据。** 当前发布 owner 提供匹配 `5cc9d8a9...` 的构建输入／stamp与批准窗口记录；本owner负责核对自身已交范围。不为了修说明而重启或伪造stamp。
2. **R1 本域优先证明已迁本地 WORK 无第一方 Node 依赖。** 使用私有、可复核构件与真实账号/CLI，记录 child topology与请求路径、成功/失败/取消/审批/清理；缺AGY输入单列，不停止可执行的其他验收。不能仅因旧fixture或目录为空即放宽门禁。
3. **R2 退出 Codex 公开 wrapper/stdio/host writer。** 复用既有Go intent/default/RPC实现，旧JS只留明确短期入口；跨M/Desktop effect边界先协调。每一条旧调用关闭后再真实回归，不新建双轨业务。
4. **R3 由监督分配跨域部署/remote/alias/account writer的既有owner。** 以上N4/N5是已核对依赖，不是本owner抢占他人可写范围。必须回报目标Go路径、旧调用归零证据和退出日期/节点；未指定的责任明确待协调，不虚构完成。
5. **R4 只有调用归零及Node-off业务验收通过，才进入停旧/删除节点。** 停共享服务、改正式拓扑、删旧实现依用户批准另行实施；保留可回退构件，不保留两套默认业务owner。

## 6. 本次证据与复核边界

主owner只读核验运行identity/stamp/disk哈希、健康/监听、已交commit与调用链；未跑新业务、构建、测试或数据库操作。Hubble只读审计Codex CLI/default/stdio writer与当前构件身份；Mendel只读审计native执行/approval、static/remote、alias来源。两者不把源码可达性当实际流量或迁移完成。

本卡把后续门禁列为待执行；不改先前验收记录的历史事实。原42项W0–W6要求及7个共同交付门禁继续有效。**本轮报告的是消除Node依赖所剩的具体工作与责任，不是W0–W6完成声明。**

独立文档复核：Hubble通过N1/N2、来源凭证和状态分列；Mendel核对N3–N6并指出三处精度问题，已限定Codex guard只保护default、alias读取失败也可能触发推送、remote绕行须frontdoor已装配。修正仅为证据说明，不在本checkpoint改变对应业务。
