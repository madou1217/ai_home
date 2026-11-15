# Bounded native Codex stdio bridge — 2026-11-15

## Source findings

The existing local TUI bridge remained Node-owned: stdout string concatenation and pending response contexts grew without wire limits and writes ignored backpressure. The earlier Go gateway bridge likewise used unbounded ReadBytes/ReadString, discarded an EOF tail, and allowed child Wait to close stdout before final output was forwarded.

A focused shared Go bridge now owns both gateway and caller-local transports:

- ReadSlice-based bounded lines borrow the short-line buffer and only accumulate when needed, with a16 MiB frame ceiling; stderr is discarded without allocations when disabled or bounded to64 KiB diagnostic lines.
- Final non-newline output is delivered before EOF closes the channel. Child Wait gives the stdout reader an opportunity to drain rather than racing it.
- Per-direction blocking I/O provides backpressure instead of unbounded message queues; stdin and WebSocket writes have15-second bounds and owner cancellation releases blocked writers.
- Bounded resume/list contexts and project-scoped response filtering are reused. Admission failure closes explicitly rather than forwarding untracked requests.
- Protocol framing is shared by the existing Go gateway and the new native local host. Account/environment composition remains outside this transport.

## Actual acceptance

- `aih-local-official-live-Jwjgxl`: real official Codex appserver via native caller-local host, isolated no-auth HOME. config/read preserves model/effort; actual child cwd is the launching project; unauthorized handshake spawns no provider process; disconnect reaps child; close with live child exits0.
- `aih-local-real-pipes-4UDrvM`: actual cat/sh/sleep processes via production bridge. Final unterminated output delivered; actual17 MiB unterminated line closes without forwarding an oversized frame; shell leader exit cleans its live descendant.
- `aih-local-final-pipes-l6roNN`: final process-owner revision preserves the tail and reaps the descendant in168 ms; an actual sleep process that never reads its2 MiB stdin input causes the bridge to close in15,049 ms. No race warning observed.
- `aih-local-official-churn-P7Y4yd`: ten actual official Codex startup/config/read/disconnect cycles through the default native companion; every pair returns to7 file descriptors and0 provider children; active shutdown exits0 in1,029 ms.

The process-group and local-host parts used above are a separate checkpoint. This commit itself changes only framing/lifecycle reuse in the existing Go app-server bridge. Subsequent write-deadline cancellation uses the same observed15-second deadline with explicit cancellation unregistering; fresh source/build checks confirm it.

## Evidence boundary

No new test cases or mocked handlers. Data files and /bin/sh commands are isolated actual I/O/process probes, not production shell execution. No shared gateway restart, DB mutation, paid inference, push or Windows runtime claim. Native build, focused vet and relevant platform cross-builds passed. Original reviewers have exhausted context; owner self_review inspected size limits, tail handling, cancellation ordering and exact staged scope. Full migration remains active.
