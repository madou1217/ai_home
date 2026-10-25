# Task 3 report: shared desktop helper/full-app lifecycle

## Scope

Added the shared desktop runtime boundary for the macOS translation helper and
standalone full app. The server-owned helper now runs through one launcher with
parent liveness, bounded helper-only restarts, stderr diagnostics, and atomic
stop behavior. The standalone app is explicit (`--full-app`), opens the native
settings shell, and uses Provider direct execution without requiring a running
AIH Server.

## Changes

- Added `lib/desktop/runtime/desktop-mode.js`.
  - Resolves `helper` versus `full-app` from argv/configuration and ownership
    state; no new environment variable was added.
  - A helper requires a live parent or server ownership. Explicit full-app mode
    always wins.
- Added `lib/desktop/runtime/desktop-protocol.js`.
  - Negotiates protocol version 1 and normalizes ids, generations, cancellation,
    request payloads, helper lifecycle events, and bounded error events.
  - Preserves helper configuration/status fields while rejecting unknown protocol
    versions and unsupported event types.
- Added `lib/desktop/runtime/desktop-launcher.js`.
  - Owns one child lifecycle, bounded stderr diagnostics, parent polling, and
    idempotent stop/send operations.
  - Restarts only helper mode after an unexpected exit; full-app mode never
    restarts automatically.
  - Does not log argv, environment, event payloads, or secrets.
- Refactored `lib/desktop/translation/service.js` to use the launcher.
  - Existing AX permission and helper protocol dispatch remain intact.
  - Direct-provider full-app preflight uses the canonical local language
    detector and therefore does not call `/v0/webui/translation/detect`.
  - Execution-target preference is persisted through the existing translation
    settings normalizer; no `AIH_*` variable was added.
- Extended `lib/desktop/translation/macos-build.js` with helper/full-app build
  modes. The existing temporary executable plus `rename` replacement remains
  atomic; full-app bundles are regular applications while helpers retain the
  accessory-app metadata used for AX/Services registration.
- Added the native full-app entry path in `native/translation/main.swift`.
  `--full-app` keeps the process independent of stdin/parent lifetime, opens
  the native settings window, and displays a direct-provider target state.
  The settings subtitle reports whether the selected execution target needs an
  AIH Server.
- Added `test/desktop-runtime.test.js` covering mode resolution, helper parent
  exit, full-app startup without a server, atomic stop, protocol negotiation,
  and local direct-provider preflight.

## Verification

- `node --test test/desktop-runtime.test.js test/translation-execution-integration.test.js test/translation-execution-port.test.js test/desktop-translation-protocol.test.js` — 20 passed, 0 failed.
- `node --check lib/desktop/runtime/*.js lib/desktop/translation/*.js lib/account/translation-settings-store.js` — passed.
- `xcrun swiftc -typecheck native/translation/*.swift` — passed.
- `git diff --check` — passed.

## Residual fix round

- Added the install-visible `aih-translation` bin entry and executable mode
  (`bin/aih-translation.js`, 0755).
- Reset launcher generation epochs for each child, so a restarted child can
  begin at generation zero without inheriting a previous process's counter.
- Queued `start()` behind an in-flight stop and covered both pending-build and
  running-child disable/re-enable races.
- Standalone full-app direct-provider requests no longer set an AIH Server
  fallback target. The real service protocol test verifies that a retryable
  direct failure never invokes the server executor.

Residual-round verification:

- `node --test test/desktop-runtime.test.js test/translation-execution-integration.test.js test/translation-execution-port.test.js test/desktop-translation-protocol.test.js` — 27 passed, 0 failed.
- `node --check lib/desktop/runtime/*.js lib/desktop/translation/*.js lib/account/translation-settings-store.js bin/aih-translation.js` — passed.
- `xcrun swiftc -typecheck native/translation/*.swift` — passed.
- `git diff --check` — passed.

## Design patterns

- `lib/desktop/runtime/desktop-mode.js` -> explicit mode resolver -> keeps
  lifecycle ownership/configuration decisions declarative and out of the
  native process -> mode tests cover helper/full-app boundaries.
- `lib/desktop/runtime/desktop-protocol.js` -> protocol adapter/normalizer ->
  gives Node and Swift one versioned, bounded event contract -> negotiation and
  normalized request/error tests pass.
- `lib/desktop/runtime/desktop-launcher.js` -> lifecycle facade with injected
  build/spawn dependencies -> isolates process ownership, restart policy, and
  diagnostics from translation business logic -> parent-exit, no-restart,
  atomic-stop, and send tests pass.
- `lib/desktop/translation/service.js` -> injected launcher plus canonical local
  detection -> preserves the existing helper boundary while enabling a
  server-independent full-app lane -> focused integration and runtime tests
  pass.

SOLID, KISS, DRY, and YAGNI review: the launcher/protocol/mode boundaries are
focused on the three new runtime responsibilities; no provider-name dispatch
or additional environment configuration was introduced.

## Follow-up

The full app shares the native settings and translation panel source with the
helper. It intentionally does not install global AX selection monitors in
standalone mode; users can still configure the direct-provider target and use
the native shell without a server. Helper AX behavior remains unchanged.

## Fix round 1

Review identified that the first implementation opened the native full-app
window but had no independent Node consumer. The fix adds
`lib/desktop/runtime/full-app-host.js` and `bin/aih-translation.js`: the host
starts the native `--full-app` child, consumes its protocol, persists settings,
and exposes a direct-provider `translate()` path. The native app now keeps its
stdin protocol open in standalone mode, skips helper-only AX monitors and
parent checks, accepts `host-translate`, and renders streamed results in the
same request-guarded panel.

The desktop protocol now requires bounded ids for translation requests, rejects
oversized text before truncation, validates generation values, suppresses stale
child generations in the launcher, and bounds nested settings/configuration/
usage payloads. The launcher also schedules a fresh start when a stop/re-enable
race invalidates a pending build. `setEnabled(true)` waits for launcher startup
so the standalone host cannot send its first request before the child exists.

Fix-round verification:

- `node --test test/desktop-runtime.test.js test/translation-execution-integration.test.js test/translation-execution-port.test.js test/desktop-translation-protocol.test.js` — 25 passed, 0 failed.
- `node --check lib/desktop/runtime/*.js lib/desktop/translation/*.js lib/account/translation-settings-store.js bin/aih-translation.js` — passed.
- `xcrun swiftc -typecheck native/translation/*.swift` — passed.
- `git diff --check` — passed.
