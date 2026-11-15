# Codex remote-control transport checkpoint — 2026-11-15

## Findings and design

Go already contained a remote-control handler, but the actual Codex stdio helper still launched the Node implementation. The Go file mixed protocol rewriting, diagnostics, chunk assembly and HTTP/WS transport in802 lines. HTTP read both bodies fully into memory and read64 MiB+1 of a response without rejecting truncation. Diagnostic chunk state was shared across connections, had no total/count/age cap, allocated from an untrusted segment count, and retained chunks even when no trace sink existed.

The transport checkpoint separates composition, HTTP, WS, protocol, summaries and bounded chunk observation:

- HTTP forwards bodies through a32 KiB buffer. Requests retain their64 MiB ceiling; responses are not silently truncated by the request limit. Known response lengths, content encoding, dynamic Connection-listed hop headers, method/query/path and status are preserved. Writes have deadlines; incomplete upstream responses terminate rather than masquerading as complete.
- WS uses one per-connection chunk observer, no whole-message observer work when tracing is disabled, and bounded writes/cancellation. Diagnostics allow at most16 pending streams,4,096 segments/message,4 MiB/message,8 MiB retained decoded content, and30 seconds before idle expiration. Actual forwarding does not depend on diagnostic acceptance.
- Remote `client_message` rewriting uses RawMessage values, not float64 round-tripping: large IDs and opaque numeric fields remain exact. Hydration-suppression files are regular-file/1 MiB bounded reads.
- Optional trace output is redacted and bounded in the standalone host; no credential payload logging or URL credentials are introduced.

## Actual evidence

All programs ran in isolated temporary HOME/state. No new test cases or mock upstream handlers were written.

- `aih-remote-official-jPtrya`: real official Codex0.167.2 app-server, direct unwrapped vendor binary with no auth; actual native Go proxy performs initialize and thread/list. No inference/login/account mutation. Production Node launch adapter selected Go; private temporary directory0700 and suppression file0600; active-WS shutdown exit0 in1,007 ms.
- `aih-remote-http-live-hm8vr02k`: real Python stdlib HTTP server, actual78,643,200-byte file (75 MiB) through native race Go proxy; exact SHA-256/length preserved. RSS before80,864 KiB, sampled peak82,736 KiB. This is one isolated transfer, not a broad performance distribution. HEAD200 preserved original length and no body; declared65 MiB request rejected413. Parent disappearance exited0 in1,965 ms.
- `aih-remote-wire-live-4x2jeI`: actual wscat CLI listener with protocol input through stdin, real client and native proxy. A rewritten envelope retained9007199254740993/995/997 exactly, applied thread-list compatibility, suppressed only the targeted hydration notification and passed ordinary text. Out-of-order chunks reconstructed diagnostic summaries. Extreme segment count and100 incomplete streams did not interrupt forwarding; reconnect did not combine prior connection fragments.
- Native package/full snapshot build, production-source vet and Linux/Windows package cross-builds passed. Race builds were used; HTTP run logs contained no race warning. The launcher deliberately retains only bounded child stderr, so do not infer universal race certification from all launcher runs.

## Scope and review boundary

This checkpoint is the reusable transport only; the standalone CLI/production launcher switch is recorded in the next checkpoint. The full Codex stdio proxy, Desktop behavior, ChatGPT live remote session, paid inference, Windows/Linux runtime and full-server production release are not completed by these observations.

Existing original review contexts are exhausted. The owner used documented self_review, checking protocol direction, exact numeric fields, transport memory limits, connection-local state and cancellation; no independent final approval is claimed. No shared DB/go.mod changes, service restart, test additions, push or gateway binary replacement.
