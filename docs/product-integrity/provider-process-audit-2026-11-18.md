# AIH provider process audit — 2026-11-18

## Scope and evidence boundary

Read-only process/parent/start/executable, listener, native log and SQLite projections were collected on macOS and the authorized AWS/Windows/Linux hosts. The only mutations were retirement of this delivery task's own three idle private acceptance instances. No new test cases, production restart, binary replacement, provider configuration change or browser command was performed. Process counts are point-in-time observations, not a leak verdict or the earlier memory incident's peak.

Private evidence root: `~/.ai_home/retained-evidence/codex-runtime-20261118/`. State files can contain management credentials; do not publish them or raw process environments. Sanitized evidence filenames are given below.

## `.aih-original` and the current launch topology

`codex` is the AIH hook/wrapper; the observed `codex.aih-original` executable is the retained official upstream program, not the wrapper. Multiple process instances do not imply multiple installations.

The 03:56 +08 snapshot and 04:10 post-retirement reconciliation found eleven live Codex terminal chains, including this audit session. All eleven terminal chains had live tmux panes; detached does not mean ownerless:

```text
tmux pane
  Node codex-app-server-stdio-proxy.js
    official codex.aih-original terminal (--remote)
    AIH Go local app-server bridge
      official codex.aih-original app-server (--listen stdio://)
        provider/plugin MCP subprocesses
```

The current local handler starts an official app-server for each accepted WebSocket connection and closes it when the connection ends (`internal/host/codexlocalappserver/handler.go:80-98`). It does not share a resident backend between independent CLI terminal chains. AIH Web Chat already has a different, in-process pool keyed by `RuntimeScope + RuntimeFingerprint`, with explicit leases and idle retirement (`internal/runtime/chatruntime/codex_client_pool.go:47-81`). That is an existing design reference, not evidence that terminal backend sharing is implemented.

Counts after this task's cleanup:

| Role | Count | Disposition |
| --- | ---: | --- |
| Formal AIH Go server | 1 | Retain; PID84956, port9527 |
| Codex terminal UI | 11 | Retain; separate live user/agent terminal chains |
| Codex official app-server | 11 | Backend reuse/lazy startup candidate; not proven orphaned |
| AIH Node Codex wrapper | 11 | Compatibility-layer optimization candidate |
| AIH Go Codex local bridge | 11 | Includes `aih-server __codex-local-app-server`; not eleven formal services |
| Security MCP | 23 | Live app-server ancestry/pipes; not safe to kill from count alone |
| Xcode MCP | 23 | Investigate demand-based activation; not all are iOS tasks |
| Xcode npm launchers | 23 | Plugin launch chain overhead; no separate AIH service owner |
| OpenCode daemon | 1 | Unneeded discovery residual identified below; not stopped |
| CodeBuddy persistent supervisor | 1 | Retain; live provider pane/child |

Additional retained processes: Claude terminal56517; CodeBuddy supervisor79157/CLI79158; interactive `aih-go ss` selectors31863/90090 attached to `/dev/ttys015` and `/dev/ttys017`; the existing shared Edge Playwright bridge12545. The selectors are user-terminal processes, not an unsolicited provider harness. The bridge was not stopped or used for browser commands.

MCP process multiplicity can include additional agent contexts. Backend69122 alone has six Security/Xcode launch groups, but it is still alive and the streams remain connected. The plugin manifest in build-ios-apps declares `npx -y xcodebuildmcp@latest mcp`, explaining the npm + Node pair; codex-security declares a stdio launcher. These are plugin/runtime launch declarations, not proof of AIH eagerly starting every provider. No global plugin settings or active MCP streams were modified.

Evidence: `provider-process-audit-20261118T035651+0800.json`, `provider-process-post-cleanup-20261118.json`, `provider-process-source-findings-20261118.json`.

## OpenCode: exact unintended startup attribution

- PID69411, PPID1, start **2026-11-17 14:01:07 +08**, `/Users/model/.opencode/bin/opencode serve --service`, loopback listener49374.
- Its HOME belongs to a CodeBuddy auth projection, not an OpenCode user terminal. CodeBuddy PID46427 is no longer present.
- CodeBuddy native log line24872 records tool call `01a1e818-456c-77f7-ac8a-5814d788a272` executing `opencode run --help` and `opencode models`.
- OpenCode's own log records `models` at `06:01:07.310Z`, then `serve --service` at `06:01:07.353Z`. The service state file identifies the same PID/port, version2.3.0.
- Two listener observations found no TCP clients. Read-only native database projection found three historical sessions, zero potentially busy sessions and zero jobs. This supports an unused discovery residual, not deletion of historical sessions or credentials.

Conclusion: this instance was triggered by an agent's exploratory command and survived its parent. The observed origin does **not** establish that AIH startup prewarms OpenCode or all providers. The daemon should not remain indefinitely merely because model discovery once ran. No `models`, `serve` or provider bootstrap command was rerun during this audit. The remaining live CodeBuddy peer was asked only for exact ownership/dependency facts; a queued message or another peer's non-use is not cleanup approval. PID69411 was left running pending that ownership/stop boundary.

## Task-owned private service cleanup actually performed

Fresh PID/start/executable, empty tasks/runs/app-install jobs, absent installer pending marker and absent distribution schedule were checked before the one-shot stop. Review intent explicitly resolved to documented self-review for the narrow task-owned cleanup; no additional reviewer/provider process was launched. Existing complete-product isolated-acceptance/cleanup scope was used, not a peer's non-use receipt.

| Host | Private processes retired | Method | Formal service preserved |
| --- | --- | --- | --- |
| macOS | Go64053, port59587 | One authenticated shutdown POST, HTTP202 | Go84956, port9527 |
| Linux | Go2483852 + Node2483870, port52785 | Disable/stop exact private unit `com.meadeo.ai_home.af8e9f54.service` | Go2548797, port9527 |
| Windows | Go20524 + Node4160, port3266 | Disable exact private logon task `com.meadeo.ai_home.8f359ec3`, then one authenticated shutdown POST, HTTP202 | Go48696, port9527 |

All five private processes and their listeners disappeared. Linux private unit is inactive/disabled with MainPID0; Windows private task is disabled. On each host the formal PID/start/executable hash and health200 were unchanged. No forced kill, repeated stop/install request, file deletion or database purge was used. Retained registration definitions, installation packages, private data and evidence remain available; only test-owned auto-starts were disabled.

Receipts: `private-service-cleanup-review-20261118.json`, `local-private-service-retirement-20261118.json`, `linux-private-service-retirement-20261118.json`, `windows-private-service-retirement-20261118.json`.

## Remote provider findings not silently cleaned

- Windows Codex Desktop app-server31832 belongs to ChatGPT.exe. It is independently owned, not a spare AIH CLI backend; it was not touched.
- Linux private service was removed from the running set as above; its formal 1.0.6 Go/Node pair remains.
- Fresh AWS inventory at **04:10:39 +08** found the formal1.0.6 Go726191/Node726201, four AGY workers and three additional AIH Node launch chains. No Codex or OpenCode resident was present in this inventory.
- HUD owner confirmed exact AGY387761 and589567 belonged to its completed HUD task and released its task occupancy at **04:01:33 +08**. They were still live in the subsequent AWS inventory; an ownership release is not a stop receipt. No signal was sent by this audit.
- AGY574419 has cwd `/var/tmp/aih-agy-src (deleted)` and tmux `aih-agy-task/session-order`; the original prompt concerned Chat/Work project/session sorting. HUD explicitly states this is another task, with no known owner/release. Deleted cwd is a warning to reconcile ownership, not permission to kill it. AGY557438 also remains outside this task's cleanup allowlist.

Evidence: `windows-process-audit-20261118.json`, `linux-process-audit-20261118.json`, `aws-process-audit-fresh-20261118.json`; peer ownership receipt `pm-95464a6c325b79095dbd09a24d766650`.

## Proposed optimization, not implemented or released

The requested cross-terminal reuse is an architectural change. Keep each terminal UI independent; pool only compatible backend resources. Three approaches have different tradeoffs:

1. Keep process-per-terminal and only fix lifecycle ownership: lowest protocol risk, but backend/MCP duplication remains.
2. **Recommended: lazy, identity-scoped backend pool plus ownership-based retirement.** A canonical local broker may lend a compatible backend only after matching account/auth-home, effective permission/sandbox policy, runtime generation, launch environment, capabilities and project configuration. Use explicit leases, bounded pool size and observable idle retirement. A backend's active turns/approval/tool work prevent retirement even if a terminal disconnects.
3. One global daemon for all accounts/tasks: fewer processes, unacceptable as a default because it merges identity/config/failure domains and creates routing/cancellation risks.

A pool cannot concatenate several JSON-RPC clients onto one stdio pipe. It needs client/request ID isolation and ownership routing of thread/turn notifications, approval/tool requests, cancellation and reconnects. Dropping one lease must not terminate another client's work; upgrading must drain old-generation leases rather than switching live processes mid-turn. Desktop/VSCode runtimes stay independent. MCP sharing/lazy activation is a separate capability decision, not a blanket kill or disable operation.

The first product lifecycle step should separate **inventory** from **launch**: showing installed apps/versions should read receipts/caches, while side-effectful CLI discovery requires an explicit operation and a bounded owner. Every task-owned helper/service needs PID/start/parent-purpose/lease metadata and a cleanup receipt; activity/upgrade locks must protect real work. No promised RAM saving is inferred from process count or summed RSS.

Real acceptance for a future implementation must cover concurrent terminals with distinct requests, same-scope sharing, different-account/permission/runtime non-sharing, one-client exit, parent crash, in-flight approvals/cancellation, idle retirement and upgrade draining. User instruction remains: no new automated test cases; use actual official CLIs and real processes/protocol calls. No implementation of this proposed architecture was performed in this audit.
