# Interactive ordinary browser surface Implementation Plan

> **For agentic workers:** Use original AWS Neon owner for disjoint HTTP transport, coordinator for native/runtime/UI, Planck independent review. No test cases or worktree/branch creation.

**Goal:** Make an authenticated WebUI surface capable of displaying and controlling a real stable Edge window, with honest permission/focus boundaries.
**Architecture:** Existing signed single-host lifecycle -> task-only Swift window capture/input -> focused Go runtime -> authenticated same-origin WS -> desktop React canvas.
**Tech Stack:** Go/coder websocket, Swift/AppKit/ScreenCaptureKit/CoreGraphics, React18/AntD/Umi; no new dependencies.
**Spec:** docs/superpowers/specs/2026-11-20-account-browser-live.md

## Global Constraints
No Electron/WebView/debug flags/extension installs/AppleEvents/AX automation/global events/whole-screen capture; no secret URLs or client PIDs; one task session, no account/proxy guarantees. User click required before focus-changing actions. No automatic permission requests, personal profile reads, tests, branch/worktree, persistent source copies or production deployment.

### Task1 coordinator — real native surface and lifecycle
- [x] Implement native preflight, task PID birth/identity checks, single-window filter, bounded latest JPEG frames, user-driven event validation and failclosed capture/input.
- [x] Embed helper sources and compile into disposable system-temp; New no side effects, Serve exclusive controller, explicit interactive stable-host start option default false.
- [x] Reject invalid URL/keys/numbers and enforce capture freshness, cancellation cleanup, no global input fallback.

### Task2 original AWS Neon — transport only
- [x] New webuiaccountbrowserliveapi handler/websocket: same-origin WS, loopback-only, first-message Authorizer within5seconds, strict JSON/body size/timeouts, receive Command/send Event, no log credentials.
- [x] Coordinator wires focused routes, resolves source embedding/build, no config mutation.

### Task3 coordinator — usable desktop UI
- [x] Hidden /browser page, start/stop/retry and compact foreground/permission explanation, live canvas plus address/back/forward/reload, pointer/wheel/key/composition commits, no test/mobile work.
- [x] No fake loaded or ready state, stop input when stale/disconnected, no frame queues. Preserve existing OAuth copy/external links; no premature isolated-account entry.

### Task4 real validation/review/delivery
- [x] Native Swift compile+actual preflight, Go build/vet, frontend real build/typecheck, no test cases.
- [x] Independent review passed for awaiting-user-start integration; scoped delivery tracked in STAGE2B-COMMIT.json. No deployment.
- [ ] Actual UI browsing/click/scroll/committed Chinese acceptance only after user agrees to foreground side effect; report remaining gate rather than pretending build is live acceptance.
