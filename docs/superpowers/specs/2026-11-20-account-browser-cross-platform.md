# Server-bound cross-platform browser viewer

## Status (2026-11-22)

Windows stable-Edge hosting is implemented and verified on a real Windows host.
macOS remains the original host adapter and now caches its signed helper so the
system permission grant survives restarts; its synthetic keyboard path still
fails to commit the omnibox when the Edge window is inactive, so real OAuth
logins stay on Windows. Linux still reports unsupported. See
`docs/product-integrity/account-browser-windows-2026-11-22.md` and
`docs/product-integrity/account-browser-macos-helper-2026-11-23.md` for
acceptance evidence and the boundaries that remain unverified. The sections below record
the 2026-11-20 design decision and no longer describe current platform
availability.

## Approved boundary
User confirmed on 2026-11-20: phones are WebUI operation clients only. The browser executes on the server selected through the existing WebUI server profiles. The viewing device's OS must not select the execution adapter. This extends the earlier desktop-only viewer scope; it does not claim Windows hosting already works.

## Design
Reuse existing authenticated WebUI HTTP transport and control-plane RemoteProxy. Add a POST NDJSON live stream and bounded POST command channel beside the existing loopback WebSocket. Both requests use existing Authorization and X-Aih-Server-Id headers. Remote keys remain in the existing server-side profile resolver, not in browser URLs or a second routing subsystem. The gateway authenticates before forwarding and the execution server authenticates again.

A stream creates one random, in-memory controller token and returns it only in its first no-store response event. Commands require both management authorization and this token in X-AIH-Browser-Session. Token is bound to this handler's one live stream; it is not a reusable account or browser-profile identity. The runtime remains the authority for exclusive browser ownership. Disconnect invalidates input immediately; ownership is retained until runtime cleanup finishes. No automatic reconnect, retry of commands, host migration, cookie copy, or fallback to another server. Every frontend request uses a captured server target and verifies that current selection and profile endpoint still match before and after asynchronous work.

Frames use bounded latest slots, events and commands use bounded queues. Per-write deadlines, stream heartbeats, initial-start timeout, bounded message and response parsing prevent unbounded buffering. A command acknowledgement means queued, not executed. Sensitive headers and stream event tokens are never logged or put in URLs. Existing first-frame-auth loopback WebSocket security is preserved. Capability and new HTTP routes require bearer authentication, not a loopback exception. No CORS opt-in or cookie-based authorization is added.

Capabilities describe the execution host OS/architecture, adapter availability, implemented capture/input operations and reasons for unavailability. Permission and signed-browser checks remain explicitly on-start checks; capability discovery neither starts a browser nor requests permissions. Mac is one adapter. Windows and other hosts explicitly report unavailable until implemented and verified on their real OS. Compiling for Windows does not establish Windows browser operation.

## Viewer
Use the shared server selector rather than a duplicate selector. Show execution-host metadata and unavailable reason. Clear frames, input, errors and pending requests on selection/profile mutation and page unmount. Late frames and capability responses cannot alter a new selection. A deliberate Start confirms foreground side effects on the execution host, not on the phone.

Responsive controls and a contained, aspect-correct surface work across narrow/wide viewports. Pointer-capability events, not UA sniffing, choose mouse versus touch behavior. A single touch taps or scrolls after movement threshold, with pointer-cancel and multi-touch rejection; no unsupported native dragging or pinch promise. An explicit text-composer action supports soft keyboards/Chinese composition by sending committed text, with separate delete/enter controls. Desktop physical-key input remains available. Clipboard, selection replacement, remote IME candidate windows and native mobile-host execution are not implied.

## Safety and proof
No Electron/WebView replacement, debug flags, extensions, Apple Events, global input, permission mutation, personal browser data, production restart or deployment. No new test cases. Use actual temporary HTTP connections, real proxy routing, cancellation and auth failures, Go build/vet/cross-build, frontend typecheck/build. Browser capture/input and visual/mobile acceptance remain separate and require the prior unresolved foreground-side-effect approval. The full product still requires account profile/proxy binding and Windows native implementation.
