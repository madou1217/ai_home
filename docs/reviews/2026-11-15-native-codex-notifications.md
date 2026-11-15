# Native Codex notification poller — 2026-11-15

## Runtime ownership and retained contract

The stdio hook's production notification factory now launches `aih-server __codex-notifications`. Node no longer polls the JSONL file or owns per-thread debounce timers. It supplies initial/live-thread add/remove changes and forwards completed status messages, keeping the existing synchronous factory/stop/poll surface plus observable readiness.

The standalone Go host owns the stateful cursor, live membership and an indexed min-heap of due status updates. It uses one debounce timer rather than one timer per event; pending entries retain only thread identity and the active/notLoaded status bit. Live threads are capped at2,048, control frames at128 KiB, input/output channels at16 entries, poll reads at256 KiB, and stalled output at3 seconds. Messages are serialized one at a time rather than building a full due-batch array. Idle sends avoid allocating timeout timers.

The existing `session:turn-started → active` and other-event `notLoaded` semantics are preserved; only live threads receive notifications and last-event debounce remains deliberate. Removing a thread also removes its pending heap entry. Node respects output drain/backpressure, bounds/control-coalesces membership writes and uses UTF-8 stream decoding. Native diagnostics/errors are visible; failure stops the owned official child rather than silently resurrecting the Node poller. Queue cursor readiness gates initial stdin/stdout processing so an early official event cannot be skipped by start-at-end initialization.

The native host does not open databases, write the notification queue or start shared services. Parent disappearance, stdin EOF, signals and bounded failed startup terminate it. See `39c4f8b47` for the cursor's identity/partial-write/rotation correctness and explicit best-effort limits.

## Actual execution evidence

All changed files/queues/processes in these runs are isolated. No new test files, mocked I/O or real user inference were used.

- `aih-notification-live-ZdrAsv`: actual captured queue events through production Node adapter/native helper; partial writes, lifecycle mapping, live add/remove,20-event last-state coalescing, same-size rename/overwrite, truncation and no callbacks after stop.
- `aih-notification-boundaries-dnzKK6`: preexisting partial record at startup,331,200-byte malformed line resynchronization, pending debounce cancellation on remove, actual FIFO/no-writer diagnostic and clean stop.
- `aih-notification-pressure-final-xjmk98es`: actual unread stdout pipe caused explicit `notification_output_backpressure`, exit1 in5,379 ms including race-runtime delay. Parent disappearance with stdin open exited0 in2,014 ms; oversized real control frame exited1 with explicit protocol error. No race warning in captured stderr.
- `aih-notification-ready-final-IKv7us`: final production Node stdio script + official Codex0.167.2 + final native helper. Initialize sent immediately, official real turn started and immediately interrupted with external networking denied by OS. Its actual lifecycle event was mapped using production code then split-written to the private queue; only completed data produced the expected status notification. Upstream EOF exited0 in1,036 ms and neither official/helper child remained. No paid inference.
- `aih-notification-go-bridge-eIcIts`: actual isolated full Go server receives the same cursor semantics through notification bridge → session bus → native WebSocket; partial/rotation pass and active shutdown exit0.
- `aih-notification-final-resources-6M6zU2`: final scheduler source with race instrumentation and1,000 actual event copies;6 FDs at every checkpoint, final partial/rotation/exit pass.
- `aih-notification-release-final-V5qtH4`: non-race release helper explicit selection and1,000 actual event copies;6 FDs throughout, RSS33,696→34,352 KiB, no late callback, exit0. A later source refinement stores a boolean instead of arbitrary event type and adds readiness gating; final full-chain replay above covers those corrections. No claim of optimal global memory or throughput.

## Build, artifact and deployment boundary

Native/full isolated snapshot build, production-source vet, Node syntax and affected Linux/Windows package cross-builds pass. Cross-build is not real Windows/Linux runtime or GUI acceptance. An ignored companion was published separately, without changing the standard running gateway binary:

`bin/native/darwin-arm64/aih-codex-notifications`

Final SHA-256: `d36c646e655b3e32bf8848b3754f2fbb4f12c6907c65043146aced312373a692`.

During this task another session rebuilt standard aih-server at18:29; it advertised the notification capability while this work was still pending. Default lookup therefore selected that standard binary, not the companion. That observation is **not** acceptance of the final source in production. Final probes explicitly selected this session's exact native build; no standard binary overwrite or shared restart was performed here. Release must rebuild from the completed commit.

## Shared work and review

CLI table/narrow-terminal work remains with its original owner, database/default/inference work remains with other owners. The main Git index contains parallel reverse changes from the earlier snapshot; this checkpoint uses a single-use isolated index and explicit paths, preserving the original staged difference. No reset, revert, amend, branch/worktree creation, test additions or push.

Original reviewer contexts have exhausted capacity. The owner records `self_review` fallback, checking protocol limits, single-threaded heap ownership, partial/rotation state, control/output pressure, readiness/child lifetime and actual committed scope; independent final approval is not claimed. The full Node-to-Go goal remains active: notification migration does not finish the larger stdio hook, Desktop, plugins or release acceptance.
