# AIH / Provider / Harness Memory Investigation and Repair Plan

> Use `superpowers:executing-plans` after confirming the intended mutation boundary. No branches/worktrees/delegation without explicit permission. User prohibits writing test cases; all verification below is real runtime/protocol observation.

**Goal:** 定位多个 `aih provider` 会话导致至少 15 GB、Warp 超过 20 GB 故障的执行链增长源，修复 AIH / Provider / Harness 的具体问题，并在目标并发与故障时长中验证。15 GB 是下界，不是峰值。

**Architecture:** `aih launch -> Provider CLI/TUI -> caller-owned app-server/harness -> AIH inference gateway -> upstream`。观测每层所有权、输入历史与回收。首个已证实的合同缺口是 AIH Codex 原生模型目录不携带窗口，harness 的有效窗口／压缩阈值未知。终端、VM、MCP 容量优化不是本任务主方案。

**Spec:** `docs/product-integrity/terminal-memory-2026-11-17.md`，以第 1、8 节为当前主线；第 2–7 节为早期取证归档。

## Global Constraints

- 不写测试用例；真实 CLI / app-server / HTTP / PTY 验证。不得用空历史读、旧 usage 通知或短稳定段冒充全部验收。
- 不杀／接管用户 session，不清空历史，不修改终端、VM、MCP 以代替执行链归因。
- 不覆盖并行 session 代码或暂存内容，不创建分支/worktree，不裸提交、不 add -A、不 reset/rebase 回退他人代码。
- 共享运行时激活／配置／凭据／正式 API mutation 必须获批；私有新进程明确记录生命周期并正常清理。
- 原始 heap/rollout/私有历史投影不能提交；目录 0700、文件 0600，不保存 argv/env 中的凭据。
- 不使用 AppleScript / osascript / Apple Events / System Events。
- 保留 tool call/result 配对、加密 reasoning、原生协议、用户模型/强度、换号草稿、续接和目标推进语义；禁止用截断、丢字节、删历史换内存。
- 精确模型元数据才可发布窗口；默认/最大窗口不混用，未知不借另一模型的值，不强制全模型 272000。

## Task 1: 已完成取证与证据校准

- [x] 确认重启前内核 low-swap/no paging space 和 loginwindow 低内存面板。
- [x] 将故障规模更正为至少 15 GB、Warp 超过 20 GB，撤回终端配置为主方案的表述。
- [x] 真实逐进程检查：官方 app-server 一度 466.4 MiB、Go wrapper 26.0 MiB、Node wrapper 20.7 MiB；记录 allocator free/high-water 和同 PID 回落，未称确定泄漏。
- [x] 当前原生 `models?client_version=0.167.2` 232/232 缺窗口，与 Go 投影结构缺字段及宿主模型缓存一致。
- [x] 官方 `debug models --bundled` 12 模型；9 个精确交集有窗口但 AIH 未发布，单字段私有补齐被同官方 CLI 正确读取。
- [x] 实际 provider 日志 auto_compact_scope_limit/full_context_window_limit=None；重启前 rollout 有 window=null 和 918462 input_tokens。
- [x] 真实分页历史投影读有非空 100 items/3 turns，10 次后 footprint 约 28.2 MiB，未复现线性增长；所有私有 app-server 已退出。
- [x] 私有 resume 对照仍读取历史 usage null；明确未证明新 turn 自动压缩已恢复。

## Task 2: 修 AIH -> Harness 模型上下文合同（精确官方兜底已实施，未激活）

**Proposed write boundary:** `application/modelmetadata/` 的 focused context reader 合同（或已有同责任接口）；`internal/runtime/codexmodelcatalog/` 独立官方目录 context reader；`internal/transport/http/modelsapi/codex_projection.go` 和必要 handler 接线；composition 若有 peer 修改须先明确范围，不覆盖。

- [ ] 列出业务 override／账号上游精确声明／官方内置精确模型／既有目录的来源与优先级；未知维持可观察，不伪造。
- [x] 官方 CLI `debug models --bundled` 在独立无凭据 HOME、5 秒／4 MiB 限制读取；真实 native 身份版本化缓存，首审 npm 子进程／失效问题已修且真实验证。
- [x] 9 个精确官方交集模型分别发布 default/max；无明确 compact limit 不造值，其余 223 未命中保持未知。
- [ ] 精确 slug 已存在但元数据缺失也能补齐；CLI wrapper 和 app-server 实际读取同一合同，不只修 WebUI 标签。
- [x] 真实生产 Handler 私有 HTTP：232 模型、9 known/223 unknown、401 保持、标准目录不变、并发 12×200；新轮实际推理 null→258400。

## Task 3: 新 turn 验证窗口与自动压缩（核心真实链已验证，矩阵仍未完成）

- [ ] 在自有受控新会话中验证实际 effective model context 和原生日志阈值；持久历史 tokenUsage null 不是反例或修复证明。
- [ ] 尊重用户 override；以模型原生默认或已配置策略触发自动压缩，不新造并行压缩重试器，不改变模型/强度。
- [x] 真实原生自动压缩 started→completed，持久 compacted=1；wire 4,112,360/557 items→32,216/7 items，后续 turn completed/OK；关闭再 resume 成功。
- [ ] 真实工具执行链／encrypted reasoning／后续工具结果／resume／换号草稿有业务证据，超限明确失败不静默丢内容。

## Task 4: 执行层内存复现与修复（未完成）

- [ ] 同 session / 同 PID/start 关联 Node launcher、Go bridge、官方 CLI/TUI、app-server 和网关。
- [ ] 每轮仅记数值：input items、wire bytes、工具输出大小、compact 状态、在途 frames、active heap、allocator peak/free、空闲回落；异常时再取限量 heap。
- [ ] 比较串行与用户目标并发，观察已知窗口后的长会话；覆盖原始复现时长，不能用 30 分钟替代。
- [ ] 若仍无界增长，依据活跃对象/保留链选修复：Provider 内部 token/history retention、AIH replay、connection lifecycle、large-frame copies、背压／observer 等。
- [ ] Node legacy line pump 的半行无上限是独立缺口，当前 CLI wrappers 入口绕过它；先证明某执行分支被使用，才纳入本次因果修复。
- [ ] 同 PID 可回落的 allocator high-water 不直接称泄漏；跨 PID 不拼趋势；结束用户工作流不是验收方式。

## Task 5: 安全激活与审查（三轮独立审查已收口，未激活）

- [ ] 执行 reviewer intent 兼容顺序；无独立 reviewer 时显式 self_review/plan_check，高风险操作另获确认或记录批准 bypass。
- [ ] 获批后激活共享配置／服务，不杀已有工作；明确哪些新启动／重连 session 生效、哪些既有 session 尚未更新。
- [ ] 需要提交时 cached diff 与显式 pathspec 核对，提交后 show --stat 验证，不夹带 peer 文件。

## Completion Gate

- [ ] 报告保持至少 15 GB、Warp 超过 20 GB 的原始事故规模。
- [ ] 具体 AIH/Provider/Harness 增长对象／触发机制有因果证据；已确认目录缺口与历史内存事故的关系不偷换为已完全证明。
- [ ] 已实施修复的有效窗口、压缩行为、内存曲线直接验证，不依赖源审计或 debug-only 通过。
- [ ] 真实目标并发／复现时长验收通过，工具链／会话语义无回归，无凭据泄漏，无回退并行工作。
- [ ] 用户收到原因、实际生效范围、可执行回退和证据边界。未满足不得标记目标 complete。


## 2026-11-17 Implementation Evidence

Owned source: `application/modelmetadata/context.go`, `codexmodelcatalog/{bundled_context,native_binary}.go`, `modelsapi/{codex_context,codex_projection,handler}.go` and the precise ContextWindows assembly hunk. No test files. Source is not committed or production-activated.

Private evidence: `~/.ai_home/diagnostics/harness-context-fix-20261117-140102/`. New turn real inference before/after, actual over-window real-history copy automatic compaction and post-restart resume all completed. Original incomplete/private relay attempts remain distinguished. See report section 9.

- [x] Scoped build + vet and Windows/Linux amd64 cross-build; full server candidate compiled privately.
- [x] Reviewer P2 launcher cancellation/native identity/mixed architecture addressed; genuine npm/native update, missing/restored native, HTTP cancellation, actual translated amd64 Go + arm64 payload and ambiguous-layout failure observed.
- [x] Final independent re-review complete; launcher cancellation/native identity and mixed architecture findings addressed; final no new actionable scoped blockers.
- [ ] Production activation authorized/applied with explicit active-session boundary.
- [ ] Original incident duration / actual concurrency / complete tool-and-Provider matrix and memory causal attribution accepted.

Do not treat 99.217% request-byte reduction as measured 99.217% RAM reduction, or this partial exact-model repair as proof of the complete >20GB incident resolution.


## 2026-11-17 Additional Real-Execution Coverage

- [x] Two private official sessions through actual candidate Go local-app-server: three real readonly printf tool rounds each; all six completed with paired call/results, expected outputs/replies and window=258400.
- [x] 90-second idle observation and actual process identity cleanup; 62 samples, observed family peak 144.82 MiB; no user session or shared runtime changed. Evidence `harness-multisession-20261117-150346`.
- [x] Actual official TUI/PTy/mux remote-resume of real copied histories before/after compaction, about 62s each; TUI peak around 27MiB, no GB reproduction; model compaction is not claimed to clear TUI transcript/replay. Evidence `harness-tui-replay-20261117-151619`.
- [x] Read pinned official rust-v0.167.2 replay source: 32768 events, 256KiB agent-delta-specific budget, not whole-event byte limit. Upstream issue #23260 is supporting investigative context, not local causal proof. Unsupported bounded_thread_replay flag not added.
- [ ] User specifies incident provider/harness mix, approximate concurrency/duration, and large-output/subagent/thread-switch pattern.
- [ ] User approves shared candidate activation and active-session boundary; no automatic restart.
- [ ] Original-scale / duration live memory retention validation and targeted upstream-vs-AIH causal resolution, not substituted by tiny or headless checks.


## 2026-11-17 Incident Reconstruction and Six-TUI Replay

- [x] Read-only complete native historical scan: 32 candidates / 523.7MiB, metadata only; rolling five minutes before low-swap showed six Codex main threads + four subagents, not exact process concurrence; matched closed lifecycles peaked at 10 threads.
- [x] Distinguish provider UI/native item_completed payload from model-truncated function outputs: before low swap 3520 stored completed items / 14.31MiB, largest about 72.75KiB. This does not by itself account for 20GB; replay/heap amplification remains unproven.
- [x] CodeBuddy shared store field named contextWindow is a chain-ID object, not token capacity; no cross-provider inference of the Codex defect.
- [x] Offline actual six official TUI + candidate Go bridge + official harness replay of incident-related real current historical copies (91.1MiB rollouts): 24 samples /118.1s, family peak798.9MiB then634.7MiB, no original-size reproduction and complete owned process cleanup.
- [ ] Confirm remaining original workload dimensions/user distribution not present in saved records; no need to block all progress solely on approximate session-count recollection.
- [ ] Obtain user approval before shared candidate activation or original-scale ongoing inference/subagent/tool-output stress; static replay is not dynamic original-duration acceptance.

Evidence: `harness-incident-reconstruction-20261117-152547` and `harness-six-session-replay-20261117-153234` private directories; report section11. Do not re-label static six-process replay as full lifecycle causal proof.


## 2026-11-17 Passive Natural-Workload and Scoped Artifact Closeout

- [x] Compare live footprint only against prior equal PID/start identities, classify growing Node module paths; main large Node growth was project-admin Vite/Nuxt, not assumed AIH. CodeBuddy current474MiB/peak1569MiB and Codex43224 current224MiB/peak294MiB remain below original incident and lack historical retaining graph.
- [x] Correct six-TUI readiness claim: six real process families, five captured prompt-ready views; s1 interactive readiness not established. No whole-original-scale claim.
- [x] Export committed HEAD2adaae640 plus owned7-file allowlist into plain private source archive (no branch/worktree). Hash6026 tracked Git blobs, 3 changed tracked/4 added, 0 outside scope/missing; composition peer uncommitted hunks excluded.
- [x] Build/vet audited source and full scoped candidate, verify real production Handler native232/9known, standard232,401. Delivery artifact separate from prior shared-worktree runtime candidates.
- [x] Record approval-gated activation/rollback scope, including rebase-on-current-committed-HEAD via archive if main moves, preserve old artifact, no user provider kills.
- [ ] Explicit user approval before shared API activation or original-scale ongoing cost-bearing inference stress. Auto-continue is not the asked-for activation confirmation.
- [ ] Original >20GB dynamic retaining object attribution, full provider/concurrency/incident-duration acceptance. Do not mark complete or substitute another short sample.

Evidence: `harness-passive-trend-20261117-154406`, `harness-scoped-delivery-20261117-154735`; report section12. If no further meaningful safe evidence can be obtained without the same permission/external-state change, use the prescribed repeated-blocker audit rather than endless status-only continuations.


## Blocking Audit Closeout

The same explicit shared-activation/original-scale ongoing inference authorization has remained absent across at least three consecutive goal turns. Safe meaningful passive and artifact-scoping progress is recorded, but it cannot prove the missing original >20GB dynamic retaining graph. Set goal blocked awaiting the user's operational scope rather than pause/complete or repeat small observations. A transient shared-service reset was re-polled on the same live process: one successful ready200 + models232/232unknown, then reset again; no service restart or death assumption.
