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

## Continued delivery: native diagnostic drain (2026-11-20)
- Observed root cause before editing: the actual compiled native helper, invoked only with nonexistent PID 2147483647, lost its final identity error in 12/12 delayed-read runs. Cmd.Wait closed StdoutPipe; scanner reported file already closed. No browser/window/capture/input was started.
- Coordinator owns internal/runtime/accountbrowserview/{service,storage,errors,native_process,native_events}.go and HTTP stream/WS safe-error mapping hunks; native/account-browser/main.swift fatal input gate hunk. Lorentz owns BrowserView.tsx and focused browser-view-errors.ts only. Planck independent review; full dependency-complete explicit-path commit/push after real observations and build/typecheck, with main index preserved.
- Replace concurrent StdoutPipe/Wait with an independently owned os.Pipe, bounded post-exit drain and joined input/reader/process lifecycle. Prioritize terminal native diagnostics before EOF; treat malformed native protocol as failure, never raw filesystem/process output. Keep newest bounded frame slot and nonfatal stale-frame pause.
- Capability retry is a read-only request to the still-selected server, not a browser restart or fallback. UI maps closed error codes, never raw native errors/paths.
- Validate the actual unchanged helper with nonexistent PID before/after plus the actual process bridge through a disposable build overlay, no committed test cases. Preserve foreground consent gate: generic continue does not authorize another focus-changing native browser experiment. Real navigation, first frame and phone/Windows acceptance remain unverified.
- Review correction: stdin failure enters a two-second responsive drain state before owned-process termination; control events are consumed, frames/readiness discarded, cancellation always selectable. Atomic native terminal state invalidates queued readiness/images and stops new writes; terminal errors return as safe typed results, not a race against an EOF channel. Native non-stale input failure stops its synchronous gate before emitting and exiting. No helper error text/path is copied to HTTP.
