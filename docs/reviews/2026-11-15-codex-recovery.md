# Codex reconnect, replay and completion — 2026-11-15

Status: ongoing Node→Go migration, not a global completion certificate. Builds, isolated native protocols, end-to-end local service results, production adoption and UI acceptance remain distinct.

## Contracts recovered from Node and confirmed defects

- Node `codex-app-server-json-rpc-client.js` retains turn bindings, retries connection at bounded count, resumes each thread, restores durable history before buffered new messages, and gives history import an expiring same-thread read-only client. Go had callbacks but never invoked them on reconnect.
- Failed `turn/start` must not be reissued: only history/anchor evidence can resolve uncertain outcomes.
- Go `CodexToolOrder.DispatchOrdered` waited for a channel that a later event had to resolve. If tool B arrived before tool A's first typed event, the sole dispatcher could block itself. The queue now continues accepting future ordering facts, serializes actual writes, bounds deferred events/bytes, latches write failures, and flushes before terminal/recovery barriers. No goroutine-per-event was introduced.
- Two driver calls passed `BuildCodexTurnStartParams` strings in the wrong order (`model, effort, runID` instead of `runID, model, effort`). Corrected both initial launch and overflow-retry construction.
- Internal cleanup and `TurnLifecycle.watch` competed for one `active.done` result. A separate closed `settledCh` now broadcasts to cleanup; only the lifecycle consumes the provider result.
- Real CLI error observation revealed the bridge was trying to persist `stream.error`, which the event store deliberately forbids. It now publishes transient errors to EventHub without allocating a database sequence, preserving the actual later `codex_turn_failed` reason.

## Recovery design

One bounded recovery owner per client: max 8 attempts, increasing 500 ms delay, overall 2 minute limit. It waits for already-accepted callbacks to drain, creates a replacement connection with gated bounded notification dispatch, restores threads using their original resume options, verifies/replaces interaction envelopes, releases dispatch, then waits for expected replay. Successful publication is atomic under the connection-state lock; a new EOF cannot leave bindings with neither connection nor recovery owner.

- New future normal requests wait for recovery. Failed requests are returned, never automatically replayed.
- Only the same binding/connection can use the history port; allowed requests are `thread/turns/list`, `thread/items/list`, `thread/goal/get`. Mutation, other threads, and use after restore callback are rejected.
- A binding's handle survives automatic recovery but remains registration-specific. Close, last Unbind, or release during backoff cancels obsolete recovery rather than retaining inactive owners.
- Interactions publish a replyable envelope only after replay validation; waiter wakeup follows publication. Replay timers carry epoch identity, so an old timer cannot fail a new recovery generation.
- Recovery anchor persistence errors propagate; only successful writes advance the in-memory persisted anchor and clear uncertain submission.
- Deferred tool events use execution-time bounded persistence contexts, not an already-canceled callback context. Limits: 256 pending tool events / 16 MiB serialized payload estimate / 8192 identity slots. These are bounds, not a complete heap/latency benchmark.

## Actual validation (no paid inference)

Temporary driver module imports the actual repository Go package and starts official Codex `0.167.2`, isolated HOME/CODEX_HOME, no production credentials. Methods are native metadata/history operations; locally injected user history is never executed as a turn.

Evidence root: `/tmp/aih-reconnect-live-20261115-dxYE3k`.

| Scenario | Evidence |
| --- | --- |
| Kill resident official app-server, recover thread | Latest race run: first attempt succeeds in 614 ms, new child PID, history read succeeds; no notification delivered before restore. |
| Kill replacement while restoring | Second bounded attempt succeeds (two actual history callback invocations); original binding handle still releases thread; no final child PIDs. |
| Narrow recovery port | Same-thread page permitted; mutation/other-thread requests denied; retained port denied after callback return. |
| Close during backoff | Final callback reports cancellation immediately, no child recreated. |
| Release during backoff | Returns disconnected while precisely unbinding; no child/recovery owner remains. |
| Full Go Service + official CLI, OS deny-all network | Initially found transient-event persistence bug; after repair a missing isolated env-key produces `stream.error` plus durable `turn.failed`, state idle, activeTurn=nil in 194 ms. SQLite contains exactly one `turn.failed`, no persisted `stream.error`. |
| Network-denied CLI retry then explicit interrupt | Actual upstream CLI emitted retryable waiting-for-network notices, not a false failed/success result. Explicit turn interrupt reached idle/no activeTurn in 2055 ms. |
| Full Go Service, kill active official CLI | Durable thread resumed with interrupted status, history imported, actor settled idle/no activeTurn in 1790 ms; SQLite contains `turn.interrupted`, without reissuing the turn. |

Final event error evidence: `driver-missing-key-race.jsonl` and `driver-real-error-1794678137011/app-state.db`. It contains only isolated configuration; do not commit runtime databases. The CLI had no credentials and was OS network-blocked; no model inference could occur. Earlier no-keyless-provider runs waited for network and timed out as observed; they are not counted as successful error completion.

`go build -mod=readonly ./...`, focused `go vet`, Windows/Linux package cross-builds, whitespace checks and race-instrumented live driver commands passed. Latest retry run recovered in 1785 ms after two actual restore callbacks. Source review cleared the bounded scope. Code checkpoint: `f7cc34649` (11 explicit paths, staged scope checked before and commit scope after; no push/deploy by this session).

## Actual resource lifecycle measurement

A non-race temporary driver used the real exported Go client/pool and official app-server for **100 distinct runtime scopes**, requesting native loaded-list and releasing each final lease. Samples explicitly forced GC; no inference was issued. Each sampled checkpoint and final close had **0 child processes, 1 driver goroutine, 6 open FDs**.

| Measurement | Before | After 100 cycles | After pool close |
| --- | ---: | ---: | ---: |
| Go live heap | 2,584,384 B | 2,717,608 B | 2,658,376 B |
| Driver RSS | 17,280 KiB | 19,312 KiB | 19,232 KiB |
| Cumulative allocated bytes | 5,278,064 B | 18,117,912 B | 18,230,856 B |

This demonstrates resource return on this startup/metadata/idle-release workload, not global memory optimality or inference-stream throughput. RSS is driver-only sampled after subprocess cleanup; it excludes peak simultaneous child memory. Per-cycle timing included an explicit 50 ms post-release observation delay, so it is not reported as latency benchmark. Evidence: `/tmp/aih-runtime-memory-20261115-Sz4jY4/measurements-100.jsonl`. Full-service recovered interruption evidence: `/tmp/aih-reconnect-live-20261115-dxYE3k/driver-recovered-interrupted-race.jsonl`, with its isolated database under `driver-real-error-1794679085082`.

## Remaining verification and migration scope

- Replay gate validation and timer epoch were source reviewed; a real official pending approval replay after reconnect has not been induced. This is not approval UI acceptance.
- Tool ordering's self-wait is removed in source and bounded; a paid multi-tool turn was not used to stress arbitrary interleavings. No synthetic upstream or new test cases were used.
- Multi-binding slow/unbound recovery callbacks can hold an attempt until its deadline; callbacks ignoring context cannot be forcibly killed by Go. Bounded worker generations and queue limits remain enforced.
- Full provider protocol/auth/usage parity, desktop terminal migration, plugins/translation/packaging residual Node ownership, cross-platform real operations and representative memory/performance measurements remain open.
- No production service restart/deploy, no branch/worktree creation, no peer code rollback. Local checkpoints will list exact paths/commits once reviewed.
