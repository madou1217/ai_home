# AIH Fabric Current Status

> **历史状态日志（append-only）**：下文记录旧阶段真实验证，包含已删除的客户端 pairing/device-token 模型。当前产品与鉴权模型以 [20-current-server-client-model.md](20-current-server-client-model.md) 和根 `README.md` 为准。

## 2026-07-14 Current Model

- Client 统一使用 Server URL + Management Key。
- 客户端 pairing、device token、scope/revoke 状态机已删除。
- 一次性 invite 只保留给高级 worker join，不属于客户端授权。
- macOS/Windows/Linux 桌面客户端已实现 Tauri 原生层、系统 Keyring、Rust transport 与三平台发布工作流；真实发布状态以每个平台的 packaged smoke evidence 为准。

## 2026-06-27 Current VPS Target Set

当前新验证目标已经切换为单节点验证：

- Active:
  - `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` with `/Users/model/.ssh/aws.pem`
- Do not use for new tests:
  - `opc@152.70.105.41`
  - `ubuntu@155.248.183.169`
  - `root@39.104.59.31`

除 AWS current 外，其他服务器只保留历史证据，不再做新部署、新探测、新清理。

最新真实证据：

- Closure status product entry 最新闭环：新增 `aih fabric closure status` 作为“当前能用什么/不能继续自动推进什么”的轻量产品入口，不启动 session proof，不跑 cloud-edge 深诊断。真实 AWS current 默认 `9527` 返回 `ok=true`、`exitOk=true`、`workflow=closure_status`、`status=usable_with_blockers`、`coreReady=true`、`selectedTransportKind=webrtc`、`statusView.sessionProof=not_run_by_status`，当前可用能力为 `node_registry/relay_node/project_host/ssh_bootstrap/open_project/transport:webrtc/start-session:opencode`；`closurePlan` 和 `failureLedger` 已不再包含 `session-marker-proof-unchecked`，`containsSkippedSessionProofNext=false`，`reports.sessionStart=null`，`cloudEdge.skipped=true`。剩余阻塞为 WebTransport H3、MPTCP/OMR、AWS 侧 Codex/Claude/AGY 凭据，`canContinueWithoutInput=false`。证据：`docs/fabric/evidence/2026-06-30-closure-status-product-entry.md`。

- Business stream closure recheck 最新闭环：按“先业务闭环，再串流测试，再记录失败原因”重新跑 AWS current 默认 `9527`。`/readyz` 返回 `ready=true`，accounts=`codex=1/claude=4/agy=7/opencode=1`；`closure resume-check` 使用 `/tmp/aih-fabric-post-mobile-strict-handoff-20260630.json` 返回 `changedEvidenceCount=0`、`canContinueWithoutInput=false`。随后真实 `closure verify` 通过：run `acf54ccc-c1bf-4f0f-8bd8-16d720d92f20`，session `ses_0e9584e97ffe0SKff7Tb9m4h31`，marker `AIH_FABRIC_CLOSURE_AUDIT_20260630_035152`，events=`ready/session-created/delta/result/done`，selected transport `webrtc`，`fallbackUsed=false`；再用新 handoff `/tmp/aih-fabric-business-stream-handoff-20260630.json` 复查 `resume-check`，仍为 `changedEvidenceCount=0`、`canContinueWithoutInput=false`。再跑真实 mobile/PWA existing-node smoke：start/attach/message/slash/stop 均 HTTP `200`，message child run `c812a761-6e70-4541-b59c-28ad435bf00a`，session ref `ses_0e957fdc4ffeXPwl4QftgFeFWy`，`messageCompletion.completed=true`，`slash.command=/status`、`unsupported=false`，final completed，eventCounts=`ready:1/session-created:1/delta:2/result:2/done:2/aborted:1`，duplicate events `0`，browser console errors `0`。失败台账明确区分已修复的 `start_marker_not_found`、`headless_session_run_still_running`、slash false positive，以及当前外部阻塞：AWS UDP/SG/NACL/TURN、AWS CLI/IAM readback、HTTPS/H3 WebTransport、OpenMPTCPRouter/MPTCP、AWS 侧 Codex/Claude/AGY 凭据。证据：`docs/fabric/evidence/2026-06-30-business-stream-closure-recheck.md`。

- Mobile PWA strict slash 最新闭环：mobile/PWA existing-node smoke 已从“允许 `headless_session_slash_unsupported` 诊断通过”收敛为真实产品闭环，删除 `--allow-unsupported-slash`，slash 必须 HTTP `200` 且 result `type=slash`。本轮真实 AWS current 默认 `9527` 先复现两类非网络失败并修复：run `90aff767-af60-4b06-acba-93f487ea1734` 失败于 `start_marker_not_found`，根因是旧 prompt 让模型拼接 marker 导致真实输出不可匹配，同时暴露 browser watchdog timer 未清理；run `0f71a20f-7bc2-4a48-b83e-319ac7764873` -> child `f450ad33-9b29-4ade-b045-76464b0f1a19` 失败于 `/status` HTTP `409 headless_session_run_still_running`，根因是 message marker 出现后未等待 child run `completed=true`。修复后真实 mobile Chromium viewport + real paired device token + `opencode` 通过：parent run `1c997586-5cbd-4901-924a-8e012db54368`，child run `dd3161f8-1c04-4da4-812b-28fe88184ceb`，sessionRef `ses_0e96298cbffeZ7b12iU6fy5V4Z`，markers `start=true/message=true`，`messageCompletion.completed=true`，`slash.status=200 command=/status unsupported=false`，`stop.status=200`，`final.completed=true`，eventCounts=`ready:1/session-created:1/delta:2/result:2/done:2/aborted:1`，browser console errors `0`。本地 mobile focused `7/7 pass`，loader+mobile `9/9 pass`，session adjacent `65/65 pass`，本地全量 `2904/2904 pass`，AWS focused `7/7 pass`。证据：`docs/fabric/evidence/2026-06-30-mobile-pwa-strict-slash-closure.md`。

- Headless slash real closure 最新闭环：completed `opencode` run 上的 `/status` 不再返回 `400 headless_session_slash_unsupported`。根因是 control-plane session command 对 completed headless run 的 slash 硬编码拒绝，未接到已有 native interactive slash 能力；已改为把 completed slash resume 成新的 interactive native run，并把 slash 作为 `initialInput` 注入。`opencode` interactive resume 现在走真实 TUI 入口 `opencode --session <id>`，普通 message 仍保持 headless run。同步到 AWS current 并按原环境重启同一 `9527` server（pid `578118`，`/readyz ready=true`，accounts=`codex=1/claude=4/agy=7/opencode=1`）。真实 start run `29e499ed-c629-45d3-83ab-252eb0a18a06` 命中 marker `AIH_SLASH_FIX_START_20260630_032000`，真实 message child run `993f34e2-f9cd-49a7-8c50-094d62a39860` 命中 marker `AIH_SLASH_FIX_MESSAGE_20260630_032000`，真实 slash child run `1915a77f-3678-4c44-9e6e-dd240e3a0fda` 返回 HTTP `200`、`accepted=true`、`resumed=true`，终端事件包含 `/status`、`OpenCode 1.17.11` 和状态面板输出；stop HTTP `200` 后 completed。start/message/slash/stop 均选择 `webrtc`，`fallbackUsed=false`。失败台账新增裸命令重启导致 `accounts=0`、多文件 scp 放错根目录、裸 SSH PATH 找不到 opencode 的原因与防再发生规则。证据：`docs/fabric/evidence/2026-06-30-headless-slash-real-closure.md`。

- Native session runtime blocker and dialogue 历史闭环：在真实 AWS `opencode` start/message/slash 验证中发现旧代码会把正常 `opencode run --format json` 工具输出误扫成 `auth_invalid_reauth_required`，导致成功回答后仍出现 `runtime-blocked` 和 `native_runtime_blocked`。已把 `native-session-chat` 的 runtime blocker 扫描边界收窄为：交互式 CLI 输出、结构化 error 事件、非零退出输出；正常非交互 stdout chunk 不再进入 auth classifier。同步到 AWS current 并重启同一 `9527` server（new node pid `574351`），本地 focused `37/37 pass`，AWS focused `37/37 pass`。旧误判通过真实 `provider accounts revalidate --providers opencode --yes` 清理，`runtimeBlockClear.cleared=1`，post audit `runtimeBlocked=0`，验证 run `40ae9a39-3abe-47af-93b5-4dbb5f32bb04` marker 命中。修复后真实 start run `518f272e-ac80-4d3c-8c29-82ac7de94518`、session `ses_0e9841eebffekpOOMuN6oUZz2K`，events=`ready/session-created/delta/result/done`，`hasRuntimeBlocked=false`、`hasError=false`；真实 follow-up message run `17b20864-a227-4345-b1b1-701d170ea0f1` resumed from start run，同 session，events=`ready/delta/result/done`，`hasRuntimeBlocked=false`、`hasError=false`。该轮 `/status` slash 当时真实返回 `400 headless_session_slash_unsupported`，后续已由最新 Headless slash real closure 修复为 HTTP `200`。证据：`docs/fabric/evidence/2026-06-30-native-session-runtime-blocker-and-dialogue.md`。

- Post-resume business stream failure retrospective 最新闭环：按“先业务闭环，再串流，再记录失败原因”的顺序复核 AWS current 默认 `9527`。`/readyz` 返回 `ready=true`；`closure resume-check` 使用 `/tmp/aih-fabric-target-local-closure-handoff-20260630.json` 返回 `changedEvidenceCount=0`、`canContinueWithoutInput=false`，说明外部输入未变化。随后按用户要求跑最新真实 `closure verify`，run `42baea7f-5161-48b1-a739-1a47a6274cfd`，session `ses_0e98ff286ffe5vlC0pgGugl4nf`，marker `AIH_FABRIC_CLOSURE_AUDIT_20260630_025104`，events=`ready/session-created/delta/result/done`，`selectedTransportKind=webrtc`、`fallbackUsed=false`、`sessionProof.ok=true`、`failureLedger.total=7/external=7/runnableCount=0`。失败原因已集中归档：Cloud UDP 是 AWS 边界/SG/NACL/TURN 证据缺失，cloud API 是 AWS CLI/IAM/local CLI 缺失，WebTransport 缺 HTTPS/H3 endpoint，multipath 缺双端 OMR/MPTCP underlay，Codex/Claude/AGY 是 AWS 侧 provider auth 不可调度；曾导致循环的 target-local 自 SSH 和 UDP 并发假失败也已记录防再发生规则。证据：`docs/fabric/evidence/2026-06-30-post-resume-business-stream-failure-retrospective.md`。

- Resume-check cloud API readback 最新闭环：`closure resume-check` 的 `cloud-udp-policy` 现在不只看 TURN 配置，也会用 `skipUdpProbe=true` 做只读 cloud API readback，判断 AWS CLI/IAM/local AWS readback 是否有新输入；不会发 UDP 包、不会启动 session、不会跑 WebTransport/multipath，也不会上传 provider 凭据。同步修复 `cloud-edge` cloud API snapshot 在 AWS 本机执行时仍 SSH 自己的问题，target-local 时改为本机执行，因此 AWS-local resume-check 不再泛化成 `aws_cloud_api_probe_failed`，而是明确输出 `aws_cli_missing,aws_iam_role_missing,aws_local_cli_missing`。真实本地客户端 resume-check 返回 `cloudApiCredentialsReady=false`、provider audit 仍为 AGY/Claude/Codex blocked、`canContinueWithoutInput=false`；真实 AWS 本机 resume-check 返回 `provider-credentials.status=audit_unavailable/ready_server_profile_missing` 且不崩溃。本地 adjacent `38/38 pass`，AWS focused `18/18 pass`，本地全量 `2900/2900 pass`。证据：`docs/fabric/evidence/2026-06-30-resume-check-cloud-api-readback.md`。

- Target-local UDP diagnostic context 最新闭环：修复 AWS 本机运行 `fabric transport prerequisites` 时默认再 SSH 自己并寻找 `/home/ubuntu/.ssh/aws.pem` 的假失败。`fabric-default-udp-probe` 现在输出 `targetExecution.commandMode=ssh|local` 和 `proofScope=client_to_target|target_local`；当命令已经在 AWS target `remoteDir` 内运行时，目标侧 echo/capture/snapshot 直接本机执行，不再 SSH 自己。重要语义修正：target-local UDP 成功不会晋级 cloud edge，报告 `candidateReady=false`、blocker=`turn_default_udp_target_local_only`，并在 `blocker-catalog/closure-plan/prerequisites/cloud-edge` 中归类为 `diagnostic_context external=false`，不再误报 `aws_public_udp_path_blocked`。真实 AWS 本机复跑返回 `commandMode=local`、`proofScope=target_local`、`local.ok=true`、`diagnosticContext.blocked=true` 且无 publickey error；真实本地客户端 `cloud-edge` 仍返回 `commandMode=ssh`、`proofScope=client_to_target`、本机 UDP timeout、AWS `enp39s0` 0 包、blockers=`turn_default_udp_9527_unreachable,aws_public_udp_path_blocked,aws_cli_missing,aws_iam_role_missing,aws_local_cli_missing`。最新真实 `closure verify` run `0218fedc-13bd-4c48-9268-9443274975a3`、session `ses_0e9a37105ffevRbl1jF0gxZQfI`，events=`ready/session-created/delta/result/done`，`selectedTransportKind=webrtc`、`fallbackUsed=false`、`failureLedger.summary.external=7`、`runnableCount=0`、`canContinueWithoutInput=false`，证明业务闭环/串流已通过且下一步不能重复空跑，必须等待 SG/NACL/TURN、HTTPS/H3、MPTCP/OMR 或 provider credentials 外部证据变化。本地 focused `51/51 pass`，AWS focused `51/51 pass`，本地全量 `2896/2896 pass`。证据：`docs/fabric/evidence/2026-06-30-target-local-udp-diagnostic-context.md`。

- Diagnostic concurrency closure 最新闭环：本轮先按 AWS-only/default `9527` 跑真实业务闭环和串流，再串行复查 transport gate，避免继续把不同失败混成“超时”。真实 `opencode` closure verify run `31d0609c-e302-4754-80d2-bad596e7072e`、session `ses_0eade0c44ffecYTrP568sj1tT0`，events=`ready/session-created/delta/result/done`，`selectedTransportKind=webrtc`、`fallbackUsed=false`、`businessClosureProven=true`、`streamProofProven=true`。根因修复：`turn_default_udp_probe_busy` 现在在 `closure-plan` 中先归类为 `diagnostic_concurrency`，生成 `transport-diagnostic-concurrency status=diagnostic_retry external=false`，不再被通用 `turn/udp` 字符串匹配误放进 `transport_cloud_edge` 外部前置；`fabric transport prerequisites` 新增 `summary.diagnosticConcurrency`，本轮真实串行结果为 `blocked=false`。真实 `cloud-edge` 仍证明远端 UDP echo ready、本机 UDP timeout、AWS `enp39s0` 抓包 0 包、host firewall 不阻塞，且 AWS CLI/IAM/local AWS CLI 均缺失。provider audit 仍为 `opencode ready`，`codex update_api_key`、`claude update_api_key`、`agy complete_oauth_reauth`。本地 focused `31/31 pass`，本地全量 `2890/2890 pass`，AWS focused `31/31 pass`。证据：`docs/fabric/evidence/2026-06-30-diagnostic-concurrency-closure.md`。

- Transport readiness blocker canonical 最新闭环：`fabric transport readiness/status` 不再把 WebTransport 同一个外部前置暴露成 `webtransport_endpoint_not_configured` 和 `webtransport_not_promoted`。readiness truth source 现在统一输出 `webtransport:webtransport_h3_endpoint_missing`，并保留底层 `webtransport_connect_failed` 这类连接证据。已 scoped 同步 AWS current，重启同一个默认 `9527` server：old pid `487271` -> new pid `536155`，`/readyz ok=true ready=true`。本地 client 真实 `transport readiness` 显示 `defaultTransport=webrtc`、`promotionReady=true`、blockers=`webtransport:webtransport_h3_endpoint_missing,omr:openmptcprouter_not_detected,mptcp:mptcp_data_plane_not_promoted`；真实 `transport status` 同步显示 WebTransport blocker 口径已收敛，同时 UDP/cloud API blockers 仍为外部前置。真实 `closure verify` run `63a9a745-86ea-45e3-80d9-e38c2ffb0e17`，session `ses_0eae9e0b6ffe7rzwpZDMncUBxy`，events=`ready/session-created/delta/result/done`，`businessClosureProven=true`、`streamProofProven=true`、`executionDecision=stop_awaiting_external_input`。本地 focused `31/31 pass`，AWS focused `9/9 pass`。证据：`docs/fabric/evidence/2026-06-30-transport-readiness-blocker-canonical.md`。

- Closure resume-check 最新闭环：新增 `aih fabric closure resume-check --handoff-file FILE`，作为 `executionDecision=stop_awaiting_external_input` 后的轻量继续判断入口。它读取 handoff、当前 `fabric transport config`、环境输入，并对 provider credentials 做 AWS 只读 audit；不启动 session，不跑 cloud-edge/WebTransport/multipath 重诊断。真实 AWS current 默认 `9527` 使用 `/tmp/aih-fabric-closure-handoff-decision-20260630.json` 运行通过：`transportInputs.turnConfigured=false`、`webtransportConfigured=false`、provider audit 仍为 `agy complete_oauth_reauth runtimeBlocked=7`、`claude update_api_key runtimeBlocked=4`、`codex update_api_key runtimeBlocked=1`，最终 `resume.canContinueWithoutInput=false`、`changedEvidenceCount=0`。从 AWS 部署目录直接运行时，因为该目录不复用 Mac client 的 paired server profile，provider audit 会以 `provider-credentials.status=audit_unavailable` 落入报告而不是让命令崩溃。结论：没有外部证据变化时不要重复跑 closure proof。证据：`docs/fabric/evidence/2026-06-30-closure-resume-check.md`。

- Closure execution decision 最新闭环：`failureLedger` 新增 `executionDecision`，把“还能不能自动继续”变成 JSON/handoff/CLI 的同一个机器可读结论。真实 AWS current 默认 `9527` 跑 `fabric closure verify --handoff-file` 通过：run `469f4f08-36f5-4a00-893a-cf529a81c64d`，session `ses_0eb0d924cffePzf0Osz5qa0ReX`，marker `AIH_FABRIC_CLOSURE_AUDIT_20260629_195415`，events=`ready/session-created/delta/result/done`，`businessClosureProven=true`、`streamProofProven=true`、`automationState=awaiting_external_input`、`runnableCount=0`、`operatorInputCount=7`。handoff 和人类 CLI 均输出 `executionDecision.decision=stop_awaiting_external_input`，并列出只有 SG/NACL/TURN、HTTPS/H3 WebTransport、双端 MPTCP/OpenMPTCPRouter、provider credentials 这些外部证据变化后才继续。证据：`docs/fabric/evidence/2026-06-30-closure-execution-decision.md`。

- Provider closure plan audit-first 最新闭环：真实 AWS node inventory 只暴露 sample account id，不暴露 auth mode；`fabric provider accounts audit` 的 `credentialHandoff` 才是 API Key/OAuth 真相源。因此 closure plan 不再从 sample account id 直接生成 `provider accounts reauth` 作为第一命令，避免 Codex/Claude API Key 账号继续被误导到 `api_key_reauth_unsupported`。真实 AWS Codex closure audit `--skip-session` 输出 `immediateNext.id=provider-codex-blocked`，第一命令已变为 `aih fabric provider accounts audit --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --providers codex --json`，provider commands 中 `hasReauth=false`；后续由 audit 的 credential handoff 给出 `update_api_key` 或 `complete_oauth_reauth`。最终完整 `fabric closure verify` run `48e993f3-31c9-4afc-9449-8cdb81bca0a0` 通过真实 WebRTC 串流 proof，`businessClosureProven=true`、`streamProofProven=true`、`runnableCount=0`、7 个剩余 failure 全部 `external=true/canAutomate=false/requiresConfirmation=true`，provider blockers 的命令均从 audit 开始。本地 focused `28/28 pass`，AWS focused `28/28 pass`，full `2882/2882 pass`，hash parity 已验证。证据：`docs/fabric/evidence/2026-06-30-provider-credential-handoff.md`。

- WebTransport H3 endpoint blocker 最新闭环：本地客户端对 AWS current 默认 `9527` 真实运行 `fabric transport webtransport --json`，Chrome 环境显示 `isSecureContext=true`、`webTransportType=function`，但握手失败 `WebTransportError: Opening handshake failed.`。现在输出同时保留底层 `webtransport_connect_failed` 并新增可行动 blocker `webtransport_h3_endpoint_missing`，明确缺的是 HTTPS/H3 WebTransport endpoint，不是浏览器能力或业务 server 不可用。真实 `fabric transport prerequisites --json` 同步显示 `baseReady=true`、AWS relay/registryAgent/webrtc services running、`promotionReady=false`，summary blockers 包含 `webtransport:webtransport_h3_endpoint_missing`，并继续保留 TURN UDP 和 multipath 外部前置。补跑真实 `fabric closure verify`：run `85f4630c-4a57-4bde-bdff-5237afce8079`，marker 命中，events=`ready/session-created/delta/result/done`，`businessClosureProven=true`、`streamProofProven=true`、`selectedTransportKind=webrtc`、`fallbackUsed=false`、`runnableCount=0`、`automationState=awaiting_external_input`。随后继续收敛 closure handoff 口径：`closurePlan.nextQueue[transport-webtransport-h3]` 和 `handoff.externalPrerequisites[webtransport-h3-endpoint]` 已统一输出 `webtransport:webtransport_h3_endpoint_missing`，不再把同一 H3 前置暴露成旧的 `webtransport_endpoint_not_configured/webtransport_not_promoted`。真实 AWS closure verify follow-up run `3c79192c-015d-40e3-8bb4-e423104b9eae` 通过同样的 WebRTC 串流 proof；AWS focused `20/20 pass`，本地 focused `20/20 pass`，新增 scoped 文件 hash parity 已验证。继续收敛自动化语义后，`transport-cloud-edge-udp`、`transport-cloud-api-readback`、`transport-webtransport-h3`、`transport-multipath-underlay` 现在全部在 queue/failure ledger 中输出 `requiresConfirmation=true`，真实 AWS closure verify run `ca9a3014-360c-4175-ab67-e0ab2cbafce7` 证明业务串流仍通过且 `runnableCount=0`；AWS focused `15/15 pass`，本地 focused `15/15 pass`。证据：`docs/fabric/evidence/2026-06-30-webtransport-h3-endpoint-blocker.md`。

- Provider credential handoff 最新闭环：`fabric provider accounts audit` 新增 `credentialHandoff`，把真实 AWS provider audit 的 `apiKeyMode/authModeCounts/runtimeBlocked` 转成可执行下一步，避免把 API Key 问题误导成 OAuth reauth。真实 AWS current 默认 `9527` audit 显示 `profileCount=13/stateRows=13/runtimeBlocked=12`，`opencode` ready，`codex` 为 `api-key + auth_invalid:upstream_401`，`claude` 为 `api-key + auth_invalid:claude_not_logged_in`，`agy` 为 `oauth + auth_invalid:agy_not_signed_in`。真实 reauth 验证：Codex account `2` 和 Claude account `1` 均返回 HTTP `400`、`api_key_reauth_unsupported`，下一步是更新/替换 AWS API key 后 revalidate；AGY account `1` 成功启动 Google OAuth job `dc479493-48d0-4693-b721-e2bbf2b9665a` 并进入 `awaiting_code`，已通过 Fabric `auth-job get` 读回日志，再通过 `auth-job cancel` 取消，远端无残留 AGY/antigravity 进程，post-cancel audit 仍为 `agy.profileCount=7/stateRows=7`。本地 provider focused `13/13 pass`，相邻 Fabric focused `31/31 pass`，AWS focused `31/31 pass`，2 个 scoped 文件 hash parity 已验证。

- Closure handoff export 最新闭环：`aih fabric closure verify` 新增 `--handoff-file`，把业务闭环、真实串流 proof、failure ledger、external prerequisites、next required evidence 和 repeat-prevention 投影成机器可读 `aih.fabric.closure-handoff.v1`，不再要求从 200KB diagnostics 或 Markdown 手工还原下一步。真实 AWS current 默认 `9527` 运行 `/tmp/aih-fabric-closure-verify-handoff-20260630.json` + `/tmp/aih-fabric-closure-handoff-20260630.json` 通过：run `7687011f-6fc3-48c4-ae6e-e010770f64ee`、marker `AIH_FABRIC_CLOSURE_AUDIT_20260629_183325`，events=`ready/session-created/delta/result/done`，`selectedTransportKind=webrtc`、`fallbackUsed=false`。handoff 显示 `businessClosureProven=true`、`streamProofProven=true`、`automationState=awaiting_external_input`、`runnableCount=0`、`operatorInputCount=7`、`externalPrerequisites=cloud-udp-policy,webtransport-h3-endpoint,multipath-underlay,provider-credentials`，且不包含 raw `reports`/`deviceToken`。本地 focused `fabric-closure-audit + fabric-node-inventory + repository-policy` 为 `20/20 pass`，本地 full `node --test test/*.test.js` 为 `2881/2881 pass`，AWS focused `fabric-closure-audit + fabric-node-inventory` 为 `18/18 pass`，3 个 scoped 文件 hash parity 已验证。

- Closure verify workflow 最新闭环：新增 `aih fabric closure verify`，作为产品化入口串起业务闭环、WebRTC 串流证明、failure ledger 和 repeat-prevention，内部复用 `closure audit`，不复制第二套判断逻辑。真实 AWS current 默认 `9527` 运行 `/tmp/aih-fabric-closure-verify-20260630-r2.json` 通过：`workflow=closure_verify`、`ok=true/exitOk=true`、run `d2a95f7c-a3c1-497d-9459-4d525f125ebd`、session `ses_0eb6ecdf7ffeie8cPsUENtd8Kq`、marker `AIH_FABRIC_CLOSURE_AUDIT_20260629_180803`，events=`ready/session-created/delta/result/done`，`selectedTransportKind=webrtc`、`fallbackUsed=false`。`failureLedger.status=usable_with_recorded_failures`，`automation.state=awaiting_external_input`，`runnableCount=0`，剩余仍分组为 `cloud-udp-policy,webtransport-h3-endpoint,multipath-underlay,provider-credentials` 且 `allExternal=true`。本地 focused `fabric-closure-audit + fabric-node-inventory + repository-policy` 为 `18/18 pass`，本地 full `node --test test/*.test.js` 为 `2879/2879 pass`，AWS focused `fabric-closure-audit + fabric-node-inventory` 为 `16/16 pass`，6 个 scoped 文件 hash parity 已验证。

- Server profile browser closure 最新闭环：新增 `scripts/fabric-real-server-profile-switch-smoke.js`，专门验证本地 WebUI/浏览器能真实添加并切换 AWS server profile，而不是只靠 CLI 已配对状态。首次真实运行 `/tmp/aih-fabric-server-profile-switch-20260630.json` 失败：两个 AWS invite 都创建成功，但浏览器 profile store 在 90s 内没有出现 paired profile，旧脚本只显示 `page.waitForFunction: Timeout 90000ms exceeded`。已把该类失败收敛为 `webui_pair_profile_store_timeout`，并记录 URL、body 摘要、profile store、active profile 和 console 样本。增强后立即复跑 `/tmp/aih-fabric-server-profile-switch-20260630-r2.json` 通过：DNS endpoint 与公网 IP endpoint 都通过真实 invite + WebUI Server Setup 配对，生成 `cp-51hq70` 和 `cp-1pp83dd`，产品 selector 分别切换后 reload 均持久化，active profile 通过 device token 读取 AWS node inventory HTTP `200`，`nodeCount=4` 且包含 `aws-current-node`。随后真实业务串流复核 `/tmp/aih-fabric-business-stream-closure-20260630-r2.json` 通过：run `40de8d5a-50e7-4d2b-b292-465d8a5d3685`、session `ses_0eb7b544dffe510apkKGkV4HDG`、marker `AIH_FABRIC_CLOSURE_AUDIT_20260629_175422`，events=`ready/session-created/delta/result/done`，`selectedTransportKind=webrtc`、`fallbackUsed=false`，`failureLedger.externalPrerequisites=cloud-udp-policy,webtransport-h3-endpoint,multipath-underlay,provider-credentials` 且 `allExternal=true`。本地 focused `server-profile-switch + control-plane-profiles + fabric-profile-pairing + repository-policy` 为 `45/45 pass`。AWS 工作目录首次跑新增测试失败于 `Cannot find module './playwright-require'`，根因是远端缺少既有 Playwright loader 依赖；同步 `scripts/playwright-require.js` 后远端 focused `6/6 pass`，新增脚本/test/docs/loader hash parity 已验证。

- External prerequisite grouping 最新闭环：`closure audit` 的 `failureLedger` 新增 `externalPrerequisites[]`，把 7 个剩余 failure 机器分组成 4 个可读前置：`cloud-udp-policy`、`webtransport-h3-endpoint`、`multipath-underlay`、`provider-credentials`。真实 AWS current 默认 `9527` 复跑 `/tmp/aih-fabric-external-prereq-local-20260630.json`：run `a0022037-95a9-4d8d-8351-e2b3b46d94a3`、session `ses_0eb8b2dd9ffeAYyWA7Sm6aD6pv`、marker `AIH_FABRIC_CLOSURE_AUDIT_20260629_173704`，仍为 `selectedTransportKind=webrtc`、`fallbackUsed=false`、`automation.state=awaiting_external_input`、`runnableCount=0`、`summary.total=7/external=7/actionableByAih=0/allExternal=true`。本地 focused `fabric-closure-audit + repository-policy` 为 `13/13 pass`，AWS bundled Node focused 为 `11/11 pass`，`failure-ledger.js/test` hash 已与 AWS 工作目录一致。测试中一次失败来自期望顺序写错：实现保留 closure `nextQueue` 顺序 cloud edge -> WebTransport -> multipath -> provider，已记录 anti-loop。

- Automation gate 串流复核：本轮不再把问题停在“超时”。先用本地客户端对 AWS current 默认 `9527` 跑真实业务闭环，diagnostics `/tmp/aih-fabric-automation-gate-local-20260630.json` 返回 `ok=true/exitOk=true`，run `75de523b-0b90-4023-9fc2-2196a249b54a`、session `ses_0eb9547f7ffe75gqe57GdZtdPH`、marker `AIH_FABRIC_CLOSURE_AUDIT_20260629_172602`，`selectedTransportKind=webrtc`、`fallbackUsed=false`。随后复跑真实 WebRTC DataChannel smoke，diagnostics `/tmp/aih-fabric-webrtc-smoke-now-20260630.json`，room `rtc_pmC98aFKWK8zy6aU`，DataChannel p95=`323ms`，RPC `1/1` p95=`322.9ms`，candidate pair=`srflx->srflx`。`failureLedger.automation.state=awaiting_external_input`、`canContinueWithoutInput=false`、`runnableCount=0`、`operatorInputCount=7`、`allExternal=true`，因此后续不能继续空跑同一链路；剩余只剩 provider credentials、AWS UDP/SG/NACL/API readback、WebTransport HTTPS/H3、MPTCP/OpenMPTCPRouter 这些外部前置。

- Closure failure ledger 远端部署复核：本轮发现并修复两个会造成“循环耗时”的真实问题。第一，AWS 远端 CLI 在没有本地 paired profile 时，`sessionStart` 返回 `report=null`，旧 `extractRunId()` 直接读 `.result` 崩溃为 `Cannot read properties of null`；现在会输出结构化 `session-marker-proof-blocked/ready_server_profile_missing`。第二，node registry 未读到时旧计划误生成 `provider-opencode-blocked`，会把 Server Setup 问题误导成 provider 账号问题；现在改为 `provider-opencode-unchecked`，immediate next 保持 `node-registry-pairing`。AWS 工作目录已 scoped 同步 `closure-audit.js/closure-plan.js/failure-ledger.js/test`，远端 bundled Node focused `fabric-closure-audit` 为 `11/11 pass`。远端无 paired profile 场景真实输出 `failureLedger.status=blocked_with_recorded_failures`、`nextQueue=node-registry-pairing,provider-opencode-unchecked,transport-default-blocked,session-marker-proof-blocked`。最终本地客户端真实 AWS closure audit 仍通过：run `1332fa23-8f24-4de3-bb73-6478ba56054d`、session `ses_0eb99e18fffexL5sroAh7pfK3q`、marker `AIH_FABRIC_CLOSURE_AUDIT_20260629_172100`，`failureLedger.summary.total=7/external=7/allExternal=true`。

- Closure failure ledger 产品化：`closure audit` 现在直接输出机器可读 `failureLedger`，避免每次靠人工从超时日志里重新分类。真实 AWS current 默认 `9527` 复跑写入 `/tmp/aih-fabric-failure-ledger-current-20260630.json`：`opencode` run `cbae4349-eb00-4d10-98e4-2df9c2762c21`、session `ses_0eba12e3dffefLoagroBdJYWO9`、marker `AIH_FABRIC_CLOSURE_AUDIT_20260629_171302` 命中，events=`ready/session-created/delta/result/done`，`selectedTransportKind=webrtc`、`fallbackUsed=false`。`failureLedger.status=usable_with_recorded_failures`、`businessClosure.usable=true`、`streamProof.ok=true`、`summary.total=7/external=7/allExternal=true`，7 个剩余项分别是 cloud-edge UDP、AWS cloud API readback、WebTransport H3、Multipath underlay、AGY/Claude/Codex provider account。重复防止规则已随 JSON 输出：业务已证明不重复跑、UDP 不并发跑、WebTransport 不误判浏览器、multipath 不从单端能力晋级、provider blocker 不当传输故障。

- Business stream failure ledger 复核：`2026-06-30-business-stream-and-failure-ledger.md` 已追加 2026-06-30 CST 本轮真实复跑。业务闭环先跑 AWS current 默认 `9527`：`/readyz ready=true`，`fabric nodes aws-current-node` 显示 AWS 节点为 `node + relay-node`，`start-session:opencode` 可用，Codex/Claude/AGY 仍分别阻塞于 `auth_invalid:upstream_401`、`auth_invalid:claude_not_logged_in`、`auth_invalid:agy_not_signed_in`。真实 `opencode` closure audit run `d9c3c1d7-f447-4ea0-9784-474a97de0bc2`、session `ses_0eba80ebfffeTJ3p7r78FdGA6i`、marker `AIH_FABRIC_CLOSURE_AUDIT_20260629_170529` 命中，events=`ready/session-created/delta/result/done`，`selectedTransportKind=webrtc`、`fallbackUsed=false`。真实 WebRTC DataChannel smoke 通过，RPC `1/1`、p95 `415.2ms`。剩余失败原因保持四类外部前置：provider credentials、AWS UDP/SG/NACL/API readback、WebTransport HTTPS/H3 endpoint、MPTCP/OpenMPTCPRouter underlay；这些不再归为未知超时或应用串流问题。

- Playwright npx loader 最新闭环：`2026-06-30-playwright-npx-loader-and-mobile-smoke.md` 关闭真实 browser smoke 依赖临时 `NODE_PATH=/tmp/aih-playwright-smoke/node_modules` 的缺口。真实复现 `npx --yes --package playwright node -e "require.resolve('playwright')"` 在当前环境下返回 `MODULE_NOT_FOUND`，原因是 npx 只把 `~/.npm/_npx/<id>/node_modules/.bin` 放入 `PATH`，CommonJS 不会自动搜索临时包根。新增 `scripts/playwright-require.js` 后，WebRTC/WebTransport/mobile smoke 共用 loader，可从 npx PATH 反推 Playwright module root；真实 loader 验证返回 `ok=true path=/Users/model/.npm/_npx/e41f203b7505f1fb/node_modules/playwright`。同时修复 mobile smoke 的浏览器请求超时过短问题：3s 会误杀 AWS `opencode` 首次 `session-created`，现收敛为 5-15s。无 `NODE_PATH` 的真实 AWS mobile/PWA smoke 已通过：parent `9e861e16-0eef-4f8d-92a8-e1ee110db7aa`、child `d6a4b449-f254-4834-a894-6209db15b210`、`message.resumed=true`、markers `start/message=true`、`stop.status=200`；无 `NODE_PATH` 的真实 WebRTC DataChannel smoke 同样通过，srflx pair、RPC `1/1`、p95 `298ms`。本地 focused `playwright-require + mobile-pwa` 9/9 pass。

- Mobile PWA existing-node 历史闭环：`2026-06-30-mobile-pwa-existing-node-closure.md` 把当前 mobile/PWA smoke 从 legacy 临时 relay-node 路线收敛到已注册 `aws-current-node`。真实 AWS 默认 `9527` 运行先复现 `browser_evaluate_timeout` 和 `message_marker_not_found`，并定位根因不是网络不通，而是 smoke 未记录浏览器内请求阶段、且没有跟随 completed headless run 的 `message.resumed=true` child `runId`。修复后真实 mobile viewport + real paired device token + `opencode` 完成 start/attach/message resume/events/slash-diagnostic/stop：parent run `5df26324-7edf-40a1-820d-9459de06885c`，child run `65f6c750-5515-414f-a5f1-f1478d4b32a1`，sessionRef `ses_0ebba4cdcffe6h2gIqUiUS1k5o`，markers `start=true/message=true`，该轮 `slash.status=400 headless_session_slash_unsupported` 当时被按显式 capability gap 记录；该 gap 已由最新 Headless slash real closure 修复为 HTTP `200`。本地 focused `fabric-real-mobile-pwa-session-smoke` 7/7 pass；新增 anti-loop 规则：浏览器总超时不能当根因、completed-without-marker 立即失败、`message.resumed=true` 必须切 child runId、当前 AWS node smoke 不再走 legacy temporary relay node。

- Business stream and failure ledger 最新闭环：`2026-06-30-business-stream-and-failure-ledger.md` 按 AWS-only、默认 `9527` 顺序复核业务闭环、串流和剩余失败原因。AWS current 当前 `DEPLOYED_GIT_HEAD=71fc5c4cc3f386972b390fd90cbe51775ee2876d`，server pid=`487271`，`/readyz ok=true ready=true`，账号计数 `codex=1,claude=4,agy=7,opencode=1`。真实 `fabric nodes aws-current-node` 读回 AWS 是 `node + relay-node`、`projectHost=true`、`runtimeHost=true`、`sshBootstrap=true`、`transportKinds=relay,webrtc`；可执行 `open-project`、`start-session:opencode`、`configure-ssh`、`run-measurement`，Codex/Claude/AGY 分别阻塞于 `auth_invalid:upstream_401`、`auth_invalid:claude_not_logged_in`、`auth_invalid:agy_not_signed_in`。真实 `opencode` closure audit run `287d0f1f-ef0a-4046-8689-1939a28fd6d0`、session `ses_0ebd95b6affekUNiKHjR4YjfXJ`、marker `AIH_FABRIC_CLOSURE_AUDIT_20260629_161140` 命中，events=`ready/session-created/delta/result/done`，`selectedTransportKind=webrtc`、`fallbackUsed=false`。同轮真实 transport 复核：readiness 返回 `defaultTransport=webrtc`、`promotedTransports=webrtc`、`fallbackReady=true`；cloud-edge 仍是 remote UDP `9527` echo ready 但 local probe timeout、AWS `enp39s0` 抓包 0 包且 host firewall 不阻塞；WebTransport 是 browser 支持但 HTTPS/H3 handshake failed；multipath 是远端 Linux MPTCP 可用但本机 macOS/OMR/默认 plain HTTP listener 不满足端到端 underlay。失败原因已按 provider credential、cloud policy/UDP、WebTransport endpoint、MPTCP/OMR 四类归档，并新增 anti-loop 规则，避免继续把这些外部前置误判成未知超时。

- Runtime gate status after auth revalidate 最新闭环：`2026-06-29-runtime-gate-status-after-auth-revalidate.md` 继续按完整 `closure audit` 推进真实 nextQueue：full audit run `70035473-9263-45ba-b270-ce1a5d9a741f`、session `ses_0ebeb67b2ffepQuzFjtVUieLTp` 通过 WebRTC 串流，`immediateNext=transport-cloud-edge-udp`；同次 cloud-edge 真实证据仍是 AWS UDP `9527` echo ready 但本机 UDP probe timeout，AWS `enp39s0` tcpdump `0 packets captured/0 received by filter`，host firewall 不阻塞，SG IDs=`sg-01e33f3412fabfded,sg-01e7f50a205d7b308`，本机/远端 `aws` CLI 都缺失且远端无 IAM role。随后真实 `provider accounts revalidate --providers codex,claude,agy` 清除 12 个 runtime block 后，真实 session guards 立即复现 `codex auth_invalid:upstream_401`、`claude auth_invalid:claude_not_logged_in`、`agy auth_invalid:agy_not_signed_in`，结论为 `credentials_still_invalid`。本轮发现并修复 Node Inventory 状态误导：有 `provider_account_unavailable:*` blocker 时，`runtimeGaps[].status` 和 `start-session:* runtimeStatus` 不再显示 `available`，而是 `degraded`。commit `71fc5c4cc3f386972b390fd90cbe51775ee2876d` 已部署到 AWS current 默认 `9527`，artifact sha256=`0a04dd9f8821b84afe00dc060de0f741112ec59eafb41fc8c5fde77941288a15`，server `483367 -> 487271`，`DEPLOYED_GIT_HEAD` 已更新为同一 commit，AWS focused 28/28 pass。部署后真实 node readback 显示 `start-session:codex|claude|agy enabled=false runtimeStatus=degraded`，`start-session:opencode enabled=true runtimeStatus=available`；部署后真实 `opencode` closure run `3530daec-be7a-41a5-bec7-c15bf7f59d29`、session `ses_0ebe27861ffe01ik69qmiXQr3g`、events=`ready/session-created/delta/result/done`，`selectedTransportKind=webrtc`、`fallbackUsed=false`。剩余 blocker 现在被明确分成 cloud policy/UDP、provider credential、WebTransport HTTPS/H3、OMR/MPTCP 四类，不能再混成“超时”。

- Selected provider runtime block plan 最新闭环：`2026-06-29-selected-provider-runtime-block-plan.md` 修复真实 session proof 期间 selected provider 从可调度变成 `runtime_blocked:opencode:upstream_401` 后，`closurePlan` 误把下一步指向 generic session retry 的问题。真实失败诊断 `/tmp/aih-fabric-continuation-20260629-233044.json` 显示 run `1f981466-5c47-4059-bdae-c54774f8076d` 事件为 `ready/session-created/runtime-blocked/delta/result`，旧 `immediateNext=session-marker-proof-blocked`；修复后同一真实失败文件回放为 `immediateNext=provider-opencode-blocked`，命令直接变为 `aih fabric provider accounts revalidate --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --providers opencode --yes --json`。commit `5f58e99661e408de796c334cde2926907b1b14e3` 已用 clean artifact 部署到 AWS current 默认 `9527`，artifact sha256=`573cc1bf6cbaf57dc1eba7ee7ece576a37de40bbc33bc76df95370205db66f4b`，远端 `DEPLOYED_GIT_HEAD` 已更新为同一 commit，server `478728 -> 483367`，`/readyz ok=true ready=true`，账号计数 `codex=1,gemini=0,claude=4,agy=7,opencode=1`。本地 focused 15/15、expanded Fabric focused 35/35、full `npm test` 2865/2865 pass；AWS 远端 focused 15/15 pass。真实 `opencode` revalidate run `a7aa271d-52ea-4654-a425-fd6ee10a6257` 通过 WebRTC、`fallbackUsed=false`、events=`ready/session-created/delta/result/done`；部署后真实 closure audit run `ef27fb6e-ee50-43e1-961b-13bdf01cd8f8`、session `ses_0ebf1cf9effeI8F5CHSyZ7qQ5e`、marker `AIH_FABRIC_CLOSURE_AUDIT_20260629_154458` 命中，`selectedTransportKind=webrtc`、`fallbackUsed=false`。失败 ledger 新增并固化：selected provider runtime block 优先 revalidate，不再重试 session；provider blocker 命令必须带 endpoint；full npm test 要看最终 TAP summary；AWS `nohup` wrapper 只清 wrapper 不杀 ready node；locale warning 为良性。

- Provider auth-job RPC closure 最新闭环：`2026-06-29-provider-auth-job-rpc-closure.md` 修复远程 `reauth` 已能启动 AWS OAuth job、但本地 client 还不能通过 Fabric 产品协议查询/取消/回调 job 的缺口。commit `e94c9b6b9b1dfca24811698ca3a76a20df10ea09` 已部署到 AWS current 默认 `9527`，artifact sha256=`30ea40d01740c7b7a9ace31b0d4c77b7f285f937fc71924ea6525b6e539f78a2`，远端 `DEPLOYED_GIT_HEAD` 已更新为同一 commit，server `475571 -> 478728`，`/readyz ok=true ready=true`，账号计数 `codex=1,gemini=0,claude=4,agy=7,opencode=1`。本地 focused `fabric-provider-accounts + node-rpc-router` 68/68、full `npm test` 2865/2865 pass；AWS 远端 focused 68/68 pass。真实 AGY reauth job `eca176e5-ee47-4cf6-99b7-fef5145f0969` 进入 `awaiting_code` 并取到 Google OAuth URL；新 `aih fabric provider accounts auth-job get` 通过 paired device token 读回 job pid `479114` 和终端日志；新 `auth-job cancel` 返回 `status=cancelled/authProgressState=cancelled`，事后无 AGY/antigravity 进程残留，AGY audit 仍收敛为真实 `auth_invalid:agy_not_signed_in`。同次真实 `opencode` closure audit run `9286dc96-84c0-4393-b6f1-1c62b0b2031f`、session `ses_0ec03fbbeffeiSwyN6jeQcab1U`、marker `AIH_FABRIC_CLOSURE_AUDIT_20260629_152507` 命中，events=`ready/session-created/delta/result/done`，`selectedTransportKind=webrtc`、`fallbackUsed=false`。失败 ledger 新增并固化：full npm test 慢但只跑一次、dependent git staging/status 不并行、AWS `nohup` wrapper 只清 wrapper 不杀 node、diagnostics JSON 事件路径用 `reports.sessionEvents`、locale warning 为良性。

- Auth CLI runtime-tools and stream closure 最新闭环：`2026-06-29-auth-cli-runtime-tools-and-stream-closure.md` 修复 AWS AGY reauth 明明 diagnostics 能看到 `.runtime-tools/bin/agy`、Web auth job 却报 `cli_not_found` 的路径不一致问题。commit `11f09c177636611aa32b75fb7f89c861a636e19b` 已部署到 AWS current 默认 `9527`，artifact sha256=`04ae1cb11636134f05a186f3485cff27ca0fa4746cb46dd6677a8dc1c78463e1`，远端 `DEPLOYED_GIT_HEAD` 已更新为同一 commit，server `470602 -> 475571`，`/readyz ok=true ready=true`，账号计数 `codex=1,claude=4,agy=7,opencode=1`。本地 focused `command-path + web-account-auth` 52/52、runtime/fabric/repository focused 34/34、full `npm test` 2861/2861 pass；AWS 远端 focused 75/75 pass。真实 AGY reauth 现在返回 HTTP 200，job `89c9f309-8156-4aa1-acfb-c281525caaa1` 进入 `awaiting_code`，拿到 Google OAuth 授权入口，证明旧 `cli_not_found` 已关闭；随后已通过 cancel 路由清理临时账号/job，无 AGY 进程残留，AGY audit 仍是 7 个原账号且 blocker 收敛为真实 `auth_invalid:agy_not_signed_in`。同次真实 `opencode` closure audit run `53e27797-89b6-43da-a87d-0b07334cf71a`、session `ses_0ec19876dffexm1lGesO7sLJA6`、marker `AIH_FABRIC_CLOSURE_AUDIT_20260629_150135` 命中，events=`ready/session-created/delta/result/done`，`selectedTransportKind=webrtc`、`fallbackUsed=false`。失败 ledger 新增并固化：不要并行 archive/hash、`command-path` shell probe 必须继承调用 env、AWS startup wrapper 只清 wrapper 不杀 node、diagnostics JSON 事件路径用 `reports.sessionEvents.result.events`。

- Next milestone diagnostics ledger 最新闭环：`2026-06-29-next-milestone-diagnostics-ledger.md` 使用现有 `closure audit --diagnostics-file` 对 AWS current 默认 `9527` 做了真实剩余里程碑审计，落盘 `/tmp/aih-fabric-next-milestone-audit-20260629.json`（186K）。真实 `opencode` 串流 run `f849d0d5-fd3e-47d1-a03b-4869411b9867`、session `ses_0ec31e659ffeCHnF8Yozb0RRuW`、marker `AIH_DIAGNOSTICS_LEDGER_STREAM_20260629_2305` 命中，events=`ready/session-created/delta/result/done`，`selectedTransportKind=webrtc`、`fallbackUsed=false`。诊断文件显示 `M3/M3.5/M4/M5/M6/runtime=pass`，`closurePlan.state=usable_with_external_blockers`，`nextQueue` 只有 7 个 external blocker 且全部 `canAutomate=false`：`transport-cloud-edge-udp`、`transport-cloud-api-readback`、`transport-webtransport-h3`、`transport-multipath-underlay`、`provider-agy-blocked`、`provider-claude-blocked`、`provider-codex-blocked`。同次 cloud-edge 真实证据为 `cloudEdgeReady=false`、`udpReachable=false`、`packetArrivalCaptured=false`、`hostFirewallBlocksUdp=false`、SG IDs=`sg-01e33f3412fabfded,sg-01e7f50a205d7b308`，blockers=`turn_default_udp_9527_unreachable,aws_public_udp_path_blocked,aws_cli_missing,aws_iam_role_missing,aws_local_cli_missing`。结论：当前软件侧闭环已过，剩余推进需要 AWS-side provider reauth、UDP/TURN 或 SG/NACL/read-only AWS API、HTTPS/H3 WebTransport endpoint、OpenMPTCPRouter/MPTCP underlay 这些真实外部输入。

- Provider accounts profile targeting 最新闭环：`2026-06-29-provider-accounts-profile-targeting.md` 修复 `fabric provider accounts audit|revalidate` 只能手动传 SSH 目标、不能从 paired server profile 推导 AWS node 的问题。commit `9d7c09fd8a53c65612d7c9863364fedee423d69a` 已用 clean artifact 部署到 AWS current 默认 `9527`，artifact sha256=`63c7996bf99f89ec900238b48f57f6bdc6b84d24725a987d07da4156b41151e4`，远端 `DEPLOYED_GIT_HEAD` 已校正为同一 commit，server `466493 -> 470602`，`/readyz ok=true ready=true`，账号计数 `codex=1,claude=4,agy=7,opencode=1`。本地 `node --check`、focused provider/runtime/closure 35/35、repository policy 2/2、full `npm test` 2860/2860 pass；AWS 远端同款 Node focused 35/35 pass。真实 endpoint-only audit 只传 `--endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527` 即推导出 `ssh=ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`、`remoteDir=/home/ubuntu/aih-fabric-current`、`nodeId=aws-current-node`、`port=9527`，读回 `remoteAudit.target.deployedGitHead=9d7c09fd8a53c65612d7c9863364fedee423d69a`。真实 `opencode` revalidate run `315ab0a7-4e5e-458e-bef8-1e633f1f54e1` 通过 WebRTC、`fallbackUsed=false`，events=`ready/session-created/delta/result/done`；真实 closure audit run `32d44d89-665f-4597-a112-fcd1ac6e894b`、session `ses_0ec37ec1affe7Kwn0bvdMA2Cb3`、marker `AIH_PROFILE_TARGETING_DEPLOY_STREAM_20260629_2228` 命中，`selectedTransportKind=webrtc`、`fallbackUsed=false`。本次失败原因已归档：旧命令 `unknown option --endpoint`、AWS 非交互 SSH PATH 没有 `node`、手写错误 `DEPLOYED_GIT_HEAD`、启动 wrapper bash 残留、locale 警告为良性；外部未闭环仍是 Codex `auth_invalid:upstream_401`、Claude `auth_invalid:claude_not_logged_in`、AGY `auth_invalid:agy_not_signed_in`、TURN/UDP、WebTransport HTTPS/H3、MPTCP/OMR。

- Promotion gate scope semantics 最新闭环：`2026-06-29-promotion-gate-scope-semantics.md` 修复 M6 promotion gate 输出容易误读的问题：保留兼容 `summary.defaultTransport`，新增 `defaultTransportScope`、`fallbackTransport`、`candidateTransports`、`blockedTransports`、`promotionPolicy.webrtc`，并在人类可读输出中展示 `default_transport_scope/fallback_transport/webrtc_policy`。本地 focused `fabric-m6-promotion-gate` 23/23、相邻 transport/closure focused 21/21、full `npm test` 2857/2857 pass。commit `896b1a9439dd2f28f71febf1736b7c3a98d8e921` 已用 clean artifact 部署到 AWS current 默认 `9527`，artifact sha256=`76d1d4db7f13ff33c946c7c9ac0df7099d2dda3c4414c7ed986dd41462b18646`，远端 focused 34/34 pass，server `461644 -> 466493`，`/readyz ok=true ready=true`，host-home env 正确。部署后真实 `transport status --with-promotion-gate --allow-direct-webrtc-promotion --skip-cloud-edge --skip-webtransport --skip-multipath` 返回 `defaultTransport=webrtc`、`defaultTransportScope=promoted_transport`、`fallbackTransport=relay`、`promotionPolicy.webrtc=direct_allowed`、relay 20/20 p95=`114ms`、WebRTC p95=`444.1ms`、RPC p95=`728.8ms`；真实 `opencode` closure run `63f9d63b-eab6-4e2c-9256-40d9fbb5e014` 仍通过 WebRTC、`fallbackUsed=false`，events=`ready/session-created/delta/result/done`，marker `AIH_PROMOTION_SCOPE_DEPLOY_STREAM_20260629_2208` 命中。

- Business stream closure 最新闭环：`2026-06-29-business-stream-closure-and-failure-ledger.md` 重新按 AWS-only 串行验证完成业务闭环和失败原因归档。AWS current 默认 `9527` 当前进程 `461644`，`DEPLOYED_GIT_HEAD=5fdfc6fffbf6e8c706f6edc6bc975cdbb7d0f8b8`，`/readyz ok=true ready=true`，host-home env 指向 `/home/ubuntu/aih-fabric-current/.aih-host-home`，不是本机 macOS profile。`fabric nodes aws-current-node` 真实读回 AWS 是 `node + relay-node`、`projectHost=true`、`runtimeHost=true`、`sshBootstrap=true`、`transportKinds=relay,webrtc`，当前可执行 `open-project`、`start-session:opencode`、`configure-ssh`、`run-measurement`；Codex/Claude/AGY 的 CLI 存在但账号不可调度，原因分别是 `auth_invalid:upstream_401`、`auth_invalid:claude_not_logged_in`、`auth_invalid:agy_not_signed_in`。真实 `opencode` closure audit run `551624ef-7834-4fd0-87a6-c576ba5cf4a5` 完成 `ready/session-created/delta/result/done`，marker `AIH_OPENCODE_CLOSURE_STREAM_20260629_2150` 在 canonical stream 命中，`selectedTransportKind=webrtc`、`fallbackUsed=false`。当前运行态 `transport status --skip-cloud-edge` 返回 `defaultTransport=webrtc`、`fallbackReady=true`、`promotedTransports=webrtc`；严格 `promotion-gate` 默认仍要求 TURN relay，未加 `--allow-direct-webrtc-promotion` 时会把 WebRTC 判为 `turn_relay_gate_not_ready` 并回到 `relay`，加上 `--allow-direct-webrtc-promotion` 后真实返回 `promotionReady=true`、`defaultTransport=webrtc`、WebRTC direct p95=`804.5ms`、RPC p95=`805.1ms`。失败 ledger 已明确：不要把 provider auth、UDP 探测并发、AWS UDP 包不到达、AWS CLI/IAM 缺失、WebTransport HTTPS/H3 缺失、MPTCP/OMR 缺失混成同一种“超时”。

- UDP probe concurrency 最新闭环：`2026-06-29-udp-probe-concurrency-classification.md` 修复真实 gate 并发误报：`closure audit/cloud-edge/prerequisites/promotion-gate` 都会临时 bind AWS UDP `9527`，并发执行时一个探测会失败为 `bind EADDRINUSE 0.0.0.0:9527`；现在共享 UDP probe 把该情况分类为 `turn_default_udp_probe_busy`，blocker catalog 映射为 `domain=diagnostic_concurrency owner=aih external=false`，`cloud-edge` summary 给出“同一时间只跑一个默认 UDP transport diagnostic”的 next action，且不会把该并发冲突误记为 `aws_public_udp_path_blocked`。真实 AWS 并发复现：一个 probe 返回 `turn_default_udp_probe_busy`，另一个 probe 仍返回真实云边界证据 `turn_default_udp_9527_unreachable + aws_public_udp_path_blocked`、`tcpdump 0 packets captured / 0 packets received by filter`。Focused tests `51/51 pass`。

- Closure plan provider priority 最新闭环：`2026-06-29-closure-plan-provider-priority.md` 修复 `closurePlan.nextQueue` 把 generic `session-marker-proof-blocked` 排在 selected provider blocker 之前的问题；现在当真实 AWS Codex 因 `provider_account_unavailable:codex` 阻断时，`immediateNext=provider-codex-blocked`，不会继续误导重跑 session marker。计划会从真实 node diagnostic 的 `sampleAccountIds` 生成第一条 reauth 命令；真实 AWS Codex gate 现在返回 `immediateNext.command=aih fabric provider accounts reauth --provider codex --account-id 2 --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json`、`requiresConfirmation=true`、`nextQueue=provider-codex-blocked,session-marker-proof-blocked,transport-cloud-edge-udp,...`。Focused `fabric-closure-audit` tests `10/10 pass`；commit `6d2ba72` 已用 clean artifact 部署到 AWS current，artifact sha256=`25d1bae5291bcb5c80e2817b81f15531221dda0ca6b11e3997b06e03ed95d498`，远端 focused `10/10 pass`，server `453080 -> 455026`，`DEPLOYED_GIT_HEAD=6d2ba72980a9a584c06a38ba1dbc6bdfecccbbb7`，`/readyz ready=true`，host-home env 正确。业务闭环复测已用 `opencode` 在 AWS current 默认 `9527` 真实完成 WebRTC 串流 run `76b21038-1bf9-4ac5-a936-ae8e698db819`，事件为 `ready/session-created/delta/result/done`、marker `AIH_OPENCODE_BUSINESS_STREAM_CLOSE_20260629` 命中、`fallbackUsed=false`；当前重复耗时根因已记录为 Codex 账号 `auth_invalid:upstream_401`、旧 plan 排序、旧命令不可操作，以及 cloud-edge/WebTransport/MPTCP 外部前置，不再把这些当成未知超时。

- Closure audit session proof hardening 最新闭环：`2026-06-29-closure-audit-session-proof-hardening.md` 先恢复 AWS current 默认 `9527` 的真实 host-home 运行态，再完成当前可用业务链路 `opencode` 的真实 WebRTC 串流 proof：run `efbcfad0-e008-4a14-be30-c92c5787968d`、`fallbackUsed=false`、marker/done/events=5。Codex 不再是 `cli_not_found`，真实新 blocker 是 AWS Codex API key `auth_invalid:upstream_401`，post-run audit 显示 `runtimeBlocked=1`；同步修复 `closure audit` 的假阳性：terminal echo 不再算 marker proof，必须在 canonical `delta/result/done` 输出中命中 marker 且观察到 `done`，`runtime-blocked/error/aborted` 会让 session proof blocked。Commit `777b35f` 已用 clean artifact 部署到 AWS current，artifact sha256=`a6ba8bc63ff2d98173cd7457402d34f91dcc22883f570afea59ba28c26ec246a`，远端 focused `15/15 pass`，server `447349 -> 450401`，`DEPLOYED_GIT_HEAD=777b35f4418f38ed1d221571e02cd635e03689fd`，`/readyz ready=true`；post-deploy `opencode` run `896a8adb-ddf5-4ad5-924d-429b587597fd` 仍通过 WebRTC、`fallbackUsed=false`、marker/done/events=5；post-deploy Codex gate 当时返回 `status=blocked`、`nextQueue=session-marker-proof-blocked,provider-codex-blocked,...`，该排序问题已由上方 provider priority 闭环修正。

- Active Todo（后续有新需求先追加到这里，再按顺序推进）：

  | 顺序 | 状态 | 事项 | 当前证据 | 下一步验收 |
  |---:|---|---|---|---|
  | 1 | done | M0 设计包落地：产品说明、拓扑、流程、ER、协议、线框、测试计划、生命周期、迁移边界、竞品/传输研究 | `docs/fabric/00-*.md` 到 `12-outbound-broker-routing.md` 已存在 | 后续只随真实实现补差，不重新发散 |
  | 2 | done | 当前测试目标收敛为 AWS current，禁止继续使用旧 152/155/39.104 | 本文件 “Current VPS Target Set” 已声明 AWS only | 所有新 smoke 命令只访问 AWS current 或本机默认端口 |
  | 3 | done | AWS current 默认 `9527` 上完成真实 `/v1/responses`、relay Codex 会话、broker relay Codex 会话、broker diagnostics recovery | `2026-06-27-outbound-broker-relay-aws-smoke.md`、`2026-06-27-broker-diagnostics-recovery.md` | 后续复测仍要用默认 `9527`，不新增端口 |
  | 4 | done | Server Profile 解耦第一刀：无 profile 进入 `/ui/server-setup`，配对成功后进入工作台 | `2026-06-26-fabric-browser-pairing-smoke.md` | 保持 browser smoke 作为 UI 改动回归门 |
  | 5 | done | Broker Proxy 接入 Server Setup 的真实浏览器 smoke | `2026-06-27-browser-broker-profile-smoke.md`：真实浏览器配对、device profile/status/accounts/sessions 全部经 broker proxy 返回 200，console 0 error/0 warning，进入 `/ui`；同 allowlist 已同步到 AWS current 默认 `9527` 并通过 broker proxy device route smoke | 已由第 6 项跨主机 broker endpoint 验收闭环 |
  | 6 | done | 跨主机 outbound-only broker 验收 | `2026-06-27-crosshost-outbound-broker-profile-smoke.md`：本机 client -> AWS public broker -> 本机 server outbound link -> 本机 node relay -> Codex 远程会话已完成；readyz、descriptor、device pair、device scoped reads、sessions RPC 和真实 Codex marker 均通过 | 作为 broker/outbound 回归门保留 |
  | 7 | done | M3 Role Registry 产品闭环：home/company node + relay-node、周期心跳/daemon、UI 节点页、relay health measurement、本地 AWS 可见性 | server API、publisher、heartbeat、foreground agent、Fabric Nodes UI 已有；`2026-06-27-m3-role-registry-measurement.md` 已证明 AWS current 默认 `9527` 可持久化 relay measurement 并在 UI 展示；`2026-06-27-m3-role-registry-two-nodes.md` 已证明本机 + AWS current 两个真实 node/relay-node 可同屏展示；`2026-06-27-m3-relay-health-strong-metrics.md` 已证明默认 `9527` WS echo p95/成功率/networkMeasurements trace；`2026-06-27-m3-fabric-nodes-mobile-regression.md` 已证明移动端多节点 UI 回归；`2026-06-28-m3-supervised-daemon-aws.md` 已证明 AWS current 默认 `9527` 上 relay + registryAgent 两个 user systemd service 长期运行、`supervisor.ready=true`、fresh `ws_echo_pass` measurement、unit/process 不含 raw secret；`2026-06-28-m3-local-aws-visibility.md` 已证明本机真实浏览器有 paired AWS server profile、Fabric Nodes 从 AWS registry 读到 2 个真实 node/relay-node、AWS 已加入本地 SSH 开发机管理且连接/目录浏览通过 | M3 完成，作为 node/relay/registry 回归门保留 |
  | 8 | done | M3.5 统一 Node 产品模型：把控制面、远程节点、SSH 开发机、节点健康和 transport candidates 收敛到一个 Node Inventory / Node Detail 模型 | `15-unified-node-product-model.md` 已定义对象模型；`2026-06-28-current-aws-node-model-readback.md` 已证明 AWS 授权 registry readback 为 nodes=2、relayNodes=2、projects=2、runtimes=4、transports=2；`2026-06-28-node-inventory-read-model.md` 已证明 Node Inventory/action gating 落地；`2026-06-28-aws-runtime-gap-diagnosis.md` 已把 AWS 缺失的 codex/claude/agy/opencode runtime 结构化为 `runtimeGaps[]`；`2026-06-28-fabric-nodes-cli-capability-smoke.md` 已把本地 `aih fabric nodes aws-current-node` 产品化并在 AWS 默认 `9527` 真实验证；`2026-06-28-aws-runtime-diagnostics-readback.md` 已把 AWS runtime gaps 从泛化 `missing_provider_runtime` 细分为真实 CLI/账号 blocker；`2026-06-29-aws-runtime-cli-availability.md` 已把 AWS provider CLI 缺口关闭，并把剩余 blocker 收敛为 `missing_provider_account:*`；`2026-06-29-aws-runtime-account-gap-cli-output.md` 已让 CLI 人类可读输出直接展示 `cli=yes account_total=0`；`2026-06-29-node-inventory-project-action-gate.md` 已移除过期 `m4_project_action_pending`，真实 AWS readback 显示 `open-project` enabled；`2026-06-29-node-local-ssh-binding.md` 已把本地 AWS SSH workspace 合并到 Fabric nodes client read-model，真实 AWS readback 显示 `ssh=yes` 和 `configure-ssh` enabled | M3.5 完成，作为 Node Inventory/action gating 和 runtime diagnostics 回归门保留 |
  | 9 | done | M4 远程开发会话：以 server profile -> node -> project -> runtime -> session 的可理解路径替代旧 M4 专用入口路线 | 8.6 AWS current real remote session smoke 已完成；`2026-06-28-m4-aws-real-remote-session-smoke.md` 证明 AWS default `9527` 上真实 node invite、device pair、relay、Codex session start、event polling、artifact retrieval、marker output 和 cleanup 均通过；8.7 `2026-06-28-m4-mobile-pwa-session-smoke.md` 证明真实 mobile viewport 可通过 AWS start/attach/message/slash/cursor reconnect/artifact/stop；`2026-06-28-native-session-command-serialization-smoke.md` 证明同一 native run 的 message/slash/approval/stop 已串行化，AWS -> 本机真实 Codex run 未复现输入拼接；本轮修复 PTY submit chunking 和 active-run attach 默认 reader 签名缺口 | M4 完成，作为 session lifecycle 和 native command serialization 回归门保留 |
  | 10 | done | M5 Recovery：ack/resume、broker interruption、relay reconnect、diagnostics export、completed run events persistence | `2026-06-28-m5-session-recovery-smoke.md`：AWS current 默认 `9527` broker endpoint + 本机真实 Codex runtime，提交前复测 broker 中断恢复 cursor `235 -> 516`、relay 中断恢复 cursor `209 -> 398`，duplicateEvents 均为 `0`，offline 窗口有 503 诊断并导出 JSON diagnostics；`2026-06-28-native-session-event-persistence-smoke.md` 证明 completed native run events 写入本机 `fabric/native-runs` 后，本地 node server 重启仍可通过 AWS `9527` 读取同一 run，返回 `persisted=true`；`2026-06-28-native-session-command-serialization-smoke.md` 证明 command ack 之外的真实 TUI 输入窗口也已按 run 串行保护 | M5 当前默认单 broker/relay reconnect gate、completed run event persistence 和 native command serialization 完成；multi-broker hardening 不作为当前默认上线前置 |
  | 11 | partial | WebRTC DataChannel / WebTransport QUIC / Multipath QUIC promotion | `2026-06-28-webrtc-datachannel-aws-smoke.md`：AWS current 默认 `9527` signaling + headed Chrome + STUN 已达到 `ICE connected`、DataChannel open、5 次 RTT，p95=`646.3ms`；`2026-06-28-m6-webrtc-cross-machine-smoke.md` 已证明本机 macOS offerer + AWS Ubuntu answerer 两台真实机器通过同一 AWS signaling room 打开 DataChannel，5 次 RTT p95=`232.1ms`，selected pair 为 `srflx -> srflx`；`2026-06-28-m6-webrtc-rpc-adapter-gate.md` 已证明同一 AWS signaling/DataChannel 可承载 `datachannel-json-rpc-echo`，部署后 RPC responses=5/handled=5，p95=`725.3ms`，WebRTC 当前 blocker 已收敛为 `turn_relay_gate_not_ready`；`2026-06-28-m6-turn-relay-diagnosis.md` 已证明当前没有可用 TURN relay candidate：AWS UDP `9527` 不可达，public TURN relay-only 为 0 candidate 且浏览器 ICE error 701；`2026-06-28-m6-webtransport-quic-diagnosis.md` 已证明当前 AWS default `9527` 不是 HTTPS/H3 WebTransport endpoint：产品页 `insecure_context`，secure context 下 opening handshake failed；`2026-06-28-m6-transport-fallback-decision-smoke.md` 已证明 WebRTC/WebTransport candidate 不会进入默认 remote RPC transport 并回落到 relay；`2026-06-28-m6-webrtc-diagnostics-surface.md` 已把 WebRTC 页面从 Lab 收敛为正式 diagnostics 并部署到 AWS current 默认 `9527`，部署后真实 DataChannel smoke 仍通过；`2026-06-28-m6-transport-decision-diagnostics.md` 已证明 AWS 真实 `/v0/webui/nodes/:id/test` 在 relay unavailable 时仍返回/audit `transportDecision`，WebRTC 拒绝原因为 `webrtc_not_promoted`；`2026-06-28-m6-multipath-mptcp-diagnosis.md` 已证明 AWS Linux 侧具备 MPTCP capability，但本机侧无通用 MPTCP socket、未检测到 OpenMPTCPRouter，且 default `9527` 是 plain AIH HTTP listener；`2026-06-28-m6-transport-promotion-gate.md` 已新增单命令聚合 gate，当前真实结果为 `promotionReady=false`、`defaultTransport=relay`、`fallbackReady=true`，post-deploy relay WS echo 20/20 p95=`106ms`，WebRTC `candidateReady=true` 但 TURN/WebTransport/Multipath 均未晋级；`2026-06-28-m6-prerequisite-audit.md` 已把剩余外部前置条件收敛为可重复审计：AWS base ready，但 `readyTransports=[]`，blockers 为未配置受控 TURN、WebTransport connect failed、本机 MPTCP/OMR/default listener 不满足；`2026-06-28-m6-relay-durability-gate.md` 已证明当前默认 relay fallback 在 AWS current 默认 `9527` clean HEAD 部署后轻量耐久探测 `6/6` 轮、`120/120` echo 全部通过，p95=`116ms`、p99=`117ms`，server pid=`250901`；`2026-06-28-m6-transport-readiness-endpoint.md` 已把 readiness 产品化为受保护 server endpoint；`2026-06-28-m6-webrtc-candidate-registry-readiness.md` 已把 AWS current registry/readiness 与真实 WebRTC candidate 对齐：`transports=3`，`aws-current-node` 有 `relay,webrtc`，readiness 不再出现 `webrtc_transport_candidate_not_registered`，但仍保持 `defaultTransport=relay`、`promotionReady=false`；`2026-06-29-m6-current-gate-readiness-recheck.md` 已复跑真实 readiness/prerequisite/promotion gate：relay 10/10 p95=`425ms`，WebRTC DataChannel p95=`206.1ms`、RPC p95=`338.8ms`，默认仍为 relay，promotion 仍阻塞于 TURN/WebTransport/MPTCP/OMR 外部前置；`2026-06-29-m6-promotion-gate-cli.md` 已把 aggregate promotion gate 产品化为 `aih fabric transport promotion-gate`，本地对 AWS 真实运行 relay 5/5 p95=`105ms`、WebRTC DataChannel/RPC p95≈`211ms`、默认仍为 relay；`2026-06-29-m6-transport-config.md` 已新增持久 transport config，真实 AWS WebTransport candidate 配置会进入 prerequisites，但仍按真实 WebTransport connect failure 阻塞，清理后 gate 显示 `transportConfig.present=false/applied=[]`；`2026-06-29-m6-promotion-gate-turn-udp-alignment.md` 已把 promotion gate 与 prerequisites 的 TURN 默认 UDP blocker 口径对齐，真实 AWS promotion gate 同时输出 `turn:turn_ice_server_not_configured` 和 `turn:turn_default_udp_9527_unreachable`；`2026-06-29-m6-udp-packet-arrival-diagnosis.md` 已证明本机到 AWS public UDP `9527` 的包没有到达实例 `enp39s0` 网卡，`tcpdump` 为 `0 packets captured / 0 packets received by filter` | TURN 需要可达受控 TURN 端口/凭据后复测；WebTransport 需要 HTTPS/H3 endpoint 后复测；Multipath 需要真实双端/路由器 underlay 后复测；未达完整 gate 前不设高级默认 |

- Runtime account revalidation 最新闭环：`2026-06-29-runtime-account-revalidation-session-guards.md` 已把 `--remote-revalidate --yes` 收敛为真实 AWS 池级 guard：不生成/上传本机账号包，清 AWS runtime blocker、reload、publish registry 后按 provider profileCount 顺序尝试真实 session；最终 `opencode` 1/1 返回 canonical marker，`codex` 1/1 写入 `auth_invalid:upstream_401`，`claude` 4/4 写入 `auth_invalid:claude_not_logged_in`，`agy` 7/7 写入 `auth_invalid:agy_not_signed_in`；`fabric nodes aws-current-node` 现在明确显示 `start-session:opencode enabled`，`codex/claude/agy blocked`。
- M6 WebRTC post-runtime-guards 最新闭环：`2026-06-29-m6-webrtc-promotion-refresh-post-runtime-guards.md` 复核本地 paired profile `cp-51hq70` 到 AWS current 默认 `9527` 的真实现状：`fabric nodes aws-current-node` 返回 `runtime_host=yes`、`ssh=yes`、`transports=relay,webrtc`、`start-session:opencode enabled`；`fabric transport readiness` 返回 `defaultTransport=webrtc`、`promotionReady=true`、`promotedTransports=["webrtc"]`、`fallbackReady=true`；`fabric transport status` 返回 `status=complete`、`remoteDevelopmentReady=true`、`advancedPromotionReady=true`；真实 `fabric session start/events` 以 `opencode` account `1` 通过 WebRTC、`fallbackUsed=false` 完成 run `c808cd28-0921-4290-8d1b-04d96d5e9e00`，并在 `delta/result/done` 命中 marker `AIH_RUNTIME_OPENCODE_WEBRTC_CLOSE_OK_20260629_1556`。
- Node connector reconnect 稳定性最新闭环：`2026-06-29-node-connector-reconnect-stability.md` 修复 relay/WebRTC connector 在 `connectOnce` 窗口遇到瞬时不可用时直接退出的问题，并移除 relay reconnect sleep 的 `unref()`；本地 `node --test test/node-relay-client.test.js test/node-webrtc-client.test.js` 21/21 pass，service/doctor focused 51/51 pass，full `npm test` 2818/2818 pass；commit `11e51db` 用 clean `git archive HEAD` 部署到 AWS current 默认 `9527`，artifact sha256=`330ae6a6a07cfeb75687bb3b3285861a9135e87783de4275fb7dd1e06181ad1e`，远端 connector focused tests 21/21 pass；受控重启 default server `398002 -> 401374` 后，relay/WebRTC connector PID 保持 `401181/401182`，3 分钟观察窗口 journal 无新增 failure，真实 `opencode` run `6f12595e-371e-4975-8347-fe2796032083` 仍通过 WebRTC、`fallbackUsed=false` 命中 marker `AIH_CONNECTOR_RECONNECT_STABILITY_OK_20260629_1611`。
- Fabric closure audit CLI 最新闭环：`2026-06-29-fabric-closure-audit-cli.md` 新增正式入口 `aih fabric closure audit`，把 paired server registry、node capabilities、transport status、provider account gates 和真实 session marker proof 收敛成一个可重复产品 gate；`--skip-cloud-edge` 支持没有本机 AWS SSH key 的远端自检；本地 focused 7/7 pass，adjacent Fabric nodes/status/session 24/24 pass，full `npm test` 2825/2825 pass；真实 AWS current 默认 `9527` 完整审计返回 `status=usable_with_blockers`、`core_ready=yes`、`selected_transport=webrtc`、`fallback_used=no`、`startable_providers=opencode`、M3/M3.5/M4/M5/M6/runtime 全部 pass，真实 `opencode` run `6c715b38-3c08-4abd-a6f9-647fecab3c7c` 在 events 中命中 marker `AIH_CLOSURE_AUDIT_FINAL_REAL_20260629_1706` 且 `done=yes`；`--fail-on-incomplete` 真实返回 exit `1` 并继续暴露 Codex/Claude/AGY 账号、TURN/WebTransport/MPTCP/OpenMPTCPRouter 外部 blocker；已用 clean `git archive HEAD` 部署到 AWS current 默认 `9527`，远端 focused closure audit 7/7 pass；远端自检因 AWS 本机没有 ready self-paired server profile 返回 structured blocked report，而不是崩溃。
- AWS self server profile 最新闭环：`2026-06-29-aws-self-profile-pairing.md` 新增 `aih fabric profile pair|pair-self`，复用真实 `/v0/webui/control-plane/devices/invites`、`/v0/fabric/device-pair`、`/v0/fabric/descriptor` 保存 ready server profile，输出只显示 `deviceTokenPresent=true` 不打印 raw token；AWS current 原 profile store 为空，执行 `pair-self --endpoint http://127.0.0.1:9527` 后生成 active profile `cp-1punknr`、`state/authState=paired`；AWS 自身 `closure audit --endpoint http://127.0.0.1:9527 --skip-session --skip-cloud-edge` 已不再出现 `ready_server_profile_missing`，完整真实 `opencode` marker 会话 run `870db4c4-f5ab-4d43-8278-442359d4abe2` 命中 marker/done/events=5，M3/M3.5/M4/M5/M6/runtime 均 pass；未复制 Mac profile 数据或 provider 凭据。
- Fabric closure plan 最新闭环：`2026-06-29-closure-plan-structured-gate.md` 已把 `closure audit` 的 free-form `nextActions` 升级为结构化 `closurePlan`：输出 `state`、`immediateNext`、状态计数、按 domain 拆分的 node/provider/transport/session items，以及每项可复跑命令和 evidence；本地 syntax pass，focused/adjacent 15/15 pass，full `npm test` 2831/2831 pass；本地到 AWS current 真实 plan readback 为 `state=needs_real_session_proof`、`done=3`、`blockedExternal=7`、`unchecked=1`，真实 `opencode` marker run `6918e0ef-fa3e-4fb1-92fc-53c9207873df` 命中 marker/done/events=5 后 `state=usable_with_external_blockers`；已用 final clean `git archive HEAD` 部署到 AWS current 默认 `9527`，远端 focused 15/15 pass，真实 marker run `2e5d538e-1abb-473f-a356-7b2e76aa2a39` 通过 WebRTC、`fallbackUsed=false`、marker/done/events=5，`closurePlan.state=usable_with_external_blockers`。剩余项继续保持 external blocker：Codex/Claude/AGY 账号、TURN/UDP cloud edge、WebTransport HTTPS/H3、OpenMPTCPRouter/MPTCP。
- Fabric blocker catalog / next queue 最新闭环：`2026-06-29-fabric-blocker-catalog-next-queue.md` 新增 Fabric blocker catalog，把 `aws_public_udp_path_blocked`、`aws_cli_missing`、WebTransport、OpenMPTCPRouter/MPTCP、provider account blocker 统一解释为 `domain/owner/impact/nextAction/command`；`fabric transport status` 现在即使 `defaultTransport=webrtc`、`advancedPromotionReady=true` 也会保留外部 blocker 的 `summary.blockerDetails[]` 和非空 `summary.nextActions[]`；`closurePlan` 新增排序后的 `nextQueue[]`，真实 AWS `opencode` run `d85f026a-ec23-4e0e-a5f9-8e125ab1d0c3` 通过 WebRTC、`fallbackUsed=false`、marker/done/events=5，`closurePlan.state=usable_with_external_blockers`、`nextQueue` 按 cloud edge -> cloud API -> WebTransport -> Multipath -> provider login 排序；focused tests 18/18 pass，full `npm test` 2846/2846 pass；commit `deb9517` 已用 clean `git archive HEAD` 部署到 AWS current 默认 `9527`，artifact sha256=`818a73c74038e3d2e083ab24e143aa689e1294bb1bf57b24750e21d7668f3c57`，server pid=`431635`，post-deploy `/readyz ready=true`，真实 closure run `15eb9c15-cc75-411b-8b9f-c4e8d7f6ccb3` 命中 marker `AIH_BLOCKER_CATALOG_DEPLOY_OK_20260629`、WebRTC、`fallbackUsed=false`、events=5、done=yes。
- Fabric cloud API local readback 最新闭环：`2026-06-29-fabric-cloud-api-local-readback.md` 已把 `fabric transport cloud-edge` 的 cloud API 诊断拆成远端节点 AWS CLI/IAM 和本机 AWS CLI 只读 readback 两条路径；任一路径能读 SG/NACL 即可关闭 cloud API readback blocker，两边都不可读才保留 blocker。本机只读命令限定为 `sts get-caller-identity`、`ec2 describe-instances`、`ec2 describe-security-groups`、`ec2 describe-network-acls`，不修改 SG/NACL/IAM，输出会脱敏 AWS access key/secret/session token。真实 AWS current 默认 `9527` 复测显示 WebRTC 默认路径仍可用，但 UDP `9527` 到实例仍 `udp_echo_timeout`、AWS 抓包 `0 packets captured`、host firewall 未阻断；远端缺 `aws` CLI/IAM，本机也缺 `aws` CLI，因此 blockers 收敛为 `turn_default_udp_9527_unreachable`、`aws_public_udp_path_blocked`、`aws_cli_missing`、`aws_iam_role_missing`、`aws_local_cli_missing`；focused tests 29/29 pass，full `npm test` 2850/2850 pass；commit `9b6e540` 已用 clean `git archive HEAD` 部署到 AWS current 默认 `9527`，artifact sha256=`25c8ce2486d5bd81a6ccf97d3cf9c809403ab27c536483b80305ce02354bce82`，server pid=`435978`，post-deploy `/readyz ready=true`，真实 closure run `6fa2c3b3-7503-4e3c-8eb1-c9ec3ccc8b26` 命中 marker `AIH_LOCAL_AWS_READBACK_DEPLOY_OK_20260629`、WebRTC、`fallbackUsed=false`、events=5、done=yes。
- Fabric cloud API local readback 复核纠偏：同一证据文件已补充 `4b8b6ef` closure-plan 分类修复后的真实复核；AWS current 默认 `9527` 服务仍为 pid `435978`、PPID `1`、`/readyz ready=true`，`DEPLOYED_GIT_HEAD=4b8b6ef5d287ce40d3b15b12bce7b2fd74ad780d`。最新 `closure audit` run `e34233a2-8c6e-4704-be1d-12cb55b4cefa` 通过 WebRTC、`fallbackUsed=false`、marker/done/events=5；`nextQueue` 当前按 `transport-cloud-edge-udp`、`transport-cloud-api-readback`、`transport-webtransport-h3`、`transport-multipath-underlay`、`provider-agy-blocked`、`provider-claude-blocked`、`provider-codex-blocked` 排序。结论：当前业务链路已闭合，剩余均是 AWS cloud edge/AWS CLI readback/H3 endpoint/MPTCP underlay/provider 登录这些外部条件，不应继续用无意义重跑消耗时间。
- Provider accounts CLI 最新闭环：`2026-06-29-provider-accounts-cli-revalidation.md` 新增正式入口 `aih fabric provider accounts audit|revalidate` 并接入 `closurePlan` provider blocker 命令；本地 focused 36/36、full `npm test` 2836/2836 pass；commit `0974c85` 用 clean `git archive HEAD` 部署到 AWS current 默认 `9527`，artifact sha256=`d26a7dca107975fca3421806d46e9877eb7d86f0d66640cfb8840e394d133441`，远端 focused 36/36 pass；真实 audit 显示 `localArchive=null`、`remote=null`、AWS profiles=13、runtimeBlocked=12；真实 revalidate 清 12 个 AWS runtime blocker、reload=13、publish runtimes=4，并跑真实 session guards：`opencode` validated，`codex/claude/agy` 正确保留在 `providersBlocked`，不再漏 Claude；同时修复 registry publish 丢 WebRTC promotion 的问题，promotion 重新发布后再次 revalidate 仍保持 `defaultTransport=webrtc`、`advancedPromotionReady=true`，最终 closure audit run `90b2e555-fb7a-4069-965d-9131c2fcf79c` 命中 marker `AIH_PROVIDER_ACCOUNTS_CLOSURE_OK_20260629`，`closurePlan.state=usable_with_external_blockers`。
- Provider account remote reauth RPC 最新闭环：`2026-06-29-provider-account-remote-reauth-rpc.md` 新增正式入口 `aih fabric provider accounts reauth --provider <provider> --account-id <id>`，本地通过 paired server profile `cp-51hq70` 调 AWS current 默认 `9527` 的 `POST /v0/node-rpc/device-provider-account-reauth`，复用 WebUI auth job manager，不复制 OAuth 逻辑、不上传本地 provider 凭据；真实 AGY reauth 返回 `jobId=276272cf-0bc9-48e2-be0b-9104a36ed7ca`、`targetAccountId=1`、`transientAccountId=8`、OAuth URL present、`authProgressState=awaiting_code`；取消后 `agy/8` profile/state 无残留，`agy/1` 保持 `configured=1 auth_mode=oauth`，AWS audit 回到 `profileCount=13 stateRows=13 configured=13`；同步修复 PTY reauth job 缺 `_reauthTargetId` 和 SQLite numeric boolean 状态快照问题；focused tests 154/154 pass，真实 `opencode` closure run `7afd0183-0ab5-48e3-8481-b0951e229985` 通过 WebRTC、`fallbackUsed=false`、marker/done/events=5。
- WebRTC session-start recovery 最新闭环：`2026-06-29-webrtc-session-start-recovery.md` 已收敛 `device-node-session-start` 在 promoted/default WebRTC 下偶发 `remote_webrtc_session_closed -> relay fallback` 的缺口；会话类 RPC 在 adapter 暂无 session 或 selected session 关闭时先等待短恢复窗口并重试一次 WebRTC，普通 status/read 不被延迟，relay fallback 仍保留；本地 focused 32/32、node-rpc/server 65/65、fabric session/closure 17/17、full `npm test` 2838/2838 pass；AWS current 默认 `9527` 已用正确 `.aih-host-home/.ai_home` 恢复真实账号池，`/readyz` 为 `codex=1,claude=4,agy=7,opencode=1`；真实 `opencode` closure audit run `175b38ad-f607-4bfd-800f-c3337ef911b0` 命中 marker `AIH_WEBRTC_RECOVERY_OK_20260629_1019`，session-start 与 events 均为 `selectedTransportKind=webrtc`、`fallbackUsed=false`，`closurePlan.state=usable_with_external_blockers`。
- M6 最新闭环：`2026-06-29-m6-relay-durability-cli.md` 已把默认 relay fallback 耐久 gate 产品化为 `aih fabric transport relay-durability`；本地到 AWS current 默认 `9527` 真实 6 轮 `120/120` echo，p95=`112ms`、p99=`115ms`、blockers=`[]`；提交前复测同为 `120/120` echo，p95=`109ms`、p99=`198ms`、blockers=`[]`。
- M4 headless session 历史闭环：`2026-06-29-headless-session-message-resume.md` 已把 AWS current `opencode` headless 命令语义收敛为真实 resume：completed run 的 `fabric session message` 返回 `resumed=true` 和新 runId，并在同一 `sessionRef` 命中真实 marker；server 重启后可从 persisted native-run metadata 继续 resume；busy run 的 message 返回 `headless_session_run_still_running`，stop 写入 `aborted` 事件。该轮 headless slash 当时明确返回 `headless_session_slash_unsupported`，后续已由最新 Headless slash real closure 修复为 completed-run slash HTTP `200`。
- M6 WebTransport 最新闭环：`2026-06-29-m6-webtransport-cli.md` 已把真实浏览器 WebTransport/H3 诊断产品化为 `aih fabric transport webtransport`；默认 browser channel 为 `auto`，本机 fallback 到 Chrome 对 AWS current 默认 `9527` 真实探测显示 `isSecureContext=true`、`webTransportType=function`，但 opening handshake failed，blocker=`webtransport_connect_failed`；`--fail-on-blocked` 返回 status `1` 且 report `ok=true exitOk=false`。
- M6 TURN 最新闭环：`2026-06-29-m6-turn-relay-cli.md` 已把 TURN relay-only WebRTC 诊断产品化为 `aih fabric transport turn-relay`；当前未配置受控 TURN，真实命令返回 `probe=null`、`gate.ran=false`、blocker=`turn_ice_server_not_configured`，不会在无 TURN 时伪造 relay candidate；`--fail-on-blocked` status=`1` 且 report `ok=true exitOk=false`；AWS current 远端 focused tests 15/15 pass，默认 `127.0.0.1:9527` 返回同一 blocker。
- M6 promotion 最新复核：`2026-06-29-m6-post-cli-promotion-readiness-recheck.md` 已在所有正式 CLI 产品入口闭环后复跑 AWS current 默认 `9527`；relay fallback `20/20` echo、p95=`109ms`，WebRTC DataChannel candidate + RPC adapter 仍通过，但 advanced `promotionReady=false`，剩余 blockers 仅为受控 TURN、HTTPS/H3 WebTransport、OpenMPTCPRouter/MPTCP/default listener 外部前置。
- M6 TURN 默认 UDP gate 最新闭环：`2026-06-29-m6-turn-default-udp-gate.md` 已把默认端口自托管 TURN 前置产品化进 `aih fabric transport prerequisites`；AWS current 能 bind UDP `9527`，但本机到 AWS UDP `9527` 真实 echo 超时，summary 新增 blocker=`turn:turn_default_udp_9527_unreachable`。
- M6 promotion/prerequisite TURN UDP 口径最新闭环：`2026-06-29-m6-promotion-gate-turn-udp-alignment.md` 已把同一个默认 UDP `9527` probe 接入 `aih fabric transport promotion-gate`；真实 AWS promotion gate 现在同时报告 `turn:turn_ice_server_not_configured` 和 `turn:turn_default_udp_9527_unreachable`，与 prerequisites 的 blocker 口径一致；relay fallback 仍可用且默认，高级 transport 仍不晋级。
- M6 UDP packet arrival 最新诊断：`2026-06-29-m6-udp-packet-arrival-diagnosis.md` 已把默认 UDP `9527` timeout 深化到 AWS 网卡抓包证据；AWS `tcpdump` 在 `enp39s0` 上 ready，但本机发往公网 UDP `9527` 的包为 `0 packets captured / 0 packets received by filter`，说明当前问题在云边界/公网 UDP 路径，不是 AIH Node.js 进程未收包。
- M6 UDP edge snapshot 最新诊断：`2026-06-29-m6-udp-edge-snapshot.md` 已把同一默认 UDP gate 的 AWS route/interface/private-public IP/host firewall/IMDS security group IDs 落入 report；真实 AWS 显示 `ufw=inactive`、`iptables INPUT ACCEPT`、`hostFirewallBlocksUdp=false`、`securityGroupIds=sg-01e33f3412fabfded,sg-01e7f50a205d7b308`，进一步把问题收敛到 AWS SG/NACL/provider UDP path 或外部受控 TURN。
- M6 cloud edge 最新闭环：`2026-06-29-m6-cloud-edge-preflight.md` 已新增正式入口 `aih fabric transport cloud-edge`；真实 AWS current 默认 `9527` 返回 `cloudEdgeReady=false`，blockers=`turn_default_udp_9527_unreachable,aws_public_udp_path_blocked,aws_cli_missing,aws_iam_role_missing`，并证明 IMDS `iam/security-credentials/` 为 HTTP `404`，即实例没有可用于读取 SG/NACL 的 IAM role。
- M6 transport status 最新闭环：`2026-06-29-m6-transport-status-cli.md` 新增 `aih fabric transport status`，真实 AWS current 默认 `9527` 输出 `status=usable_partial`、`remoteDevelopmentReady=true`、`defaultTransport=relay`、`fallbackReady=true`、`advancedPromotionReady=false`、`cloudEdgeReady=false`；默认不跑重型 browser promotion gate，`--with-promotion-gate` 可显式执行完整聚合 gate。
- M6 direct WebRTC promotion 最新闭环：`2026-06-29-m6-direct-webrtc-promotion.md` 已把 direct WebRTC 晋级收敛为显式 opt-in gate；真实 AWS current 默认 `9527` 的 `promotion-gate --allow-direct-webrtc-promotion --skip-webtransport --skip-multipath` 返回 `promotionReady=true`、`promotedTransports=["webrtc"]`、`defaultTransport=webrtc`、`blockers=[]`，WebRTC selected pair 为 `srflx -> srflx`，DataChannel p95=`200.9ms`，RPC p95=`200.5ms`；同参数 `transport status --with-promotion-gate` 返回 `status=complete`、`advancedPromotionReady=true`、`nextActions=[]`。本步只完成 gate/status 的高级传输晋级，不静默切换运行时 remote request selector；TURN/WebTransport/MPTCP/OMR 仍作为独立候选路径按各自前置复测。
- M6 WebRTC management RPC selector 最新闭环：`2026-06-29-m6-webrtc-rpc-adapter.md` 已把真实 WebRTC DataChannel session 接入 remote management RPC selector；AWS current 默认 `9527` 上 `node webrtc connect` 建立 open DataChannel 后，真实 `/v0/webui/nodes/aws-current-node/test` 选择 `aws-current-node-webrtc`、`fallbackUsed=false`、status `200`，audit 写入 `transportKind=webrtc`。同轮修复 readiness 语义：`fallbackReady` 现在独立表示 relay fallback 可用，不再等同“当前 selected transport 是 relay”；最终 `fabric transport readiness` 返回 `defaultTransport=webrtc`、`fallbackReady=true`、`relayMeasurementPass=true`、`promotedTransports=["webrtc"]`，`fabric transport status` 返回 `status=complete`、`remoteDevelopmentReady=true`。AWS current 远端 focused readiness/WebRTC tests 51/51 pass，本地 full `npm test` 2752/2752 pass。
- M6 WebRTC supervised service 最新闭环：`2026-06-29-m6-webrtc-supervised-service.md` 已把 WebRTC connector 纳入 `aih node service` 监督服务，AWS current 默认 `9527` 上 relay、registry agent、WebRTC connector 三个 user systemd service 均为 `state=running` 且 `supervisorReady=true`；preflight 新增 duplicate supervised process gate，真实重启 AWS server 后 `fabric transport readiness` 仍恢复为 `defaultTransport=webrtc`，`fabric transport status` 返回 `status=complete remoteDevelopmentReady=true`，`fabric-m3-daemon-preflight` 返回 `remainingGate=[] duplicateSupervisedProcesses=[]`。AWS 远端 focused tests 35/35 pass，本地 full `npm test` 2759/2759 pass。
- M6 WebRTC promotion 持久化最新闭环：`2026-06-29-m6-webrtc-promotion-persistence-recheck.md` 修复并验证 direct WebRTC promotion gate 通过后未写入 registry/readiness 的缺口；`promotion-gate --allow-direct-webrtc-promotion --skip-webtransport --skip-multipath --publish-promotion --node-id aws-current-node` 真实 AWS current 运行返回 `promotionReady=true`、`promotionPublished=true`、`defaultTransport=webrtc`，WebRTC DataChannel p95=`642.6ms`、RPC p95=`298.2ms`，并由 AWS node 自己通过 token-file 发布 24h 过期 promotion（`expiresAt=2026-06-30T02:41:57.270Z`）。多个 registry-agent heartbeat 周期后 registry 仍保留 `remoteRequestReady=true`，本机 client readiness 返回 `defaultTransport=webrtc`、`promotedTransports=["webrtc"]`、`fallbackReady=true`，真实 `/v0/webui/nodes/aws-current-node/test` 选择 `aws-current-node-webrtc` 且 `fallbackUsed=false`。AWS current 远端 focused tests 23/23 pass，本地 focused 51/51 pass，full `npm test` 2791/2791 pass。
- AWS WebUI supervisor diagnostics 最新闭环：`2026-06-29-aws-webui-supervisor-diagnostics.md` 修复 node-rpc diagnostics 在 HTTP server 进程里误判 user systemd 服务未运行的问题；server wiring 现在把 `spawnSync` 传入 node-rpc，node doctor 为 Linux `systemctl --user` 补 `XDG_RUNTIME_DIR` 和 DBUS 地址。AWS current 默认 `9527` 重启后真实 `/v0/webui/nodes/aws-current-node/test` 返回 `selectedTransportKind=webrtc`、`fallbackUsed=false`、`supervisorReady=true`、relay/registryAgent/webrtc 三项 `running=true`，本地和 AWS focused doctor/node-rpc tests 均 `76/76 pass`。
- AWS opencode live closure 最新闭环：`2026-06-29-aws-opencode-live-closure.md` 复核当前 AWS `/readyz ready=true` 且 accounts 为 `codex=1,claude=4,agy=7,opencode=1`；本地 paired profile `cp-51hq70` 授权读取 AWS registry，`aws-current-node` 为 `runtimeHost=true`、`transports=relay,webrtc`、`start-session:opencode=enabled`；真实 `fabric session start aws-current-node --provider opencode` 通过 WebRTC selector 返回 marker `AIH_AWS_OPENCODE_LIVE_OK_20260629`；completed run 的 `fabric session message` 返回 `resumed=true`、同一 `sessionRef`，并命中 marker `AIH_AWS_OPENCODE_RESUME_LIVE_OK_20260629`；最终事件读取在 WebRTC session closed 后按设计落到 relay fallback 且保留 `transportDecision`。
- AWS runtime account blocker reasons 最新闭环：`2026-06-29-aws-runtime-account-blocker-reasons.md` 已把 commit `a34122a` 用 clean `git archive HEAD` 部署到 AWS current 默认 `9527`，并在 commit `0939396` 后修正 reason 语义，重启 server pid=`386417` 和 registry-agent pid=`386503` 后真实读回 `account_reasons`。当前 `aws-current-node` 仍 `runtimeHost=true`、`ssh=yes`、`defaultTransport=webrtc`、`fallbackReady=true`，但四个 provider 账号均不可调度：Codex `runtime:auth_invalid:upstream_401=1`，Claude `runtime:auth_invalid:claude_not_logged_in=4`，AGY `runtime:auth_invalid:agy_not_signed_in=7`，OpenCode `runtime:auth_invalid:upstream_401=1`；`start-session:codex|claude|agy|opencode` 均 blocked。真实 opencode run `e10838c7-ce95-4476-a755-c6f5f966835c` 通过 WebRTC 建 session 后写入 `runtime-blocked auth_invalid/upstream_401`，已 stop 并最终 `completed=true`。结论：本段 Fabric 连接和诊断闭环完成，下一 blocker 是 AWS provider 账号重新登录/修复，不是继续改节点连通。
- Runtime account activation deploy 最新闭环：`2026-06-29-runtime-account-activation-deploy.md` 已把 commit `23b9389` 用 clean `git archive HEAD` 部署到 AWS current 默认 `9527`，artifact sha256=`e48c083710c07695c387d4938053db58f28ecc1ea041f2bfe4dcdc7387d63752`，server pid=`388546`、registry-agent pid=`388812`；远端 `node --check scripts/fabric-runtime-account-activation.js` pass，AWS focused activation tests `8/8 pass`，本地 full `npm test` `2807/2807 pass`。部署后真实 readback 仍为 `defaultTransport=webrtc`、`fallbackReady=true`、`remoteDevelopmentReady=true`，四个 provider 的 `fabric session start` guard 均 `blocked=true`、`registryAuthorizedStatus=200`、`sessionStartStatus=0`，没有创建假 run。`--apply` 现已具备导入后清 stale runtime block、reload、publish、readback 的闭环，但本轮没有执行 credential transfer/import；下一步必须在明确确认后运行 `fabric-runtime-account-activation.js --remote-dry-run --yes` 和 `--apply --yes`。
- Runtime account activation audit 最新闭环：`2026-06-29-runtime-account-activation-audit.md` 新增 `fabric-runtime-account-activation.js --remote-audit`，真实 SSH 读取 AWS current 的 `account_state.db` 和 provider profile 目录，只读、不生成本地账号包、不上传凭证、不清 runtime block；commit `3c1067a` 已用 clean source artifact 部署到 AWS current 默认 `9527`，artifact sha256=`3253afab2d703e714f5b59cccf81d10e5051507563c9e8f1a3dfeb3cf012eb3b`，server pid=`390486`，远端 `DEPLOYED_GIT_HEAD=3c1067aa5d347b7bb220e067e1193c8add1f71ab`，AWS focused activation tests `10/10 pass`。AWS readback 显示 `readyz.ready=true` 且账号计数为 Codex 1、Claude 4、AGY 7、OpenCode 1，但 runtime 真相是 `profileCount=13 stateRows=13 configured=13 runtimeBlocked=13 clearableRuntimeBlocks=13`；provider blockers 分别为 Codex `auth_invalid:upstream_401`、Claude `auth_invalid:claude_not_logged_in`、AGY `auth_invalid:agy_not_signed_in`、OpenCode `auth_invalid:upstream_401`。本地 activation tests `10/10 pass`，full `npm test` `2809/2809 pass`，post-deploy `fabric nodes aws-current-node` 仍显示 `open-project/configure-ssh` enabled、`start-session:*` blocked，`fabric transport status` 仍为 `status=complete defaultTransport=webrtc fallbackReady=true`。结论：AWS node/transport 已闭环，真实会话仍卡在 provider 凭证运行态；下一步必须在明确确认后执行 credential transfer/import，不能用 `/readyz` 账号数量冒充可调度。
- AWS Japan 已收敛为唯一 current 部署目录：`/home/ubuntu/aih-fabric-current`。
- 2026-06-28 AWS host-home repair:
  - 修复 current public `9527` server 未带 `AIH_HOST_HOME` 导致读取 `/home/ubuntu/.ai_home` 的真实问题；该问题会让本机 paired profile 401，或让新 pairing 写入错误 data root 后 registry readback 变成 `counts=0`。
  - 只重启 AWS default `9527` server，old pid `223645` -> new pid `225598`；新 server 环境为 `AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home`，registry agent 保持同一 host home。
  - 本机重新配对后授权 registry readback 恢复为 `nodes=2`、`relayNodes=2`、`projects=2`、`runtimes=4`、`transports=2`；AWS node 仍是 `projectHost + relayNode`，但 `runtimeHost=false`。
  - `scripts/fabric-m3-daemon-preflight.js` 已补 server process `AIH_HOST_HOME` 检查，并把正常 relay/registry agent 归类为 `supervisedProcesses`；真实 AWS preflight 返回 `ok=true`、`residue=[]`、`remainingGate=[]`。
  - 证据：`docs/fabric/evidence/2026-06-28-aws-host-home-repair.md`。
- 2026-06-28 当前 AWS Node Model readback：
  - 本地 shared server profile store 返回 1 个 paired AWS direct profile。
  - 未授权读 AWS `/v0/fabric/registry` 返回 HTTP 401，证明 registry 仍受 device token gate 保护。
  - 使用本地 paired profile device token 授权读取 AWS registry 返回 HTTP 200：`nodes=2`、`relayNodes=2`、`projects=2`、`runtimes=4`、`transports=2`。
  - `aws-current-node` 当前是 `node + relay-node`，有 project `/home/ubuntu/aih-fabric-current` 和 `ws_echo_pass` relay measurement。
  - AWS `/readyz` 当前 HTTP 200 但 `ready=false`，provider account counts 全为 0；当前 registry runtime records 都属于 `local-mac-remote-node`。
  - 结论：本地 WebUI 可以真实看到 AWS server profile、AWS node、AWS project 和 relay health；但不能宣称 AWS node 已可点击启动 Codex/Claude 远程开发会话。
  - 证据：`docs/fabric/evidence/2026-06-28-current-aws-node-model-readback.md`。
- 2026-06-28 AWS runtime diagnostics readback:
  - `95190ca feat(fabric): report runtime diagnostics from nodes` 新增 registry agent `--runtime-diagnostics`，节点侧真实上报 provider CLI 是否存在和同节点 `/readyz` provider account counts；不会上传 raw token，不执行 provider CLI。
  - full `npm test` 2684/2684 pass；clean `git archive HEAD=95190ca` 已部署到 AWS current 默认 `9527`，source artifact `72ca41683a78180d4be0786f8bb23c9ae69f8a43848c0b95f87bed670c9f28e3`，server pid `266437`。
  - AWS registry agent user service 已持久带上 `--runtime-diagnostics`，MainPID `266541`，仍保留 `--transport relay=online`、`--transport webrtc=online` 和 relay WS echo probe。
  - 本地 profile `cp-51hq70` 曾处于 `degraded`，先用现有 device token 真实授权请求 AWS `/v0/fabric/registry` 返回 HTTP 200 后才修复为 `paired`，并恢复 `activeProfileId=cp-51hq70`；未手工伪造 token、未重新导入凭据；不带 `--endpoint` 的 `fabric nodes` 和 `fabric transport readiness` 均已通过默认 profile 路径。
  - 授权 readback：`aws-current-node` 为 `projectHost + relayNode`，`runtimeHost=false`，`runtimeDiagnostics=4`；Codex CLI shim 存在但 AWS provider accounts 为 0，因此 `start-session:codex` blocker 为 `missing_provider_account:codex`；Claude/AGY/OpenCode CLI 均缺失，因此 blockers 为 `missing_provider_cli:claude|agy|opencode`。
  - 直接 session-start guard 已真实验证：Codex 和 Claude 均 `registryAuthorizedStatus=200`、`sessionStartStatus=0`，分别按 `missing_provider_account:codex` 和 `missing_provider_cli:claude` 阻断，没有伪造 session POST。
  - readiness 回归仍 pass：`defaultTransport=relay`、`fallbackReady=true`、`relayMeasurementPass=true`；M6 gate 回归 relay 5/5 p95=`111ms`，WebRTC DataChannel/RPC 仍通过但 promotion 仍被 TURN/WebTransport/Multipath 前置阻塞。
  - 证据：`docs/fabric/evidence/2026-06-28-aws-runtime-diagnostics-readback.md`。
- 2026-06-29 AWS runtime CLI availability:
  - AWS current 只安装 provider CLI 到项目隔离目录 `/home/ubuntu/aih-fabric-current/.runtime-tools`，不写系统全局路径、不导入 provider 凭据、不触碰旧服务器。
  - `claude=2.1.195`、`opencode=1.17.11`、`agy=1.0.13` 已可被 supervised service PATH 解析；`codex` 继续使用项目 `node_modules/.bin/codex`。
  - AWS default `9527` 的长期进程收敛为 server、registry agent、relay connect；`node service status` 返回 `ok=true`、`supervisor.ready=true`、relay/registryAgent 均 running。
  - 本地默认 paired profile `cp-51hq70` 不带 `--endpoint` 读取 AWS registry：未授权 HTTP 401，授权 HTTP 200，`nodeFound=true`，`relayState=online`，`transportKinds=relay,webrtc`。
  - `aws-current-node` 当前四个 provider 的 `cliAvailable=true`、`accountTotal=0`；runtime blocker 统一为 `missing_provider_account:codex|claude|agy|opencode`。这表示 AWS 已具备 provider CLI 二进制，但仍不是 provider runtime host，因为没有导入 provider 账号。
  - session-start guard 已真实验证四个 provider 均被本地 action gating 阻断，`registryAuthorizedStatus=200`、`sessionStartStatus=0`，没有伪造 session POST。
  - 本轮真实 readback 暴露并修复 CLI 大 JSON stdout flush 截断；本地 `fabric nodes aws-current-node --json` 输出 `14070` bytes 可解析，AWS 本机 `fabric registry agent ... --once --json` 输出 `807464` bytes 可解析。
  - focused tests 26/26 pass，full `npm test` 2684/2684 pass。
  - 证据：`docs/fabric/evidence/2026-06-29-aws-runtime-cli-availability.md`。
- 2026-06-29 AWS runtime account gap CLI output:
  - `aih fabric nodes aws-current-node` 的人类可读输出已直接展示 runtime gap 诊断：`missing_provider_account:<provider> (cli=yes account_total=0 account_source=readyz)`。
  - 真实 AWS readback 仍为默认 paired profile `cp-51hq70`、未授权 HTTP 401、授权 HTTP 200、registry `nodes=2 relay_nodes=2 projects=2 runtimes=4 transports=3`。
  - AWS `/readyz` 返回 `ok=true`、`ready=false`、`codex/gemini/claude/agy/opencode=0`，证明当前缺口是 provider 账号未导入，不是 Fabric control/relay 失败。
  - 真实 session-start guard 复测四个 provider：均 `blocked=true`、`registryAuthorizedStatus=200`、`sessionStartStatus=0`，没有伪造 session POST。
  - `fabric transport readiness --node-id aws-current-node` 仍为 `defaultTransport=relay`、`fallbackReady=true`、`promotionReady=false`；高级 transport 仍只因 TURN/WebTransport/OpenMPTCPRouter/MPTCP 外部前置阻塞。
  - commit `4fdf221` 已用 clean `git archive HEAD` 同步到 AWS current；artifact sha256=`4cdb874af7a31edc31d08e315c14bdeae7bf926251e70a86f6857e665677a4e7`，远端 `node --check` 和 `test/fabric-nodes-client.test.js` 4/4 pass，默认 `9527` `/readyz` 仍 `ok=true`、`ready=false`、账号全 0。
  - `node --check lib/cli/services/fabric/nodes-client.js` pass；`test/fabric-nodes-client.test.js` 4/4 pass；full `npm test` 2684/2684 pass。
  - 证据：`docs/fabric/evidence/2026-06-29-aws-runtime-account-gap-cli-output.md`。
- 2026-06-29 Node Inventory project action gate:
  - `open-project` action 不再返回过期 `m4_project_action_pending`；有真实 project snapshot 的 node 直接 enabled，没有 project snapshot 时只返回 `missing_project_snapshot`。
  - full `npm test` 2687/2687 pass；commit `5926b4e` 已用 clean `git archive HEAD` 同步到 AWS current，artifact sha256=`c034daaf88ae3e443c7d9c64dee4fa0ca220a38fec106ab289c906a78512a8d1`。
  - AWS default `9527` 已用 `.aih-host-home` 配置和 management key 重启，server pid=`276554`；registry-agent pid=`276850`、relay-node pid=`276855` 均 active。
  - 真实 AWS readback：`aih fabric nodes aws-current-node` 返回 `open-project: enabled`，`start-session:codex` 仍按 `missing_provider_account:codex` 阻断且 `sessionStartStatus=0`；readiness 仍 `defaultTransport=relay`、`fallbackReady=true`、`promotionReady=false`。
  - 证据：`docs/fabric/evidence/2026-06-29-node-inventory-project-action-gate.md`。
- 2026-06-29 Node local SSH binding:
  - 本地 client 读取 AWS registry 后，用本地 `app-state.db` 的 SSH connection/workspace 做脱敏 enrichment；不会把 private key、password、Bearer token 或 raw device token 写入 Fabric nodes report。
  - 真实 AWS readback：`aih fabric nodes aws-current-node` 返回 `ssh=yes`、`ssh_links=AWS Current Japan -> AIH Fabric Current`、`configure-ssh: enabled`；`start-session:*` 仍按 `missing_provider_account:*` 阻断。
  - 本地 JSON leak check 对 `privateKey|password|SECRET|aws.pem|device-token|Bearer` 无命中；focused tests 8/8 pass，expanded Fabric registry tests 17/17 pass，full `npm test` 2692/2692 pass。
  - commit `8f375dc` 已用 clean `git archive HEAD` 同步到 AWS current，artifact sha256=`0474dbd9bee8a08a17371b5effafdd3ce008008cfc996f8fe52a360bfd675e2b`，远端 focused nodes tests 8/8 pass，默认 `9527` `/readyz` 仍 `ok=true`、`ready=false`、账号全 0。
  - 证据：`docs/fabric/evidence/2026-06-29-node-local-ssh-binding.md`。
- 2026-06-29 AWS host-home runtime recheck:
  - clean source sync 后真实 prerequisite audit 暴露运行态漂移：server pid `276554` 没有 `AIH_HOST_HOME`，M6 base gate 返回 `base_ready=no`、`server_host_home_mismatch`。
  - 只重启 AWS current 默认 `9527` server，不新增端口、不导入 provider 账号；新 server pid=`279373`，`AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home`。
  - 复跑 prerequisite audit：`base_ready=yes`，AWS gate `candidate=yes promotion=yes`，registry `nodes=2 relayNodes=2 projects=2 runtimes=4 transports=3 nodeInventory=2`，`aws.blockers=[]`。
  - 复跑 promotion gate：默认仍为 `relay`，advanced promotion 仍只阻塞于 TURN/WebTransport/MPTCP/OMR 外部前置。
  - 证据：`docs/fabric/evidence/2026-06-29-aws-host-home-runtime-recheck.md`。
- 2026-06-29 M6 current gate readiness recheck:
  - 真实 `fabric transport readiness --node-id aws-current-node` 使用默认 paired profile `cp-51hq70`，未授权 HTTP 401、授权 HTTP 200；`defaultTransport=relay`、`fallbackReady=true`、`relayMeasurementPass=true`、`promotionReady=false`，CLI 标题已从 `client smoke` 收敛为正式 `AIH Fabric transport readiness`。
  - 真实 prerequisite audit 返回 `baseReady=true`、`promotionReady=false`、`readyTransports=[]`；AWS base gate `promotionReady=true`，server process count `1`，supervisor ready，registry `nodes=2 relayNodes=2 projects=2 runtimes=4 transports=3 nodeInventory=2`。
  - 真实 promotion gate 返回 relay `10/10`、p95=`425ms`；WebRTC DataChannel candidate ready，RTT p95=`206.1ms`，DataChannel RPC `ok=true`、responses=`3`、handled=`3`、RPC p95=`338.8ms`，selected pair 为 `srflx -> srflx`。
  - promotion 仍被真实外部前置阻塞：TURN 未配置受控 `iceServers`；WebTransport 连接 `https://ec2-...:9527/v0/fabric/webtransport/echo` 失败；multipath 阻塞于本机 macOS 无 MPTCP、未检测到 OpenMPTCPRouter、default `9527` 仍是 plain AIH HTTP listener。
  - M6 external prerequisite audit 已产品化为 `aih fabric transport prerequisites`；真实 AWS current 运行返回 `base_ready=yes`、`promotion_ready=no`、`ready_transports=none`，`--fail-on-blocked --json` 已验证退出码为 1 且 report 保持 `ok=true`、`exitOk=false`。
  - `node --check lib/cli/services/fabric/transport-readiness-client.js` pass；`node --check scripts/fabric-real-transport-readiness-client-smoke.js` pass；`test/fabric-real-transport-readiness-client-smoke.test.js` 5/5 pass。
  - commit `6dc6a5b` 已用 clean `git archive HEAD` 同步到 AWS current；artifact sha256=`1b5f551152fabdf5ebf7f3200f25e1d892df9c07694fd3c309bb48263a2087d9`，AWS focused `transport-prerequisites` test 3/3 pass，默认 `9527` `/readyz` 仍 `ok=true`、`ready=false`、账号全 0；本地客户端到 AWS 的真实 `transport prerequisites` 仍返回 `base_ready=yes`、`promotion_ready=no`。
  - 证据：`docs/fabric/evidence/2026-06-29-m6-current-gate-readiness-recheck.md`。
- 2026-06-29 M6 promotion gate CLI:
  - 新增正式产品入口 `aih fabric transport promotion-gate`，复用同一个 aggregate M6 gate，不复制探测逻辑。
  - 本地真实 AWS current 运行：relay `5/5`、p95=`105ms`；WebRTC candidate ready，DataChannel RTT p95=`211ms`，RPC responses=`2/2`、handled=`2`、RPC p95=`211.1ms`；default transport 仍为 `relay`，promotion 仍为 `false`。
  - `--fail-on-blocked --json` 返回 process status `1`，report 保持 `ok=true`、`exitOk=false`，blockers 为 `turn_relay_gate_not_ready`、`turn_ice_server_not_configured`、`webtransport_connect_failed`、`local_mptcp_unavailable`、`openmptcprouter_not_detected`、`default_listener_is_plain_http_not_multipath_transport`。
  - full `npm test` 2690/2690 pass；commit `e467a1c` 已用 clean `git archive HEAD` 同步到 AWS current，artifact sha256=`e5affb7290d4418b9da4660a675ce4e5c3e2c8e8b4cc4fa04cb603b81c214862`，AWS focused tests 14/14 pass，默认 `9527` `/readyz` 仍 `ok=true`。
  - 证据：`docs/fabric/evidence/2026-06-29-m6-promotion-gate-cli.md`。
- 2026-06-29 M6 relay durability CLI:
  - 新增正式产品入口 `aih fabric transport relay-durability`，复用现有 relay durability gate，不复制 echo/统计逻辑。
  - 本地真实 AWS current 默认 `9527` 运行 6 轮、`120/120` echo、successRate=`1`、p95=`112ms`、p99=`115ms`、blockers=`[]`；提交前复测同为 `120/120` echo、p95=`109ms`、p99=`198ms`、blockers=`[]`。
  - full `npm test` 2701/2701 pass；AWS current 远端 focused tests 10/10 pass，远端本机默认 `9527` durability 2 轮 10/10、p95=`3ms`。
  - 证据：`docs/fabric/evidence/2026-06-29-m6-relay-durability-cli.md`。
- 2026-06-29 M6 WebTransport CLI:
  - 新增正式产品入口 `aih fabric transport webtransport`，复用真实浏览器 `scripts/fabric-real-webtransport-smoke.js`，默认探测 HTTPS/H3 WebTransport URL。
  - 默认 browser channel 为 `auto`，本机 fallback 到 Chrome 对 AWS current 默认 `9527` 真实运行：`isSecureContext=true`、`webTransportType=function`，但 `WebTransportError: Opening handshake failed.`，summary `candidateReady=false promotionReady=false blockers=[webtransport_connect_failed]`。
  - 默认诊断命令返回 status `0` 且 `exitOk=true`；`--fail-on-blocked --json` 返回 status `1` 且 report `ok=true exitOk=false`。
  - focused tests 11/11 pass；full `npm test` 2708/2708 pass；AWS current 已同步 artifact `6fe09e6502839767960f998327f81eaf25c13adb163dc38e4dbf54da1693ecc9`，远端 focused tests 11/11 pass，默认 auto 使用 bundled Chromium 对 `127.0.0.1:9527` 真实返回同一 `webtransport_connect_failed` blocker，`--fail-on-blocked` status=`1`。
  - 证据：`docs/fabric/evidence/2026-06-29-m6-webtransport-cli.md`。
- 2026-06-29 M6 TURN relay CLI:
  - 新增正式产品入口 `aih fabric transport turn-relay`，复用真实浏览器 `scripts/fabric-real-webrtc-datachannel-smoke.js`；没有完整 TURN URL/用户名/凭据时不启动 WebRTC smoke，不伪造 relay candidate。
  - 当前本机对 AWS current 默认 `9527` 真实运行：`probe=null`、`gate.ran=false`、`candidateReady=false`、`promotionReady=false`、blocker=`turn_ice_server_not_configured`。
  - 默认诊断命令返回 status `0` 且 `exitOk=true`；`--fail-on-blocked --json` 返回 status `1` 且 report `ok=true exitOk=false`。
  - focused tests 15/15 pass；full `npm test` 2715/2715 pass；AWS current 已同步 artifact `201ac6f0dde5f86ff84cedc580bad9efb787174952d8d6844ac29bbbee3befa0`，远端 focused tests 15/15 pass，默认 `127.0.0.1:9527` 真实返回同一 `turn_ice_server_not_configured` blocker，`--fail-on-blocked` status=`1`。
  - 证据：`docs/fabric/evidence/2026-06-29-m6-turn-relay-cli.md`。
- 2026-06-29 M6 post-CLI promotion readiness recheck:
  - 所有正式 transport CLI 入口闭环后复跑 AWS current 默认 `9527` 的 `prerequisites`、`promotion-gate`、`turn-relay`、`webtransport`。
  - `prerequisites` 返回 `baseReady=true`、`promotionReady=false`、`readyTransports=[]`，AWS server pid=`279373`，`AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home`，registry counts=`nodes=2 relayNodes=2 projects=2 runtimes=4 transports=3 nodeInventory=2`。
  - `promotion-gate` 返回 default transport 仍为 `relay`，fallback `20/20` echo、p95=`109ms`；WebRTC DataChannel candidate ready，RTT p95=`353.3ms`，RPC `responses=3/handled=3`、p95=`198.8ms`。
  - advanced promotion 仍只阻塞于 `turn_ice_server_not_configured`、`webtransport_connect_failed`、`local_mptcp_unavailable`、`openmptcprouter_not_detected`、`default_listener_is_plain_http_not_multipath_transport`；`transportConfig.present=false`。
  - 证据：`docs/fabric/evidence/2026-06-29-m6-post-cli-promotion-readiness-recheck.md`。
- 2026-06-29 M6 TURN default UDP gate:
  - `aih fabric transport prerequisites` 现在会在未跳过时通过 AWS SSH 临时启动 UDP `9527` echo，并从本机真实探测同一默认端口；该 probe 不新增产品端口，不安装 TURN/QUIC 软件，不触碰旧服务器。
  - 本机到 AWS current 真实运行：AWS base preflight pass，remote UDP echo `ready=true port=9527`，local probe `ok=false error=udp_echo_timeout sent=13 durationMs=5004`。
  - 完整 `prerequisites` summary 新增 `turn:turn_default_udp_9527_unreachable`，并保持 `baseReady=true`、`promotionReady=false`、`readyTransports=[]`。
  - `--fail-on-blocked --skip-webtransport --skip-multipath --json` 返回 status `1` 且 report `ok=true exitOk=false`。
  - focused tests 12/12 pass；full `npm test` 2717/2717 pass；AWS current 已同步 artifact `ea32c59113222ebdf99ce41d7a604658b91fd4ff09ae5b259263e0a7bb78bf69`，远端 focused tests 12/12 pass。
  - 证据：`docs/fabric/evidence/2026-06-29-m6-turn-default-udp-gate.md`。
- 2026-06-29 M6 promotion gate TURN UDP alignment:
  - `aih fabric transport promotion-gate` 现在复用同一个默认 UDP `9527` probe；`target` 输出包含 AWS current `remoteDir=/home/ubuntu/aih-fabric-current` 和 `port=9527`，方便证据追踪。
  - 本机到 AWS current 真实运行：relay fallback `20/20` echo p95=`104ms`；WebRTC DataChannel `candidateReady=true`、RTT p95=`218.7ms`、RPC `responses=3/handled=3`、RPC p95=`221ms`。
  - TURN gate 现在与 prerequisites 一致：remote UDP echo `ready=true port=9527`，local probe `ok=false error=udp_echo_timeout sent=13 durationMs=5001`，summary 同时包含 `turn:turn_ice_server_not_configured` 和 `turn:turn_default_udp_9527_unreachable`。
  - `--fail-on-blocked --json` 返回 status `1` 且 report `ok=true exitOk=false`；advanced blockers 仍为 TURN、WebTransport、MPTCP/OMR/default listener，默认仍为 relay。
  - focused tests 28/28 pass；full `npm test` 2719/2719 pass；AWS current 已同步 artifact `8c779807e3678904f0b9559287cae28e75b31228673aa01c349f9b9c402cbb7e`，远端 focused tests 28/28 pass。
  - 证据：`docs/fabric/evidence/2026-06-29-m6-promotion-gate-turn-udp-alignment.md`。
- 2026-06-29 M6 UDP packet arrival diagnosis:
  - 手工强证据：AWS `enp39s0` 上运行 `tcpdump -w /tmp/aih-udp9527.pcap "udp and port 9527"`，本机向 AWS public IPv4 `43.207.102.163:9527/udp` 发送 20 个 datagram，结果为 `0 packets captured`、`0 packets received by filter`、`0 packets dropped by kernel`。
  - 共享 default UDP probe 已产品化 packet capture：`prerequisites` 和 `promotion-gate` 报告 `remote.packetCapture.ready=true available=true captured=false interface=enp39s0 status=124 packets=[]`，stderr 包含 `0 packets captured` 和 `0 packets received by filter`。
  - 真实 AWS `prerequisites --skip-webtransport --skip-multipath --json` 仍为 `baseReady=true`、`promotionReady=false`，blockers=`turn:turn_ice_server_not_configured,turn:turn_default_udp_9527_unreachable`。
  - 真实 AWS `promotion-gate --skip-webtransport --skip-multipath --skip-webrtc --json` 仍为 relay fallback `20/20`、p95=`105ms`、`defaultTransport=relay`，并带同一 packet capture 证据。
  - focused tests 30/30 pass；full `npm test` 2721/2721 pass；AWS current 已同步 artifact `81ba89030e92d41d298ec7d92717b30a7b7eb3ba29d35890b33c2f0899146eb0`，远端 focused tests 30/30 pass。
  - 证据：`docs/fabric/evidence/2026-06-29-m6-udp-packet-arrival-diagnosis.md`。
- 2026-06-29 M6 UDP edge snapshot:
  - 共享 default UDP probe 现在同时采集 AWS edge snapshot：route/interface/source address、`ip -br addr`、`ufw`、`iptables`、`nft` 摘要，以及 IMDS instance/public IP/security group IDs。
  - 顺序真实 AWS `prerequisites --skip-webtransport --skip-multipath --json` 返回 AWS base ready、remote UDP echo `ready=true`、local UDP echo `udp_echo_timeout`、packet capture `captured=false`，edge snapshot 为 `interface=enp39s0`、`privateAddress=172.31.47.163`、`publicIpv4=43.207.102.163`、`hostFirewallBlocksUdp=false`、security groups `launch-wizard-1,default`。
  - 顺序真实 AWS `promotion-gate --skip-webtransport --skip-multipath --skip-webrtc --json` 返回 relay fallback `20/20`、p95=`108ms`、`defaultTransport=relay`，并带同一 edge snapshot。
  - focused tests 33/33 pass；full `npm test` 2724/2724 pass；AWS current 已同步 artifact `1f2042e976672cb551c60d9aadff6ad27b76272af2d1536fbdcd6e03c2761511`，远端 focused tests 33/33 pass。
  - 证据：`docs/fabric/evidence/2026-06-29-m6-udp-edge-snapshot.md`。
- 2026-06-29 M6 cloud edge preflight:
  - 新增正式产品入口 `aih fabric transport cloud-edge`，复用默认 UDP `9527` probe 并增加 AWS API credential readiness 检查；该命令只读，不修改 SG/NACL/firewall，不新增端口，不安装 TURN/QUIC。
  - 真实 AWS current 默认 `9527` 返回 remote UDP echo `ready=true`，local UDP echo `udp_echo_timeout`，packet capture `captured=false interface=enp39s0`，edge summary 仍为 `hostFirewallBlocksUdp=false`。
  - 同一报告显示 AWS 侧 `awsCli.available=false`，IMDS token 可用但 `iam/security-credentials/` HTTP `404`，所以 `awsApiCredentialsReady=false`；summary blockers 为 `turn_default_udp_9527_unreachable`、`aws_public_udp_path_blocked`、`aws_cli_missing`、`aws_iam_role_missing`。
  - `--fail-on-blocked --json` 真实返回 process status `1` 且 report `ok=true exitOk=false`；本地 focused tests 18/18 pass；full `npm test` 2731/2731 pass；AWS current 已同步 artifact `c5b216d5445160e611c28f3a344ab3cac0a10fa805fd047de91c6d9b7a581f4e`，远端 focused tests 18/18 pass。
  - 证据：`docs/fabric/evidence/2026-06-29-m6-cloud-edge-preflight.md`。
- 2026-06-28 M4 8.7 Mobile/PWA session smoke:
  - 真实 Chromium mobile viewport `390x844` 通过 AWS current 默认 `9527` 创建 device pair 和 node invite，relay node 在线。
  - 真实 Codex runtime 位于本机 node，AWS 仍是 control plane/broker/relay-capable node；AWS `/readyz` 为 `ready=false` 且 provider accounts 全为 0，所以 AWS 缺的是 provider runtime/account，不是控制面能力。
  - `device-node-session-start`、`device-node-session-attach`、`device-node-session-command` message、slash `/status`、stop 均返回 HTTP 200。
  - cursor reconnect 从 `260` resume 到 `440`，duplicateEvents=`0`，message marker 命中。
  - artifacts `refs=20`、`fetched=20`、`bytes=10566`，browser console errors=`0`。
  - 真实 Codex run 没有发出 `approval_request`，所以 mobile smoke 不伪造 approval response，记录为 `skipped=true, reason=no_approval_request`。
  - 事后本机无 mobile smoke、relay client、`m4-8-7-mobile-node`、本地 attach diagnostic 残留；AWS 只剩默认 `9527` server pid `194865`。
  - 本地 focused tests 100/100 pass。
  - 证据：`docs/fabric/evidence/2026-06-28-m4-mobile-pwa-session-smoke.md`。
- 2026-06-28 M5 Session Recovery smoke:
  - AWS current 只作为默认 `9527` broker/control/relay-capable endpoint；真实 Codex runtime 位于本机 `127.0.0.1:9527`，没有新增产品端口。
  - 真实 broker interruption：中断后 broker proxy 返回 HTTP 503 `fabric_broker_server_offline`，同 `serverId` 重连后 proxy `readyz` HTTP 200。
  - broker 恢复后 attach/message/ack/stop 均为 HTTP 200，cursor 从 `235` resume 到 `516`，duplicateEvents=`0`。
  - 真实 relay interruption：relay offline 后 node status 为 `offline`，offline attach 返回 HTTP 503 `remote_transport_unavailable`。
  - relay 恢复后 attach/message/ack/stop 均为 HTTP 200，cursor 从 `209` resume 到 `398`，duplicateEvents=`0`。
  - JSON diagnostics export 已覆盖 broker 和 relay 两条路径；事后本机和 AWS 均无 M5 smoke/broker/temp relay 残留，只剩既有长期 relay `local-mac-remote-node` / `aws-current-node`。
  - 本地 focused tests 82/82 pass。
  - 证据：`docs/fabric/evidence/2026-06-28-m5-session-recovery-smoke.md`。
- 2026-06-28 WebRTC DataChannel AWS smoke:
  - 新增 `scripts/fabric-real-webrtc-datachannel-smoke.js`，通过真实 Chromium/Chrome 两个 page peer、AWS current 默认 `9527` signaling room 和 STUN 采集 transport evidence。
  - 真实 headed Chrome smoke 返回 `ok=true`，room `rtc_ersFsxFB9XRkpmZi`，signaling messages 为 offer/ready/answer/candidates 共 9 条。
  - Offerer/answerer 均为 `connectionState=connected`、`iceConnectionState=connected`、DataChannel opened。
  - 两端 candidate 均为 `host=2`、`srflx=1`，selected candidate pair 为 `srflx -> srflx`。
  - 应用层 ping/pong RTT samples=5，avg=`463.8ms`、p50=`400.8ms`、p95=`646.3ms`。
  - Browser console `0` errors / `0` warnings，pageErrors empty。
  - 本地 focused tests 17/17 pass。
  - 结论：WebRTC DataChannel 不再只是 signaling partial，已成为 explicit transport candidate；但还不能设为默认 transport。
  - 证据：`docs/fabric/evidence/2026-06-28-webrtc-datachannel-aws-smoke.md`。
- 2026-06-28 M6 WebRTC cross-machine smoke:
  - 扩展 `scripts/fabric-real-webrtc-datachannel-smoke.js` 支持 `--create-room-only` 和 `--peer-role offerer|answerer --room-id ...`，原双 page peer smoke 默认行为不变。
  - 第一次真实跨机尝试失败在 AWS browser runtime：Chromium 缺 `libatk-1.0.so.0`；AWS 使用 Playwright `1.61.1` 安装 Chromium，并通过 `install-deps chromium` 补齐 73 个系统依赖，下载 `50.8 MB`、新增约 `160 MB` 磁盘占用。
  - 复测使用同一 AWS current 默认 `9527` signaling room `rtc_zdGfUBArAYBmN0b0`，本机 macOS Chrome 为 offerer，AWS Ubuntu bundled Chromium headless 为 answerer。
  - Offerer/answerer 均返回 `ok=true`、DataChannel opened、`connectionState=connected`、`iceConnectionState=connected`。
  - 本机候选 `host=2,srflx=1`；AWS 候选 `host=1,srflx=1`；两端 selected candidate pair 均为 `srflx -> srflx`。
  - 应用层 ping/pong RTT samples=5，avg=`129.06ms`、p50=`103.6ms`、p95=`232.1ms`。
  - Browser console `0` errors / `0` warnings，pageErrors empty。
  - 本地 focused tests 8/8 pass。
  - 结论：M6 11.2 第二真实机器参与同一 AWS signaling room 已完成；但 TURN relay 和 WebTransport/QUIC 未完成前仍不能设 WebRTC 为默认 transport。
  - 证据：`docs/fabric/evidence/2026-06-28-m6-webrtc-cross-machine-smoke.md`。
- 2026-06-28 M6 TURN relay diagnosis:
  - 扩展 `scripts/fabric-real-webrtc-datachannel-smoke.js` 支持 TURN `--ice-username` / `--ice-credential`、`--ice-transport-policy relay` 和浏览器 `icecandidateerror` 采集；报告中凭据被 redacted。
  - AWS 可以临时 bind UDP `9527`，但本机 -> AWS UDP `9527` echo 超时；在当前“不新增产品端口”的约束下，AWS 自建受控 TURN 不能成立，因为 TCP `9527` 已由 AIH server 使用，UDP `9527` 也不可达，TURN relay 还通常需要可达 relay port range。
  - public TURN domain `openrelay.metered.ca` 在本机解析为 `198.18.0.4`，不是公网 TURN；AWS 解析为 `15.235.47.158` / IPv6。
  - public TURN relay-only 域名测试和直连 `15.235.47.158` 测试都没有产生任何 candidate；两端 DataChannel 未打开，浏览器 ICE error 为 701，包含 `TURN allocate request timed out` 和 TCP `Failed to establish connection`。
  - 本地 focused tests 8/8 pass。
  - 结论：11.3 诊断完成，但没有 relay candidate pass；WebRTC 不能 promotion，仍保留 WSS/broker relay fallback。
  - 证据：`docs/fabric/evidence/2026-06-28-m6-turn-relay-diagnosis.md`。
- 2026-06-28 M6 WebTransport/QUIC diagnosis:
  - 新增 `scripts/fabric-real-webtransport-smoke.js`，使用真实 Chromium browser 探测 `isSecureContext`、`WebTransport` API、connect time、stream RTT 和 failure reason；不启动临时 QUIC server，不把 HTTP/WSS 成功冒充 WebTransport 成功。
  - Local/AWS Node `v22.16.0` 均无内建 `globalThis.WebTransport` / QUIC server；AWS current 只监听 TCP `9527` 的 AIH HTTP server，没有 HTTPS/H3/QUIC listener。
  - 产品 HTTP 页面 `http://...:9527/ui/` 下 `isSecureContext=false`、`webTransportType=undefined`、failureReason=`insecure_context`。
  - 使用 `https://example.com` secure context 尝试连接 `https://ec2-...:9527/v0/fabric/webtransport/echo` 时，浏览器 `WebTransport` API 存在，但返回 `WebTransportError: Opening handshake failed`。
  - HTTP `/readyz` 返回 200；HTTPS `/readyz` 无 TLS response。
  - 本地 focused tests 12/12 pass。
  - 结论：11.4 诊断完成，但当前 AWS default `9527` 不是 WebTransport/QUIC endpoint；WebTransport 不能 promotion，仍保留 WSS/broker relay fallback。
  - 证据：`docs/fabric/evidence/2026-06-28-m6-webtransport-quic-diagnosis.md`。
- 2026-06-28 M6 Transport fallback decision smoke:
  - 新增 candidate-only transport catalog：`webrtc` / `webtransport` 可被记录为候选，但不会进入 remote request transport。
  - `selectTransportDecision()` 用真实 AWS registry readback 构造决策：`local-mac-remote-node-relay` 被选中，WebRTC candidate 被拒绝为 `webrtc_not_promoted`，`fallbackUsed=true`。
  - 真实 WebRTC failure smoke 使用 AWS current 默认 `9527` signaling、headed Chrome、不可用 STUN：offerer/answerer 都只有 `host=2` candidate，DataChannel 未打开，RTT samples=`0`，connection failed。
  - 真实 fallback session 走 AWS broker proxy -> 本机 server -> relay -> Codex runtime，`viaProxy=true`、relay online、`device-node-session-start` HTTP 200、marker `AIH_M6_FALLBACK_RELAY_OK_628A` 命中，`/quit` cleanup completed。
  - 事后停止临时 broker link；本机/AWS 均无 `m6-fallback`、WebRTC smoke 或 broker connect 残留；本轮临时 remote-node 配置和 secret 已清理，audit jsonl 保留。
  - 本地 focused tests 51/51 pass；`npm test` 2604/2604 pass。
  - 证据：`docs/fabric/evidence/2026-06-28-m6-transport-fallback-decision-smoke.md`。
- 2026-06-28 M6 WebRTC diagnostics surface:
  - WebUI route 从 `/ui/fabric/webrtc-lab` 收敛为 `/ui/fabric/webrtc-diagnostics`；组件改为 `FabricWebrtcDiagnostics`；Server Setup 不再展示 WebRTC Lab 入口；smoke 默认 page path 同步到 diagnostics route。
  - 本地当前产品代码、脚本和测试已搜不到 `webrtc-lab`、`WebrtcLab`、`WebRTC DataChannel Lab`、`WebRTC DataChannel 实验`、`AIH Fabric WebRTC Lab`、`webrtc_lab`、`fabric-webrtc-lab`、`LabRole`、`aih-fabric-lab`。
  - 本地 focused tests 11/11 pass；本地 Web build pass。
  - 使用 `git archive HEAD` 部署到 AWS current 默认 `9527`，避免 dirty worktree 夹带 unrelated 改动；远端源码 sha256 `7826575c0652f0c7bad4cbc0af8132f000e222772fdc4718f711c19a49b035e8`。
  - AWS Web build pass，dist 产物包含 `p__FabricWebrtcDiagnostics.ba0a9fb1.async.js`；AWS server 同端口重启为 pid `220838`，`/readyz` HTTP 200。
  - 真实浏览器打开 AWS `/ui/fabric/webrtc-diagnostics` 显示 `WebRTC DataChannel 诊断`，未出现旧 Lab 文案。
  - 部署后真实 DataChannel smoke：room `rtc_UBC5Ba6xal_zDHVo`，DataChannel open，5 次 RTT，avg=`602.04ms`、p50=`599.6ms`、p95=`848.1ms`，selected pair `srflx -> srflx`。
  - 结论：diagnostics surface productization 完成；WebRTC 仍是 candidate，未晋级默认 transport。
  - 证据：`docs/fabric/evidence/2026-06-28-m6-webrtc-diagnostics-surface.md`。
- 2026-06-28 M6 Transport decision diagnostics:
  - `remote-gateway` 现在返回并审计 `transportDecision`，包含 `transportPurpose`、`selectedTransportId`、`selectedTransportKind`、`fallbackUsed`、`fallbackFrom`、`rejectedTransports`。
  - relay handler 抛出 `remote_relay_session_unavailable` 时，HTTP error details 和 remote audit 仍保留同一个 decision，不再丢失 WebRTC/WebTransport candidate rejection reason。
  - 本地 focused tests：`remote-node-registry + web-ui-router.remote-nodes` 45/45 pass，`remote-relay-server + node-relay-client` 27/27 pass；全量 `npm test` 2613/2613 pass。
  - 使用 `git archive HEAD` 部署 `53b378f` 到 AWS current 默认 `9527`，archive sha256 `c7ac0694abe0257e4cc5af95e37aa192916f6b9bcdd35c3208c3d78feae7f063`。
  - AWS 真实 `/v0/webui/nodes/m6-decision-audit-node/test` 返回 `remote_relay_session_unavailable`，同时返回 `transportDecision.fallbackUsed=true`、`fallbackFrom=["webrtc"]`、`reason=webrtc_not_promoted`。
  - AWS 真实 `/home/ubuntu/.ai_home/remote-audit.jsonl` 写入同样的 fallback/rejectedTransports；临时 node/transport 已清理，最终 `/v0/webui/nodes` 只剩既有 `m4-8-5-artifact-node`，server 只保留默认 `9527` pid `223645`。
  - 结论：transport promotion 仍未完成，但 candidate rejection/fallback decision 已成为运行时可追溯数据。
  - 证据：`docs/fabric/evidence/2026-06-28-m6-transport-decision-diagnostics.md`。
- 2026-06-28 M6 Multipath/MPTCP/OpenMPTCPRouter diagnosis:
  - 新增 `scripts/fabric-multipath-diagnosis.js`，只读检查本机/AWS MPTCP capability、OpenMPTCPRouter marker、default `9527` TCP/readyz/listener ownership。
  - 真实诊断：本机 Darwin/arm64 `python_has_IPPROTO_MPTCP=false`；AWS Linux/x86_64 `proc_net_mptcp_enabled=1`、`python_has_IPPROTO_MPTCP=true`。
  - AWS default `9527` TCP connect 真实通过，`/readyz` 为 `aih-server`，remote listener 为 `node pid=225598`。
  - blockers=`local_mptcp_unavailable`、`openmptcprouter_not_detected`、`default_listener_is_plain_http_not_multipath_transport`，verdict=`diagnostic_pass_promotion_blocked`。
  - 结论：Multipath/MPTCP/OpenMPTCPRouter 只能作为 underlay candidate 保留；当前拓扑不能 promotion。
  - 证据：`docs/fabric/evidence/2026-06-28-m6-multipath-mptcp-diagnosis.md`。
- 2026-06-28 M6 Transport promotion gate:
  - 新增 `scripts/fabric-m6-promotion-gate.js`，聚合 WebRTC DataChannel、TURN relay、WebTransport/QUIC 和 Multipath/MPTCP/OpenMPTCPRouter 的真实 gate。
  - 真实 AWS current 默认 `9527` 运行结果：`promotionReady=false`、`promotedTransports=[]`、`defaultTransport=relay`、`fallbackRequired=true`、`fallbackReady=true`。
  - Relay fallback baseline 已纳入同一 gate：AWS default `9527` WebSocket echo 20/20 成功，payload `64B`，post-deploy RTT p95=`114ms`；如果 relay baseline 不通过，gate 不再假定 `defaultTransport=relay`。
  - WebRTC DataChannel 当前 `candidateReady=true`，最新真实 AWS gate 5 次 RTT p95=`538.8ms`，selected pair 为 `srflx -> srflx`；DataChannel RPC adapter echo 已通过，responses=`5`、requestsHandled=`5`、RPC p95=`715.3ms`；当前只剩 `turn_relay_gate_not_ready` 阻塞 WebRTC promotion。
  - TURN relay 当前未配置受控 `iceServers`/凭据，输出 `turn_ice_server_not_configured`；本轮不使用公共 TURN 冒充受控 TURN。
  - WebTransport secure-context 尝试 `https://ec2-...:9527/v0/fabric/webtransport/echo`，结果 `webtransport_connect_failed`。
  - Multipath 当前 AWS Linux 侧 MPTCP ready，但本机 `local_mptcp_unavailable`、未检测到 OpenMPTCPRouter，且默认 `9527` listener 仍是 Node HTTP server pid `237041`。
  - focused tests 26/26 pass。
  - 本轮 M6 relay fallback 变更已用干净 git archive 源码部署到 AWS current 默认 `9527`：Web build pass，source artifact `f6f60bdd4cd38020962977d9512788b0cb215674a7979e3d4900247ff295c090`，新 server pid `242090`；部署后 preflight `ok=true`、`processCount=1`、`supervisorReady=true`、registry readback `nodes=2 relayNodes=2 projects=2 runtimes=4 transports=2 nodeInventory=2`、`residue=[]`、`remainingGate=[]`。
  - 部署后重新运行聚合 gate：`promotionReady=false`、`defaultTransport=relay`、`fallbackReady=true`；relay echo 20/20 p95=`114ms`，WebRTC 仍为 candidate p95=`229.3ms`，TURN 未配置受控凭据，WebTransport 仍非 HTTPS/H3 endpoint，Multipath 仍阻塞于本机 MPTCP/OpenMPTCPRouter/default listener。
  - 2026-06-28 M6 WebRTC RPC adapter gate：clean HEAD 已部署到 AWS current 默认 `9527`，Web build pass，source artifact `74a4a65621cec054ed5afdd6799dfaade6d6d020c9a733159cdb5e5dd99fb237`，新 server pid `243661`；部署后 preflight `ok=true`、`processCount=1`、`supervisorReady=true`、`residue=[]`、`remainingGate=[]`；部署后聚合 gate：relay echo 20/20 p95=`106ms`，WebRTC DataChannel p95=`632.3ms`，RPC adapter `datachannel-json-rpc-echo` p95=`725.3ms` 且 `ok=true`；summary blockers 不再包含 `remote_rpc_webrtc_adapter_not_*`。
  - full `npm test` 2640/2640 pass。
  - 证据：`docs/fabric/evidence/2026-06-28-m6-transport-promotion-gate.md`。
- 2026-06-28 M6 Transport readiness client smoke:
  - 新增正式 CLI `aih fabric transport readiness` 和 smoke 脚本 `scripts/fabric-real-transport-readiness-client-smoke.js`；两者共用 `lib/cli/services/fabric/transport-readiness-client.js`，从本地 shared server profile store 读取 paired AWS profile，直接用本地 device token 访问 AWS current 默认 `9527` readiness；不再通过 SSH 读取 AWS token。
  - clean HEAD 已部署到 AWS current 默认 `9527`，source artifact `1efb9ce7c57fd2025bd87d895f9ed5defacabbfec5dec32ebe50dc7381735298`，server pid `255015`，provider accounts 仍为 0；部署后 preflight `ok=true`、`processCount=1`、`supervisorReady=true`、registry readback `nodes=2 relayNodes=2 projects=2 runtimes=4 transports=2 nodeInventory=2`、`residue=[]`、`remainingGate=[]`。
  - 部署后真实 client 结果：profile `cp-51hq70`，未授权 HTTP `401`，授权 HTTP `200`，`aws-current-node` 返回 `defaultTransport=relay`、`fallbackReady=true`、`relayMeasurementPass=true`、relay RTT `p95=1ms/max=1ms/count=20`。
  - 当前 advanced `promotionReady=false`，当时 blockers 仍包含未注册/未晋级 WebRTC、未配置 HTTPS/H3 WebTransport、未检测到 OpenMPTCPRouter/MPTCP data plane；这不是 client 连接失败。后续 `2026-06-28-m6-webrtc-candidate-registry-readiness.md` 已把 AWS current 的 WebRTC candidate 注册进 registry/readiness，当前 WebRTC blocker 收敛为 `webrtc_not_promoted` + `turn_relay_gate_not_ready`。
  - focused test `test/fabric-real-transport-readiness-client-smoke.test.js` 等 readiness/broker 相关测试 15/15 pass；`node bin/ai-home.js fabric transport readiness --json` 真实 AWS client CLI pass。
  - full `npm test` 2661/2661 pass。
  - 证据：`docs/fabric/evidence/2026-06-28-m6-transport-readiness-client-smoke.md`。
- 2026-06-28 Fabric nodes capability CLI:
  - 新增正式 CLI `aih fabric nodes [node-id]`，通过本地 paired server profile/device token 读取 AWS `/v0/fabric/registry`，先验证未授权 HTTP `401`，再授权读取 HTTP `200`；输出 node 的 server/relay/project/runtime/SSH capabilities、runtime gaps 和 action blockers。
  - `transport-readiness-client` 和 `nodes-client` 共用 `lib/cli/services/fabric/server-profile-client.js`，避免重复读取 profile/token/fetch 逻辑；输出只包含 `deviceTokenPresent=true`，不打印 raw token。
  - Node Inventory action gate 已去掉过期的 `m4_remote_session_action_pending`：`local-mac-remote-node` 的 `start-session:codex|claude|agy|opencode` 已 `enabled=true`；`aws-current-node` 的 start-session 只因 `missing_provider_runtime:*` 阻塞。
  - clean code commit `79d59c6` 已部署到 AWS current 默认 `9527`，source artifact `a5dd0902f555934a0906ef2018342d1dceb3cf7934427909c055c192121f67e4`，server pid `256368`，provider accounts 仍为 0。
  - 部署后 preflight `ok=true`、`processCount=1`、`supervisorReady=true`、registry readback `nodes=2 relayNodes=2 projects=2 runtimes=4 transports=2 nodeInventory=2`、`residue=[]`、`remainingGate=[]`。
  - 部署后真实 client 结果：`node bin/ai-home.js fabric nodes aws-current-node` pass，profile `cp-51hq70`，AWS node 为 `relay=yes/project_host=yes/runtime_host=no/measured=yes`，runtime gaps 为 `codex/claude/agy/opencode missing_provider_runtime`；readiness 回归仍 pass，`defaultTransport=relay`、`fallbackReady=true`、`relayMeasurementPass=true`。
  - `aih claude` 审查按 AIH Server 路径尝试，但 30 秒仍停在 `Waiting for claude to boot`，没有产出审查文本；进程已中断。
  - focused tests 19/19 pass；Web build pass；full `npm test` 2665/2665 pass。
  - 证据：`docs/fabric/evidence/2026-06-28-fabric-nodes-cli-capability-smoke.md`。
- 2026-06-28 Fabric session start CLI gate:
  - 新增正式 CLI `aih fabric session start <node-id> --provider PROVIDER --prompt TEXT`，沿用本地 paired server profile/device token，先读取 Node Inventory action gate，再调用受保护的 `/v0/node-rpc/device-node-session-start`。
  - `server-profile-client` 的 shared `fetchJson()` 仅扩展 method/body 支持，供 readiness/nodes/session-start 共用 profile/token/fetch 逻辑；输出仍只暴露 `deviceTokenPresent=true`，不打印 raw token。
  - 真实 AWS gate：`node bin/ai-home.js fabric session start aws-current-node --provider codex --prompt "AIH_FABRIC_AWS_RUNTIME_BLOCK_CHECK" --json` 返回 `blocked=true`、`registryAuthorizedStatus=200`、`sessionStartStatus=0`、blocker=`missing_provider_runtime:codex`；这证明本地能连 AWS registry，但 AWS node 缺 provider runtime 时不会盲目 POST。
  - clean commit `5a8113e` 已部署到 AWS current 默认 `9527`，source artifact `5b016a0c1c64bb4622a675fc1cb26db9e78d4bdc28cf092ab6dc4834d142c66a`，server pid `257703`，provider accounts 仍为 0。
  - 部署后 preflight `ok=true`、`processCount=1`、`supervisorReady=true`、registry readback `nodes=2 relayNodes=2 projects=2 runtimes=4 transports=2 nodeInventory=2`、`residue=[]`、`remainingGate=[]`。
  - 部署后真实 client 回归：`fabric nodes aws-current-node` pass，`fabric transport readiness` pass，`fabric session start aws-current-node --provider codex` 仍按预期返回 `sessionStartStatus=0` / `missing_provider_runtime:codex`。
  - enabled node smoke：`fabric session start local-mac-remote-node --provider codex --account-id 1 --model gpt-5.5` 返回 `sessionStartStatus=200`、native run accepted、runId present；随后同 device channel stop 返回 HTTP `200` / `accepted=true`。临时 marker 检测未命中，所以不把这次算作 conversation marker smoke；完整对话 marker 仍以 M4 AWS/mobile evidence 为准。
  - focused tests：session-start 4/4 pass；nodes/inventory/role-registry 10/10 pass；full `npm test` 2669/2669 pass。
  - 证据：`docs/fabric/evidence/2026-06-28-fabric-session-start-cli-gate.md`。
- 2026-06-28 Fabric session control CLI:
  - 新增正式 CLI `aih fabric session attach|events|message|slash|stop`，沿用本地 paired server profile/device token，调用受保护的 device-node session routes，不打印 raw token。
  - 本地 focused tests：session-control/start 9/9 pass；nodes/inventory/role-registry 10/10 pass；`aih fabric --help` 已展示 start/attach/events/message/slash/stop。
  - 真实 AWS default `9527` smoke：`local-mac-remote-node` 上 Codex run `54559278-18bb-4be9-a903-ae426291894e` 完成 start 200、attach 200、events 200、message 200、slash 200、stop 200，post-stop events 显示 `aborted=1`、`done=1`、`completed=true`。
  - 提交并部署：`b69c7c5 feat(fabric): add session control CLI` 通过干净 `git archive HEAD` 临时源码部署到 AWS default `9527`，remote pid `259071`，artifact sha256 `c819cd3b4c7f2c5a1ff804789ee281f3f7112a2661e6ad80593965c9a0476315`，未导入 provider 凭据。
  - 部署后真实检查：M3 preflight ready、registry counts `nodes=2/runtimes=4`；`aws-current-node` 仍为 relay/project host 且 `runtimeHost=false`；`local-mac-remote-node` 提供 `agy/claude/codex/opencode` runtimes；transport readiness 默认 relay、`fallbackReady=true`。
  - 部署后 session-control：run `8d147b98-93cf-4dac-9ab7-0d6dd1a3636f` 完成 start/attach/events/message/stop，post-stop `terminal-output=312/aborted=1/done=1/status=completed`；run `d32d0fb5-1afa-452f-a56c-12f67a7dd6ce` 完成 start/slash/stop，post-stop `terminal-output=12/aborted=1/done=1/status=completed`。
  - 部署后发现并修复 completed run 事件保留过短：旧逻辑 60 秒后清理内存 run，导致同一 run 的 `events` 后续返回 404；`b8ea19b fix(fabric): retain completed session events longer` 修复为默认保留 30 分钟，并支持 `AIH_NATIVE_RUN_RETENTION_MS` / `AIH_SESSION_RUN_RETENTION_MS` 配置，最低 60 秒、最高 24 小时。
  - retention 修复真实部署验证：AWS default `9527` 已部署 `b8ea19b`，artifact sha256 `8d9309d0732611c0fac9d692bbf13676f9879c86bab2e4c283b17193603307bd`，remote pid `260427`；本地 `local-mac-remote-node` server 以同端口 `9527` 重启到当前仓库入口，pid `36576`；run `2d83f79f-9d74-492f-9830-340d6b21fbcf` stop 后立即 events 200，等待 70 秒后同 run 再读 events 仍为 200、`cursor=168/terminal-output=165/aborted=1/done=1/status=completed`。
  - completed run event persistence 修复真实部署验证：commit `a8d5e5d` 已用干净 `git archive HEAD` 部署到 AWS default `9527`，artifact sha256 `4f77e9c7415c3941c59e7d31fdaf4f8340751480106b3bab96df638ce63c36ba`，remote pid `262206`；本地 node server 同端口 `9527` 重启到当前仓库入口，最终 pid `55595`；真实 AWS -> `local-mac-remote-node` Codex run `9a8ffe98-58f1-4bc3-9f3c-40454ccfe401` 完成 start/message/slash/stop，磁盘 JSONL `157291` bytes，server 重启后同 run events 仍为 HTTP 200、`status=completed/cursor=327/persisted=true/aborted=1/done=1`。
  - 真实发现：并行发送 message 和 slash 会在 TUI 输入层串联成 `/statusPlease...`；CLI 单条 command 路由可用，但更高层原生客户端必须串行化同一 run 的交互输入，不能并发灌入 TUI。
  - 后续已修复并验证：`975badd fix(fabric): serialize native session commands` 为同一 `sessionId` 增加 per-session command queue、in-flight idempotency 复用和 `240ms` settle window；AWS default `9527` -> `local-mac-remote-node` 真实 Codex run `1d46a3d3-95d4-4ab0-b8da-fec4eb5a0efe` 同时发送 message 与 `/status` 均 HTTP 200，events 中两条输入分离，`concatenationHits=[]`。
  - 证据：`docs/fabric/evidence/2026-06-28-fabric-session-control-cli-smoke.md`。
- 2026-06-28 Native session event persistence smoke:
  - 新增 append-only native run event store：completed run events 写入 `<aiHomeDir>/fabric/native-runs/*.events.jsonl`，run meta 写入同名 `.json`；large terminal artifacts 可写入 `<aiHomeDir>/fabric/session-artifacts`。
  - active run 仍优先读内存；内存缺失、清理或 server restart 后才读 persisted events，避免 running run 的实时状态被磁盘读取路径覆盖。
  - 本地 focused tests 31/31 + session-control/start 9/9 通过；full `npm test` 2676/2676 通过。
  - 真实 AWS readback 使用 paired profile `cp-51hq70` 和默认 `9527`；AWS 未导入 provider 凭据，真实 Codex runtime 在 `local-mac-remote-node` 的 account `4` 上执行。
  - 重启后同 run `9a8ffe98-58f1-4bc3-9f3c-40454ccfe401` 通过 AWS `fabric session events` 返回 `persisted=true`，证明 completed run events 已脱离内存保留窗口。
  - 证据：`docs/fabric/evidence/2026-06-28-native-session-event-persistence-smoke.md`。
- 2026-06-28 Native session command serialization smoke:
  - 同一 native run 的 `message` / `slash` / `approval_response` / `stop` 现在进入同一个 session queue；不同 run 不互相阻塞；重复 idempotency key 在 in-flight 阶段复用同一个 promise，不重复写 PTY；失败命令仍执行 settle window 后让后续命令继续。
  - 本地 focused tests：command/control/router 29/29 pass，session start/catalog/router 73/73 pass；full `npm test` 2680/2680 pass。
  - AWS current 已部署 `975badd`，artifact sha256 `298301c5a5ac4cb41afd4778336a3dbcd2545f536ed475209c535d63b23083e2`，remote pid `263117`，默认 `9527`，`--skip-import`，provider accounts 仍为 0。
  - 本地 default `9527` 使用当前仓库入口运行，readyz `ready=true`，provider accounts 为 `codex=1, gemini=1, claude=5, agy=7, opencode=1`；local relay/registry launchd 服务均指向 `/Users/model/projects/feature/ai_home/bin/ai-home.js`。
  - 真实 AWS -> 本机 Codex run `1d46a3d3-95d4-4ab0-b8da-fec4eb5a0efe` 同时发送 message marker 和 slash `/status`，两条 command 均 HTTP 200，message ack cursor `11`，slash ack cursor `12`；events 中 message 和 `/status` 分离，`concatenationHits=[]`；stop HTTP 200，final status `completed`，event type 包含 `aborted`。
  - 证据：`docs/fabric/evidence/2026-06-28-native-session-command-serialization-smoke.md`。
- 2026-06-28 M3.5 Node Inventory 第一刀：
  - 新增 server/client 统一 Node Inventory read model，按 node 聚合 projects、runtimes、relayNodes、transports、measurements 和 action gating。
  - 当时真实 AWS registry payload 跑 read model 后，`aws-current-node` 显示 `projectHost=true`、`relayNode=true`、`runtimeHost=false`，四个 start session action 分别阻塞于 `missing_provider_runtime:codex|claude|agy|opencode` 和当时尚未完成的 M4 session action。
  - 当时 `local-mac-remote-node` 显示 `runtimeHost=true`，provider runtimes 为 `codex/claude/agy/opencode`，start session action 只剩当时尚未完成的 M4 session action。
  - 后续 M4 8.2-8.7 已完成；当前仍不能在 AWS node 上启动 provider session 的原因是 AWS node 无 provider runtime/account，不是 M4 session 协议未完成。
  - 本地 focused tests 9/9 pass，Web build pass，`npm test` 2575/2575 pass。
  - 证据：`docs/fabric/evidence/2026-06-28-node-inventory-read-model.md`。
- 2026-06-28 AWS runtime gap diagnosis:
  - Node Inventory read model 新增 `runtimeGaps[]`，同一套 provider runtime gate 同时驱动 runtime 缺口和 start-session blockers。
  - 真实 AWS `/readyz` 显示 provider accounts 全为 0；AWS host-home 下 `profiles/codex|gemini|claude|agy|opencode` 目录数量均为 0。
  - 授权 registry readback 显示 `runtimes=4` 全部属于 `local-mac-remote-node`；`aws-current-node.runtimeGaps=codex/claude/agy/opencode missing`。
  - 结论：AWS 当前是 control plane / relay / SSH / project host，不是 provider runtime host；除非明确导入或配置 provider accounts，否则不能直接在 AWS 上启动 provider session。
  - 证据：`docs/fabric/evidence/2026-06-28-aws-runtime-gap-diagnosis.md`。
- 2026-06-28 AWS registry heartbeat self-heal:
  - 修复 clean deploy 后 `server + relay + registryAgent` 都 running 但授权 registry readback 仍为 `nodes=0` 的真实缺口。
  - 根因是 `heartbeatFabricNode()` 只更新已注册 node；registry 被清空后长期 registry agent 的合法 heartbeat 不能自愈创建 `aws-current-node`。
  - 部署脚本已修复 stale `9527` pid/port 残留导致的假成功：现在会清理旧 server、校验新 pid、检查失败日志并等待 `/readyz`。
  - `a7ecba5` 已通过干净 HEAD 部署到 AWS current 默认 `9527`，新 server pid `235769`，preflight `ok=true`、`supervisorReady=true`、`residue=[]`、`remainingGate=[]`。
  - 本地授权 profile 读取 AWS registry 返回 `nodes=2`、`relayNodes=2`、`transports=2`、`projects=2`、`runtimes=4`、`nodeInventory=2`；`aws-current-node` 可见但 `runtimeGaps=codex/claude/agy/opencode missing_provider_runtime`，符合未导入 provider 凭据的约束。
  - 证据：`docs/fabric/evidence/2026-06-28-aws-registry-heartbeat-self-heal.md`。
- 2026-06-28 M3 preflight registry readback hardening:
  - `scripts/fabric-m3-daemon-preflight.js` 新增只读 registry readback gate：使用远端 token 文件请求 `http://127.0.0.1:9527/v0/fabric/registry`，只输出 counts、目标 node presence、runtimeProviders 和 runtimeGaps，不打印 token。
  - 真实 AWS current 运行结果：`registry.counts=nodes=2, relayNodes=2, projects=2, runtimes=4, transports=2, nodeInventory=2`，`targetNode.id=aws-current-node`、`present=true`、`runtimeHost=false`、`runtimeGaps=codex/claude/agy/opencode missing_provider_runtime`，`remainingGate=[]`。
  - 证据：`docs/fabric/evidence/2026-06-28-m3-preflight-registry-readback.md`。
- AWS current 默认端口部署已重新收敛到 `9527`：
  - Deploy command 未传 `--port`，启动日志为 `listen: http://0.0.0.0:9527`。
  - 最新 source artifact 为 `94de613e7fe53fd1a0b145307c8256f4e3c8990f2cd2a3df41ab59bf6f1a6895`，`26340463` bytes。
  - PID 检查只发现一个 `77912 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527`，没有 `9528`。
  - `http://127.0.0.1:9527/readyz` 返回 `ready=true`，账号池为 `codex=3, gemini=1, claude=4, agy=7, opencode=0`。
  - 公网 TCP `43.207.102.163:9527` 可连接，但 `curl --noproxy "*" --max-time 10 http://43.207.102.163:9527/readyz` 仍 0 bytes timeout；公网 HTTP ingress 不能作为当前产品依赖。
- AWS current 默认端口真实 broker relay + Codex remote session 已通过：
  - `scripts/fabric-real-broker-relay-smoke.js --endpoint http://127.0.0.1:9527 --server-id aws-current --token-file /home/ubuntu/aih-fabric-current/.broker-token` 返回 `ok=true`。
  - device/client endpoint 为 `http://127.0.0.1:9527/v0/fabric/broker/servers/aws-current/proxy`，报告 `viaProxy=true`。
  - broker outbound link connected，relay online，`transportKind=relay`，`sessions.status=200`，`rpc=control_plane.device.node_sessions`。
  - 真实 Codex remote session 使用 `codex account 1`、`model=gpt-5.5`，`startStatus=200`，runId present，模型输出命中 `AIH_REAL_BROKER_RELAY_OK_627A`。
  - marker 不在 prompt 中原样出现，prompt 只要求模型用 underscores 拼接分散单词。
  - `/quit` accepted，cleanup completed；本地和远端均无 `fabric-real`、`fabric broker connect`、`node relay connect`、`aws-current-broker` 残留进程。
  - 本地回归：focused 49/49 pass，`npm test` 2507/2507 pass，`git diff --check` pass。
  - 证据：`docs/fabric/evidence/2026-06-27-outbound-broker-relay-aws-smoke.md`。
- Broker Proxy 已接入 Server Profile 产品入口：
  - `/ui/server-setup` 的配对和探测保存表单都支持 `直连 Server` / `Broker Proxy`。
  - Broker 模式使用 `brokerEndpoint + serverId` 生成 `/v0/fabric/broker/servers/{serverId}/proxy` endpoint。
  - 保存、导入导出和配对都会保留 `connectionMode=broker-proxy` 与 broker metadata；device token 仍不导出。
  - 粘贴 direct pair URL 但选择 Broker 模式时，device pair 请求仍走 broker proxy endpoint。
  - 本地回归：`control-plane-profiles + fabric-profile-gate` 33/33 pass，`npm --prefix web run build` pass。
  - AWS current 默认 `9527` profile-entry broker relay smoke 通过：`viaProxy=true`，relay online，sessions RPC 200，远端无残留进程。
  - `aih claude` 按 AIH Server profile 路径尝试前端审查，但超过 60 秒仍停在 `Waiting for claude to boot`，没有产出审查文本。
  - 证据：`docs/fabric/evidence/2026-06-27-broker-profile-ui-entry.md`。
- Broker link 断开诊断与同 `serverId` 恢复已在 AWS current 默认 `9527` 验证：
  - registry 保存 `lastDisconnected` 快照，包含 `disconnectReason`、`closeCode`、`connectedAt`、`lastSeenAt`、`disconnectedAt`。
  - broker proxy 离线响应返回 HTTP 503、`fabric_broker_server_offline` 和 `brokerStatus.lastDisconnected.disconnectReason=broker_server_link_closed`。
  - 同一 `serverId` 重新建立 outbound broker link 后，broker proxy `readyz` 恢复 HTTP 200。
  - `aih fabric broker connect` 前台模式支持 `--reconnect-delay-ms` 和 `--max-attempts`，可作为长期 outbound link 的受控重连入口。
  - AWS current 默认 `9527` 再次通过 broker proxy -> relay -> real Codex remote session；模型输出命中 `AIH_BROKER_DIAGNOSTICS_RECOVERY_OK_20260627`，`/quit` 与 abort cleanup 均 accepted。
  - 远端残留进程检查为空，没有留下 diagnostics smoke、broker relay smoke、broker connect 或 relay connect 进程。
  - 证据：`docs/fabric/evidence/2026-06-27-broker-diagnostics-recovery.md`。
- Broker Proxy 的 Server Setup 真实浏览器 smoke 已完成：
  - 新增 `scripts/fabric-browser-broker-profile-smoke-server.js`，启动隔离 AIH server，并建立真实 outbound broker control link。
  - 真实浏览器打开 `/ui/server-setup`，选择 `Broker Proxy`，填写 broker endpoint 和 server id，通过 broker proxy 消费真实 pair URL。
  - 首轮发现真实 403 缺口：Server Setup refresh 需要 `device-profile`、`device-status`、`device-accounts`、`device-sessions` 四个 device-scoped GET 路由通过 broker。
  - Broker allowlist 已补这四个最小路由，仍不开放 management API 或 `/v1/responses`。
  - 复测请求均为 200：`device-pair`、`descriptor`、`device-profile`、`device-nodes`、`device-status`、`device-accounts`、`device-sessions`。
  - 浏览器 console 为 0 errors / 0 warnings；profile 保存为 `connectionMode=broker-proxy`、`state=paired`、`authState=paired`，点击 `进入工作台` 后进入 `/ui`。
  - 本地回归：`node --test test/fabric-broker-routing.test.js test/control-plane-profiles.test.js test/fabric-profile-gate.test.js` -> 41/41 pass；`npm --prefix web run build` pass。
  - AWS current 默认 `9527` 已同步 allowlist 并重启，唯一 server 进程为 `110864 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527`，`AIH_FABRIC_BROKER_TOKEN` env present。
  - AWS current 远端 `node --test test/fabric-broker-routing.test.js` -> 8/8 pass；broker proxy device route smoke 返回 pair 200，`descriptor/profile/nodes/status/accounts/sessions` 全部 200。
  - AWS current 事后无 broker connect 或 smoke 残留进程；`/readyz` 仍为账号清理后的 `ready=false, accounts=0`，不影响本次 broker/device route 结论。
  - 证据：`docs/fabric/evidence/2026-06-27-browser-broker-profile-smoke.md`。
- 跨主机 outbound broker Server Profile/node relay/remote session 已完成：
  - AWS public `http://43.207.102.163:9527/readyz` 当前 HTTP 200。
  - 本机 AIH server 通过 `aih fabric broker connect http://43.207.102.163:9527 --server-id local-mac-crosshost --local-url http://127.0.0.1:9527` 主动 outbound 注册到 AWS broker。
  - 本机 client 通过 AWS public broker proxy 访问本机 server：`readyz` 和 `/v0/fabric/descriptor` 均 200。
  - 真实 local device invite 通过 AWS broker proxy 完成 pair，返回 device token；`device-profile`、`device-nodes`、`device-status`、`device-accounts`、`device-sessions` 均 200。
  - 同一 broker proxy endpoint 触发 `scripts/fabric-real-outbound-relay-smoke.js`，node relay online，`transportKind=relay`，sessions RPC HTTP 200。
  - 同一 broker proxy endpoint 启动真实 Codex 远程会话，`codex account 1`、`model=gpt-5.5`、runId present，输出命中预期 marker。
  - `/quit` accepted，abort cleanup accepted；cleanup 后本机无 `local-mac-crosshost` / smoke / broker connect 残留，AWS 只剩默认 `9527` server pid `110864`；broker proxy 对 `local-mac-crosshost` 返回可诊断 offline。
  - 证据：`docs/fabric/evidence/2026-06-27-crosshost-outbound-broker-profile-smoke.md`。
- M3 Role Registry measurement + UI slice 已完成：
  - 本轮修复 agent -> heartbeat -> server registry -> Web UI 的 relay measurement 链路。
  - `aih fabric registry agent` 会把 probe 摘要写入 transport `measurement`，server 按白名单持久化 `status/durationMs/successes/failures/rttMs/measuredAt`。
  - Fabric Nodes UI 不再把 `online` relay transport 误判为 `pending-measurement`，并显示 measurement 摘要。
  - AWS current 默认 `9527` 已同步服务端最小变更和 Web build；当前 server pid 为 `113275`。
  - 真实 local agent -> AWS current heartbeat 通过：`ok=true`、`attempts=1`、`failures=0`、probe `health=online`、`status=reachable`、`durationMs=238`。
  - 独立 registry readback 返回 `counts=nodes:1, relayNodes:1, transports:1, projects:1, runtimes:4`，relay transport 含 `measurement.status=reachable`、`durationMs=238`。
  - 真实浏览器打开 `http://43.207.102.163:9527/ui/fabric/nodes`，节点、Relay Health、measurement 和 online 均可见，console 0 error/0 warning。
  - 本地回归：Fabric registry focused 21/21 pass，`node --check` pass，`npm --prefix web run build` pass。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-role-registry-measurement.md`。
- M3 Role Registry two-node slice 已完成：
  - AWS current 自身通过 `scripts/fabric-real-vps-registry-publish.js --port 9527 --node-id aws-current-node` 注册为第二个真实 `node + relay-node`。
  - 本轮未访问旧 `152/155/39.104`，未新增产品端口；AWS current 仍使用默认 `9527`。
  - AWS self publish `ok=true`，roles 为 `node, relay-node`，heartbeat `ok=true`，foreground agent `ok=true`、`attempts=1`、`failures=0`、probe `status=reachable`、`durationMs=33`。
  - 独立 registry readback 返回 `nodes=2, relayNodes=2, transports=2, projects=2, runtimes=4`；node ids 为 `aws-current-node` 和 `local-mac-remote-node`。
  - 两条 relay transport 均为 `online`，且均含 measurement。
  - 真实浏览器打开 `http://43.207.102.163:9527/ui/fabric/nodes`，两个节点、两个 relayNodes、Relay Health、reachable 和 online 均可见，console 0 error/0 warning。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-role-registry-two-nodes.md`。
- M3 Role Registry service/daemon partial 已补：
  - AWS current 生成了持久 Fabric device token file：`/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token`，权限 `600`，证据不打印 token。
  - 首次 5 次 heartbeat 长跑失败为 `forbidden_fabric_node_owner`，确认 7.2 自注册使用一次性内存 token，未持久化 owner token。
  - 通过真实 `POST /v0/fabric/registry/nodes` 将 `aws-current-node` 重新绑定到持久 token 设备 `fabric-agent-aws-current-node`，registry 总计仍为 `nodes=2, relayNodes=2, transports=2, projects=2, runtimes=4`。
  - 第二次 `aih fabric registry agent` 以 10 秒间隔运行 5 次，返回 `ok=true`、`attempts=5`、`failures=0`，probe `status=reachable`、`durationMs=4`，独立 readback 显示 `aws-current-node-relay` measurement 已更新。
  - `node service install --dry-run` 在 AWS current 返回 `ok=true`、`writes=false`，计划包含 `relay` 和 `registryAgent`；`node service status` 明确两个 systemd user unit 仍为 `missing`，且 `management_key_missing` 阻塞真实安装。
  - `aih server config set --generate-management-key` 已补为本地安全前置入口，后续 7.3 可由 CLI 内部生成 management key，避免在 argv/stdout 暴露。
  - `scripts/fabric-m3-daemon-preflight.js --json` 已补为只读 preflight 入口；真实 AWS current 返回 `verdict=ready_for_confirmed_7_3_execution`、`installDryRun.writes=false`、`residue=[]`。
  - `13-m3-supervised-daemon-runbook.md` 已落地 7.3 执行、验收和回退步骤。
  - 事后无 `fabric registry agent` 或 `node relay connect` 残留进程，未安装 systemd unit。
  - 本地服务/registry focused tests：53/53 pass；`fabric-m3-daemon-preflight + server.command-fast-start + node-doctor + node-relay-service + fabric-registry-agent-service` 56/56 pass。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-node-service-daemon-partial.md`。
- M3 preflight code readiness audit 已完成：
  - 只读 SSH 复核发现 AWS current 远端代码尚未包含 `--generate-management-key`，且未包含 `13-m3-supervised-daemon-runbook.md`。
  - `scripts/fabric-m3-daemon-preflight.js --json` 已补远端代码就绪度检查：`remoteCode.generateManagementKey`、`remoteCode.supervisedDaemonRunbook`、`remoteCode.ready`。
  - 修复后真实 AWS current preflight 返回 `ok=false`、`verdict=preflight_failed`，remaining gate 增加 `remote_code_missing_generate_management_key` 和 `remote_runbook_missing`。
  - 本地 preflight/service focused tests：59/59 pass；`node --check` pass。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-preflight-code-readiness-audit.md`。
- M3 current code sync + preflight ready 已完成：
  - 为避免 dirty worktree 中 Claude/Anthropic 未提交改动污染 AWS current，本轮使用 `git archive HEAD` 同步已提交代码，未使用工作区打包路径。
  - 同步归档 `/tmp/aih-fabric-head-27b9d13.tar.gz`，sha256=`a29e6fc6eccfccc6065391d6ac1508f8e4d468647cb1ead7b967f09e93befd5c`，大小 `2.6M`。
  - AWS current 远端复核：preflight 脚本包含 PATH 修复，`server-config-command.js` 包含 `--generate-management-key`，`13-m3-supervised-daemon-runbook.md` 已存在。
  - 真实 `node scripts/fabric-m3-daemon-preflight.js --json` 返回 `ok=true`、`verdict=ready_for_confirmed_7_3_execution`、`remoteCode.ready=true`、`installDryRun.writes=false`、`residue=[]`。
  - AWS current 进程表只剩一个默认 `9527` server，没有 registry agent、relay connect、broker 或 smoke 残留。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-current-code-sync-preflight-ready.md`。
- M3 Relay Health strong metrics 已完成：
  - AWS current 默认 `9527` server listener 已增加 `/v0/fabric/transport/echo` WS echo endpoint，不新增产品端口。
  - 真实 direct WS echo 返回 `ok=true`、`successes=20`、`failures=0`、`rttMs.count=20`、`p95=1ms`。
  - 真实 `aih fabric registry agent` 通过 `relay=ws://127.0.0.1:9527/v0/fabric/transport/echo` 写入 `aws-current-node-relay` latest measurement：`status=ws_echo_pass`、`sampleCount=20`、`successRate=1`、`rttMs.p95=2`。
  - 同次 heartbeat 追加 `networkMeasurements` trace；独立 readback 返回 `networkMeasurements=2`，latest entry 指向 `aws-current-node-relay`。
  - 真实浏览器打开 `http://43.207.102.163:9527/ui/fabric/nodes`，两个节点、`p95`、`100% ok (20)`、`ws_echo_pass` 均可见，console 0 error/0 exception。
  - AWS current 只剩默认 `9527` server pid `121002`，无 registry agent、relay connect、transport echo 或 browser smoke 残留进程。
  - 本地 focused tests 36/36 pass；AWS current focused tests 36/36 pass；Web build pass。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-relay-health-strong-metrics.md`。
- M3 Fabric Nodes mobile regression 已完成：
  - 真实 Chrome mobile viewport `390x844` + touch emulation，通过 AWS current 真实 device pair profile 打开 `/ui/fabric/nodes`。
  - 首轮发现并修复移动端空白首屏：`.fabric-nodes-page` 被布局到 `y=-1008`，根因是 mobile `.app-content` 缺少稳定 height/flex 边界。
  - 修复后复测 `headerRect.y=106`、`pageRect.y=68`、content scroll container `720/3633`，无横向溢出，`overflowEls=[]`。
  - 两个 node row 可见；点击 `local-mac-remote-node` 后详情切换为 `Local Mac Remote Node`，项目、runtime、transport、Relay Metadata 均可查看。
  - 页面仍显示 `p95`、`100% ok (20)`、`ws_echo_pass`，console 0 warning/error/exception。
  - 截图：`/tmp/aih-m3-fabric-nodes-mobile-390-fixed.png`、`/tmp/aih-m3-fabric-nodes-mobile-390-detail.png`。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-fabric-nodes-mobile-regression.md`。
- M3 continuation audit 已完成：
  - 当前 authoritative todo 仍是本文件的 Active Todo 和 M3 Todo Queue；后续新增需求必须先追加到对应 todo，再按顺序推进。
  - 历史复核当时确认 top-level 1-6 done，7 partial，8-10 pending；M3 7.1、7.2、7.4、7.5 done，只有 7.3 partial。
  - 当前该结论已被后续 M3.5/M4/M5/M6 证据取代；以本文件顶部 Active Todo 和各 Todo Queue 为准。
  - 复核命令不访问旧 `152/155/39.104`，只使用本机与 AWS current 默认 `9527`。
  - 本地 focused tests 36/36 pass，AWS focused tests 36/36 pass，Web build pass，AWS WS echo 20/20 pass 且 p95=2ms。
  - AWS current 只剩默认 `9527` server，无 registry agent、relay connect、broker 或 smoke 残留；本机移动端验证 Chrome 已关闭。
  - 工作区仍混有另一条 Anthropic/Claude 改动，Fabric/M3 后续提交只能 stage Fabric 文件。
  - 证据：`docs/fabric/evidence/2026-06-27-m3-continuation-audit.md`。
- AWS current 默认端口真实 Codex `/v1/responses` 已在重新部署后通过：
  - non-stream：`POST http://127.0.0.1:9527/v1/responses`，`x-provider=codex`，`model=gpt-5.5`，`store=false`，HTTP 200，`response.output_text` 包含 `AIH_AWS_CODEX_NONSTREAM_REDEPLOY_9527_OK_20260627`。
  - stream：同 endpoint，`stream=true`，HTTP 200，`response.output_text.done` 包含 `AIH_AWS_CODEX_STREAM_REDEPLOY_9527_OK_20260627`。
- AWS current 默认端口真实 relay Codex runtime 会话已通过：
  - `scripts/fabric-real-outbound-relay-smoke.js --endpoint http://127.0.0.1:9527 --session-provider codex --session-account 1 --session-model gpt-5.5` 返回 `ok=true`。
  - control/node health 均为 `true`，`relay.status=online`，`transportKind=relay`，device scopes 包含 `sessions:read` 和 `sessions:write`。
  - Codex runtime 会话输出命中预期 marker。
  - output events 为 `ready=1, output=437, aborted=1`；`/quit` accepted，`session-run-abort` accepted，cleanup `completed=true`。
  - smoke 后远端进程表无 Codex/relay 残留，只剩 `node bin/ai-home.js server serve --host 0.0.0.0 --port 9527`。
- 跨主机 API relay smoke 已推进到真实 node join 准备阶段：
  - `scripts/fabric-real-outbound-relay-smoke.js` 新增 `--node-join-url` 和 `--device-pair-url`，endpoint 模式可通过真实 `/v0/node-rpc/join` 与 `/v0/fabric/device-pair` 准备 node/device，不再要求共享 server host-home。
  - 本机 -> AWS 公网 `http://43.207.102.163:9527` 真实 API-mode smoke 在 `node_join` 阶段超时：`node_join_request_failed:The operation was aborted due to timeout`。
  - 失败报告明确 `preparation.mode=api`、`phase=node_join`；relay child 未启动，AWS 事后仍只剩 `--port 9527` server。
  - 证据：`docs/fabric/evidence/2026-06-27-cross-host-api-relay-smoke-attempt.md`。
- 真实请求中发现并本地修复两个 Codex adapter 缺口：
  - 本地路由字段 `provider` 不应转发给上游 Codex。
  - non-stream `/v1/responses` 需要从 `response.output_item.done` 事件补齐 `response.completed.output=[]` 的可见文本。
  - 本地验证：`node --check lib/server/codex-adapter.js` pass；`node --test test/server.codex-adapter.test.js` 28/28 pass；Fabric/session/Codex adapter 定向集合 70/70 pass。
- 本轮为 relay runtime completion 补了真实 cleanup 链：
  - Codex project trust 写入账号级 `CODEX_HOME` 下的 `.codex/config.toml`，避免 runtime CLI 仍弹 trust prompt。
  - control-plane/node-rpc/relay allowlist 增加 `session-run-abort`，smoke 在 marker 命中后通过 abort RPC 关闭 runtime 子进程。
  - account 3 的 relay runtime 失败已确认为账号密钥问题：Codex 返回 `401 Incorrect API key provided: yesboss-****udou`；不计为 relay/control-plane 失败。
- AWS 不可用期间，本机默认 `9527` 已用当前 worktree 补充真实 runtime 排错证据：
  - 临时停止并恢复本机 `com.clawdcodex.ai_home` LaunchAgent；当前 worktree server 以 `AIH_SERVER_STRICT_PORT=1` 启动在 `0.0.0.0:9527`，未使用新端口作为有效证据。
  - 当前 worktree `/v1/responses` non-stream 真实返回 `AIH_LOCAL_CODEX_NONSTREAM_9527_OK_20260627`，`response.output` 与 `response.output_text` 均有可见文本。
  - 当前 worktree `POST /v0/node-rpc/session-start` 启动真实 Codex runtime session，返回 runId；output events 为 `ready=1, output=2730`，模型回复包含预期 marker。
  - 本轮发现并修复 macOS runtime session spawn 两个真实问题：primary loader spawn 失败时需 fallback 到 secondary loader；POSIX shell shim 需要通过 shell wrapper 启动。
  - 本地回归：runtime/session/server/relay/deploy focused tests -> 79/79 pass。
  - 本机原 LaunchAgent 已恢复，`127.0.0.1:9527/readyz` 返回 `ready=true`，本轮 marker 子进程无残留。
- `scripts/fabric-real-vps-deploy.js` 默认远端目录已改为 `/home/ubuntu/aih-fabric-current`；`--skip-import` 时不再要求 `--accounts`，transfer-only 不传账号包、不启动 server、不创建版本目录。
- 2026-06-27 current-only 真实同步结果：
  - Source artifact: `dbfeed88fce56b2f80926c3496593e9cbf78c15ef0cd5a374bcf99945f3f0956`，`26319739` bytes。
  - `node-runtime-cache-hit`、`node-modules-cache-hit`。
  - 远端目录复核只剩 `aih-fabric-current`；没有 `aih-fabric-real-*` 版本目录。
  - 远端残留进程检查为空，没有留下 `server serve`、`node relay connect`、registry agent 或 smoke 进程。
- AWS current 验证结果：
  - `node --check lib/server/control-plane-device-session-start.js lib/server/node-rpc-router.js lib/cli/services/node/relay-client.js lib/server/remote/relay-server.js scripts/fabric-real-outbound-relay-smoke.js` -> pass。
  - `node --test test/fabric-real-outbound-relay-smoke.test.js` -> 9/9 pass。
  - `node --test test/control-plane-device-session-start.test.js test/server-node-rpc-wiring.test.js test/node-relay-client.test.js test/fabric-real-outbound-relay-smoke.test.js test/codex-project-registry.test.js` -> 43/43 pass。
  - runtime/session/server/relay/deploy focused tests -> 79/79 pass。
  - `node --test test/fabric-real-vps-deploy.test.js test/control-plane-profiles.test.js test/fabric-profile-gate.test.js` -> 49/49 pass。
  - `npm --prefix web run build` -> pass，仅保留既有 Vite chunk size warning。
  - `node scripts/fabric-real-outbound-relay-smoke.js --timeout-ms 30000` -> `ok=true`、`relay.status=online`、`transportKind=relay`、`sessions.status=200`、`sessions.rpc=control_plane.device.node_sessions`。
- `155.248.183.169` 保留历史 v12 证据，但不再作为 active target 使用。
- AWS Japan 历史 v16 部署：`/home/ubuntu/aih-fabric-real-20260627-isolated-v16`，端口 `19684`。该证据保留用于追溯，不再作为新部署形态。
- AWS 初始无系统 Node/npm，但有 `curl/python3`；导入真实账号包时使用 Python zipfile fallback，没有安装系统包。
- AWS v16 真实导入为 `imported=15 duplicates=0 invalid=0 failed=0`，账号池为 `codex=3, gemini=1, claude=4, agy=7`。
- AWS v16 `fabric registry agent service status` 只读检查通过，识别为 `systemd-user`，状态为 `missing`，没有安装 service。
- AWS v16 完成真实 registry publish、heartbeat、foreground agent `--count 2` 和 TCP echo probe：
  - `agent.ok=true`
  - `agent.attempts=2`
  - `agent.failures=0`
  - `agent.probes[0].status=tcp_echo_pass`
  - `registryCounts=nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4`
  - `runtimeProviders=codex/gemini/claude/agy`
  - `transportKinds=relay:online`
- 小水管部署优化新增 source artifact cache：
  - 本地连续两次 source artifact 构建 sha/bytes 一致：`2ff0d858463a62a11fb7a21d7710c451980bfee3db99d83a3369e9712fb13aad`，`26298869` bytes。
  - AWS v16 首次上传稳定 source artifact 后，AWS v17 transfer-only 命中 `source-cache-hit`，同时命中 `node-runtime-cache-hit` 和 `node-modules-cache-hit`。
- AWS v18 完成真实 outbound relay smoke：
  - Remote dir: `/home/ubuntu/aih-fabric-real-20260627-isolated-v18`。
  - 部署模式：`--skip-import --skip-start`，只同步当前源码和依赖缓存，不启动持久 server。
  - Source artifact: `e7e4389f4eca4f3f36e01fa1d149f0ba8c25f04814f2d1aa702a83a220ca88e2`，`26304154` bytes；远端 `node-runtime-cache-hit`、`node-modules-cache-hit`。
  - `node scripts/fabric-real-outbound-relay-smoke.js --timeout-ms 30000` 在 AWS 上返回 `ok=true`。
  - Smoke 使用两个真实 AIH server 子进程和一个真实 `aih node relay connect` 子进程；`relay.status=online`、`transportKind=relay`、`transportStatuses=relay:up`。
  - 设备端通过 `/v0/node-rpc/device-node-sessions` 经 relay 读到远端 node local server，`status=200`、`rpc=control_plane.device.node_sessions`。
  - Smoke 后远端进程残留检查为空；没有安装 systemd、没有改防火墙/安全组、没有开放公网端口。
- AWS v19 完成真实 `node doctor` / supervisor 只读验证：
  - Remote dir: `/home/ubuntu/aih-fabric-real-20260627-isolated-v19`。
  - 部署模式：`--skip-import --skip-start`，只同步当前源码和依赖缓存，不启动 server，不安装 service。
  - Source artifact: `ad447fa105b2b218913531600c6c2d1cf697c8368d97ec5130dcf63de0ba4aaf`，`26305489` bytes。
  - 远端 `AIH_CLI_PATH` 指向 v19 `bin/ai-home.js` 后，doctor 识别 `aih.ok=true`、`platform=linux/x64`、`services.relay.type=systemd-user`、`services.registryAgent.type=systemd-user`。
  - 隔离 home 未写 server config，doctor 正确报告 `management_key_missing`；两个 service 都是 `state=missing/running=false`，`nodeSupervisor.ready=false`。
  - v19 未留下新进程；只读检查发现 AWS 上仍有 v13-v16 旧 `server serve` 进程，未获确认前不停止。
- AWS v20 完成真实 `node service status` 产品入口验证：
  - Remote dir: `/home/ubuntu/aih-fabric-real-20260627-isolated-v20`。
  - 部署模式：`--skip-import --skip-start`，只同步当前源码和依赖缓存，不启动 server，不安装 service。
  - Source artifact: `ed232cc0c1ecbb9c63b1b7c1474ab328a77ddac46ce906d61f4bc01f17338db1`，`26307277` bytes。
  - 远端 `node bin/ai-home.js node service status --control-url http://127.0.0.1:19885 --node-id aws-v20 --json` 返回 `action=status`、`services.relay.type=systemd-user`、`services.registryAgent.type=systemd-user`、`supervisor.ready=false`。
  - v20 无残留进程；该命令是面向用户的统一节点长期在线状态入口，不再要求用户分别理解 relay service 与 registry agent service。
- AWS v21 完成真实 `node service install --dry-run` 产品入口验证：
  - Remote dir: `/home/ubuntu/aih-fabric-real-20260627-isolated-v21`。
  - 部署模式：`--skip-import --skip-start`，只同步当前源码和依赖缓存，不启动 server，不安装 service。
  - Source artifact: `412a2f1311c29181a536e9437076d3dd6b1296dac326e1c19eccf2151686fc87`，`26311266` bytes。
  - 远端 `node bin/ai-home.js node service install http://127.0.0.1:19886 --node-id aws-v21 --token-file ... --dry-run --json` 返回 `ok=true`、`dryRun=true`、`plan.writes=false`、`services=[relay,registryAgent]`。
  - v21 明确返回 `no-service-dir` 与 `no-v21-process`；没有写 systemd unit，没有启动后台进程。
- AWS v22 完成真实 `node service uninstall --dry-run` 回退入口验证：
  - Remote dir: `/home/ubuntu/aih-fabric-real-20260627-isolated-v22`。
  - 部署模式：`--skip-import --skip-start`，只同步当前源码和依赖缓存，不启动 server，不卸载 service。
  - Source artifact: `3d96dff582250a7cde53357ab8e3f5cd6ab06e25208521b29bf12a4644b6bdc7`，`26314708` bytes。
  - 远端 `node bin/ai-home.js node service uninstall --node-id aws-v22 --dry-run --json` 返回 `ok=true`、`dryRun=true`、`plan.writes=false`、`services=[registryAgent,relay]`。
  - v22 明确返回 `no-service-dir` 与 `no-v22-process`；没有写/删 systemd unit，没有启动后台进程。
- Server Profile 导入/导出/迁移功能已按用户决定于 2026-07-02 **整体移除**（UI 按钮、页面逻辑、`serialize/parse/import ProfileBundle` 服务函数、类型与相关测试全部删除）。客户端是薄壳，连到哪个 server 就完整用哪个（见 `19-server-context-closure-requirements.md`），不再提供 profile bundle 导入导出。
- 本轮重新按正确路径尝试 Claude worker：
  - 错误路径 `aih claude 4/5` 不应作为前端 worker 证据。
  - 正确路径 `node bin/ai-home.js claude --print ...` 显示 `Running claude (AIH Server)`，但超过 60 秒停在 `Waiting for claude to boot`，未产出审阅内容或 diff。
- 本地公网 HTTP ingress probe 仍失败：
  - `nc -vz -w 5 43.207.102.163 9527 -> TCP connect succeeded`
  - `curl --noproxy "*" --max-time 10 http://43.207.102.163:9527/readyz -> timeout with 0 bytes received`
- 已接受并实现 outbound broker routing 第一刀：
  - 新增 [12-outbound-broker-routing.md](12-outbound-broker-routing.md)，明确 direct public ingress 不再作为默认依赖；server/node/client 都应能走 outbound broker/relay。
  - `aih server` 同一 HTTP/WSS listener 支持 broker control WebSocket `/v0/fabric/broker/control` 和 broker proxy base `/v0/fabric/broker/servers/<serverId>/proxy`。
  - 新增 `aih fabric broker connect <broker-url> --server-id ID --token TOKEN --local-url http://127.0.0.1:9527`，用于 AIH Server 主动 outbound 注册到 broker。
  - 新增 `scripts/fabric-real-broker-smoke.js`，作为默认端口真实 broker smoke 入口；它不启动 server、不分配新端口，只连接已运行 endpoint，并通过 broker proxy 验证 readyz/descriptor/device-pair。
  - 新增 `scripts/fabric-real-broker-relay-smoke.js`，保持 broker outbound link 在线，再把 broker proxy base 作为 device/client endpoint 调用现有 outbound relay smoke。
  - Broker allowlist 第一阶段只开放 `/readyz`、Fabric descriptor/pair/registry 和 device node session API；不代理 `/v0/management/accounts` 或 `/v1/responses`。
  - 本地真实 socket 验证通过：`node --test test/fabric-broker-routing.test.js` -> 6/6 pass；真实 HTTP server + 真实 WebSocket broker control link 完成 readyz、descriptor、device-pair 和 `device-node-session-start` 代理。
  - 相关回归通过：`node --test test/fabric-broker-routing.test.js test/fabric-transport-echo.test.js test/fabric-registry-publish.test.js test/server-node-rpc-wiring.test.js test/root.router.test.js test/help.messages.test.js` -> 53/53 pass。
  - 本机默认 `127.0.0.1:9527` broker smoke 当前返回结构化失败 `phase=broker_connect` / `Unexpected server response: 404`，原因是正在运行的 `/opt/homebrew/bin/aih server serve` 进程尚未包含本轮 broker upgrade 路径；未停止或替换该本机服务。
  - AWS current 默认 `9527` broker relay + real Codex remote session 通过，证据：`docs/fabric/evidence/2026-06-27-outbound-broker-relay-aws-smoke.md`。
  - 本地协议证据：`docs/fabric/evidence/2026-06-27-outbound-broker-routing-local-smoke.md`。

当前结论：

- 当前部署纪律已经改为单一 `/home/ubuntu/aih-fabric-current`，后续不得再用 vNN / isolated 目录作为默认验证路径。
- Registry/agent/本机 TCP echo 的历史证据在 AWS v16 上成立；真实 outbound relay 管理链路、sessions RPC smoke、`/v1/responses` non-stream/stream、relay Codex 会话 cleanup、以及 broker proxy -> relay -> Codex 远程会话已在 AWS current 默认 `9527` 上验证成立；节点长期在线前置诊断和双服务 supervisor 汇总的历史证据在 AWS v19 上成立；面向用户的统一 `node service status` 入口历史证据在 AWS v20 上成立；受监督 `node service install` / `uninstall` dry-run 产品入口历史证据在 AWS v21/v22 上成立；Server Profile bundle 的本地迁移入口已成立；非 AWS 服务器只保留历史证据，不再继续验证。
- Raw public HTTP ingress 仍不成立，产品默认路线不能依赖开放高端口。
- 小水管部署路径已经从“每个 isolated deploy 都重传源码”推进到“稳定 source artifact 远端缓存复用”；受监督 node agent 已有统一 status、install dry-run 和 uninstall dry-run 入口，并已在 AWS current 默认 `9527` 完成真实 systemd user service 安装、重启、heartbeat 和 fresh measurement 验收；多客户端 Server Profile 已有无 secret bundle 迁移入口；outbound broker routing 已完成本地真实 socket 闭环、AWS current 默认端口真实远程会话闭环、Broker Profile 产品入口、broker link 断开诊断和同 `serverId` 恢复、Broker Profile 的真实浏览器 Server Setup smoke，以及真实可达 AWS broker endpoint 的跨主机 outbound-only Server Profile/node relay/Codex 远程会话验收。本机真实浏览器已完成 paired AWS server profile，Fabric Nodes 能从 AWS registry 看到 2 个真实 node/relay-node，AWS current 也已加入本地 SSH 开发机管理并通过连接/目录浏览。M3、M3.5、M4 和 M5 当前默认恢复 gate 已完成，native session command serialization 已用 AWS -> 本机真实 Codex run 验证；M6 软件侧 WebRTC/RPC/fallback gate 已完成，当前只剩按 `2026-06-28-m6-prerequisite-audit.md` 提供受控 TURN、HTTPS/H3 WebTransport endpoint 或真实 OpenMPTCPRouter/Linux underlay 后复测 promotion；不再卡 AWS 高端口 public ingress。

## M3 Todo Queue

后续新增 M3 需求先追加到这里，再按顺序推进：

| 顺序 | 状态 | 子项 | 当前证据 | 下一步验收 |
|---:|---|---|---|---|
| 7.1 | done | heartbeat 写入 relay measurement，Fabric Nodes UI 正确展示 relay health | `2026-06-27-m3-role-registry-measurement.md` | 作为后续 UI/agent 回归门保留 |
| 7.2 | done | 第二真实节点 evidence：至少区分 home/company 风格的 node + relay-node | `2026-06-27-m3-role-registry-two-nodes.md`：`local-mac-remote-node` + `aws-current-node` 两个真实 node/relay-node 已同屏展示 | 作为后续多节点 UI/registry 回归门保留 |
| 7.3 | done | 长期 daemon/service：registry agent + relay 自动在线 | `2026-06-28-m3-supervised-daemon-aws.md`：AWS current 默认 `9527` 已完成真实 `node service install --yes`、relay + registryAgent user systemd service active、`supervisor.ready=true`、重启后 fresh `aws-current-node-relay` measurement 为 `ws_echo_pass` / `20` samples / `successRate=1` / `p95=1ms`；同时修复 service `AIH_HOST_HOME` 传递、remote-node secret 缺失导致的 relay 401、server restart argv raw secret 泄露 | 作为后续 7.6、本地 Fabric Nodes 和远程开发会话的长期在线回归门保留 |
| 7.4 | done | relay health 强指标：p95 RTT、echo 成功率、失败原因 | `2026-06-27-m3-relay-health-strong-metrics.md`：AWS current 默认 `9527` WS echo 20/20 pass，latest measurement 和 `networkMeasurements` trace 均落盘，Fabric Nodes UI 显示 `p95`、`100% ok (20)`、`ws_echo_pass` | 作为后续 relay health/UI 回归门保留 |
| 7.5 | done | 节点页移动端/多节点真实浏览器回归 | `2026-06-27-m3-fabric-nodes-mobile-regression.md`：390x844 mobile viewport 真实配对 profile，两个节点可见，点击节点后详情可用，无横向溢出，console 0 issue | 作为后续移动端 UI 回归门保留 |
| 7.6 | done | 本地 AWS 可见性：完成本地 ready server profile，并将 AWS 加入 SSH 开发机管理 | `2026-06-28-m3-local-aws-visibility.md`：本地真实浏览器 Playwright `aih-76` 的 active server 为 `http://43.207.102.163:9527`、profile state 为 `paired`、Fabric Nodes 显示 `nodes=2` / `relayNodes=2` / `projects=2` / `runtimes=4` / `transports=2`，AWS Current Node 在线且 relay health 为 `p95 1ms · 100% ok (20) · ws_echo_pass`；本地 SSH 开发机包含 `AWS Current Japan` 和 `AIH Fabric Current` workspace，SSH test `status=reachable`，browse `/home/ubuntu/aih-fabric-current` 返回真实目录 | M3 完成；后续如果要让不同浏览器免重新配对，需要做共享本地 server-profile store |

## M4 Todo Queue

后续新增 M4 需求先追加到这里，再按顺序推进。详细设计以 [14-m4-remote-development-session.md](14-m4-remote-development-session.md) 为准。

| 顺序 | 状态 | 子项 | 当前证据 | 下一步验收 |
|---:|---|---|---|---|
| 8.0 | done | 删除旧 M4 路线和历史 M4 baseline 证据 | commit `9da184a` 删除旧路线、M4 baseline 证据和相关计划文案；全仓搜索无废弃 route 标识 | 作为后续防回归搜索门保留 |
| 8.1 | done | M4 远程开发会话设计冻结：拓扑、流程、功能矩阵、状态机、数据模型增量、协议边界、验收 gate | `14-m4-remote-development-session.md` 已落地 | 后续新增需求必须先追加到本 queue，再实现 |
| 8.2 | done | Session catalog + attach contract | `2026-06-28-m4-session-catalog-attach-contract.md`：新增 `session-catalog` / `session-attach` contract，本机 node、device-node relay、broker allowlist、relay client 和 descriptor 已覆盖；focused 82/82 + 26/26 pass | AWS current 真实打开/attach 仍在 8.6，不在 8.2 越级宣称 |
| 8.3 | done | Canonical command envelope：message、slash、approval_response、stop 分离 | `2026-06-28-m4-canonical-command-envelope.md`：新增 `session-command` / `device-node-session-command`，message/slash/approval_response/stop 独立类型，ack 带 commandId/idempotencyKey，broker/relay/server wiring focused 102/102 pass | AWS current 真实打开/attach/command 仍在 8.6，不在 8.3 越级宣称 |
| 8.4 | done | Event store + seq/ack/resume | `2026-06-28-m4-event-store-seq-ack-resume.md`：新增 session event store、`session-ack` / `device-node-session-ack`，events 带 `seq/cursor`，focused 109/109、full 2576/2576、本地默认 `9527` 真实会话 cursor resume 无重复且 ack accepted；AWS current 默认 `9527` 已部署 commit `5c51743`，descriptor 包含新能力，AWS -> `local-mac-remote-node` ack proxy 200 且 stale cursor 不回退 | 作为 event resume 回归门保留 |
| 8.5 | done | Approval and artifact lanes | `2026-06-28-m4-approval-artifact-lanes.md`：approval lane、artifact refs/fetch、lane-filtered resume 已落地并通过 focused/full tests | 作为后续 M5 recovery 回归门保留 |
| 8.6 | done | AWS current 真实 smoke | `2026-06-28-m4-aws-real-remote-session-smoke.md`：AWS current default `9527` 上真实 node invite、device pair、relay、Codex session start、event polling、artifact retrieval、marker output 和 cleanup 均通过 | 作为后续 AWS default `9527` 远程会话回归门保留 |
| 8.7 | done | Mobile/PWA smoke | `2026-06-28-m4-mobile-pwa-session-smoke.md`：真实 mobile viewport 通过 AWS start/attach/message/slash/cursor reconnect/artifact/stop；无 mock 数据 | M4 完成，作为 mobile/PWA session 回归门保留 |
| 8.8 | done | Native session command serialization guard | `2026-06-28-native-session-command-serialization-smoke.md`：`975badd` 为同一 native run 串行化 message/slash/approval/stop；AWS current default `9527` -> `local-mac-remote-node` 真实 Codex run 同时发送 message 与 `/status`，两条 command 均 HTTP 200，events 分离，`concatenationHits=[]` | 作为后续原生 GUI/TUI 客户端输入层回归门保留 |

## M6 Transport Promotion Queue

后续新增 transport promotion 需求先追加到这里，再按顺序推进。

| 顺序 | 状态 | 子项 | 当前证据 | 下一步验收 |
|---:|---|---|---|---|
| 11.1 | done | WebRTC DataChannel AWS signaling + STUN browser RTT | `2026-06-28-webrtc-datachannel-aws-smoke.md`：AWS current 默认 `9527` signaling、headed Chrome、STUN、`ICE connected`、DataChannel open、5 次 RTT，p95=`646.3ms` | 作为后续 phone/cross-machine/TURN/WebTransport 比较基线保留 |
| 11.2 | done | WebRTC phone/PWA 或第二真实设备参与同一 AWS signaling room | `2026-06-28-m6-webrtc-cross-machine-smoke.md`：本机 macOS offerer + AWS Ubuntu answerer 两台真实机器通过同一 AWS signaling room `rtc_zdGfUBArAYBmN0b0` 打开 DataChannel，5 次 RTT p95=`232.1ms`，selected pair 为 `srflx -> srflx`；首次失败缺 AWS browser runtime 已记录并修复 | 作为 TURN/WebTransport 比较基线保留；WebRTC 仍未设为默认 |
| 11.3 | partial | WebRTC TURN relay candidate 和失败诊断 | `2026-06-28-m6-turn-relay-diagnosis.md`：AWS UDP `9527` echo 超时，当前默认端口约束下不能承载受控 TURN；public TURN relay-only 域名/IP 两组测试均为 0 candidate，浏览器 ICE error 701，DataChannel 未打开 | 需要可达受控 TURN 端口/凭据或 Metered REST API iceServers 后复测；未有 relay candidate 前不设默认 |
| 11.4 | partial | WebTransport/QUIC smoke | `2026-06-28-m6-webtransport-quic-diagnosis.md`：产品页为 HTTP `insecure_context`，secure context 下浏览器有 `WebTransport` API 但 AWS `https://...:9527` opening handshake failed；当前 default `9527` 只有 HTTP/TCP，无 HTTPS/H3/QUIC listener | 需要真实 HTTPS/H3 WebTransport endpoint 后复测 connect time 和 stream RTT；未通过前不设默认 |
| 11.5 | done | Transport fallback decision gate | `2026-06-28-m6-transport-fallback-decision-smoke.md`：WebRTC candidate failure 可诊断；selector 拒绝 `webrtc_not_promoted` 并选择 relay；AWS broker proxy + relay + 真实 Codex session marker 通过 | 作为 WebRTC/WebTransport promotion 前的默认保护门保留 |
| 11.6 | done | WebRTC diagnostics surface productization | `2026-06-28-m6-webrtc-diagnostics-surface.md`：当前产品代码不再保留 WebRTC Lab 入口/命名；AWS current 默认 `9527` 已部署 diagnostics route，真实浏览器页面标题和真实 DataChannel smoke 均通过 | 作为后续 transport candidate 诊断入口保留；不改变默认 transport |
| 11.7 | done | Transport decision diagnostics and audit | `2026-06-28-m6-transport-decision-diagnostics.md`：真实 AWS `/v0/webui/nodes/:id/test` 证明 relay unavailable 也返回/audit `transportDecision`，WebRTC candidate 被拒绝为 `webrtc_not_promoted`，临时 node/transport 已清理 | 作为 M6 promotion 前的运行时可追溯保护门保留；不改变默认 transport |
| 11.8 | done | Multipath/MPTCP/OpenMPTCPRouter diagnosis | `2026-06-28-m6-multipath-mptcp-diagnosis.md`：真实本机 + AWS SSH + default `9527` 诊断证明 AWS Linux MPTCP capability 存在，但本机无通用 MPTCP socket、未检测到 OpenMPTCPRouter、default `9527` 是 plain AIH HTTP listener；verdict=`diagnostic_pass_promotion_blocked` | 作为后续 underlay candidate 诊断入口保留；需要真实 Linux/Linux 或 OpenMPTCPRouter topology 后才能复测 promotion |
| 11.9 | done | Aggregate promotion gate + relay fallback baseline | `2026-06-28-m6-transport-promotion-gate.md`：同一命令聚合 relay baseline、WebRTC、TURN、WebTransport、Multipath；AWS current 默认 `9527` 部署后 relay WS echo 20/20 p95=`114ms`，最终 relay-only live check p95=`107ms`，`fallbackReady=true`；高级 transport 仍为 `promotionReady=false` | 作为 M6 总保护门保留；下一步只能在受控 TURN、HTTPS/H3 WebTransport endpoint 或真实 OpenMPTCPRouter/Linux underlay 具备其一后复测 promotion |
| 11.10 | done | WebRTC DataChannel RPC adapter readiness | `2026-06-28-m6-webrtc-rpc-adapter-gate.md`：真实 AWS current 默认 `9527` signaling/DataChannel 上完成 `fabric.webrtc.echo` RPC frame 往返；部署后 responses=`5`、requestsHandled=`5`、RPC p95=`725.3ms`；M6 gate 不再输出 `remote_rpc_webrtc_adapter_not_*` blocker | 软件侧 adapter gap 已闭环；WebRTC promotion 剩余前置是受控 TURN relay candidate |
| 11.11 | done | M6 external prerequisite audit | `2026-06-28-m6-prerequisite-audit.md`：新增 `scripts/fabric-m6-prerequisite-audit.js`，post-deploy 真实 AWS audit 返回 `baseReady=true`、`promotionReady=false`、`readyTransports=[]`；AWS default `9527` pid=`247633`、registry readback `nodes=2 relayNodes=2 projects=2 runtimes=4 transports=2`、residue=`[]`；TURN 未配置、WebTransport connect failed、Multipath 阻塞为本机 MPTCP/OMR/default plain HTTP listener | 作为后续高级 transport 前置审计入口保留；没有受控 TURN/HTTPS-H3/OMR topology 前不再重复宣称 advanced promotion |
| 11.12 | done | Relay fallback durability guardrail | `2026-06-28-m6-relay-durability-gate.md`：新增 `scripts/fabric-m6-relay-durability-gate.js`；focused test 6/6 pass，其中包含真实 loopback WebSocket echo；clean HEAD 已部署到 AWS current 默认 `9527`，source artifact `3ad0b4eecbfff1005a4ed14c3cc847d3ea8e0cb78e5e525456e6ecef03f0493c`，server pid=`250901`；post-deploy preflight `ok=true`、registry readback `nodes=2 relayNodes=2 projects=2 runtimes=4 transports=2 nodeInventory=2`、residue=`[]`、remainingGate=`[]`；post-deploy durability gate `6/6` 轮、`120/120` echo、successRate=`100%`、p50=`104ms`、p95=`116ms`、p99=`117ms`、blockers=`[]` | 作为小水管默认 relay fallback 回归门保留；它不改变高级 transport promotion 状态 |
| 11.13 | done | Server-side transport readiness endpoint | `2026-06-28-m6-transport-readiness-endpoint.md`：新增 `GET /v0/fabric/transport/readiness`，需要 `nodes:read` device token；focused tests 20/20 pass，full `npm test` 2656/2656 pass；clean HEAD 已部署到 AWS current 默认 `9527`，source artifact `783f0a692ad965b82690c6c021dd69567baa022a1055f87088635a1c4807a2a5`，server pid=`252371`；未授权请求 HTTP `401`；授权读取全量返回 `nodes=2`、`defaultTransport=relay`、`fallbackReady=true`、advanced `promotionReady=false`；授权过滤 `aws-current-node` 返回 `nodes=1`、`relayMeasurementPass=true`、relay p95=`1ms`；`2026-06-29-m6-current-gate-readiness-recheck.md` 复测默认 profile readiness 仍为未授权 401/授权 200、默认 relay/fallback ready/promotion false，并把 CLI 人类可读标题从 `client smoke` 收敛为正式 readiness | 作为 WebUI/客户端解释“当前能用什么、为什么 advanced 不能默认”的只读产品入口；不改变高级 transport promotion 状态 |
| 11.14 | done | WebRTC candidate registry/readiness alignment | `2026-06-28-m6-webrtc-candidate-registry-readiness.md`：AWS current user-level registry agent 持久增加 `--transport webrtc=online`，保留 relay echo probe；最终 MainPID `265669` 的 argv、`PATH` 和 `AIH_HOST_HOME` 已验证；本地 paired profile 读回 registry `transports=3`，`aws-current-node.transportKinds=relay,webrtc`，readiness 不再出现 `webrtc_transport_candidate_not_registered`，promotion 仍被 `turn_relay_gate_not_ready` 阻塞 | 作为 WebRTC candidate/product-state 回归门保留；不改变默认 relay，也不宣称 TURN/WebRTC promotion 完成 |
| 11.15 | done | Product CLI promotion gate | `2026-06-29-m6-promotion-gate-cli.md`：新增 `aih fabric transport promotion-gate`，本地对 AWS current 默认 `9527` 真实运行 aggregate gate；relay `5/5` p95=`105ms`，WebRTC DataChannel/RPC p95≈`211ms`，`--fail-on-blocked --json` 返回 status `1` 且 report `ok=true exitOk=false`；clean HEAD 已同步 AWS，远端 focused tests 14/14 pass | 作为正式 promotion gate 入口保留；只有真实 TURN/HTTPS-H3/OMR 前置满足后才允许 promoted transport 改变默认 relay |
| 11.16 | done | Persistent external transport config | `2026-06-29-m6-transport-config.md`：新增 `aih fabric transport config show/set/clear`，配置只保存 TURN/WebTransport 探测输入且输出脱敏；`prerequisites` / `promotion-gate` 会读取配置，但显式 CLI/env 优先，配置不能把任何 transport 标记为 ready；本机真实写入 AWS WebTransport candidate 后 prerequisites 显示 `transportConfig.applied=[webtransport.url,webtransport.pageUrl]` 且仍 `promotionReady=false`，清理后 `transportConfig.present=false/applied=[]`；真实 promotion gate relay `5/5` p95=`109ms`、WebRTC/RPC p95≈`202ms`、默认仍为 relay；full `npm test` 2697/2697 pass；AWS current 远端 focused tests 11/11 pass | 作为后续接入真实 TURN/HTTPS-H3/OMR 参数的可追溯配置入口；没有真实外部前置时仍不晋级 advanced transport |
| 11.17 | done | Product CLI relay durability gate | `2026-06-29-m6-relay-durability-cli.md`：新增 `aih fabric transport relay-durability`，复用现有 relay durability gate；本地对 AWS current 默认 `9527` 真实运行 6 轮、120/120 echo、successRate=`1`、p95=`112ms`、p99=`115ms`、blockers=`[]`；full `npm test` 2701/2701 pass；AWS current 远端 focused tests 10/10 pass，远端本机默认 `9527` durability 2 轮 10/10、p95=`3ms` | 作为默认 relay fallback 稳定性回归门保留；不改变高级 transport promotion 状态 |
| 11.18 | done | Product CLI WebTransport diagnostics | `2026-06-29-m6-webtransport-cli.md`：新增 `aih fabric transport webtransport`，默认 browser channel 为 `auto`；本机对 AWS current 默认 `9527` 的真实 HTTPS/H3 WebTransport probe 显示 `isSecureContext=true`、`webTransportType=function`，但 opening handshake failed，blocker=`webtransport_connect_failed`；`--fail-on-blocked` status=`1` 且 report `ok=true exitOk=false`；full `npm test` 2708/2708 pass；AWS current 远端 focused tests 11/11 pass，默认 auto 使用 bundled Chromium 对 `127.0.0.1:9527` 真实返回同一 blocker | 作为 WebTransport/H3 前置诊断入口保留；仍需要真实 HTTPS/H3 endpoint 后才能复测 promotion |
| 11.19 | done | Product CLI TURN relay diagnostics | `2026-06-29-m6-turn-relay-cli.md`：新增 `aih fabric transport turn-relay`，当前未配置受控 TURN 时真实返回 `probe=null`、`gate.ran=false`、blocker=`turn_ice_server_not_configured`，`--fail-on-blocked` status=`1` 且 report `ok=true exitOk=false`；focused tests 15/15 pass；full `npm test` 2715/2715 pass；AWS current 远端 focused tests 15/15 pass，默认 `127.0.0.1:9527` 返回同一 blocker | 作为 TURN relay 前置诊断入口保留；仍需要真实 TURN URL/username/credential 后才能跑 relay-only candidate promotion |
| 11.20 | done | Post-CLI promotion readiness recheck | `2026-06-29-m6-post-cli-promotion-readiness-recheck.md`：所有正式 transport CLI 入口闭环后复跑 AWS current 默认 `9527`；`prerequisites` 返回 `baseReady=true`、`promotionReady=false`、`readyTransports=[]`；`promotion-gate` 返回 relay fallback `20/20` p95=`109ms`、WebRTC DataChannel candidate ready、RPC responses=`3/3` p95=`198.8ms`，advanced blockers 仅剩 TURN/WebTransport/MPTCP/OMR 外部前置 | 当前软件侧入口和 gate 已闭环；下一步必须提供真实 TURN、HTTPS/H3 WebTransport endpoint 或 OpenMPTCPRouter/Linux underlay 之一后复测 promotion |
| 11.21 | done | Default-port self-hosted TURN UDP gate | `2026-06-29-m6-turn-default-udp-gate.md`：`prerequisites` 已内置默认 UDP `9527` reachability probe；AWS current 能 bind UDP `9527`，但本机到 AWS UDP echo 超时，summary 新增 `turn:turn_default_udp_9527_unreachable`；strict gate status=`1`；full `npm test` 2717/2717 pass；AWS current 远端 focused tests 12/12 pass | 默认端口自托管 TURN 当前不可晋级；仍需要可达受控 TURN、云侧放通 UDP `9527`/relay path，或外部 TURN URL/username/credential 后复测 |
| 11.22 | done | UDP edge snapshot in default TURN gate | `2026-06-29-m6-udp-edge-snapshot.md`：`prerequisites` / `promotion-gate` 的默认 UDP `9527` probe 现在记录 AWS route/interface/public IP/host firewall/security group IDs；真实 AWS 显示 `enp39s0`、`172.31.47.163`、`43.207.102.163`、`ufw inactive`、`iptables INPUT ACCEPT`、`hostFirewallBlocksUdp=false`、SG IDs `sg-01e33f3412fabfded,sg-01e7f50a205d7b308`，同时 packet capture 仍为 0 packets；本地 focused 33/33 pass，full `npm test` 2724/2724 pass，AWS focused 33/33 pass | 当前不是 AIH Node.js 进程或实例内防火墙收包问题；下一步只能调整 AWS SG/NACL/provider UDP path，或配置真实受控 TURN 后复测 promotion |
| 11.23 | done | Product CLI cloud-edge preflight | `2026-06-29-m6-cloud-edge-preflight.md`：新增 `aih fabric transport cloud-edge`，真实 AWS current 默认 `9527` 输出 `cloudEdgeReady=false`、`packetArrivalCaptured=false`、`hostFirewallBlocksUdp=false`、`cloudApiCredentialsReady=false`；blockers=`turn_default_udp_9527_unreachable,aws_public_udp_path_blocked,aws_cli_missing,aws_iam_role_missing`，strict status=`1`；本地 focused 18/18 pass，full `npm test` 2731/2731 pass，AWS focused 18/18 pass | 剩余动作已收敛为云边界/外部前置：给实例或本地提供只读 AWS API 能力后查 SG/NACL，或直接配置真实可达 TURN/HTTPS-H3/OMR path 后复测 promotion |
| 11.24 | done | Product CLI transport status aggregate | `2026-06-29-m6-transport-status-cli.md`：新增 `aih fabric transport status`，默认聚合 paired readiness 与 cloud-edge preflight；真实 AWS current 默认 `9527` 返回 `status=usable_partial`、`remoteDevelopmentReady=true`、`defaultTransport=relay`、`fallbackReady=true`、`relayMeasurementPass=true`、`advancedPromotionReady=false`、`cloudEdgeReady=false`、`cloudApiCredentialsReady=false`，strict status=`1`；`--with-promotion-gate --skip-webtransport --skip-multipath --skip-webrtc` 真实返回 relay `20/20` p95=`113ms`、promotion blockers=`turn:turn_ice_server_not_configured,turn:turn_default_udp_9527_unreachable`；本地 focused 18/18 pass，full `npm test` 2737/2737 pass，AWS focused 18/18 pass | 当前单命令已经能回答“能不能用、缺什么、下一步做什么”；M6 仍只剩受控 TURN/HTTPS-H3/OMR 或云边界放通这类外部前置，未满足前继续保持 relay 默认 |
| 11.25 | done | Direct WebRTC promotion opt-in gate | `2026-06-29-m6-direct-webrtc-promotion.md`：真实 AWS current 默认 `9527` 在 `--allow-direct-webrtc-promotion --skip-webtransport --skip-multipath` 下返回 `promotionReady=true`、`promotedTransports=["webrtc"]`、`defaultTransport=webrtc`、blockers=`[]`；WebRTC selected pair `srflx -> srflx`，DataChannel p95=`200.9ms`，RPC p95=`200.5ms`；同参数 `transport status --with-promotion-gate` 返回 `status=complete`、`advancedPromotionReady=true` | 作为 direct WebRTC 显式晋级 gate 保留；TURN/WebTransport/MPTCP/OMR 仍按各自前置复测，不用 direct pass 冒充 relay-only TURN pass |
| 11.26 | done | WebRTC management RPC runtime selector + readiness fallback semantics | `2026-06-29-m6-webrtc-rpc-adapter.md`：`0b0a57b` clean HEAD 和后续 `7ab862e` readiness fix 已同步 AWS current 默认 `9527`，最终 clean artifact sha256=`4fe98f6b7663b6b8e99b50eafb0764fe851c24a857e27da4f472646d6a72dcf8`；server pid `317768`、relay pid `317794`、registry agent pid `315696`、webrtc connector pid `319046`；真实 `/v0/webui/nodes/aws-current-node/test` 选择 `aws-current-node-webrtc`、`fallbackUsed=false`、HTTP status `200`；`transport readiness` 返回 `defaultTransport=webrtc`、`fallbackReady=true`、`relayMeasurementPass=true`、`promotedTransports=["webrtc"]`；`transport status` 返回 `status=complete`、`remoteDevelopmentReady=true`；本地/AWS focused readiness+WebRTC tests 均 51/51 pass，本地 daemon preflight 返回 `remainingGate=[]` | WebRTC 已可作为有 open session 时的真实 management RPC data plane；relay fallback 同时保持可见和可用。剩余未完成项只属于外部前置：受控 TURN、HTTPS/H3 WebTransport endpoint、OpenMPTCPRouter/MPTCP underlay 或 AWS UDP/cloud edge 放通 |
| 11.27 | done | AWS node opencode live session + completed-run resume | `2026-06-29-aws-opencode-live-closure.md`：当前 AWS `/readyz ready=true`，`aws-current-node` 授权 readback 为 `runtimeHost=true` 且 `start-session:opencode=enabled`；真实 `fabric session start aws-current-node --provider opencode` 走 `selectedTransportKind=webrtc/fallbackUsed=false`，marker `AIH_AWS_OPENCODE_LIVE_OK_20260629` 命中；同一 completed run 的 `fabric session message` 返回 `resumed=true`、新 runId、同 `sessionRef`，marker `AIH_AWS_OPENCODE_RESUME_LIVE_OK_20260629` 命中；最终 events 在 WebRTC session closed 后落到 relay fallback 且可追溯 | 作为“本地客户端实际管理 AWS node 项目并对话”的当前回归门；Codex/Claude/AGY 在 AWS 上仍按 `provider_account_unavailable` 阻断，TURN/WebTransport/MPTCP 仍是独立外部前置 |
| 11.28 | done | Closure verify workflow entry | `2026-06-30-business-stream-and-failure-ledger.md`：新增 `aih fabric closure verify`，作为业务闭环 -> 串流证明 -> failure ledger -> repeat-prevention 的正式入口；真实 AWS current 默认 `9527` verify 通过，run `d2a95f7c-a3c1-497d-9459-4d525f125ebd`、session `ses_0eb6ecdf7ffeie8cPsUENtd8Kq`、events=`ready/session-created/delta/result/done`、`selectedTransportKind=webrtc`、`fallbackUsed=false`、`workflow=closure_verify` 已写入 diagnostics | 后续排障先跑 `closure verify` 判断业务是否已闭环；当 `automation.state=awaiting_external_input` 且 `runnableCount=0` 时，不再重复空跑同一链路，改推进对应外部前置 |

## 2026-06-26

已完成：

- Fabric 立项和设计包初版。
- 角色叠加模型：client、server、node、relay node、agent runtime。
- server-first 客户端流程：未配置 server 时不得直接进入旧 WebUI。
- 公司/家里互管 walkthrough。
- command/output + semantic 双层协议草案。
- Provider runtime 交互能力边界：MVP 承诺消息、slash、审批和会话恢复；GUI bridge 进入后续独立 contract。
- 数据模型补齐 audit、relay link、transport session、network measurement、evidence run。
- Transport promotion gate：WSS、WebRTC、WebTransport/QUIC、multi-relay、OpenMPTCPRouter/MPTCP。
- 从立项到发布的 Fabric 阶段门和追溯规则。
- 旧 Control Plane/remote node 到 Fabric 的迁移映射。
- 项目内协作 skills：
  - `docs/fabric/skills/aih-codex-implementer`
  - `docs/fabric/skills/aih-claude-architect-reviewer`
  - `docs/fabric/skills/aih-claude-frontend-worker`
- Fabric transport CLI 初版：
  - `aih fabric transport probe`
  - `aih fabric transport tcp-echo`
  - `aih fabric transport tcp-echo-server`
  - `aih fabric transport echo`
  - `aih fabric transport echo-server`
- M2 Server Profile 解耦第一刀：
  - Web client 启动时检查 ready server profile。
  - 未 paired / 缺 device token 时重定向到独立 `/ui/server-setup`。
  - `/ui/server-setup` 提供 pair URL/code、endpoint 探测、profile 列表、ready 后进入工作台。
  - Server 公开 `/v0/fabric/descriptor` 和 `/v0/fabric/device-pair`，新 invite URL 指向 `/ui/server-setup`。
  - 前端 Server Setup 优先读取 Fabric descriptor / pairing endpoint，再落到现有 profile store。
  - 侧栏和移动顶部显示当前 server selector。
  - 旧 `Settings -> 控制面` 保留为高级设置入口，不再作为默认 first-run 页面。
- M1 WebRTC Signaling Lab 第一刀：
  - Server 公开 `/v0/fabric/webrtc/signaling/rooms` 和 room messages endpoint。
  - Web UI 新增 `/ui/fabric/webrtc-lab`，可创建 room、生成 answerer 分享 URL、展示 connection/ICE/signaling/candidate/signal 诊断状态。
  - Answerer 通过 `room&role=answerer` URL 自动启动，避免只打开页面但没有 join。
  - 2026-06-26 当时只证明 signaling 和 UI 状态机；2026-06-28 已补 AWS current + STUN + headed Chrome 的 DataChannel open/RTT evidence，但完整 phone/cross-machine/TURN gate 仍未完成。
- M3 Role Registry Server API 第一刀：
  - Server 公开 `/v0/fabric/registry` 和 `/v0/fabric/registry/nodes`。
  - Node registration 可声明 `node` / `relay-node` 角色、projects、runtimes、transport endpoints 和 relay capacity。
  - 写入需要 `nodes:write` device token；读取需要 `nodes:read`。
  - Fabric registry 写入 `fabric-registry.json`，同时把兼容的 node/relay transport 镜像到旧 remote registry。
- M3 Role Registry Publisher 第一刀：
  - 新增 `aih fabric registry publish <server-url> --token TOKEN ...`。
  - 支持 `--node-id`、`--relay-node`、`--bandwidth-kbps`、`--project`、`--runtime`、`--transport`、`--json`。
  - 当前只发送一次 node snapshot，不保存 token、不安装服务、不启动 daemon。
- M3 Real Registry Publisher 第二刀：
  - `aih fabric registry publish` 新增 `--from-server`，从目标 server 的真实 `/v0/management/accounts` 推导 API runtimes。
  - Fabric runtime provider 白名单补入 `gemini`，避免真实账号池中的 Gemini 被 registry 丢弃。
  - 新增 `scripts/fabric-real-vps-registry-publish.js`，用于远端本机创建 device invite、发布真实 node+relay-node snapshot、读回 Fabric registry 和旧 node view，输出脱敏证据。
- M3 Registry Heartbeat 第三刀：
  - Server 新增 `POST /v0/fabric/registry/heartbeat`。
  - 新增 `aih fabric registry heartbeat <server-url> --node-id ID ...`。
  - Heartbeat 只更新 node/relay/transport liveness，不替换已发布的 projects/runtimes。
  - Heartbeat 使用 `nodes:write` device token，并校验 node owner device。
  - 真实 VPS registry evidence runner 已扩展为 publish 后立即 heartbeat，再读回 registry 和旧 node view。
- M3 Foreground Registry Agent 第四刀：
  - 新增 `aih fabric registry agent <server-url> --node-id ID ...`。
  - Agent 复用 heartbeat sender，按 interval 循环上报 node/relay/transport liveness。
  - 支持 `--count` / `--once`，用于真实 smoke 时有限循环，不留下后台进程。
  - 当前是前台进程，不安装 systemd/launchd，不保存 token，不改系统配置。
  - 真实 VPS registry evidence runner 已扩展为 publish -> heartbeat -> agent `--count 2` -> registry readback。
- M3 Registry Agent Transport Probe 第五刀：
  - `aih fabric registry agent` 新增 `--probe-transport kind=url`。
  - Agent 每轮 heartbeat 前执行真实 transport probe，并让 probe 结果覆盖同 kind 的手填 health。
  - probe 结果只输出 `kind/health/error/duration/status`，不回显完整 URL。
  - 真实 VPS registry evidence runner 默认探测 `relay=http://127.0.0.1:<port>/healthz`。
  - 这证明 agent 可接入真实测量，但还不是跨机器 relay/data-plane echo。
- 小水管真实部署优化：
  - `scripts/fabric-real-vps-deploy.js` 增加远端 Node runtime 缓存，按 sha256 校验后复用。
  - 增加远端 `node_modules` 缓存，缓存 key 来自本地 `package.json + package-lock.json`。
  - 目标是让 2-3Mbps VPS 不再每次 evidence 部署都重传 29-30MB runtime 或重跑完整 npm install。
  - 仍不安装系统包、不改 systemd、不改防火墙/安全组。

真实证据：

- `docs/fabric/evidence/2026-06-26-vps-ssh-baseline.md`
  - `root@39.104.59.31` 可 SSH，且有 node/curl/python3。
  - `opc@152.70.105.41` 和 `ubuntu@155.248.183.169` TCP 22 可达，但 SSH banner 8s/25s 超时，暂不适合作为首批 relay 安装目标。
  - `aih fabric transport probe` 已验证三台 VPS 的 TCP 22 都可达。
- `docs/fabric/evidence/2026-06-26-legacy-remote-node-source-audit.md`
  - 旧实现是 Control Plane hub-and-spoke，不是 Fabric 终态。
  - `node-router`、`relay-client`、`relay-server`、`remote-gateway` 可作为 Fabric WSS/relay baseline 资产复用。
  - `/test` 只能证明管理链路，不等于真实 provider runtime session 成功。
- `docs/fabric/evidence/2026-06-26-ws-echo-lab.md`
  - 本地 `fabric transport echo-server` + `fabric transport echo` 已跑通，能产出 RTT。
  - 本地 `fabric transport tcp-echo-server` + `fabric transport tcp-echo` 已跑通，能验证 raw TCP 应用数据往返。
  - `39.104.59.31` 上 Node 可用但缺 `ws`；未安装依赖。
  - `39.104.59.31:18768` 公网 TCP 可达，但 HTTP/WS 应用层超时，不能作为 WSS baseline 通过。
  - `39.104.59.31:18770` 公网 TCP probe 可达，但 raw TCP echo 失败，远端临时进程没有收到 `conn/data` 日志，说明高端口路径不能作为 relay baseline。
- `docs/fabric/evidence/2026-06-26-server-profile-gate-smoke.md`
  - `npm run web:build` 通过。
  - 无 ready server profile 打开 `/ui/` 会进入 `/ui/server-setup`，不会直接进入 Dashboard/Chat。
  - 侧栏配置入口指向 `/ui/server-setup`；高级控制面仍可从 `/ui/settings?tab=control-planes` 进入。
  - 模拟 paired profile 后访问 `/ui/chat` 不被 gate 误拦，server selector 显示 `Ready Smoke`。
- `docs/fabric/evidence/2026-06-26-fabric-server-endpoint-smoke.md`
  - `server fabric descriptor and device pair endpoints support server setup onboarding` 通过。
  - `/v0/fabric/descriptor` 返回 `service=aih-fabric`。
  - `/v0/fabric/device-pair` 可消费 invite 并返回 device token。
  - 新生成的 invite `pairUrl` 指向 `/v0/fabric/device-pair`，`webPairUrl` 指向 `/ui/server-setup`。
- `docs/fabric/evidence/2026-06-26-fabric-browser-pairing-smoke.md`
  - 真实 Playwright Chromium 打开 `/ui/server-setup?pair=...` 后自动配对成功。
  - ready profile 显示 `1 READY` / `1 PROFILES`。
  - smoke server 隔离项目快照后显示 `0 会话`，不再泄露宿主历史会话数量。
  - 点击 `进入工作台` 后进入 `/ui`，没有被 gate 拉回 setup 页面。
  - 浏览器 console warning/error 为 0。
- `docs/fabric/evidence/2026-06-26-webrtc-signaling-lab.md`
  - `fabric-webrtc-signaling` store/server wiring 定向测试通过。
  - `npm run web:build` 通过，只有既有 Vite chunk size warning。
  - Playwright 浏览器完成 Server Setup 配对后进入 `/ui/fabric/webrtc-lab`。
  - Offerer/answerer 完成 `offer,candidate,candidate,ready,answer,candidate,candidate` 信令交换。
  - 浏览器 console warning/error 为 0。
  - DataChannel 未 open；同页最小 `RTCPeerConnection` 自检也停在 `connecting/checking`，因此 verdict 为 `partial`。
- `docs/fabric/evidence/2026-06-26-role-registry-server-api.md`
  - `fabric-role-registry` 单测通过。
  - Server wiring 测试通过：未授权写入 401，`nodes:write` 可注册 node，`nodes:read` 可读取 registry。
  - 注册结果包含 node roles、project、runtime、relay metadata。
  - 原始机器指纹不出现在 registry 序列化结果中。
  - `/v0/node-rpc/device-nodes` 能读到 mirrored relay node，迁移期兼容成立。
- `docs/fabric/evidence/2026-06-26-registry-publisher-smoke.md`
  - `node scripts/fabric-registry-publish-smoke.js` 通过。
  - 隔离 server pair 成功，CLI publisher 退出码 0。
  - Registry counts: nodes=1、relayNodes=1、projects=1、runtimes=2、transports=1。
  - 旧 `/v0/node-rpc/device-nodes` 能读到 `local-dev-smoke` mirrored node。
- `docs/fabric/evidence/2026-06-26-real-vps-deploy-attempt.md`
  - 不使用 mock registry；已把当前 worktree 和真实账号导出包传到 `root@39.104.59.31:/root/aih-fabric-real-20260626-215410`。
  - 账号导出包 hash 本地/远端一致：`9ad393b02850a8c2623576588757b8ef59718c16aab71a744e152d351367c99f`。
  - 远端 root `npm install` 通过；显式 `npm run web:build` 在 1.6GB 弱机上停在 Vite/Rollup 阶段并导致 SSH banner 超时。
  - `39.104.59.31:9527/8317` TCP 可达，但 HTTP `/healthz` 和 `/v0/fabric/descriptor` 为 5s 后 502 空响应，不能算 AIH server running。
  - 本轮尚未完成远端 `aih import`、本次版本 server 启动、真实 registry publish。
  - 真实 `aih claude -p` 前端 worker 尝试超过 60s 停在 `Waiting for claude to boot`，没有产出前端 patch；不能伪装成稳定非交互 worker。
  - 新增 `scripts/fabric-real-vps-deploy.js`，恢复后按本地 build、远端 `npm install --ignore-scripts`、真实账号导入、临时 server 启动继续，避免弱 VPS 再跑 Vite build。
- `docs/fabric/evidence/2026-06-26-real-japan-vps-deploy.md`
  - `ubuntu@155.248.183.169` 和 `opc@152.70.105.41` 均已完成真实部署：源码/Web dist、Node runtime、当前账号导出包上传，远端 `npm install --ignore-scripts`，远端 `aih import`，临时 server 启动。
  - 两台 VPS 的账号包 hash 与本地一致：`14b8f3dd4745dc3ae1f6d3bd65aa3e7f604042a7a7c578abe1148f69e3c48bd2`。
  - `155` 使用官方 `node-v22.16.0-linux-x64`；`152` 使用 `node-v22.16.0-linux-x64-glibc-217` 兼容 CentOS 7 / glibc 2.17。
  - 两台远端本机 `/healthz`、`/v0/fabric/descriptor`、`/ui/` 均 HTTP 200。
  - 两台公网 `18080` 互访失败：`155 -> 152` 为 `No route to host`，`152 -> 155` 为 timeout；主因是 firewall/cloud ingress 未放行 18080，而不是 AIH server 未启动。
  - 本轮没有改 systemd、没有安装系统包、没有改防火墙、没有删除远端目录。
- `docs/fabric/evidence/2026-06-26-real-vps-refresh-and-claude-worker.md`
  - 复测 `ubuntu@155.248.183.169` 和 `opc@152.70.105.41` 远端本机 `/healthz`、`/v0/fabric/descriptor` 仍为 HTTP 200。
  - `39.104.59.31` TCP 22/8317/9527 可达，但 SSH 仍在 banner exchange 阶段超时；当前不能作为可管理部署目标。
  - `aih claude 4 -p "只输出 ok"` 真实通过；复杂 Fabric 前端审查也真实完成，发现 WebRTC Lab log key、share URL endpoint、Server Setup probe gate 三个问题。
  - 回归通过：runtime focused 118/118、`web-account-auth + fabric-real-vps-deploy` 50/50、Fabric/server wiring 44/44、`provider-launch-strategy` 27/27、全量 `npm test` 2417/2417。
- `docs/fabric/evidence/2026-06-27-real-vps-claude-worker-and-isolated-deploy.md`
  - 三台 VPS 使用真实账号导出包完成 v3/v4 隔离部署，导入均为 `imported=15 duplicates=0 invalid=0 failed=0`。
  - v3 验证修复 flat OAuth credential import 后，三台 server runtime pool 均为 `codex=3, gemini=1, claude=4, agy=7`。
  - 本地公网 HTTP ingress probe 对三台 VPS 均 timeout；远端 Node 监听 `0.0.0.0:<port>`，问题不在 Node bind，而在公网 ingress/安全组/防火墙/overlay 层。
  - v4 在 `152.70.105.41` 与 `39.104.59.31` 上完成真实 registry publish：node+relay-node、projects=1、runtimes=4、transport=relay，runtime providers 来自真实 `/v0/management/accounts`。
  - `155.248.183.169` v4 已部署并导入 15 账号，但后续 SSH health/script copy 连续 banner timeout，因此 registry publish 未验证。
  - v8/v5 后续补齐三台真实 registry publish + heartbeat：
    - `155.248.183.169:18881` -> `vps-155-jp-v8`
    - `152.70.105.41:18882` -> `vps-152-jp-v8`
    - `39.104.59.31:18583` -> `vps-39-cn-v5`
  - 三台 registry readback 均为 `nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4`，runtime providers 为 `codex/gemini/claude/agy`，transport 为 `relay:online`。
  - `152` 和 `155` 的 v8 部署均命中 `node-runtime-cache-hit` 与 `node-modules-cache-hit`，真实导入均为 `imported=15 duplicates=0 invalid=0 failed=0`。
  - 最新本地公网 HTTP ingress probe 对 `18881/18882/18583` 仍全部 timeout，说明默认产品路径不能依赖 raw public HTTP ingress。
  - v9 使用当前代码重新部署三台 VPS：
    - `155.248.183.169:18981` -> `vps-155-jp-v9`
    - `152.70.105.41:18982` -> `vps-152-jp-v9`
    - `39.104.59.31:18983` -> `vps-39-cn-v9`
  - 三台 v9 均命中 `node-runtime-cache-hit` 与 `node-modules-cache-hit`，真实导入均为 `imported=15 duplicates=0 invalid=0 failed=0`。
  - 三台 v9 均完成 registry publish + heartbeat + foreground agent `--count 2`：`agent.attempts=2, agent.failures=0`，lastCounts 仍为 `nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4`。
  - 最新本地公网 HTTP ingress probe 对 `18981/18982/18983` 仍全部 timeout。
  - v10 使用当前代码重新部署三台 VPS，并启用真实 agent transport probe：
    - `155.248.183.169:19081` -> `vps-155-jp-v10`
    - `152.70.105.41:19082` -> `vps-152-jp-v10`
    - `39.104.59.31:19083` -> `vps-39-cn-v10`
  - 三台 v10 均有远端 runtime cache 与 node_modules cache；账号池均为 `total=15`，provider 分布为 `codex=3, gemini=1, claude=4, agy=7`。
  - 三台 v10 均完成 registry publish + heartbeat + foreground agent `--count 2`，`agent.probes` 均为 `relay:online:reachable`，探测耗时分别约 4ms、3ms、14ms。
  - v10 registry readback 均为 `nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4`，runtime providers 为 `codex/gemini/claude/agy`，transport 为 `relay:online`。
  - 最新本地公网 HTTP ingress probe 对 `19081/19082/19083` 仍全部 timeout。
  - 本轮再次真实尝试 `aih claude` 前端只读审阅，仍卡在 `Waiting for claude to boot` 超 90 秒；没有 Claude 输出或 Claude 生成的 diff。

当前下一步建议：

1. 不重复 M3/M4/M5 默认切片；它们已由上方 queue 和 2026-06-28 证据闭环。
2. M6 direct WebRTC 已在 AWS current 晋级为当前可用 data-plane；TURN relay、HTTPS/H3 WebTransport endpoint、OpenMPTCPRouter/Linux underlay 仍按各自外部前置独立复测，不能用 direct WebRTC 结果冒充这些路径通过。
3. 当前 AWS 默认 data-plane 是 WebRTC，relay fallback 仍必须保持可见和可用；promotion 过期、WebRTC session closed 或 connector 不可用时，relay fallback 是小水管稳定兜底。
4. 新增产品里程碑必须先追加到本文件对应 queue，再实现、真实验证、落证据和 scoped commit。

注意：

- 当前 `fabric transport probe` 只证明 TCP/HTTP 网络可达；`tcp-echo` 才证明应用数据能往返；HTTP `serviceHealthy=false` 时不能当作 Fabric endpoint 可用。
- WebRTC direct data-plane 当前已晋级并通过真实 AWS opencode 会话；WebTransport/TURN relay/MPTCP 仍必须在各自 gate 通过前保持 candidate 或 blocked 状态。
- M2/M3/M4/M5 当前默认切片已完成；旧 M2/M3 partial 说明只作为历史追溯保留，不代表当前状态。
- 当前 AWS-only 策略不再使用旧 `152/155/39.104` 服务器做新验证；它们只保留历史证据。
- AWS current node 当前是 provider runtime host；只是 Codex/Claude/AGY 账号不可调度。当前真实可用 provider 是 `opencode`，不要把其他 provider 的 auth blocker 误判为控制面/relay 失败。
- `docs/fabric/skills/*` 是项目内 skill；如果运行器不自动发现，需要显式传路径或安装到 Codex skills 目录。
- 当前 `aih claude -p` 最小 smoke 和一次复杂前端审查已真实通过，但复杂任务首 token 慢；后续前端 patch 应明确由 `aih claude` 执行并记录命令/evidence，再由 Codex 做验收。
