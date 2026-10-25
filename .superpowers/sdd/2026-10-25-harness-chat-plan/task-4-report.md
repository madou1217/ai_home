# Task 4 report: Web Chat mini-window surface

Date: 2026-10-25

## Implemented

- Added `web/src/features/chat-runtime/ChatMiniWindow.tsx`.
  - Mounts a portal-based, draggable and pinnable floating Chat surface.
  - Resolves the persisted Chat selection through the existing account/session catalog and creates a draft Chat session when no saved session is available.
  - Reuses `useSessionRuntime`, `SessionRuntimeController` through the existing hook, `SessionWorkspace`, `SessionRuntimeActions`, and the existing projection store. There is no second SSE transport or reducer.
  - Reuses the canonical timeline and composer, so streamed output, model selection, slash commands, attachments, queue behavior, and the existing stop command keep the same runtime semantics as the full Chat page.
  - Adds compact inline connection/loading/error states, explicit reconnect, stop, pin, drag, close, and account-switch controls. Same-provider account changes retain the canonical runtime session; draft and cross-provider changes start a fresh mini target.
- Added `web/src/features/chat-runtime/chat-mini-window.module.css` for the compact floating surface. Errors and status are inline rows; no large `Alert` block or left-edge status decoration is used.
- Mounted the window from `web/src/app.tsx` inside the existing data-plane shell, so it remains available on every WebUI route without navigating to `/ui/chat`.
- Extended `web/src/components/chat/chat-global-shortcuts.ts` with the route-independent `Cmd/Ctrl+Alt+C` Chat mini-window action and an open event for host integrations. The existing Chat page prevents browser handling while the app-shell component owns the action.
- Added the shortcut to `KeyboardShortcutsModal` and exported the component from the Chat Runtime feature index.
- Added `test/web-chat-mini-window.test.js`, which verifies canonical runtime reuse, app-shell mounting, route-independent shortcut registration, and compact inline error semantics.

## Review follow-up

- Persisted Chat session lookup now reads selection at open time. A lookup/API failure remains visible as the compact inline error with retry; the fallback draft is created only when lookup succeeds without a match or no persisted session was requested.
- Account switching now delegates to `resolveChatAccountChange`: same-provider bound sessions retain their canonical `chatSessionId` and rehydrate the existing timeline under the new execution account; draft or cross-provider changes create a fresh target explicitly.
- The app-shell mini-window uses persisted sessions only when opened away from `/ui/chat`. If navigation into `/ui/chat` occurs while a persisted mini session is open, it is replaced with a separate draft before the canonical page can attach, preventing duplicate controller/SSE subscriptions while keeping the mini runtime's separate-session semantics explicit.
- Added stable `data-runtime-workspace` and `data-runtime-workspace-dock` hooks for mini-window CSS instead of relying on hashed CSS-module class names.

## Verification

- `npx eslint src/features/chat-runtime/ChatMiniWindow.tsx src/features/chat-runtime/SessionWorkspace.tsx src/features/chat-runtime/index.ts src/components/chat/chat-global-shortcuts.ts src/components/chat/KeyboardShortcutsModal.tsx src/pages/Chat.tsx src/app.tsx` — passed.
- `node --test test/web-chat-mini-window.test.js` — 3 tests passed, 0 failed.
- `git diff --cached --check` — passed.
- `cd web && PATH=/Users/model/.nvm/versions/node/v22.21.0/bin:$PATH npm run build` — passed. Webpack compiled successfully in 26.10s, then `stamp-sw-cache` completed with `CACHE_NAME=aih-hos6-pwa-f5072616` and 189 files.
- `cd web && npx tsc --noEmit --pretty false` — the repository has pre-existing type errors across unrelated files; no diagnostic referenced `ChatMiniWindow.tsx` or the changed shortcut/app-shell files.

## Design patterns used

- `web/src/features/chat-runtime/ChatMiniWindow.tsx -> canonical facade/composition boundary ->` keeps floating-window lifecycle and presentation separate while delegating session creation, SSE lifecycle, projection, timeline rendering, composer dispatch, stop, and reconnect to the existing Chat Runtime facade; verified by the focused source-contract test and ESLint.
- `web/src/features/chat-runtime/ChatMiniWindow.tsx -> portal + local interaction state ->` keeps drag, pin, close, and viewport positioning local to the floating surface while preserving the shared runtime controller; verified by the component structure and changed-file lint.
- `web/src/components/chat/chat-global-shortcuts.ts` + `web/src/app.tsx -> descriptor/event source of truth ->` lets the shortcut remain route-independent and avoids URL navigation or a second shortcut parser; verified by the focused shortcut contract test.
- `web/src/features/chat-runtime/chat-mini-window.module.css -> compact inline status presentation ->` expresses loading and failure states as small status rows consistent with the repository visual constraints; verified by source assertions and ESLint/build source inclusion.

SOLID/KISS/DRY/YAGNI review: the only new runtime composition is the floating-surface boundary; transport, event parsing, projection, command IDs, timeline rendering, and composer behavior remain shared with the canonical Chat Runtime. No provider-specific branches or new environment variables were introduced.

## Concerns

- `cd web && npx tsc --noEmit --pretty false` still reports pre-existing diagnostics in unrelated files (including the existing `siderWidth` typing error in `app.tsx`); no diagnostic referenced `ChatMiniWindow.tsx` or the changed shortcut files. The production Webpack build and focused checks pass with Node v22.21.0.
