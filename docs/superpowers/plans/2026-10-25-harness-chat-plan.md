# Harness Chat Desktop and Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Web 和 macOS 共享现有 Chat Runtime/harness 的前提下，提供可快捷键唤起、可停止、可重连的小窗 Chat。

**Architecture:** Chat Runtime server remains the single source of truth for sessions, commands, timeline and SSE events. Web uses the existing TypeScript client/controller; macOS uses a narrow JSON-line client adapter over the same HTTP/SSE endpoints. The native desktop shell owns the window and shortcut, never provider-specific argv.

**Tech Stack:** Node.js CommonJS server, existing ChatRuntimeService/Codex harness driver, TypeScript React, Swift/AppKit, JSONL helper protocol, HTTP/SSE.

**Spec:** `docs/superpowers/specs/2026-10-25-desktop-translation-chat-design.md`

## Global Constraints

- Chat must use `ChatRuntimeService` and existing harness driver; no second model request path.
- No new `AIH_*` environment variables.
- Provider/model selection comes from Chat Runtime catalog.
- Native helper does not log prompts, responses, credentials or SSE payloads.
- Every command and event carries session/command/request identity; stale events are ignored.
- Web changes require build, changed-file ESLint and focused tests.
- Swift changes require typecheck and runtime helper verification.

### Task 1: Extract a narrow native Chat Runtime client contract

**Files:**
- Create: `lib/desktop/chat/chat-runtime-client.js`
- Create: `lib/desktop/chat/chat-runtime-protocol.js`
- Test: `test/desktop-chat-runtime-client.test.js`

**Interfaces:**

```js
createDesktopChatRuntimeClient({ fetch, openEvents, idFactory })
  .createSession(target)
  .start(sessionId, after)
  .sendTurn(sessionId, text, options)
  .stopTurn(sessionId, commandId)
  .close()
```

- [ ] **Step 1: Write failing tests** for session creation, event cursor replay, command idempotency, cancellation and normalized runtime errors.
- [ ] **Step 2: Run the focused test and verify it fails.**
- [ ] **Step 3: Implement the client by mirroring the existing `ChatRuntimeApiClient` paths** (`/sessions`, `/commands`, `/events`) and parsers. Reuse DTO shape, but keep the transport dependency injectable for macOS and Node tests.
- [ ] **Step 4: Implement JSONL protocol projection** for helper ↔ native shell: `chat.open`, `chat.submit`, `chat.stop`, `chat.close`, `chat.event`, `chat.error`.
- [ ] **Step 5: Run tests and commit.**

```bash
node --test test/desktop-chat-runtime-client.test.js
git add lib/desktop/chat test/desktop-chat-runtime-client.test.js
git commit -m "feat(chat): add desktop runtime client contract"
```

### Task 2: Add macOS Chat panel controller

**Files:**
- Create: `native/chat/ChatPanel.swift`
- Create: `native/chat/ChatPanelContent.swift`
- Modify: `native/translation/main.swift` or shared desktop entrypoint created by translation plan
- Test: `xcrun swiftc -typecheck native/translation/*.swift native/chat/*.swift`

- [ ] **Step 1: Define explicit states**: disconnected, connecting, idle, streaming, stopping, failed. Buttons are derived from state.
- [ ] **Step 2: Build a compact native panel** with transcript scroll view, input field, send/stop button, session/model status, reconnect action, and reduced-motion-aware transitions.
- [ ] **Step 3: Route user actions through JSONL events** to the Node desktop client; do not call provider CLIs from Swift.
- [ ] **Step 4: Ignore stale session/command generations** before mutating transcript state.
- [ ] **Step 5: Typecheck and commit.**

```bash
xcrun swiftc -typecheck native/translation/*.swift native/chat/*.swift
git add native/chat native/translation/main.swift
git commit -m "feat(chat): add native harness chat panel"
```

### Task 3: Add Chat shortcut and desktop shell integration

**Files:**
- Modify: shared desktop launcher/protocol from translation plan
- Modify: `native/chat/ChatPanel.swift`
- Create: `native/desktop/ShortcutRegistry.swift`
- Test: `test/desktop-chat-shortcut.test.js`

- [ ] **Step 1: Write failing shortcut tests** for default shortcut, user-configured shortcut, conflict reporting and disabled state.
- [ ] **Step 2: Implement a descriptor-based shortcut registry** with translation and Chat actions; no hard-coded provider logic and no WebUI URL fallback.
- [ ] **Step 3: Add native registration/validation**. If a global shortcut cannot be registered, show an inline settings error and keep the helper alive.
- [ ] **Step 4: Add “open Chat” command to the desktop protocol**; the shell shows/raises the Chat panel without stealing host right-click behavior.
- [ ] **Step 5: Run tests, typecheck and commit.**

```bash
node --test test/desktop-chat-shortcut.test.js
xcrun swiftc -typecheck native/translation/*.swift native/chat/*.swift native/desktop/*.swift
git add native/desktop native/chat test/desktop-chat-shortcut.test.js
git commit -m "feat(desktop): add chat shortcut registry"
```

### Task 4: Add Web Chat mini-window surface

**Files:**
- Create: `web/src/features/chat-runtime/ChatMiniWindow.tsx`
- Create: `web/src/features/chat-runtime/chat-mini-window.module.css`
- Modify: `web/src/pages/chat-page-state.tsx` or existing Chat shell entry
- Modify: `web/src/components/chat/chat-global-shortcuts.ts`
- Test: focused Chat Runtime UI tests and changed-file ESLint

- [ ] **Step 1: Reuse `useSessionRuntime` and `SessionRuntimeController`**; do not create a second SSE reducer.
- [ ] **Step 2: Add mini-window open/close state, drag position, pin state, input composer, streaming output, stop and reconnect actions.
- [ ] **Step 3: Add a Chat shortcut action to the existing shortcut source of truth.** The shortcut opens the mini-window from any WebUI page; it never navigates to `/ui/chat` merely to configure the shortcut.
- [ ] **Step 4: Add compact inline runtime errors and loading transitions; obey the repository ban on large Alert blocks.
- [ ] **Step 5: Build, lint changed files, run focused tests and commit.**

```bash
cd web && npm run build
cd web && npx eslint src/features/chat-runtime/ChatMiniWindow.tsx src/components/chat/chat-global-shortcuts.ts
cd .. && git add web/src/features/chat-runtime web/src/components/chat/chat-global-shortcuts.ts
 git commit -m "feat(chat): add Web mini window"
```

### Task 5: Runtime acceptance and recovery hardening

**Files:**
- Modify: `docs/architecture/design-patterns.md`
- Test: full Node tests, Web build, Swift typecheck, real Web/macOS runtime

- [ ] **Step 1: Start AIH Server and helper; trigger Chat shortcut** and verify native panel opens without WebUI navigation.
- [ ] **Step 2: Create a Chat Runtime session, stream a turn, stop it, reconnect with `after` cursor, and verify no duplicated output.
- [ ] **Step 3: Repeat through the Web mini-window using the existing Edge tab.
- [ ] **Step 4: Stop/restart helper and verify session reconnect behavior; runtime errors remain compact and actionable.
- [ ] **Step 5: Run final verification.**

```bash
node --test test/*.test.js
xcrun swiftc -typecheck native/translation/*.swift native/chat/*.swift native/desktop/*.swift
cd web && npm run build
```

- [ ] **Step 6: Document the shared shell, Chat Runtime facade, and shortcut registry patterns with evidence, then commit.**
