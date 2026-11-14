# Go runtime lifecycle review and real-process evidence — 2026-11-15

Status: in progress; full Node→Go migration remains active. Continuation of `2026-11-14-node-go-weekly-audit.md`. This slice began at `d1f09a5b4`, with parallel main commits and unrelated dirty files protected. No branches/worktrees, new test cases, mock suites, production restart or paid inference.

## Codex RPC: confirmed defects

Before modification, the **actual exported Go client** launched official Codex `0.167.2` in an empty temporary HOME/CODEX_HOME:

1. The real `thread/started` callback synchronously requested `thread/loaded/list`. It timed out after 1000 ms because the sole stdout reader was inside that callback.
2. `ReleaseThread` returned success immediately, but the official loaded-list still contained the thread. Go only unbound callbacks; Node sends `thread/unsubscribe` and awaits `thread/closed`.
3. Source review also found handshake publication before initialize completion, non-nil Background contexts bypassing request timeout, reader waiting on its own reaper, and zero-reference clients retained in the pool.

Official protocol schema was generated from the installed executable (not a mock) into `/tmp/aih-rpc-protocol-20261114-UCeuPv/schema`. `ThreadUnsubscribeResponse` supports `notLoaded`, `notSubscribed`, `unsubscribed`. Online source retrieval did not yield usable content in this run; claims here use local source and actual protocol behavior, not a claimed current web version.

## Implementation design

- Split transport connection, bounded dispatch, thread release, binding handles and pool ownership into focused modules instead of expanding the original `codex_rpc.go`.
- One bounded connection-initialization flight; ordinary callers cannot use a child until initialize/initialized succeeds. Waiter cancellation does not cancel the owner. Requests always have a deadline, including Background contexts.
- The reader dispatches responses directly; notifications/server requests enter a **fixed-size 256-entry ring**, with **16 MiB serialized byte budget including the active callback**. No goroutine-per-notification. Overflow explicitly fails the connection, accepted messages drain before disconnect callbacks.
- Frame reading is limited to 32 MiB while assembling; normal frames borrow the 64 KiB reader buffer, large frames use temporary growth rather than permanently retaining a large Scanner buffer. These are serialized limits, **not a claim that total heap is 16 MiB**.
- At most two dispatcher generations per client (current plus draining predecessor). A misbehaving external callback cannot cause unlimited worker creation via repeated reconnects. Arbitrary callbacks that never return still cannot be forcibly terminated by Go.
- Every RPC response/write/read and scoped callback is attached to its connection generation. Old callbacks cannot reconnect implicitly into a new child. A scoped turn handle includes registration identity, allowing old cleanup to revoke old queued events without touching a same-name replacement.
- Release is a bounded, shared per-thread operation: register watch before unsubscribe; wait for ACK and closed; caller cancellation only cancels its wait. Active binding release is refused. Bind waits for release; new same-thread commands fail busy during release. Unknown release completion closes the affected connection rather than reusing it.
- Driver cleanup atomically hands binding ownership to release; scoped cleanup is idempotent and never falls back to name-only cleanup after its handle is gone. Publication checks terminal state under the active-turn lock.
- Pool retirement has an atomic client-state gate, requires zero leases/bindings/releases, and closes outside the pool lock and lease-once callback. Child pipes are explicitly closed so inherited writer FDs cannot retain the reader indefinitely.

## Real Codex verification, no inference

Evidence root: `/tmp/aih-rpc-live-20261114-rnHjxY`. The temporary external driver imports the repository's real Go package. It uses actual `initialize`, `thread/start` (ephemeral), `thread/loaded/list`, `thread/unsubscribe`; no `turn/start`, steer or compact requests.

| Scenario | Result |
| --- | --- |
| Reentrant callback request | Before: 1000 ms timeout. Final race run: 2 ms success. |
| Thread release | Final race run: 11 ms; official loaded-list empty. |
| 16 concurrent Ensure calls | Zero failures, one official app-server child PID. |
| SIGSTOP isolated child + Background request | 500–502 ms timeout; SIGCONT then a new request succeeds, stale response ignored. |
| Close from callback | 2–4 ms return; no self-join. |
| Old generation Unbind after reconnect | New same-name binding receives its event; old queued second event is revoked. |
| Two leases | Same client/child; one release leaves other usable. |
| Zero leases + active binding | Child retained; active release rejected as not idle. |
| Last binding/release completes | No child PIDs; next acquire creates a new client. |
| Pre-canceled handle release | Returns context canceled; local ownership cleared and child reclaimed. |
| Closed pool acquire | Returned client is closed; no child spawned. |
| One release waiter canceled | Short waiter deadline exceeded; other waiter succeeds; loaded-list empty. |
| Queue overload via actual thread metadata operations | 256 accepted callbacks delivered before `codex_app_server_notification_overflow`; generation-scoped next request fails rather than reconnecting silently. Final child list empty. |

Recorded outputs: `before.txt`, `reentrant-final.txt`, `lifecycle-final.jsonl`, `bounds-release-scoped-final.jsonl`. Commands used `go run -mod=mod -race .` in the temporary driver module; no race warning appeared on exercised paths. No test cases or protocol-faking child processes were added to the repo.

## Full-server composition smoke

Race-instrumented standalone Go Server in a new empty HOME: `/healthz` HTTP200/ok=true; `/readyz` HTTP200/ready=false because this isolated instance has no accounts/catalog. SIGTERM exited 0 in 1.014s, no race warning. This is composition/lifecycle evidence, **not ready-for-inference evidence**. Artifacts: `/var/folders/nj/0mx5gymd41x8f64xcfm635440000gn/T/aih-runtime-health-20261115-w41u0vp5`.

## Claude native stream lifecycle

Working-tree implementation separates process I/O from `driver_native.go` and introduces a bounded-state input coordinator: accepted initial prompt/steer increments pending count; each result decrements it; only final successful result with no accepted steer closes the process as expected success. Error result, partial stdin write, canceled run or incomplete EOF cannot become success. Producer event sends select cancellation; explicit pipe ownership and read-idle deadlines address inherited output handles without dropping tail data due to consumer backpressure. No in-memory prompt queue was added.

Actual full Go Server + official Claude Code `2.1.325` ran in isolated HOME with an OS **deny-all-network** policy. The wrapper only `exec`s the official binary with bare/no-persistence flags; it emits no synthetic protocol. Local `/cost` and `/help` commands avoid paid inference. Final race-instrumented observations:

| Scenario | Result |
| --- | --- |
| `/cost` successful result | 0.801s; nonempty completed assistant message; state idle/no active run; no official CLI PID or launch-context files remain. |
| Accepted `/cost` and `/help` steer | Both HTTP200; final `/help` output present; 0.296s to idle; no orphan PID/context files. |
| No-auth error result | 0.262s; failed=true (not falsely successful); process cleaned. |
| Cancel after official exec observed | 72.28ms abort-to-settled; no active run/orphan PID/context files. |
| Full server shutdown | exit0 in 1.026s; no race warning on these paths. |

Evidence: `/tmp/aih-native-stream-20261114-huxemqmn/full-server-official-cli-race/observations.json` and per-scenario records. This verifies real result/steer/error/cancel behavior without model generation; remote inference, all providers and inherited-grandchild stress scenarios remain outside that evidence.

## WebUI terminal: direct Go CLI execution slice

`webuiopenappapi` now resolves a native `cmd/aih` binary using build info (program path + GOOS/GOARCH), rather than trusting a file named aih-go or accidentally invoking aih-server. Same-provider registered Go native strategies and Codex↔Claude Relay use this binary directly. Numeric account aliases and explicit `relay <identity-provider> <id>` preserve identity rather than passing accountRef as a prompt. Gateway credentials stay in child environment, never argv or responses.

The existing native desktop terminal lifecycle remains Node-owned. Wider identity-provider Relay and external Pi/DSH/DSH-TUI also retain their original Node argv, selected **before** Go launch by explicit capability routing. This is not a fallback on Go failure. Go executable/argument/config errors fail closed, and no previously available path is disabled just to reduce migration scope.

Real component chain verified in isolated HOME: launcher → persistent WebUI PTY → tmux → aih-go → official Claude CLI. Cwd/model/account/egress env preserved; repeated open reused the same TermID; close removed the durable session. Official CLI was intentionally unable to reach upstream; no conversation/inference success claimed. A real aih-server renamed aih-go was rejected before spawning. Retained Node branches were verified only to selection/argv + actual PTY creation, **not full external harness completion** (their intentionally absent legacy entry yielded MODULE_NOT_FOUND). Artifacts: `/tmp/aih-s2-launch-oAlmTi/{operations-v2.jsonl,guard-server.jsonl,cap-*.jsonl}`. Windows/Linux package cross-builds passed; no Windows/Linux real terminal acceptance.

Final helper revision replay: `/tmp/aih-s2-final-oI9lTo/final-replay-summary.json`; direct reuse, Relay loading missing gateway environment from app-state, bad-executable no-spawn guard, zero residual sessions/tmux servers. Source hashes matched before/after actual replay.

Environment config is indexed once per launch instead of repeatedly copying the full environment map; build-info platform verification uses two strings rather than a settings map. These are allocation reductions by construction, not measured latency claims.

## Local checkpoints

- `f459282d0` — bounded Codex RPC dispatch, generation-scoped handles and real thread/pool resource release.
- `4595baa21` — Claude result/steer lifecycle and cancellable native stream cleanup.
- `5bab26a0a` — WebUI terminal Go-owned capability routing and direct native CLI invocation.

These commits were independently source reviewed and used exact file pathspecs with staged scope verified before and commit scope after. No unrelated concurrent files were included. Local commit does not imply push, deployment or production adoption.

Validation: `go build -mod=readonly ./...`, focused `go vet`, Linux/Windows cross-builds of changed packages, whitespace checks and generated contract checks. A brief full-build failure while another session was adding `runCodexGatewayAuth` was rechecked after its new source appeared; the final full build passed. This review did not repair or commit that parallel slice.

## Boundaries and remaining work

- Automatic reconnect/thread resume/interaction replay is still not implemented in the Go transport; manual reconnect and generation isolation are not equivalent to Node recovery parity.
- Overflow-recovery's reader reentrancy primitive was reproduced and fixed using a safe real metadata callback. A paid context-overflow generation was not triggered; the complete generation-retry workflow remains unverified.
- Codex driver has older state-sharing/cleanup paths outside the transport primitive. The real transport race checks do not certify all driver concurrency.
- Memory claims are structural bounds, not a full CPU/RSS/allocation benchmark or proof of optimality. Large-frame and byte-budget limits were source reviewed; only entry-count overload was induced with the real CLI.
- Production binaries and services were not replaced or restarted. No browser visual acceptance performed.

The full migration goal remains active; this document is a checkpoint, not a completion certificate.
