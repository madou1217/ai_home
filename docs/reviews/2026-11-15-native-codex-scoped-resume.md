# Native scoped Codex resume proxy — 2026-11-15

## Production path

`startCodexCliResumeCwdProxy` now launches an isolated Go subcommand rather than creating a Node WebSocket server and pending-frame array. The existing exported patch helpers remain compatibility aliases; production rewrite/response tracking/transport all run in Go. Upstream handshake completes before accepting the local WebSocket, so there is no unbounded pre-connect frame queue.

The CLI integration passes the new private local credential to official Codex through the existing remote-auth-token environment flag. Once scoped remote execution is selected, startup failure is explicit instead of silently switching to native/default-account history. Unrelated default-account and native CLI paths remain untouched.

- Upstream URL/cwd and credentials enter once through a32 KiB-limited stdin pipe; not process argv, URL, environment or temporary credential files.
- Local listener requires a fresh random token and rejects browser Origin; bounded8 connections,16 MiB frames,10-second upstream dial and15-second write deadline.
- Project scope is injected only when appropriate and checked again on response rows, with symlink-aware canonical matching and pagination preserved. Explicit allProjects remains opt-in.
- Both resume and list contexts use the separately committed bounded/error-aware trackers.
- Shared standalone loopback host owns cancellation, parent monitoring and handler draining for both resume and remote-control helpers.
- Startup accepts no partial/unbounded input. Missing configuration exits explicitly after5 seconds; missing owner exits promptly even before configuration. A transient implementation that tried synchronously closing blocked stdin failed the real timeout probe, was corrected before commit, and is not reported as passing.

## Actual acceptance and limitations

All subprocesses and files below are isolated; no user account credentials or shared DB were accessed, and no new test cases/mock servers were created.

- `aih-resume-wire-live-ye24xb`: real wscat CLI upstream and native proxy; scope injection, explicit cwd/allProjects,64-bit ID preservation, distinct numeric/string IDs, server-request context protection, capacity/error release, keys absent from argv and shutdown.
- `aih-resume-scope-final-M2zQnU`: keyless/wrong token401, browser403, response-side own-project filtering with nextCursor retained, allProjects retained,513th list request explicit error.
- `aih-resume-official-accepted-lGsjl6`: official Codex0.167.2 app-server with external networking denied by OS sandbox. Actual persisted vendor rollout resumed successfully; threadIds patch correct; project-scoped listing returned the resumed thread with canonical cwd match. Active helper shutdown exit0 in1,020 ms.
- A newly created empty official thread initially had no rollout and could not resume. A separate isolated/no-auth OS-network-denied turn produced its real rollout but exceeded the observation timeout; that turn was terminated and is **not** counted as successful inference. Final acceptance resumed the actual artifact in a fresh official process without another turn; no synthetic vendor-history file was invented.
- `aih-resume-startup-timeout-66cztktl`: absent private config exits1 with `resume_proxy_config_timeout` in6,249 ms including race-runtime exit delay.
- Final parent-before-config probe and final default-companion/remote-control regression are recorded in the OS temporary evidence directories `aih-resume-parent-final-*` and `aih-two-native-hosts-final-*`.
- Native full snapshot build, production-source vet, Node syntax, Linux/Windows relevant-package cross-builds passed. Cross-build is not real Windows/Linux runtime or visual CLI acceptance. No broad throughput/queue saturation certification.

## Local artifact and shared-worktree safety

An additional ignored `bin/native/darwin-arm64/aih-codex-resume-proxy` helper was published exclusively, then updated only after verifying this session's prior hash. Final SHA-256: `bd1aefa72faf93792ce6748b8cdff67c06b034992a4b2b9598dd6095dc8d655a`. The standard running gateway binary was not replaced or restarted. Release packages obtain the command from the standard rebuilt aih-server; explicit binary override never falls through.

Another session's AWS snapshot advanced HEAD while the main index retained hundreds of reverse differences. This session notified owners and did not reset/clean/commit those changes. The checkpoint uses a one-use isolated index and explicit paths; only this session's unchanged path entries are advanced afterward, preserving peer index content. No amend, new branch/worktree, dependency update or push.

Original review agents are context-exhausted. The owner documents self_review of credential/host scope, checked capacity, exact RPC IDs, cancellation and source/commit closure; independent final review is not claimed. Full Codex stdio, plugins and broader Node-to-Go migration remain active work.
