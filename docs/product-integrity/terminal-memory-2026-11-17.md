# Warp / iTerm2 多 AIH 会话内存事故：证据与处置方案

记录日期：2026-11-17，Asia/Shanghai。调查基点：`a35da53016931134a5a188d660e15628ef972da5`。

**事故规模更正（用户 2026-11-17 明确）：终端至少 15 GB，Warp 已超过 20 GB。** 下文的重开后采样只是另一时间段的基线，不用于否定该故障规模。不得用后台会话／MCP 的数 GiB 开销替代 GUI 终端异常归因；“应用组口径”只是尚未证实的可能性，不能作为解释用户观测的结论。

## 1. 当前结论：以 AIH / Provider / Harness 为排查对象

**范围更正（用户明确）：问题是多个 `aih provider` 会话里的 AIH / Provider / Harness 执行链发生了什么，不是让用户换终端、降低 VM 配额或少开会话。** Warp/iTerm2 至少 15 GB、Warp 超过 20 GB 是故障表现。此前把终端回滚作为首要处置属于重心偏移；第 2–7 节保留原始证据，但终端配置、VM、MCP 容量方案降为背景，**不作为本任务主方案和完成门槛**。

1. **已确认并修补一个 AIH → Harness 的执行链缺陷。** 原 `GET /v1/models?client_version=0.167.2` 的 232 个模型全部缺少窗口字段；Go 投影已补充精确模型 context 合同和官方 native 目录读取器。候选生产 Handler 的真实 HTTP 返回 9 个被同版本官方目录证明的窗口；其余 223 个不猜测。代码已写入当前工作树，但未提交、未重启／部署共享服务。
2. **新轮真实推理证明窗口已经作用于 Harness。** 同一官方 Codex、同模型和最小请求，修复前 `modelContextWindow=null`；修复后为 **258400**（官方默认 272000 × 95%）。两轮均真实联系既有网关、输入 6523 tokens、回复 `OK`、turn completed、exit 0；不是离线 JSON 或旧 usage 回放。
3. **真实过窗历史已自动压缩并继续执行。** 对本轮自身真实长会话的私有副本，未手动 compact、未降低窗口／阈值，原生 `contextCompaction` 从 started 到 completed；真实请求从 **4,112,360 bytes / 557 items → 32,216 bytes / 7 items**，字节减少 **99.217%**，存在持久 `compacted` 记录；最终模型回复 `OK`、turn completed、无工具执行。其后关闭并重启该私有 app-server，再次 resume 同线程，新轮仍 window=258400、input_tokens=11167、回复 OK 并 completed。
4. **这个缺陷与长会话累积有直接关联，但完整 20 GB 事故尚未验收。** 实际旧 harness 日志窗口／自动压缩阈值为 None；重启前有单次 918462 input_tokens、window null。修复恢复了原生上下文边界和压缩，能实测减少后续历史请求量；仍未取得全部并发、所有 Provider 和原始事故时长的堆保留链与内存曲线，不能声称“Warp >20 GB 唯一根因全部排除”。
5. **当前 provider 内存峰值与泄漏需区分。** 先前同一 app-server 曾达 466.4 MiB，活跃对象约 52.4 MiB、大块空闲分配区约 307.7 MiB，随后同 PID 回落。成功压缩运行的一组 RSS 在约 99.7–132.8 MiB，RSS 不是 physical footprint；不以其短时平稳替代目标并发长验收。
6. **交付边界与兼容审查。** 独立只读审查发现 npm 启动器子进程取消／底层版本失效风险，已改为识别并直接运行 official native payload；在未修改的官方 npm JS + 真实 native 布局中验证了缓存命中、只更换 native 后刷新、native 丢失时明确不可用、恢复后成功，并验证取消自有 HTTP 后 native 退出。三轮独立只读审查已结束，最终无新增阻断；混合 Node/Go 架构也按实际唯一 native 布局解析。没有用终端、VM、MCP 容量调整替代本任务。

**补充验收：** 两个私有真实 Codex 会话经候选 Go local-app-server 完成六轮只读工具调用，全部调用/结果配对、window=258400，90 秒空闲后回收，观测进程族 peak 144.82 MiB。真实官方 TUI 另做压缩前后历史副本只读 resume，各约 62 秒，TUI peak 约 27 MiB、未复现 GB 增长。上游同版本事件回放与本地候选窗口修补是不同责任，详见第 10 节。

**历史范围已部分还原：** 01:18:50 之前滚动五分钟有 6 个 Codex 主线程 + 4 个子代理写事件；闭合任务区间峰值 10 个线程，不等于 OS 进程数。对这 6 个主线程的真实当前历史快照，六套官方 TUI/Go bridge/harness 并行离线 resume，24 个采样、约 118 秒，族 peak 798.9 MiB→末尾 634.7 MiB，没有重现 15–20GB；这排除了“仅初始加载当前快照即可复现”的小范围假设，不排除持续活动累积。详见第 11 节。

**当前主线：已修复的精确模型窗口／原生压缩候选 → 激活方案与影响范围确认 → 实际目标并发／原始故障时长的 Provider/Harness 内存验收 → 继续覆盖剩余未知模型和其他 Provider。** 不以重启用户会话、清空历史或减少需求作为验收。

本轮修改范围为 focused Go context 合同、native 目录适配器、Codex 模型投影及共享 composition 的窄接线；原有 peer 改动全部保留、未 stage/commit/push。没有新增测试用例；验证为真实 HTTP/CLI/app-server/网关推理与原生自动压缩。完整本轮结果见第 9 节；第 8 节为修补前诊断记录。

## 2. 本机与时间线

- 机器：macOS 27.2.1 (26B131)，`hw.memsize=17179869184`。
- 本次系统启动：**2026-11-17 10:21:24 +0800**。
- Warp 安装版本：`0.2026.11.04.08.17.01`；iTerm2：`3.7.6`。这是本机版本，不是“最新版本”结论。
- `/opt/homebrew/bin/aih` 最终解析至本工作区 `bin/ai-home.js`。
- 当前 Warp 主进程 PID 19988、iTerm2 PID 23549，均在约 12:04 重开；不能把它们的 lifetime peak 当作昨晚事故峰值。

### 重启前系统事件

私有原始证据：`~/.ai_home/diagnostics/terminal-memory-20261117-122027/kernel-low-swap.log`。

- 01:18:51.094：`killing_idle_process ... (low-swap ...)`。
- 01:18:51.182：`triggering no paging space action due to low-swap`。
- 01:18:56.199：`doing pcontrol on Code [49079]`。
- 01:19:01.213：`doing pcontrol on ZCode [62286]`。
- 01:20:08.990：仍在执行 low-swap / pcontrol 操作。

该两分钟窗口含 794 条 `killing_` 事件行。这是日志事件数，**不是经去重的进程数**；不可据此声称杀死了 794 个不同进程。`pcontrol` 同样不能无条件等同于该应用已因 OOM 退出。

RunningBoard 状态快照可以辨认历史 Warp PID 13208、iTerm2 PID 3271，但没有取得它们的内存大小和确定的退出原因。已做的有限时段查询不能覆盖整个事故，也不能把超时／空结果当作“没有异常”。

### 排除误用的报告

- `/Library/Logs/DiagnosticReports/JetsamEvent-2026-11-17-102346.ips` 在本次重启后，记录的是 `modelmanagerd` 的 `per-process-limit`；不是 Warp/iTerm2 至少 15 GB、Warp 超过 20 GB 的历史异常证据。
- 11 月 16 日 18:48–18:50 的 `aih-server-*.ips` 是 `SIGKILL (Code Signature Invalid)` / `Taskgated Invalid Signature`。不能因为文件名含 aih 就算作本次内存崩溃。
- `ps VSZ`、`vmmap TOTAL VIRTUAL` 的几百 GiB 是虚拟地址空间口径，不能当成实际内存。当前终端 `vmmap` 的 physical footprint 只有数百 MiB。

## 3. 实际进程采样

方法：依据本机 SDK `sys/resource.h` 的 ABI，调用 `proc_pid_rusage(RUSAGE_INFO_V4)`，取得 `ri_phys_footprint`、lifetime peak、进程启动标识；辅以 `ps` 的 PID、PPID、RSS、comm。**不采集命令参数、环境变量或终端正文。**

2026-11-17 **12:20:27–12:22:28 +0800**，间隔约 15 秒，共九次：

| 分组 | 最后一次进程数 | Footprint 范围 | 说明 |
| --- | ---: | ---: | --- |
| Warp | 2 | 383.6–403.3 MiB | 主进程及同路径辅助进程 |
| iTerm2 | 1 | 235.0–253.8 MiB | 主应用本身，不含独立子进程 |
| aih-server 同名进程 | 13 | 464.5–825.5 MiB | 1 个主服务及 12 个带 parent-pid 的辅助进程，不是 13 个主服务 |
| Codex | 24 | 1350.2–1422.6 MiB | 当时 12 CLI + 12 app-server；并不表示 24 个独立用户会话 |
| Node | 60 | 3384.3–3524.2 MiB | 包含不同用途；不能全部归为 AIH wrapper |
| MCP npm launcher | 13 | 653.7–653.9 MiB | 另外还有其 Node worker，不能只按 launcher 估算总成本 |
| Edge | 19 | 2683.0–2922.3 MiB | 浏览器进程集合 |
| Colima VM | 1 | 5054.7–5057.1 MiB | 通过打开的 `.colima/_lima/colima` 文件识别 |

各行是分组 footprint 的和，不是“实际 DRAM 的可直接相加清单”；压缩内存、共享映射和记账方式需要区分，不能用简单求和宣称超过物理 RAM 的部分就是泄漏。

主 aih-server PID 1359 在采样中从 217.1 升至 561.8 MiB，采样结束 lifetime peak 577.5 MiB。共享服务同期有工作负载，这不足以认定泄漏，但也**不能据此排除主服务增长**。后续要同时记录请求／会话负载和空闲后是否回落。

后续 `vmmap` 验证：Warp 主进程 380.0 MiB / peak 425.8 MiB；iTerm2 211.3 MiB / peak 280.6 MiB。Warp 使用的 jemalloc zone 不能被本次 vmmap 完整解析，因此不能依靠该 malloc zone 表归因具体对象。

排查期间 swap 从约 2.1 GiB 增至约 3.4 GiB；这不是同一时间窗下的泄漏速度证明，也包含并行工作负载和诊断开销。一次过宽的历史日志读取自身接近 1 GiB，已按精确 PID/命令核验后只停止本轮该读取器，随后使用带超时的窄窗口查询。没有停止用户会话。

## 4. AIH 链路核对：哪些已知，哪些只是嫌疑

### 4.1 已知有界的数据

- `lib/cli/services/pty/pty-runtime-run.js:2056–2060`：子进程输出转发后，识别用 `outputBuffer` 限制为 4000 字符。
- `lib/cli/services/pty/shell-drawer-controller.js:272–281`：抽屉打开时主输出缓存限制为 120000 字符。
- `internal/runtime/terminalsession/service.go:38`：Go Web 终端默认 replay 上限 256 KiB；仍需区别订阅队列与浏览器/终端本地缓存，不能用它证明全链路都只有 256 KiB。
- `lib/runtime/persistent-session.js:92,117` 及 Go mux：tmux 默认 `history-limit=50000`。当前 Codex socket 的 12 个 pane 均 `alternate_on=1`、`history_size=0`，导出的 `history_bytes` 合计约 1.14 MiB；不是当前多 GiB 的来源。历史旧 pane 的状态无法由当前值还原。

### 4.2 应优先对照的输出放大点

`lib/cli/services/pty/persistent-launch.js:69–79,382–383`：**仅 Claude、非登录且启用持久 tmux 路径**默认注入：

```text
CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1
CLAUDE_CODE_FORCE_SYNC_OUTPUT=1
CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL=1
```

本机已安装 Claude 2.1.325 的实现中存在对应开关，虚拟滚动相关分支实际读取 `DISABLE_VIRTUAL_SCROLL`；不能将它当成无效环境变量。这组兼容策略是长会话重绘／保留成本的重点嫌疑，**尚未取得该机器上的因果对照**，而且它不能单独解释 Codex 路径或两个终端所有增长。

有现成的单会话退出兼容注入开关 `AIH_CLAUDE_TMUX_RENDER_COMPAT=0`。只影响新启动的 wrapper；若 attach 既有 tmux provider，不会改变已启动 provider 的环境。不得以为在另一个 shell 里 export 就修复了所有现有会话。对照必须创建自有新会话，不杀原会话、不接管用户 pane。

### 4.3 标题事件与输出背压

- `lib/cli/services/pty/terminal-title/composer.js:11`：busy spinner 120ms；`terminal-title/index.js:31`：多帧轮播 4000ms。标题来源和 transport 已分离；不要为了降开销删除用户已约定的会话名／账号／模型轮播。
- `shell-drawer-controller.js:81–87`：主输出直接 `stdout.write(data)`，未使用返回值驱动 PTY 暂停／恢复。**缺少显式背压不等于已经证明内存泄漏**：必须先判断实际 stdio 类型、平台行为以及排队字节是否增长。更不能把 Node 写队列和 GUI 终端历史缓存混成一个对象。
- 本机 Node v22.21.0 的实际内置 `tty.WriteStream` 构造器调用 `this._handle.setBlocking(true)`。因此，普通本地 TTY 路径不能仅凭没有 `drain` 就认定存在无限异步 stdout 队列；管道／代理路径必须单独验证。此证据进一步降低了“直接 stdout 队列就是终端异常高占用根因”的可信度。
- 不允许直接丢弃、截断、正则合并任意 PTY 字节来“限流”；这会破坏 ANSI 状态机、Unicode、终端能力查询和工具交互。若证实队列增长，应以有界流控和上游暂停处理；只允许合并 AIH 自己拥有的标题状态。

## 5. 早期候选方案归档（已由第 8 节 Harness 主方案取代）

**本节保留排查历史，不再代表执行优先级。用户已明确要求查 AIH / Provider / Harness，不执行本节终端／VM／MCP 配置调整。**

### 早期 P0 候选：配置止血（未执行，不作为本任务门槛）

1. **iTerm2**：对 AIH 实际使用的 profile 关闭无限回滚，初始建议上限 **10000 行**。若 profile 存在并开启备用屏幕写入回滚选项，在 AIH 专用 profile 关闭；历史当前值未导出，不得声称已开启。保留会话日志／Provider 原生会话记录作为完整历史，终端回滚只作为展示缓存。行数上限不是字节硬上限，仍需看 footprint。
2. **Warp**：本机 Warp 实际数据库位于隐私保护的 Group Container，读取返回 `EPERM`，未修改隐私授权。没有验证本版本提供的回滚/块保留上限入口，不能虚构配置键或直接写数据库。需通过用户可见设置确认保留策略；若没有可验证的限制，则继续观测并以可移植的会话持久化控制展示生命周期，不宣称 `clear` 一定释放内存。
3. **系统余量**：保持现有业务不动；确认 Colima 所承载容器负载后，再决定是否将 VM 从 6 GiB 调至 4 GiB。此项可能需重启 VM，必须单独获批，不能在排查时擅自停止 Docker/业务。多会话先做容量预算，不把“永远少开会话”当最终修复。
4. 不增大 Node heap 上限，不自动杀终端，不随意清空历史，不向全局 shell 配置写未经验证的开关。

### P1：可追责观测

- 首选 `physical footprint + RSS + lifetime peak + PID/start identity`，并区分终端主进程、wrapper、Provider、MCP 和 VM。
- 正常每 30 秒采样；默认不采集正文或凭据，轮转和体积限制必须存在。异常增长时才抓有限大小的 `vmmap -summary`／必要堆证据。
- 对本机 16 GiB 的**建议初始告警值**：单终端 footprint 连续两次超过 2 GiB 提醒，超过 4 GiB 升级；或连续多次出现超过 256 MiB/min 的增长时留证。这是观测阈值，不是“低于该值必然安全”的承诺，不实施自动 kill。
- 同时记录系统压力、swap 变化和活跃会话数。指标在终端退出前写盘，不能再只依赖进程死亡后的截图。
- 若异常归于终端：区分文本／块历史、字体/布局、图像、标题和 GPU 对象；Warp jemalloc 的限制要明确记录，不能拿不完整统计断言没有泄漏。

### P2：只做真实对照，不新增测试用例

同一台机器、同一终端 profile、相同窗口尺寸和可比较的真实长会话负载，逐个变量比较：

1. 原生 Provider 与 AIH 包装（区分是否 tmux、是否新会话）；
2. Claude 默认兼容策略与自有新会话退出兼容策略；
3. 只降低 AIH 标题更新频率的候选与原策略，保留全部标题轮播语义；
4. 固定有限回滚与原 profile；无限回滚的高负载对照必须有内存中止阈值，不在已紧张机器上硬造 OOM；
5. Warp 与 iTerm2 分开观测，不把一个终端的通过外推给另一个。

先 30 分钟受控采样，再至少 2 小时或不短于实际复现时长的业务长会话，并覆盖目标并发数量。记录输出字节/帧数、终端 footprint、Provider footprint、输入延迟、回滚大小和负载阶段。屏幕完整、中文/emoji、粘贴、resize、断线重连、换号后的草稿保持均要真实验收；不因为内存降低就接受交互损坏。

### P3：按证据改代码

- 若 Claude 兼容组显著放大增长：把三个独立开关从强制组合改为按已验证终端能力／版本决定的窄策略；优先保留同步输出，避免未经验证地一刀切移除渲染兼容。
- 若标题事件导致增长：在统一 facade/transport 中合并状态和限制频率，不向各 Provider 分散打补丁。
- 若写队列增长：增加独立流控 adapter，真实 PTY 暂停/恢复、drain 后继续，队列有界；不得丢弃字节或侵入协议路由。
- 若属于终端内部：携带最小复现、版本和限量内存证据验证候选版本；升级不是未经复现的万能答案。
- 若主 aih-server 仍持续增长：进一步取得 Go 堆与空闲回落对照，独立处理，不与终端自身缓存混淆。

执行步骤见 `docs/superpowers/plans/2026-11-17-terminal-memory-containment.md`。

## 6. 本轮产物与未完成项

私有证据目录：`~/.ai_home/diagnostics/terminal-memory-20261117-122027/`，约数 MiB，仅当前用户可读；包含九次 JSON 快照、汇总、有限历史内核日志、iTerm2 相关设置摘录、tmux metadata 和终端 vmmap。没有放进 Git，没有复制账号凭据或终端会话正文。RunningBoard 的原始状态记录仍可能包含本机元数据，应保持私有，不直接发送第三方。

官方网页检索本轮没有返回可用结果，iTerm2 官方页面直接抓取返回 403；本报告不依赖未核实的线上版本／设置入口，依据本机进程、偏好设置、SDK、安装实现和工作树源码。

**完成的部分：** 系统内存危机取证、当前分层内存测量、无限回滚风险确认、AIH 关键链路审计、分级处置及真实验收计划。

审查方式：本轮未获授权派生 reviewer，执行显式 `self_review` 与 `plan_check`：复核了数字/单位、源码引用、终端主进程与子进程归属、时间范围、证据权限以及各项未完成边界；未静默假装独立审查已通过。

**未完成的部分：** 终端至少 15 GB、Warp 超过 20 GB 的历史异常分配对象归因、P0 配置批准与应用、长时间／目标并发真实复现和修复验收。因此不标记“泄漏已修复”或整个目标完成。


## 7. 继续排查：后台会话、MCP 与真实对象基线

本节为 2026-11-17 午间继续排查的增量证据。未批准的 profile／VM／MCP 配置仍未改；没有启用 iTerm Python API、没有隐私授权绕过、没有 AppleScript、没有创建或清理用户 pane。

### 7.1 低内存面板时间线进一步确认

新增有限窗口的 `--info --debug` 读取证实 **01:22:00** loginwindow 打开 `LowMemoryPanel`，**01:22:10** 开始低内存采样。该时段的面板扫描明确仍包含 Warp 与 iTerm2，但没有公开进程大小数值。它进一步证明系统进入了低内存处理流程，**不能推断两个终端在 01:18 就已经死亡**，也不能还原用户看到的至少 15 GB、Warp 超过 20 GB 的占用构成。

### 7.2 “关闭窗口”不等于“释放持久会话资源”

约 12:46 的 tmux 元数据与真实子进程关联：14 个可访问 pane 中，**9 个 session 没有连接客户端**；这些 pane 的可读取后代 footprint 合计 **2906.4 MiB（约 2.84 GiB）**。其中 8 个是 Codex，1 个是 Claude。当前 12 个 Codex pane 中，8 个未连接的后代合计约 2725 MiB。

这些后台会话不是按 detach 状态就能判定的僵尸；它们可以运行未完成任务。未执行 kill 或自动回收。8 个未连接 Codex 的 tmux 创建时间均在 **10:24:28** 左右，与重启后恢复窗口一致；源码 `lib/server/server.js:1832–1854`、`persistent-session-restore.js:256–307` 也有后台恢复机制。时间吻合与源码相符，但没有取得逐个 restore 日志，不能把所有后台工作都断言为错误恢复。

**方案补充：** 区分“会话历史／恢复元数据”和“仍在执行的 Provider + app-server + MCP 进程”。如果将来要让完成且空闲的会话休眠，必须先能证明任务已终止/空闲、保留可恢复信息，并验证下次恢复的语义；不能为了省内存破坏用户要求的持久会话。重启自动恢复也需要容量预算／分批启动，不能擅自关闭所有后台工作。

### 7.3 MCP 的重复启动开销已经量化并做了真实握手对照

当前观测到的 15 组 XcodeBuildMCP npm launcher + 直接 worker 合计约 **1888.0 MiB**，仅 npm launcher 约 **755.2 MiB**。同一 Codex 会话可能有自己的 app-server 和一套 stdio MCP，不能把这些进程都归为终端自身内存，也不能宣称能直接合并为一个共享实例。

本轮使用**已安装的同一 XcodeBuildMCP 2.7.0 入口（SHA256 相同）**做了顺序真实协议对照；均在各自私有 HOME/CWD，关闭遥测，不继承凭据，不调用构建／设备／模拟器工具：

| 启动 | 实际协议 | 稳态 footprint（启动 20 秒后） |
| --- | --- | ---: |
| 直接 `node <installed-entry> mcp` | initialize + initialized + tools/list，24 tools | 59.276 MiB |
| `npm exec --offline --call 'node <same-entry> mcp'` | 相同，24 tools | 整组 91.766 MiB |

本对照差约 **32.489 MiB/实例**，其中 npm 父进程约 32.91 MiB。两次均观察约 38 秒，stdin 关闭后 exit 0，复查私有 HOME 下无存活进程。这个证据支持“使用固定版本的直接可执行入口，消除每实例常驻 npm”作为**系统余量优化**。不能把私有握手对照称为正式全部工具等价，也不能线性保证对 15 个正式实例恰好节省 755 MiB；正式配置/工具/版本和长期负载还需验收。

不要把 `.npm/_npx/<hash>` 缓存路径直接写成长期生产契约；应先选择稳定的受管安装路径、固定版本和明确升级流程，再获得配置变更批准。没有修改当前 MCP 配置或安装新依赖。

安装源码的 `server/server.js` 使用 `StdioServerTransport`。CLI 的 per-workspace daemon 不等于可复用的共享 HTTP MCP 服务；未经隔离／状态验证，不建议用通用多路复用偷偷把不同会话合并。该安装版本虽有 `XCODEBUILDMCP_MCP_IDLE_TIMEOUT_MS`，默认 0（不退出），但 stdio client 是否自动重连尚未验证；不能直接打开 idle exit 导致现有会话失去工具。

### 7.4 iTerm2 对象基线：本轮不支持“Replay 或历史行已经占到 GiB”

`heap -s -H --noContent` 两次真实读取同一 iTerm2 PID 23549：

| 约定时刻 | Footprint | malloc 对象总量 | DVR | LineBlock/LineBuffer 可识别分配 | CFString |
| --- | ---: | ---: | ---: | ---: | ---: |
| 12:40:39 | 224.0 MiB | 83.9 MiB | 8.071 MiB | 约 0.060 MiB | 17.5 MiB |
| 13:02 左右 | 265.6 MiB | 83.0 MiB | 8.074 MiB | 约 0.077 MiB | 19.5 MiB |

DVR 底层两块 buffer 均合计 8 MiB，当前没有随该时段输出变成 GiB。LineBlock 相关表只是可识别分配，不保证涵盖每个裸 raw buffer；不要把它当完整历史保留字节数。malloc 对象和 footprint 不是同一口径，不能用差值直接命名为 GPU 泄漏。后续应在异常增长时再做同对象／映射对照，而不是全局关闭回放后宣称根因。

同一时段 Warp 主进程 `vmmap` footprint 约 380.8 MiB、peak 425.8 MiB；仍受 jemalloc zone 解析限制。

### 7.5 观测程序与身份边界

在私有目录运行 `capture.py`：每 30 秒、最多 30 分钟/61 次、JSON 总量预算 8 MiB；只读 PID/PPID/comm/start identity/RSS/footprint/peak/swap，不记录 argv、环境或终端正文，不自动 kill，也不自动抓大型 heap。它是本轮取证工具，不是新增测试用例或常驻生产服务。权限目录 0700、文件 0600。

新增私有证据目录：`~/.ai_home/diagnostics/terminal-memory-followup-20261117-123754/`。运行完成与完整趋势另行写入汇总，**脚本存在或元数据文件存在都不能当作仍在运行／已完成的证据**。

采样发现共享主 aih-server 在本轮外部操作下多次更换 PID：12:29:55 启动的 57310 随后被 74748、77253、81103 等进程替换。没有由本轮发起重启。所有曲线应按 `(pid,start_ticks)` 分段；旧 PID 的高值和新 PID 的低值之间不能称为 GC 回落或泄漏修复。

首次继续采样对拒绝 footprint 的 root login broker 不保留 topology，因此内置 descendant 汇总可能漏计。已另存 `topology-complete-once.json`（拒绝的 footprint 标为 null）和 `terminal-ancestry.json` 校正进程链。约 12:48 的完整拓扑：Warp 自身约 375.6 MiB、可读取后代约 377.0 MiB；iTerm2 自身约 231.3 MiB、可读取后代约 140.7 MiB，另有两个 root login 的 footprint 不可读。不将漏计 descendant 数字冒充精确总量。

**增量结论：** 后台持久会话和每会话 MCP 存在已量化的独立内存成本，且消除常驻 npm 的候选已有真实协议证据；但 GUI 终端至少 15 GB、Warp 超过 20 GB 的历史异常具体对象依然没有定位，不因这些新发现改变原问题的完成标准。


## 8. 主线收敛：AIH 模型目录 → Harness 窗口／压缩 → 长会话内存

### 8.1 已证实的模型合同缺口

真实本机接口（只读，标准客户端密钥仅在内存中使用，不回显、不保存）：

```text
GET /v1/models?client_version=0.167.2
HTTP 200
models=232
missing context_window=232
```

源码：`internal/transport/http/modelsapi/handler.go:168–169` 调用 `newCodexModelList`；`codex_projection.go:24–50` 的传输结构没有窗口字段，其构造也未传窗口。该结论不是凭静态搜索猜测，实际接口和宿主官方客户端缓存一致。

用同一已安装 Codex 0.167.2 的受支持命令 `debug models --bundled`（私有 HOME、无账号凭据、没有模型请求）读取官方内置元数据：

| 精确模型 | 官方默认窗口 | 官方最大窗口 | AIH 原生目录 |
| --- | ---: | ---: | --- |
| gpt-6.1-sol | 272000 | 872000 | 均缺失 |
| gpt-6-astra | 272000 | 872000 | 均缺失 |
| gpt-5.5 | 272000 | 272000 | 均缺失 |
| gpt-6.1-terra | 500000 | 872000 | 均缺失 |

其余精确交集和来源存于 `gateway-vs-bundled-exact-context-diff.json`。官方内置目录只有 12 个模型，不可拿这些窗口填满 232 个任意模型；未知模型不能继承同家族／第一条模型的窗口。

还核对 `buildModelCatalogProjectionArgs`：当前模型 slug 已存在时直接返回，不会修复已经缺字段的精确命中项。WebUI 的 `chat-harness-model-metadata.js` 另有窗口注入，但不能据此声称 CLI 原生目录路径也得到了窗口。

### 8.2 实际 Harness 限制为空，与故障前长历史相关

只读本机官方日志并只输出数值与控制字段：

```text
auto_compact_scope_limit=None
full_context_window_limit=None
auto_compact_window_prefill_tokens=None
token_limit_reached=false
```

当前高增长会话日志有 `history_items=1258`、`input_items=1254`；`total_usage_tokens=2475844` 为内部计数，不等同某次请求输入。该线程最近一次实际 token 事件另有 `input_tokens=520171`。

重启前 **2026-11-17 01:18:50 +0800** 之前的记录：

- 线程 `01a1da12-9ab6-7a70-929e-581822624377`：最后一次 `input_tokens=918462`，`model_context_window=null`，模型 gpt-6-astra；此前有 1 条 compact 记录，最后在 11 月 15 日，不能说历史从未压缩。
- 线程 `01a1da3a-a43d-7c23-a16e-a4f89615faaa`：最后一次 `input_tokens=612986`，窗口 null。
- 线程 `01a1e3d0-0663-75f3-abe2-a24f9f261373`：事故前最后一次 `input_tokens=350763`，窗口 null；该文件事故前没有 compact 记录。

这些是旧原生会话里的元数据，不是本轮模拟出的负载；不导出提示词、工具正文、凭据。它们支持“长会话上下文没有得到正常窗口边界”的优先修复方向，但不是“20 GB 全部是 token 文本”或“超窗就是唯一内存根因”的证明。

### 8.3 真实对照通过了什么，没有通过什么

1. **官方目录读取对照**：相同 `codex debug models`、相同私有运行条件，仅改变精确模型的目录字段。AIH 原样：窗口 null；仅补 `context_window=272000`：返回 272000；再补官方最大值：返回 872000。三次 exit 0。证明客户端能读取这些字段，尚未触发真实 turn / 自动压缩。
2. **真实历史分页读**：使用本轮自身 session 的真实完整记录快照和 `threads`、`thread_turns`、`thread_items`、projection state 的单线程只读副本。首次只拷 rollout 的尝试得到 0 turns，因为是 paginated history，不算完整历史读取；补齐 343 条 item 投影后，10 次真实分页 RPC 有 100 items / 3 turns，响应非空。footprint 约 16.0→28.2 MiB，6 秒空闲后持平，exit 0。没有模型／工具请求。
3. **私有 resume**：第一次模型 provider 名不匹配被官方拒绝，保留为失败观察，不能用作窗口对照。后续沿用 aih_server 身份但指向无网络的私有配置，两组成功 resume；tokenUsage 通知都来自持久历史，窗口仍 null。不能将其称为“补字段后压缩已生效”，须在新 turn 的有效配置／限制日志验证。
4. **内存对象**：线上官方 app-server 11435 曾达 466.4 MiB，但活跃对象约 52.4 MiB、large empty/swapped 约 307.7 MiB；同 PID 后续回落，不支持当时全是持续不可达对象泄漏。该 PID 后来不再存活，需以进程身份分段，不能继续对它发信号或把新进程低值拼接为回落。

### 8.4 修补前拟定方案（实施状态以第 9 节为准）

**第一步：恢复精确模型上下文合同。**

- 聚焦 `modelsapi` 的 Codex 投影，增加明确的窗口读取端口／聚焦适配器；不要在 `handler.go` 或 Provider 启动大文件塞新的目录扫描逻辑。
- 数据来源按业务配置／上游精确声明／已安装官方 CLI 精确模型／已有元数据目录等受信来源定义优先级；默认窗口与最大窗口不可混用。
- 已知精确模型携带真实 `context_window`（和被证实的最大窗口）；不猜未知模型，不把 gpt-6.1-sol 的 272000 强写到所有 232 个模型；不强改用户模型或推理强度。
- 同时覆盖 CLI → caller-owned app-server 与 WebUI harness，不只修当前页面显示。已存在 slug 但缺字段时也要能完成补齐。
- 不覆写宿主缓存；优先修发布方，再验证新会话实际消费的目录和 effective config。运行中的 provider 是否刷新由真实协议／日志验证，不为加载补丁杀正在工作的 session。

**第二步：验证压缩策略真的生效。**

- 受控自有新会话，确认 `model_context_window` 与 `auto_compact_scope_limit` / `full_context_window_limit` 不再未知；不得用旧 tokenUsage 回放代替新轮日志。
- 根据用户选定模型窗口和既有压缩策略触发压缩；先明确阈值来源，不凭空选 80% 当所有 Provider 通用政策。用户主动设置优先，不另造重试/压缩循环。
- 验证 tool call/result 配对、encrypted reasoning、自动目标推进、会话 resume、换号草稿均保留；不能用强截断历史换取低内存。

**第三步：把内存放大定位到具体执行层。**

- 按同一 session、PID/start identity 关联 AIH wrapper、Go local bridge、官方 CLI/TUI、app-server，记录每轮输入 item 数／wire bytes／工具结果长度／compaction、活跃 heap、allocator high-water 与空闲回收。
- 串行与目标并发比较，检查 large frame 解码/复制、tokenization/reasoning 历史保留与背压，而不是仅看总进程数。
- Go 主桥 `BridgeAppServerStdio`、resume/list tracker 目前源码有帧／数量上限；Node legacy `createLinePump` 仍未设半行上限，但当前 12 个 CLI wrapper 在入口已走 run-cli 分支，不实际使用该 pump。它是独立防御缺口，不能在未证明执行的情况下宣布本次根因。
- 如果带窗口／正常压缩仍出现同层无界增长，再依据真实 heap/alloc 证据修 provider/harness 或 AIH；不先卸载插件、清空历史、删会话或重启整个工作环境。

**完成要求：** 新轮有效窗口／压缩有直接证据；原始故障时长和目标并发下执行链内存无持续无界增长；至少 15 GB／Warp 超过 20 GB 的故障有可解释且可复现的分配链路或足够等价的新证据。当前未满足，不声称已修复。

### 8.5 证据、清理与范围

私有目录 `~/.ai_home/diagnostics/harness-memory-20261117-132111/`：原生进程 footprint、vmmap、heap、目录差异、仅数值的 provider 日志摘录、官方 schema、真实历史私有副本及协议摘要。真实历史副本含会话内容，因此只保存在私有目录、禁止提交和对外直接发送。

所有自有 app-server 根进程退出、私有 HOME 进程匹配为空；未向用户进程发信号。旧观察中的 provider 元数据不完整、分页首次空结果、resume provider 错误及旧 usage null 均已如实保留。上轮 30 分钟观察完整结束于 13:08:09，61 samples；没有把它当长期修复验收。

本节对应修补前只读排查阶段，当时没有修改生产业务代码／宿主缓存／用户配置或重启共享服务。后续实际代码与独立审查见第 9 节；不将早期 self_review 记录冒充完整业务验收。


## 9. 窗口合同修补与真实原生自动压缩验收

时间：2026-11-17 13:53 后；私有证据目录：`~/.ai_home/diagnostics/harness-context-fix-20261117-140102/`。**候选已落工作树，未部署到共享服务。**

### 9.1 代码边界

- `application/modelmetadata/context.go`：窗口值和只读快照接口；default 必须正数、maximum 不得小于 default；未知不伪造。
- `internal/runtime/codexmodelcatalog/bundled_context.go`：已安装官方 `debug models --bundled`；私有 HOME、凭据环境 allowlist 排除、5 秒／4 MiB 限额、并发刷新合并、取消不写负缓存、失败 1 分钟退避、成功 1 小时缓存、运行前后核对 native identity。
- `internal/runtime/codexmodelcatalog/native_binary.go`：识别 native magic，npm/pnpm optional 平台包及 vendor fallback；不运行 JS/shell 来发现 target。对官方 npm alias 目录，manifest 真实名称仍为 `@openai/codex`，按包布局解析精确 native 文件；native 身份同时用于执行与缓存。
- `internal/transport/http/modelsapi/codex_context.go`：单次快照、精确 slug join；不从家族、alias target 或第一条模型借窗口。
- `codex_projection.go`／`handler.go`：Codex 传输字段与独立端口接线；读取失败用 `X-AIH-Model-Context: unavailable` 暴露，不影响标准 OpenAI 目录／模型路由／用户配置。
- `internal/host/aihserver/composition.go`：仅模型 Handler 的 ContextWindows 接线块属于本轮；账号删除、OAuth 等其他 staged/unstaged hunk 均为 peer 工作，不纳入本次产物。

本次仅提供被官方**精确模型**证明的兜底元数据。223 个未命中模型仍未知，尚未做账号级上游探测／业务 override 的通用窗口服务；用户 CLI 显式 model_context_window/compact 配置仍由官方客户端优先处理。不能宣称覆盖所有模型或其他 Harness。

### 9.2 实际生产模块 HTTP 与故障回退

临时只读诊断服务使用真正的 `modelsapi.Handler`、models.dev 索引、公开 232 模型投影及新的 native reader，不访问账号凭据或调用假模型服务：

- 原生目录 232 项，9 known／223 unknown；Sol=272000/max872000，Terra=500000/max872000。
- 标准 `/v1/models` 仍 232 项，未增加 Codex 专用 context 字段；未鉴权=401。
- 同时 12 个请求全部 200；缓存后约毫秒级，结果相同。
- binary 不可用时仍返回目录但窗口未知，并有 unavailable header，不伪造窗口。

证据：`production-handler-observation.json`、`production-handler-final-known_binary.json`、`production-handler-final-unavailable_binary.json`。

### 9.3 新轮真实 Provider 对照

官方 Codex 0.167.2，两个独立私有 HOME、同模型 gpt-6.1-sol、同只读请求“不要用工具，回复 OK”，真实请求走现有网关：

| 目录 | 新轮 input_tokens | 原生 window | 结果 |
| --- | ---: | ---: | --- |
| 修补前当前公开目录 | 6523 | null | OK / completed / exit 0 |
| 候选 Handler 返回目录 | 6523 | 258400 | OK / completed / exit 0 |

证据：`live-turn-context-comparison.json`。后续只为读取日志的短诊断没有取得限额日志行，不能称其证明阈值；完成证据来自下一节真正的自动压缩。

### 9.4 实际长历史自动压缩及续接

输入为本轮自身真实线程的私有副本（rollout 与该线程分页投影），旧 `last_token_usage.input_tokens=332623`、window null；不是人为填充长字符串，也不是模型模拟器。

- 只把候选窗口目录接入私有配置；没有写 model_context_window 或人工 compact threshold，没有调用 `/compact` 或 `thread/compact/start`。
- 新 `turn/start` 自动产生 contextCompaction started；透明 loopback 转发完整请求到正式真实网关，协议事件计数不保存正文。
- **第一个真实 HTTP 200 SSE**：4,112,360 bytes、557 items；压缩推理约 136.75 秒后 contextCompaction completed，原生 window=258400；持久记录 `compacted` 1 条。
- **第二个真实 HTTP 200 SSE**：32,216 bytes、7 items，后续 input_tokens=11131；最终 turn completed，无工具调用，回复 `OK`；总 144.28 秒，exit 0。
- wire bytes 减少 99.217%，约 127.65 倍；输入项 557→7。这证明“窗口未知使本来过窗的历史不触发这条原生压缩路径”的修复效果，不能把字节缩减比例直接当 RAM 缩减比例。
- 采集到该自有 app-server 10 个 RSS 样本，99.7–132.8 MiB；没有声称这是一小时／目标并发峰值或 physical footprint。
- 正常退出后，重开同私有 HOME，再 resume 同线程并发送最小只读 OK 请求：window=258400、input_tokens=11167、completed、OK、exit 0。没有清空历史或删除工具调用；原始工具记录留在 rollout，由官方压缩保留摘要。

证据：`real-auto-compaction-v4-observation.json`、`post-compact-resume-observation.json`。

前三次未完成观察明确保留：v1 转发未收到可用完整流；v2 诊断转发器对大小写 Authorization 重复导致 BrokenPipe/502；v3 已纠正鉴权并收到 200 SSE，但 125 秒提前中止时摘要尚在输出；v4 延长有界观察到 136 秒压缩完成，不以观察超时当 provider 已死。只修诊断工具，没有因此给业务接口打无关补丁。

### 9.5 独立审查与 npm/native 生命周期

首轮独立 reviewer 提出两项 P2：npm JS launcher 的 child 可能不随超时退出；只 stat launcher 会漏掉 native 更新。已添加 focused native resolver：执行与签名都使用真正 native，不执行脚本发现目标。复审另指出 Go 与 Node 架构可能不同，已从实际安装的同 OS payload 中选唯一 target；歧义时明确不可用，不按 Go/Node 架构猜值。

取得 npm Registry 官方 0.167.2 小型 launcher 包并校验 SHA1，保留源 JS 和 manifest；没有安装依赖或写全局 npm。私有布局用未修改官方 launcher、官方 alias manifest、当前安装的真实 native：

1. 首次读取成功／后续命中缓存；
2. JS 路径、mtime、size 不变，只将 native 链接换到真实二进制 clone，下一次重新读取；
3. native 删除后立即不可用，不再复用旧窗口；还原即成功；
4. 真实观察到 native child PID 后取消自有 HTTP，子进程消失，私有服务器 exit 0。

证据：`official-npm-native-identity-observation.json`、`official-native-cancellation-observation.json`、`mixed-architecture-live-observation.json`、`native-architecture-ambiguity-observation.json`。本机 arm64 Go 和 Rosetta amd64 Go 都实际读取了唯一 arm64 official native；Windows/Linux 仅编译，不冒充其 runtime 通过。最终独立只读审查无新增具体阻断，未重跑验收；原问题长期因果边界仍未证明。

### 9.6 编译、清理与剩余工作

- scoped Go build 与 go vet（不运行测试）；Windows amd64 / Linux amd64 focused cross-build；完整 `cmd/aih-server` 编译为私有 candidate。
- 候选不覆盖 `bin/native`，不重启共享服务，正式 `/models` 仍可能旧字段；不得称正式 session 已修复。
- 所有自有 runtime/app-server/native child 已退出，私有数据留证；不向 peer/user 会话发信号。不跟随私有 native 符号链接 chmod 真实安装文件。
- 本轮未写测试用例，未 stage/commit/push；focused diff whitespace 通过。全工作区另有 peer 的 CSS EOF 空行警告，未越界修改，不能称全树 diff check 干净。
- 剩余：用户认可后的共享激活与新/旧 session 生效边界；其余未知模型的真实来源／策略；多 Provider、工具执行／换号草稿完整矩阵、原始故障时长与实际并发的内存保留链验收。独立只读审查已收口。

**因此本轮证明了一个真实 AIH 缺口的代码修补 + 新轮窗口 + 原生自动压缩 + 压缩后续接，仍不宣布整个至少 15 GB／Warp >20 GB 事故已完成。**


### 9.7 当前生效边界与下一步

2026-11-17 14:52 的只读复查，正式服务 232 个模型仍全部缺窗口，见 `production-not-activated-observation.json`。因此现在的准确状态是：**工作树候选完成精确窗口修补和本机真实协议验收；正式服务与既有 session 未被本轮改动。**

建议下一步先确认共享激活方式：保留当前服务／构建产物可回退版本，审查与所有权范围一致后发布候选；不强杀 provider、tmux、harness 或正在运行的用户任务。新启动/重连/目录刷新 session 是否消费新窗口要逐层确认，未加载的老 app-server 不宣称自动生效。若只允许新进程使用候选，先隔离候选端口继续目标并发验收，不重启共享服务。

原始事故的完成标准不变：这是明确缺陷的已验证修补，不是对全部 Provider、全部 232 模型或整个 >20GB 峰值的唯一根因／最终验收结论。


## 10. 多会话工具链、真实 TUI 与上游 Harness 内存保留边界

本节不修改生产代码，也不把 auto-continue 当共享服务激活许可。候选模型窗口仍未激活到正式服务；不调整终端／VM／MCP，也未运行新增测试用例。

### 10.1 两个真实会话 × 三轮工具，执行链与回收

私有证据：`~/.ai_home/diagnostics/harness-multisession-20261117-150346/`。

运行链：真实 WebSocket 协议客户端 → 本轮候选 Go `__codex-local-app-server` → 安装的官方 Codex 0.167.2 app-server → 当前真实 AIH 网关 → 上游模型。两个独立私有 HOME/CWD，MCP 空集合；每轮只允许一次 `printf`，不访问用户项目文件，不执行网络／写操作。

- 2 sessions × 3 turns = **6 个 completed**；每轮 1 次 commandExecution started/completed，所有 item ID 与类型配对，exitCode=0，输出包含精确 marker，模型回复 marker 一致；没有审批回调自动放行。
- 六轮 native window 均 **258400**；各后续轮输入 token 仅从约 6647→6979/6981，工具结果可以跨轮继续使用，没有捕获 tool-call 缺配对错误。
- 完成后真实观察 **90 秒空闲**，随后 `thread/unsubscribe`、断线、结束 caller-owned bridge。总 127.44 秒、62 个 footprint 样本；没有重启或 signal 用户会话。
- 本轮 Node observer + 2 Go bridge + 2 official harness 及短生命周期 git helper 族峰值 **144.82 MiB**。两 Go bridge 分别约 20.4/21.1 MiB，两个 app-server peak 38.4/37.8 MiB；空闲阶段分别约 31.5/34.9 MiB。它只是该小负载真实观测，不表示原始并发或原始时长内存上界。
- 精确记录的 11 个进程身份最终均不存在；短时 defunct git 状态在最终回收后没有残留。未将“done 文件”当作进程已死的唯一依据。

证据：`acceptance-summary.json`、`memory-observation.json`、`runtime-status.log`、`final-cleanup-scope.json`。

### 10.2 真实官方 TUI：模型上下文压缩不是展示回放清理

私有证据：`~/.ai_home/diagnostics/harness-tui-replay-20261117-151619/`。

使用两个独立自有 tmux socket（不是用户 provider socket），真正执行官方 Codex TUI `resume --remote`，经候选 Go local bridge 读取本轮自身实际历史的私有副本。没有发送任何初始 prompt、stdin 任务、turn/start、模型或工具请求；配置上游指向关闭端口进一步防止误联系模型。两组加载真实分页历史，不是 `--help` 或假终端。

| 历史副本 | 观察时长 | TUI peak footprint | app-server peak | Go bridge peak |
| --- | ---: | ---: | ---: | ---: |
| 压缩前：3 turns / 343 items | 61.9s | 26.829 MiB | 52.735 MiB | 23.907 MiB |
| 原生压缩并续接后：5 turns / 348 items | 62.0s | 27.454 MiB | 40.814 MiB | 23.891 MiB |

**不能由此声称 RAM 降低 99% 或全部旧工具 UI 已释放。** 模型 compaction 改的是后续推理输入；TUI 仍要保留可查看的原始会话/工具历史。真实 TUI 这组小窗口 resume 没有复现 GB 级增长，不排除大量工具输出／子代理／频繁切换造成的长期保留。

截屏文本的简单 `error:` 匹配曾命中历史会话里的 Python TypeError，不是启动错误；没有把这个启发式误报算作复现。所有自有 TUI/bridge/harness 退出，专用 tmux 关闭，原历史和真实用户会话保留。

证据：`tui-replay-summary.json`、`tui-replay-comparison.json` 及私有屏幕记录。

### 10.3 同版本上游源码：事件数量限额不等于所有负载的字节限额

本机及三个事故前会话创建记录的 CLI 版本均为 **0.167.2**。只读核对官方仓库 `rust-v0.167.2` tag 的 primary source：

- `codex-rs/tui/src/app.rs:310`：`THREAD_EVENT_CHANNEL_CAPACITY=32768`；同文件约 570 行另有 `transcript_cells: Vec<Arc<dyn HistoryCell>>`。
- `app/thread_event_buffer.rs:9–10,42–67`：合并 agent message delta 每段上限 4 KiB，该类 delta 总保留 256 KiB；回放淘汰条件为事件数量或该类 delta 字节，**不是所有 event 的总字节预算**。
- `app/thread_events.rs:290–314`：过滤多类 raw/audio/command delta，但一般 ItemCompleted 等仍进入 replay；`snapshot():370–390` 对 turns 和 events 克隆。不能因此说所有事件无限个数，也不能假装完成工具 payload 已受 256 KiB 限制。
- `ThreadClosed` 在该文件约 244 行清理 active ID 等状态；这一小段不足以证明整个 map/其他 owner 没有后续回收，不能从局部推断永久泄漏。

官方 issue **openai/codex #23260** 有 app-server 高达 28 GB、并行 agent CLI 各约 1.5–1.8 GB，以及 TUI 回放保留的报告/讨论。这是上游报告，**不是本机事故的独立证明，也不等于本机存在同一触发条件**。issue 可能更新，本报告不把“open/closed”当验收依据。线上来源此次 web 工具可读，部分直接 GitHub API 抓取超时；固定 tag 源码已保留私有 SHA256，未修改 vendor 二进制。

安装官方 CLI 的实际 `features list` 没列出 `bounded_thread_replay`，二进制也没找到该字面量；所以没有向当前用户配置写入上游讨论中的开关，也没有建议未知 flag 已生效。此项是另一个上游保留风险线索，不能与 AIH 窗口丢失的已复现缺陷混为一个已修好的对象。

source provenance 限制：版本 tag 与本机 reported version 一致，不等于本地二进制 commit/hash 已证明完全同源码。需要后续在该官方原生 TUI 上以真实大工具/子代理/线程切换负载取对象证据，不能仅凭 issue 认定本机唯一根因。

证据：`upstream-source/app.rs`、`upstream-source/app/thread_event_buffer.rs`、`upstream-source/app/thread_events.rs`、`upstream-source/app/thread_routing.rs`、`installed-harness-replay-feature-availability.json`、`pre-reboot-cli-identity.json`。

### 10.4 未证实的其他无界路径与调查界限

只读审计看到了旧 Node SSE parser、headless fallback 暂扣 stderr、ANSI 半帧及部分 session map 的缺少统一字节限额问题。没有证明事故负载走到了这些分支，未将“源码存在”改写为“导致 20GB 的根因”，没有为了显得进展而扩修不相关模块。

系统新的资源报告记录过匿名 Node PID20357 footprint 2372.45 MB，但缺少它的完整 launch argv/父进程与保存的进程身份；只能认定当时有大 Node 工作负载，不能把 `resource coalition=Warp` 就当作 AIH wrapper。小窗口 historical log 仍只给出匿名 Node，本轮没有据此归罪 provider 或终端。官方 Codex PID43224 的报告是 disk-writes，不是 OOM；未拿磁盘写入量当内存。

### 10.5 下一步所需的用户范围与完整目标边界

当前不是无进展／已完成：真实工具矩阵的基本链和真实 TUI 层已取得新证据，原始事故因果闭环仍缺。

请确认两项最小输入：

1. 事故时主要运行哪些 `aih provider` / harness（Codex、Claude、CodeBuddy、OpenCode 等），约多少个并发会话、持续多久；是否包含子代理、多线程切换或特别大的工具输出。
2. 是否允许在不杀现有 provider/harness 用户任务的前提下激活共享模型目录候选；以及接受怎样的共享服务维护窗口／新会话生效方式。

没有批准不重启共享服务；没有原始负载范围不把“2 sessions / 127秒”冒充“实际并发／原始时长”。后续如果需要修改上游原生回放预算，应先真实复现分配对象、校准版本、在独立官方构建中验证语义，不能在 AIH wrapper 随便过滤工具结果或旧记录。


## 11. 原始负载还原与六主会话真实 TUI 离线回放

本轮不把没有用户回答误当作原始并发不可查；继续读取既有 native 记录重建证据。未激活共享候选、未修改代码/正式缓存/终端/VM/MCP，未请求新模型或工具负载；没有新增测试用例。

### 11.1 时间与证据来源

私有目录：`~/.ai_home/diagnostics/harness-incident-reconstruction-20261117-152547/`。

扫描 `.codex/sessions`、`.claude/projects`、CodeBuddy 家族物理去重根 `.codebuddy/projects`；开始窗口 **2026-11-16 18:00 +0800**、首次已知 low-swap **2026-11-17 01:18:50 +0800**、本次 boot **10:21:24 +0800**。mtime 和首条 native timestamp 先过滤，32 个历史候选，总读取约 523.7 MiB，完整流式扫描约 2.1 秒，没有 malformed/overbudget 行；仅输出 ID、时间、数量、长度、token 数，不导出提示词、工具正文或 reasoning ciphertext。

实际窗口内保留记录覆盖 26 个 Codex 线程（11 主 / 15 子代理）、1 个 CodeBuddy 家族会话、1 个 Claude 会话。窗口不是全部机器历史，也不保证未落盘的会话被覆盖；Claude/CodeBuddy 部分时间戳乱序，已按 min/max 而非文件最后一行取时间，未用缺记录证明 provider 没运行。

### 11.2 负载下界与并发含义

- 固定 01:15–01:20 五分钟分桶观察到 6 个 Codex 主线程和 3 个子代理；滚动窗口 **01:13:50–01:18:50** 有 6 主 + 4 子代理写事件。两者窗口不同，不把 9/10 数值混为矛盾。
- 更早 00:05 和 00:10 的桶有 11 个 Codex 活跃线程及 1 个 CodeBuddy 家族；01:00 桶含 7 主 + 4 子代理。
- 只采用存在起止配对的 task_started→task_complete/turn_aborted 区间，排除缺终态的 censored 区间后，任务生命周期重叠峰值 10 个线程；01:18:50 有 7 个闭合生命周期区间跨过该时点（5 主/2 子）。这仍不是“10 个 OS 进程同时 busy”，可能含等待／用户阶段。
- 主线程真实会话创建时间跨 11 月 15 日夜间到 11 月 17 日 00:22，部分已经运行多轮；不能据此说每一条创建到结束之间连续执行了同等时长。

事故前滚动五分钟内六个主线程最近一次输入和窗口：

| 主线程短 ID | input_tokens | 原生窗口 |
| --- | ---: | --- |
| e527-e164 | 228178 | null |
| e50f-c4cb | 300436 | null |
| e3d0-0663 | 350763 | null |
| dfb7-34fe | 208181 | 258400 |
| e515-e6f3 | 216877 | null |
| e2ab-9fd9 | 465591 | null |

五条缺窗口，一条已有有效窗口。**不能因此说所有当时 harness 都同样缺窗口，也不能把修补定义成所有内存根因。** 这组证据强化了实际长会话/子代理负载与先前目录问题的相关性，并给后续目标并发提供最低重建值。

证据：`incident-reconstruction.json`、`matched-task-overlap-metadata.json`、`reconstruction-summary.json`、`incident-replay-selection.json`。

### 11.3 原生工具完成事件大小，不能拿截断后的模型输出代替

第一次统计的 `function_call_output` 是模型可见截断输出，不足以评估 TUI 事件。另行扫描真实 `event_msg.item_completed.item`：

- 18:00 到 01:18:50 之前：3520 个完成项，序列化 payload 总量 **15,005,120 bytes（14.31 MiB）**。
- 最大已保存完成项 **74,491 bytes（72.75 KiB）**，其中 CommandExecution 的聚合输出 65536 bytes；与 model-facing 常见约 10 KiB 截断不是同一口径。
- 整个观察窗口保存 5137 个完成项，总约 20.98 MB；个别工具的最大聚合输出会被 provider 自身保留/截断，磁盘记录不能代表没有截断前的内存副本或内部对象。

**这不足以支持“已保存的这些完成事件原文直接堆成 20GB”**，但也不能用它证明没有 replay/clone/索引/渲染/tokenization 放大或未落盘对象。上游 #23260 仍只是风险线索，未在本机建立同一对象因果链。

CodeBuddy 家族实际会话在事故前磁盘约 101.6 MiB，主要类型含 file-history-snapshot 36.8 MiB、function_call 23.5 MiB、function_call_result 29.9 MiB；18:00–01:18 窗口 REPL=191 调用，结果正文仅约 0.27 MiB。它的 `contextWindow` 字段是**上下文链 ID 对象**，不是 token 容量，不能把同名字段的 null 直接归入 Codex 缺窗口。家族共享根也不能单独证明国际/CN/桌面哪个进程持有它。REPL 进程堆与强引用链没有保存，不基于“工具叫 REPL”就宣布泄漏。

证据：`completed-item-payload-metadata.json`、`codebuddy-before-incident-metadata.json`、`codebuddy-repl-size-metadata.json`。

### 11.4 六个事故相关主线程，真实官方 TUI 并行回放

私有目录：`~/.ai_home/diagnostics/harness-six-session-replay-20261117-153234/`。

选自事故前滚动窗口的六条主线程，不随意造六个空 session。每条只读复制**当前已保存** rollout 与对应 thread/history rows 到独立 HOME（总 rollout 约 **91.1 MiB**、工具/历史 items 5318 条）；这不是过去内存或过去每一时刻的历史重建。上游配置指向本机关闭端口，未发送 prompt、turn/start、模型或工具请求。

运行真实链：自有 tmux/PTY → 官方 Codex TUI `resume --remote` → 候选 Go local-app-server → 官方 app-server。本轮用了六套独立 caller-owned 进程，与用户现有终端无连接；设置总进程族 1.5 GiB／单进程 512 MiB 保护，未触发。

- 24 个采样，观察区间约 **118.1 秒**，含清理总 126.6 秒；族峰值 **798.9 MiB**，末尾 **634.7 MiB**。
- 六个 TUI peak 约 **25.6–27.0 MiB**，六个 bridge peak **20.7–22.5 MiB**，各 harness peak **33.6–103.0 MiB**；加载后 allocator 有回落，没有 GB 级持续增长。
- 六套真实 TUI/bridge/harness 进程族均观察到，但只有五套保存屏幕确认可见输入提示；s1 的 prompt 就绪未建立，因此不称“六套全部交互就绪”。仅初始视图，不冒称把每页历史／全部子代理切换都走了一遍。
- 所有精确记录的自有 TUI/bridge/harness/helper 身份均退出，专用 tmux sockets 清理；没有停用户线程，没有写主历史、没有清空大工具结果。

**证据改变下一步：** 真实历史的初始静态加载和六主会话并存本身，未复现原始至少 15 GB/Warp >20GB；剩下必须围绕**持续生成、子代理／线程切换、工具历史/索引/渲染的动态累积**取证。不能把 799 MiB 当原始事故上界，也不能靠这个短观察说修复闭环完成。

证据：`replay-acceptance-summary.json`、`six-tui-memory.json`、`completed-replay.json`、单线程私有屏幕证明。

### 11.5 当前仍需批准/确认的边界

已经从本机还原至少六主会话和子代理活动，不再要求用户必须先回忆“具体开了几个”才能做任何进展。仍需要用户确认该下界是否代表实际终端分布、是否还有未保存/其他 Provider 负载，以及是否允许共享候选激活或同规模持续生成验收。15:40 只读复查，正式模型目录仍 **232/232 无窗口**，候选没有被本轮激活。

未开展无批准的大规模付费推理、十几个 agent 的长时压力或会改变用户任务的“复现”。进一步原始时长/原始并发真实业务验收与历史堆归因尚缺，不标 complete；如果最终卡在共享激活批准上，应明确请求批准而不是循环重启或反复跑小样。


## 12. 自然负载被动趋势、归属校准与可核对的交付候选

时间：2026-11-17 15:43 后。此轮不重复低覆盖压力样例，也不把 auto-continue 当作共享服务重启／原规模长期付费推理授权。没有新增模型或工具负载；未修改正式配置、终端、VM、MCP，未 commit/push。

### 12.1 相同进程身份的自然负载趋势

私有目录：`~/.ai_home/diagnostics/harness-passive-trend-20261117-154406/`。

将当前 `proc_pid_rusage` 的 PID + start identity 与早先真实快照匹配，不拼不同进程：

- 官方 Codex app-server **43224**：12:20 约 50.91 MiB → 15:44 约 223.88 MiB，lifetime peak 294.27 MiB；这是真实增长，但后续 vmmap 约 215.6 MiB，未达到历史 15–20GB，不说明增长永久不可回收。
- 官方 CodeBuddy **87331**：当前约 474.33 MiB、lifetime peak **1568.94 MiB**；vmmap 中大部分实际 writable footprint 在 app-specific Bun/JS 分配区，`JS VM Reservations`/WebKit 虚拟地址的数 GiB 不是实际 RAM。没有触发在线 heap/GС 或向该用户进程注入检查。
- Codex TUI **39008** vmmap 约 54.7 MiB；aih Go 主服务 vmmap 约 193.1 MiB、peak341.5MiB。均为当前时点，不作为故障前值。
- 增长最多的 Node **25665/25707/25581/25749/25791/25858** 已按实际模块路径确认是另一个 `project-admin` 的 Vite/Nuxt 开发服务，不是 AIH harness 或 wrapper。不能用“多个 node 大了”就归因 AIH。
- 当前活着的 Codex/CodeBuddy/Claude/OpenCode 本机进程，没有直接恢复出故障前 >20GB heap 强引用链。被动测量只得到了具体进程自然变化和分配区域，**没有新证明唯一泄漏点**。

证据：`same-identity-trends.json`、`largest-node-script-identities.json`、`passive-findings-summary.json` 和各 `vmmap` 摘要。未保存 argv/env 凭据，模块路径／非敏感 flag 名仅作身份分类。

### 12.2 严格的独立候选来源，避免混入并行工作

前面用于真实验收的 candidate 从共享工作区构建，工作区同时含其他 session 的未提交业务修改。即使本轮没改它们，**该旧构建也不能作为本任务可直接部署的范围保证**。本轮另做 source archive，只从提交基线导出，再叠加审查过的 owned allowlist，未创建分支或 Git worktree。

私有目录：`~/.ai_home/diagnostics/harness-scoped-delivery-20261117-154735/`。

- 源基线：`2adaae64028c0320723a717e3827daae821d3a70`。
- 全量校对导出的 **6026 个 committed Git blob**（包括普通文件／软链接目标）与原 object ID；只发现三项 tracked 修改：`modelsapi/handler.go`、`modelsapi/codex_projection.go`、`aihserver/composition.go`。
- 只增加四个文件：`application/modelmetadata/context.go`、`codexmodelcatalog/bundled_context.go`、`codexmodelcatalog/native_binary.go`、`modelsapi/codex_context.go`。
- composition 从 HEAD 重做**唯一 ContextWindows handler 接线块**，账号删除/OAuth 等 peer 未提交 hunk 没有复制。遗漏文件 0、范围外文件 0；普通暂存区保持原 peer 35 文件内容，未 reset/add/commit。
- scoped build + go vet、完整 `cmd/aih-server` 编译通过；该诊断 HTTP main 后来移到交付 source 之外，再复核 allowlist 和重建最终 binary，防止诊断文件意外变成交付代码。

新候选：`aih-server-candidate-scoped`，61,359,442 bytes，SHA256：

```text
b3168b20b747927e1ae8d6dc9e7b6f31d743617bbfdf3f943845d4cdf6444060
```

基于同一 audited source 的真实生产 Handler 私有 HTTP 再验收：原生目录 232/9 known、Sol272000，标准目录232、unauthorized401；候选 capability 正常。没有把这个小 HTTP 检查称为重新完成所有原生推理/压缩长期验证；原先相同 reviewed source 的行为证据仍在第9–11节。

正式 `bin/native/darwin-arm64/aih-server` 仍为原文件（13:29:29，60,705,600 bytes），没有被本轮替换。此前共享工作区 candidate 继续仅作取证，不默认用于发布。未来若 main 前进，批准后也必须从**新 HEAD + 同 owned patch**重建，不拿旧基点候选覆盖 peer 新提交。

证据：`build-provenance.json`、`source-allowlist-verification.json`、`audited-final-binary.json`、`scoped-handler-live-observation.json`。

### 12.3 批准后才能执行的激活/回退范围

`activation-and-rollback-scope.json` 记录候选来源、待批准动作及验证点；本轮没有实际激活：

1. 先核对当前 shared main、service PID/start、正在运行的 executable 与磁盘 binary/hash，不能假定磁盘文件就是活进程映像。
2. 明确共享 API 服务是否允许维护切换；保留精确旧 artifact/config 的私有回退副本。不强杀 provider/harness/tmux/user 任务。
3. 激活后用授权的只读 `/models` 验证9个精确窗口和223个 unknown、标准格式与鉴权不变；再确认自有新 turn 真正使用窗口，老 session 未刷新不宣称生效。
4. 出现异常先取同 PID/start footprint／有限映射／必要堆证据；回退只处理获批共享 API binary/config，不误杀 caller-owned provider 进程，不 reset 共享代码。
5. 原始规模持续生成／子代理验收需明确允许范围、费用与停止阈值，不以少量 `OK` 或离线 replay 替代。

### 12.4 当前完成判断

本次属于**新证据和可核对的交付产物进展**，不是空等或反复状态汇报。目标仍不满足完整 completion：历史 >20GB 的具体活跃对象归属／动态保留链未证明，候选未激活，实际原始时长/原规模 workload 未验收。已完成的局部缺陷与验收必须如实保留，但不能把它们升级成事故全量完成。

继续安全动作如果只剩共享激活许可或原规模有成本负载，须等待用户明确同意；不能为维持“自动继续”而擅自升级权限、继续小样循环、重复抓在线大 heap 或制造 OOM。


### 12.5 最终观察与阻塞审计（不是完成）

15:56 的只读模型目录请求出现 ConnectionReset；随后对**同一共享服务**重读：15:57:07 `/readyz=200 ready:true`，原生目录仍232/232缺窗口；约一秒后两端点又 ConnectionReset。PID25994 仍存活。这里没有将短失败当进程死亡、没有重启或另建共享实例；间歇重置原因未归因，不冒充服务已稳定或彻底停止。记录在 `shared-service-repoll-final.json`。

同一共享激活/原规模有成本动态验收批准条件已经跨至少三个连续目标回合出现。本轮仍有实质进展（自然负载归属校准、排除其他项目Node、严格allowlist独立构建、真实HTTP再核对），但不足以证明原始>20GB动态强引用链；继续不改变外部许可/负载状态的短观察不能补足该证明。因此最终状态应为**blocked，等待用户明确允许的操作范围**，不是complete、不是自发pause，也不是因为技术困难停工。

等待用户选择：允许仅共享API候选激活（明确维护/回退且不杀provider任务）、允许独立候选端口上的原规模持续推理/子代理验收及其费用/阈值，或只要只读报告不做激活。用户一旦给出新信息／许可即可重新核对现场继续；历史目标和>=15GB/Warp>20GB严重程度保持原样。
