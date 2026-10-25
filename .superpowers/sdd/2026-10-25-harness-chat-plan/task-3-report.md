# Task 3 report: desktop Chat shortcut and shell integration

Date: 2026-10-25

## Implemented

- Added `native/desktop/ShortcutRegistry.swift` as a descriptor registry for the existing translation action and Chat action.
  - Defaults are explicit and documented in code: translation `⌘⌥T` (preserved) and Chat `⌘⌥C` (separate key, so it does not conflict with translation).
  - Supports configurable symbols or `command+option+<key>` values, enabled/disabled descriptors, duplicate binding conflict reports, and monitor registration failures.
  - Global monitor failure is surfaced through a compact status event and the native panel hint while the helper remains alive.
  - The registry owns no provider, HTTP, WebUI, or runtime logic.
- Preserved the existing `⌘,` native translation-settings shortcut as a third shell descriptor while keeping translation and Chat actions independently configurable.
- Routed the existing translation shortcut through the descriptor registry and routed Chat shortcuts through `ChatPanel.openFromShortcut()`, which uses the existing `chat.open` JSONL shell command. Existing host right-click monitoring remains non-consuming.
- Added Chat shortcut persistence/configuration to the existing translation settings boundary (`chatShortcut`) and included both shortcut values in helper configure messages. No new `AIH_*` environment variable was introduced.
- Added an editable Chat shortcut row to the native settings window and compact inline shortcut status feedback.
- Included `native/desktop/ShortcutRegistry.swift` in the macOS build source list/hash and server source fingerprint.
- Added `test/desktop-chat-shortcut.test.js` covering default/configured shortcuts, conflict and disabled handling, `chat.open` routing, right-click ownership, and build/fingerprint inclusion.

## Verification

- `xcrun swiftc -typecheck native/translation/*.swift native/chat/*.swift native/desktop/*.swift` — passed.
- `node --test test/desktop-chat-shortcut.test.js test/desktop-runtime.test.js test/desktop-translation-protocol.test.js test/translation-execution-integration.test.js` — 30 tests passed, 0 failed.
- `node --check` passed for all changed JavaScript modules.
- `git diff --check` — passed before commit.

## Design patterns used

- `native/desktop/ShortcutRegistry.swift -> descriptor registry + strategy callback ->` keeps action registration/provider behavior separate, permits conflict/disabled validation, and avoids provider branches; verified by Swift typecheck and focused shortcut tests.
- `native/chat/ChatPanel.swift -> narrow shell facade ->` ensures shortcut activation reuses `chat.open` and the existing Chat lifecycle; verified by protocol/routing assertions and desktop runtime tests.
- `lib/desktop/translation/protocol.js` and `lib/account/translation-settings-store.js -> existing protocol/settings boundary ->` carries configuration without introducing another transport or environment variable; verified by focused normalization tests.
- `lib/desktop/translation/macos-build.js` + `lib/server/source-fingerprint.js -> deterministic source manifest ->` ensures native desktop source changes rebuild and invalidate the helper; verified by focused manifest checks.

SOLID/KISS/DRY/YAGNI review: the registry is the only new abstraction because shortcut conflict and registration lifecycle are shared concerns; Chat remains a native shell action and does not duplicate runtime/provider transport.

## Review follow-up fixes

- Full-app mode now emits a protocol-valid `chat.error` with the original request and generation when no `ChatRuntimeService`/bridge is available. The native panel leaves `connecting` and shows an actionable message to connect an AIH Server; direct translation remains independent.
- `shortcutEnabled` and `chatShortcutEnabled` now normalize with default `true`, persist through the existing translation settings store, pass through settings/protocol/configure, and are rendered as native settings checkboxes before reaching the registry.
- Shortcut conflict, invalid-value, and monitor-registration errors now update the settings window's compact inline status label whenever it is visible, with pending status replayed when settings opens.
- Increased the native settings window to 420 points and constrained the status label to the stack width so the added controls and error text fit without clipping.

Follow-up verification:

- `xcrun swiftc -typecheck native/translation/*.swift native/chat/*.swift native/desktop/*.swift` — passed.
- `node --test test/desktop-chat-shortcut.test.js test/desktop-runtime.test.js` — 24 tests passed, 0 failed.
- `node --check` passed for changed JavaScript modules and `git diff --check` passed.
