# Native Go session watch — 2026-11-15

## Complete execution slice, not declaration-only migration

Before this checkpoint `/v0/webui/sessions/watch/ws` still ran Node's WebSocket → SSE parser → Go bridge. The pending Go handler was not registered in production. The new registration and automatic public alias send browsers directly to the Go handler and the shared session-event bus. The existing SSE route is retained.

The legacy/private Node entry is now a bounded byte tunnel: no WebSocket server implementation, JSON/SSE parsing, event subscription or heartbeat is retained there. Its original exported factory/close interface remains compatible with `server.js`. The focused route-ownership entry describes only these actual paths and does not put the first-frame Management-Key flow into the generic inference Client-Key forwarder.

## Protocol, authentication and lifecycle

- Same-host HTTP(S) Origin gate before upgrade; malformed/foreign origins fail 403. Native clients without Origin still require first-frame credentials.
- First text frame carries Bearer and target; 16 KiB limit and 5-second auth deadline. No event subscription or data before authentication. Header/URL credentials do not replace the required first frame.
- Legacy deployments with distinct Node and Go keys use an authenticated loopback handshake carrying the SHA-256 digest of the expected external key. The Node adapter replaces, never relays, client-supplied bridge/internal-auth headers. Go requires loopback peer and valid internal management authentication before honoring the digest; comparison is constant-time. Raw keys are not sent in URL or logged.
- Subsequent legacy client messages are drained via Reader/io.Discard rather than allocating each discarded payload. Writes/pings are time-bounded; event batches are bounded and semantic hook state is not treated as a redundant refresh.
- Close handshake gets a 250 ms native-socket fallback. Inspection of the pinned WebSocket library showed CloseNow cannot interrupt an already-running Close; the adapter therefore retains the actual hijacked transport for that fallback.
- Managed bus lifetime closes watchers/subscribers on host cancellation; explicit close waits for cleanup. The shared composition change is four isolated lifecycle hunks, excluding database/default/terminal peer hunks.
- SSE write/flush deadlines and bus-cancel interruption prevent a slow stream holding shutdown indefinitely. A cancellation callback is joined before resetting the deadline.

## Actual execution evidence

All runs use isolated temporary HOME/state, generated keys, ephemeral loopback listeners and the actual native race-enabled Go Server. No new test cases or mock upstream were written. No real account credentials, paid inference, shared database or shared gateway changes.

- `aih-session-watch-live-PkeDzq`: first frame connected, no pre-auth data, actual transcript append event; wrong/missing credential 4401, missing target 4400, no-frame timeout 1008 at 5,002 ms, foreign Origin403.
- `aih-watch-close-LLsxkx`: a client that paused reads and never ACKed the auth-failure close lost its actual server socket in 280 ms (identified by the client's specific TCP port, not all server connections).
- `aih-watch-final-auth-c9Pba7`: final actual direct Go and production Node byte-adapter paths both delivered real file events. Wrong key4401, bad JSON/binary4400, oversized frame1009; foreign/non-HTTP/path-bearing Origin403. Forged bridge digest and internal-key substitution do not authorize the external flow. New handshakes reject the prior rotated external key and accept the replacement. Adapter close terminates live tunnels and later attempts receive503.
- `aih-watch-kqueue-final-rStXlu`: 50 concurrent subscribe/close operations and 20 immediate atomic-rename/disconnect cycles return to21 descriptors/0 watched paths at every checkpoint; only target+parent are watched in a1,000-sibling directory. Actual hook events UserPromptSubmit → PermissionRequest → PostToolUse → Stop arrive in order. Concurrent authenticated WS, unauthenticated WS and SSE exit with host cancellation in1,038 ms, exit0. See the dedicated resource checkpoint for the failed-before evidence and resource design.
- No race diagnostic observed. Native builds, production-source vet, Node syntax checks and route-manifest check pass. Linux/Windows package cross-builds pass, not real platform runtime evidence.

## Boundary and review

No production deployment/restart, browser-render acceptance, paid inference, large-scale throughput benchmark, exhaustive slow-consumer saturation or Windows/Linux live acceptance is claimed. The existing bus has a bounded queue with best-effort overflow semantics, not durable event replay. Clients reconnect and refresh state; this slice does not invent exactly-once delivery.

The original review agents exhausted context; none was replaced. The owner documented `self_review` fallback and checked exact route/auth direction, private bridge authority, cancellation/watcher descriptor ownership, early exits, explicit-path commit scope and preservation of peer changes. Independent final review remains unavailable and is not claimed. Overall Node-to-Go migration remains active; this closes one actual runtime bridge, not plugins/Codex stdio/native CLI residuals.
