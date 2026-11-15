# Caller-owned native Codex TUI app-server — 2026-11-15

## Actual owner transition

The production `startCodexTuiLocalAppServer` path previously created a Node WebSocket server, spawned official app-server children, concatenated stdout strings and kept response-context Maps. It now delegates to `aih-server __codex-local-app-server`. The compatibility module retains its public API; argument/profile/legacy termination utilities are separated from actual execution.

The standalone Go host receives a bounded private stdin configuration and inherits the caller's selected environment. It does not load gateway default accounts, open AIH's business DB or start shared services. It resolves the existing upstream command/shim before the handoff, preserves model/effort config arguments, uses explicit caller cwd and strips local proxy token environment variables before launching the official process. The local random token is not on argv or in a URL.

Only authenticated CLI-origin WebSocket requests spawn official children. Per-host concurrency is bounded. The shared native stdio bridge provides bounded line reads/backpressure, exact protocol patches, final-output draining and bounded close. Both default TUI and resume launchers now surface failure after native local execution is selected rather than silently switching to a different built-in/default-account path.

## Actual evidence

- `aih-local-official-live-Jwjgxl`: official Codex0.167.2 native binary through the production launcher and new Go host, isolated no-auth HOME. Unauthenticated request401 and zero provider children. Official config/read returned requested model/effort; thread/start and lsof confirmed caller cwd; disconnect reaped the child. No turn/inference or user account mutation.
- `aih-local-official-churn-P7Y4yd`: default lookup selected the actual native companion; ten official initialize/config/read/disconnect cycles,7 FDs and0 provider children at every two-cycle checkpoint. Host close with live provider: exit0 in1,029 ms, provider PIDs gone.
- `aih-local-final-native-kCCRNT`: final default companion replay successfully initialized official Codex and exited0. A prior probe omitted creation of its isolated CODEX_HOME, hit the existing readiness guard/failed upgrade and was not counted as success; caller/default transaction guard code was not weakened.
- `aih-local-final-pipes-l6roNN`: real sh/cat/sleep I/O proves final unterminated stdout preserved, descendant cleanup, and15,049 ms blocked stdin termination. The17 MiB overlimit probe is recorded in `aih-local-real-pipes-4UDrvM`.
- Native/full isolated snapshot builds, production-source vet, JS syntax and relevant Linux/Windows cross-builds passed. Windows process-tree/verbatim handling is source and cross-build evidence only.

## Local artifact and safety boundary

An additional ignored helper was exclusively published, then updated only after checking this session's prior artifact hash:

`bin/native/darwin-arm64/aih-codex-local-app-server`

Final SHA-256: `92d8bb599d12e1483cf0c2ac819e3f778a3f5f77c771587aa5f680b286ecacd9`.

This did not replace the running standard gateway binary or restart the gateway. Capability-confirmed standard aih-server is preferred; the companion protects development callers while that standard artifact remains older. An explicit binary override never falls through. Release packages use the rebuilt standard server.

Shared main-index reverse differences from the concurrent AWS snapshot are not this session's changes. Commits use a one-use independent index and explicit pathspec. For the default-launcher file, only this session's new delta is applied to the staged blob, preserving the existing staged default/account reversal and every other peer path; no reset/revert/amend or sweeping cleanup.

## Review / remaining scope

Original reviewer contexts are exhausted; documented owner self_review covers caller identity, config boundary, bounded transport, close ordering, child groups and staged closure. No independent final approval is claimed. No new tests, business database change, push or shared-service restart. Interactive full TUI rendering, real credential refresh/capture, Windows/Linux live execution, Desktop integration and the remaining stdio hook transforms/plugins are still separate acceptance gates. Full Node-to-Go goal remains active.
