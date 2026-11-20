# Server-bound browser viewer execution plan

Approved scope: phone is an operation client; selected server owns the real browser.

## Ownership and delivery
- Coordinator: internal/transport/http/webuiaccountbrowserliveapi/{handler,http_stream,http_commands}.go; internal/host/aihserver/webui_account_browser_live_routes.go POST route hunks; web/src/features/account-browser/{BrowserView,browser-view-client,browser-view-input,BrowserTextComposer,browser-view.module.css}; these spec/plan documents.
- Copernicus: only internal/runtime/accountbrowserview/capabilities{,_darwin,_other}.go. No independent index/commit manipulation; dependency-complete coordinator commit after review.
- Planck: independent read-only protocol/security and final scoped review.
- No tests, worktrees, branches, copies of the source tree, peer/index rewrites, browser activation or deployment.

## Tasks
1. Add execution-host capability snapshot; distinguish adapter implementation from on-start browser/permission readiness.
2. Add bearer-authenticated POST /live/stream and POST /live/command. Use bounded queues, controller token, initial-start timeout, heartbeat/write limits, cancellation and cleanup-held ownership; preserve old WS.
3. Replace the feature client with captured existing-server HTTP routing, token-header commands and bounded NDJSON reading. Close on selection/profile change; never fall back to local or auto-reconnect/retry commands.
4. Adapt the viewer to host capabilities, responsive toolbar, touch tap/scroll/cancel and explicit committed-text composer. Preserve current frame-age protection and user-start boundary.
5. Real temporary transport/proxy/auth/cancellation observations plus build/vet/typecheck/frontend build and Windows/Linux cross-build; no fake browser runtime results. Independent review, fix findings and record exact evidence boundary.
6. Fresh-HEAD temporary index scoped commit with all dependencies, cached-stat/tree audit, untouched main-index verification, push main and verify remote includes commit. Report remaining real browsing/Windows/account-isolation gates.

## Execution rulings and evidence boundary
- Reused standard authenticated HTTP streaming instead of a second WebSocket gateway: existing RemoteProxy already resolves the selected server and replaces upstream credentials. Legacy loopback WS remains unchanged.
- Commands and stream tokens are session-control leases only; no account identity, persistent profile or proxy correctness is claimed.
- Independent review required per-publication write deadlines (cleared after Flush), fail-closed deadline capability checks before runtime launch, incremental UTF-8 byte limits per NDJSON event and a strict total of eight pending/in-flight client controls. These corrections are included.
- Touch drag means scroll, not native browser element dragging. Explicit text composition is deliberate; candidate-window/selection/clipboard behavior is not claimed.
- Actual HTTP observations run two temporary authenticated server instances, real control-plane profile storage/RemoteProxy and real browser runtime only through waiting-for-start, lease timeout, close/disconnect. No browser launch/capture/input occurs. Frontend build/typecheck and Windows/Linux cross-compilation do not substitute for visual/native-platform acceptance.
- Initial runner shutdown used two seconds, below HTTP new-connection grace; goroutine diagnostic showed HTTP readRequest only, no remaining accountbrowser goroutines. Eight-second disposable-server shutdown plus closing client idle connections completed. Product code was not changed to mask this diagnostic.
