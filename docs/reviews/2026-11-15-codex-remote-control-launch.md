# Native Codex remote-control launch checkpoint — 2026-11-15

## Execution owner

The existing stdio helper's `startRemoteControlProxyProcess` now delegates to a focused native-launch adapter. It starts `aih-server __codex-remote-control`, not Node's remote-control HTTP/WS script. Disabled proxy configuration still disables it; when enabled, native missing/outdated/startup failure is explicit and does not silently bypass the proxy or restore the old Node owner.

The early Go subcommand assembles only the loopback transport, optional bounded/redacted trace, private ready file, signal/parent lifetime and HTTP server. It does not open AIH accounts/databases, start helpers or supervise Node. HTTP and hijacked WebSocket handlers are canceled and joined before process exit. Binding outside loopback, invalid upstream schemes/credentials, unexpected arguments and missing original parent fail before listening.

The compatibility launcher validates a machine-readable capability marker before selecting a binary. Ready/suppression state lives under an exclusively created0700 temporary directory with0600 files, and is removed when its own child exits. An enabled-but-unavailable proxy raises a targeted error rather than hiding the failure.

## Actual acceptance

- Production launcher → standalone Go → official unwrapped Codex0.167.2 app-server initialize/thread-list in isolated no-auth HOME: passed (`aih-remote-official-jPtrya`). No inference, login or user state accessed.
- Actual Python HTTP upstream75 MiB content/HEAD/413 and parent-death verification: see transport checkpoint `66cea2b8d`.
- Actual wscat upstream protocol rewrite/suppression/bounded diagnostics: see same checkpoint.
- `aih-remote-capability-final-1Js3wY`: old explicit standard artifact rejected with `codex_remote_control_native_binary_outdated`; new native artifact selected, ordinary frame preserved, active connection shutdown exit0, private launch directory removed.
- `aih-remote-local-stage-GOnhe1`: default local lookup selected the actual `aih-codex-remote-control` companion and child exit0. No Node remote-control process launched.
- Native full snapshot build, production-source vet, Node syntax and affected Linux/Windows package cross-builds passed. Real Windows/Linux launch is unverified.

## Local artifact boundary

The running shared gateway binary predates the new subcommand. To avoid breaking newly launched Codex hooks while honoring the prohibition on shared restarts, this session exclusively published an **additional ignored helper artifact**, not a replacement gateway binary:

`bin/native/darwin-arm64/aih-codex-remote-control`

SHA-256: `97511ec602702e751aedefa54704efa9db11f00bfaf182daa4350668fd4ec9fc`.

The launcher prefers a capability-confirmed standard `aih-server`; local development can use the companion when that standard artifact is older. An explicit binary override remains exact and does not fall through. Release packaging continues to carry the standard server, which provides the subcommand when built from this source. The companion is not committed. Shared9527 remained PID24791 in the final checks; this is not a production remote-session rollout claim.

## Remaining and review

The original larger stdio proxy, Desktop integration, actual ChatGPT remote-control session and plugin-host JS execution remain separate residuals. The historical Node remote-control module is still available to diagnostic import callers but no longer owns this production subprocess launch; it is not claimed deleted. Existing browser/terminal application state was not restarted.

Original review subagents have exhausted context; this checkpoint records owner self_review rather than independent approval. Scope/staged files, native selection, no-fallback behavior, private-path ownership, parent cancellation and trace bounds were inspected. No new tests, DB changes, dependency edits, shared-service restart, push or gateway binary replacement.
