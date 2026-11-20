# Account browser foundation Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development for the original owner implementation and independent review; user forbids test cases and worktree/branch/source copies.

**Goal:** Land an authenticated durable account-browser profile foundation without prematurely choosing or impersonating a browser engine.
**Architecture:** Focused disk registry + host-lifecycle port in runtime, authenticated account/server authority resolution in HTTP adapter, tiny composition-root wiring. Host unavailable is explicit; no fake open/stream.
**Tech Stack:** Go standard library and existing core accounts/appstate/store APIs; no new dependency.
**Spec:** docs/superpowers/specs/2026-11-20-account-browser-foundation.md

## Global Constraints
Electron forbidden; no test cases; preserve all peer code/index; no branch/worktree/persistent source copies; no production/config/account/permission mutation; no credential exports; actual HTTP/process evidence; scoped commit/push per reviewed stage.

### Task1: Runtime identity/profile/host boundary (original AWS Neon owner)
Files: new internal/runtime/accountbrowser/{identity,profiles,files,service}.go, exact breakdown may change within this new package only.
- [x] Implement validated stable identity and deterministic opaque profile ID.
- [x] Implement atomic first-create/read with private durable data; reject corruption/symlinks/traversal/cross-identity, idempotent/restart-safe ensure.
- [x] Implement Host interface and synchronous true open/close state, no host no fake success, close preserves storage.
- [x] Compile and review runtime; no test files or remote Git mutations.

### Task2: Authenticated HTTP and composition (coordinator)
Files: new internal/transport/http/webuiaccountbrowserapi/{handler,authority}.go, new internal/host/aihserver/webui_account_browser_routes.go, one import+builder-call hunk webuiroutes.go.
- [x] Verify actual provider/account via Store.GetByRef and existing server identity from appstate.ReadKV.
- [x] Implement bodyless ensure/read/open/close/capabilities routes, JSON codes, no absolute paths or secrets.
- [x] Compose same singleton runtime/handler once; use canonical public alias generation.

### Task3: Real validation, review and scoped delivery
- [x] Run gofmt/go build/go vet on changed packages, without writing tests.
- [x] Run task-owned one-shot HTTP process with ephemeral isolated data and actual handler requests; verify auth/invalid ref/provider/notfound/idempotency/identity separation/close retention/host-unavailable/corruption/symlink/concurrent ensure/restart. Runner is throwaway actual client/server, no committed test cases.
- [x] Independent review; address material findings and rerun affected real cases.
- [ ] Audit HEAD/disk/index; isolate only approved paths in fresh temporary index; inspect cached stat/full diff; explicit-path scoped commit; inspect committed tree/stat; preserve peer index exactly; push main and verify remote contains commit.
- [ ] Report first backend milestone and remaining browser frame/input/persistence/OAuth/proxy/UI acceptance separately. No production deployment.
