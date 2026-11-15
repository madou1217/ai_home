# Session event watcher resource checkpoint — 2026-11-15

This is the resource foundation for native Go session-watch WebSockets, not a claim of complete migration or deployment.

## Real failure and root cause

A real isolated Go race server accepted and closed 50 concurrent WebSocket subscriptions to a real Claude transcript. Initial file descriptors grew from 25 to 67. A second run identified the retained resources as transcript/directory descriptors, not live client sockets. The bus started duplicate watchers for concurrent subscribers; the pinned fsnotify v1.9.0 kqueue Close path marked its state closed before Remove, leaving file descriptors.

An explicit Remove-before-Close attempt fixed ordinary churn but did not close the actual atomic-rename/immediate-disconnect race (20 iterations retained 9 transcript descriptors). That partial fix was not committed as complete. During implementation an uninitialized close-completion channel also failed isolated shutdown; it was corrected and fresh shutdown was verified before this commit.

## Design and source

- One in-progress watcher start per bus entry; publish only into the still-current entry, and wait for pending starts on Close.
- Shared bus lifetime context plus synchronous idempotent close completion; host integration is a separate checkpoint.
- Small platform watcher adapter: Darwin owns just the target vnode and parent directory using kqueue. One event loop reconciles inode replacements and performs final native descriptor cleanup. It does not enumerate/watch every sibling file.
- A one-element invalidation queue coalesces redundant filesystem notices; semantic hook events still use the existing bus queue. Non-Darwin keeps the existing fsnotify adapter and explicit descriptor removal.
- No dependency changes, new test cases, database changes or shared-service restart.

## Final actual evidence

Evidence directory: `aih-watch-kqueue-final-rStXlu` in the OS temporary directory, `evidence.json` and raw lsof snapshots. Actual native `-race` Go Server, empty isolated state, actual WS/SSE clients, actual hook HTTP endpoint, actual file append/atomic rename:

| Observation | Result |
|---|---|
| Baseline descriptors | 21 |
| Watching target in a directory with 1,000 unrelated transcripts | exactly 2 watched file/directory descriptors |
| 10/20/30/40/50 concurrent subscribe/close checkpoints | 21 total descriptors, 0 watched paths at every checkpoint |
| 5/10/15/20 immediate atomic-rename/disconnect checkpoints | 21 total descriptors, 0 watched paths at every checkpoint |
| File append and atomic replacement | update events received |
| Actual UserPromptSubmit → PermissionRequest → PostToolUse → Stop | all four delivered in order |
| Host cancellation with authenticated WS, unauthenticated WS and SSE | 1,038 ms including race-runtime shutdown, exit 0; SSE ended |
| Race diagnostics | none observed |

The host/WebSocket parts used in this evidence are committed separately; this leaf checkpoint itself does not activate them. Native builds and source vet passed. Linux/Windows affected-package cross-builds passed but are not real platform execution evidence. Performance evidence is bounded descriptor ownership, not proof of globally optimal memory or latency.

## Review capability

Existing reviewer contexts are exhausted; no replacement reviewer was created. Per repository policy the owner documented a self-review bypass and inspected cancellation/WaitGroup ordering, entry identity, single loop FD ownership, early failure cleanup and exact staged scope. No independent final approval is claimed. Actual failing and passing resource observations above are preserved rather than overwritten.
