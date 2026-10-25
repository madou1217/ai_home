# Translation Desktop and Shared Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成不抢宿主右键的 macOS 翻译 helper、原生设置窗口、共享桌面壳基础和可脱离 AIH Server 的 Provider 直连翻译。

**Architecture:** 保持 `TranslationPanel` 只负责翻译视图和状态机；新增窄的 desktop shell/controller 负责窗口、快捷键、设置和进程生命周期。翻译执行通过 `TranslationExecutionPort` 选择 AIH Server adapter 或本地 Provider route runner，Provider 名称仍只存在于 descriptor/registry/facade。

**Tech Stack:** Swift/AppKit, Node.js CommonJS, existing translation provider registry/facade/route-runner, app-state SQLite JSON store, macOS Services/AX.

**Spec:** `docs/superpowers/specs/2026-10-25-desktop-translation-chat-design.md`

## Global Constraints

- 不新增 `AIH_*` 环境变量；新配置使用现有 translation settings/provider config store 或 server config。
- 不监听 `rightMouseUp` 弹出 AIH 菜单；宿主应用右键菜单必须保持原样。
- 原生设置窗口不得打开 WebUI URL。
- Provider dispatch 必须使用 descriptor/registry/facade，不新增 `if (provider === ...)`。
- Web 源码改动必须运行 `cd web && npm run build`、改动文件 ESLint 和相关测试。
- Swift 改动必须运行 `xcrun swiftc -typecheck native/translation/*.swift`；helper 构建后必须运行 `codesign --verify --deep --strict`。
- 现有未提交的 `native/translation/*.swift` 改动属于本计划的起点，只能在验证后提交；不要带入其他未相关工作区改动。

### Task 1: Finish native settings and right-click boundary

**Files:**
- Modify: `native/translation/main.swift`
- Modify: `native/translation/TranslationPanel.swift`
- Modify: `native/translation/TranslationPanelContent.swift`
- Create: `native/translation/TranslationSettingsWindow.swift`
- Test: `test/desktop-translation-protocol.test.js` (new protocol-level test; Swift UI behavior is verified by typecheck and runtime)

**Interfaces:**
- `TranslationPanelContent.showSettings()` creates/raises one `NSWindow` owned by the content object and never opens a URL.
- Settings window emits JSON events through the existing helper stdin/stdout protocol: `{type:"settings", action:"save", patch:{...}}` and `{type:"settings", action:"close"}`.
- `main.swift` keeps Services and shortcut entry points, but `rightMouseUp` only clears transient selection state.

- [ ] **Step 1: Write the failing protocol test.**

```js
const protocol = require('../lib/desktop/translation/protocol');

test('settings messages are versioned and right click never becomes a translation command', () => {
  assert.deepEqual(protocol.normalizeHelperEvent({ type: 'settings', action: 'save', patch: { target: 'zh-Hans' } }), {
    version: 1, type: 'settings', action: 'save', patch: { target: 'zh-Hans' }
  });
  assert.equal(protocol.normalizeHelperEvent({ type: 'right-click', text: 'secret' }), null);
});
```

- [ ] **Step 2: Run the focused test and verify it fails** with `Cannot find module '../lib/desktop/translation/protocol'`.
- [ ] **Step 3: Implement the narrow protocol normalizer** in `lib/desktop/translation/protocol.js`; accept only versioned settings/cancel/translation events, strip text from unknown right-click events, and cap patch sizes.
- [ ] **Step 4: Implement `TranslationSettingsWindow.swift`** with target language, auto-copy, shortcut display, execution target, and close/save controls. Use `NSWindow`/`NSStackView`; no WebKit and no URL opening. Keep state local to the window and send only patches through the helper protocol.
- [ ] **Step 5: Wire `TranslationPanelContent.showSettings()`** to create one window, center it on the current screen, and use `NSAnimationContext` for show/hide while respecting reduced motion.
- [ ] **Step 6: Wire `main.swift` and `TranslationPanel.swift`** so `⌘,` opens the native window and right-click never calls `popUp` or `offer`.
- [ ] **Step 7: Run verification.**

```bash
node --test test/desktop-translation-protocol.test.js
xcrun swiftc -typecheck native/translation/*.swift
node --check lib/desktop/translation/protocol.js
```

- [ ] **Step 8: Commit only the focused files.**

```bash
git add lib/desktop/translation/protocol.js test/desktop-translation-protocol.test.js native/translation/main.swift native/translation/TranslationPanel.swift native/translation/TranslationPanelContent.swift native/translation/TranslationSettingsWindow.swift
git commit -m "feat(translation): add native settings boundary"
```

### Task 2: Add direct Provider translation execution port

**Files:**
- Create: `lib/translation/execution-port.js`
- Create: `lib/translation/executors/direct-provider.js`
- Create: `lib/translation/executors/aih-server.js`
- Modify: `lib/desktop/translation/service.js`
- Modify: `lib/translation/index.js`
- Test: `test/translation-execution-port.test.js`

**Interfaces:**

```js
createTranslationExecutionPort({ direct, server })
  .translate(request, { signal, emit }) -> Promise<{ok,text,error,attempts}>
```

`request.target` is `direct-provider` or `aih-server`; direct requests contain `routes`/`providerConfig`, server requests contain `origin`/`serverId`. The port owns no UI and never logs source text or secrets.

- [ ] **Step 1: Write failing tests** for direct route selection, configured/missing provider credentials, cancellation, server fallback, and stale request ids.
- [ ] **Step 2: Run `node --test test/translation-execution-port.test.js`; verify failures** because the port and executors do not exist.
- [ ] **Step 3: Implement `direct-provider.js`** by composing `readTranslationProviderConfig`, `createTranslationAdapterRegistry`, `getTranslationProviderFacade`, and `runTranslationRoutes`. Resolve config through context; never branch on provider id.
- [ ] **Step 4: Implement `aih-server.js`** by extracting the current SSE request/parse/cancel behavior from `lib/desktop/translation/service.js`. Preserve `AbortSignal.any`, request generation checks, and serverId header routing.
- [ ] **Step 5: Implement `execution-port.js`** as the target registry/facade. Unknown targets return a normalized retryable error; aborted requests return `translation_aborted`.
- [ ] **Step 6: Refactor `service.js`** to call the port. Helper mode defaults to `aih-server`; full-app mode can select `direct-provider`. Keep `getStatus()` declarative with target capabilities and configured state.
- [ ] **Step 7: Run verification.**

```bash
node --test test/translation-execution-port.test.js
node --check lib/translation/execution-port.js lib/translation/executors/direct-provider.js lib/translation/executors/aih-server.js lib/desktop/translation/service.js
```

- [ ] **Step 8: Commit.**

```bash
git add lib/translation/execution-port.js lib/translation/executors/direct-provider.js lib/translation/executors/aih-server.js lib/translation/index.js lib/desktop/translation/service.js test/translation-execution-port.test.js
git commit -m "feat(translation): add direct provider execution port"
```

### Task 3: Add shared desktop helper/full-app lifecycle

**Files:**
- Create: `lib/desktop/runtime/desktop-mode.js`
- Create: `lib/desktop/runtime/desktop-launcher.js`
- Create: `lib/desktop/runtime/desktop-protocol.js`
- Modify: `lib/desktop/translation/macos-build.js`
- Modify: `lib/desktop/translation/service.js`
- Test: `test/desktop-runtime.test.js`

**Interfaces:**

```js
resolveDesktopMode({ argv, parentPid, serverOwned }) -> 'helper' | 'full-app'
createDesktopLauncher({ build, spawn, mode, config })
  .start() / .stop() / .send(event)
```

- [ ] **Step 1: Write failing tests** for helper parent exit, full-app startup without server, atomic stop, and protocol version negotiation.
- [ ] **Step 2: Implement `desktop-mode.js`** using argv/config state, not a new environment variable. Helper mode requires a live parent/server; full-app mode is explicit.
- [ ] **Step 3: Implement `desktop-protocol.js`** with version, request id, generation, cancel, and normalized error events.
- [ ] **Step 4: Implement `desktop-launcher.js`** with one child lifecycle, stderr diagnostics, restart policy only in helper mode, and no secret argv/env logging.
- [ ] **Step 5: Refactor macOS build/service wiring** to use the launcher while preserving existing AX permission behavior and atomic executable replacement.
- [ ] **Step 6: Add a full-app executable entry point** that opens the native settings/translation shell without requiring a running AIH Server; the first screen must show target status and configuration state instead of a blank window.
- [ ] **Step 7: Run verification.**

```bash
node --test test/desktop-runtime.test.js
node --check lib/desktop/runtime/*.js lib/desktop/translation/*.js
xcrun swiftc -typecheck native/translation/*.swift
```

- [ ] **Step 8: Commit.**

```bash
git add lib/desktop/runtime lib/desktop/translation/macos-build.js lib/desktop/translation/service.js test/desktop-runtime.test.js
 git commit -m "feat(desktop): add helper and full app lifecycle"
```

### Task 4: Web advanced settings and direct target visibility

**Files:**
- Modify: `web/src/features/translation/SystemTranslationControl.tsx`
- Modify: `web/src/features/translation/TranslationProviderSettings.tsx`
- Modify: `web/src/features/translation/TranslationWorkspace.tsx`
- Modify: `web/src/features/translation/translation.module.css`
- Test: relevant existing translation tests plus changed-file ESLint

- [ ] **Step 1: Add UI tests or focused reducer tests** for target capability display, unavailable provider state, and no full-page Alert blocks.
- [ ] **Step 2: Render direct-provider/AIH Server as a capability target selector** sourced from `/settings` and provider descriptors; do not infer readiness from provider names.
- [ ] **Step 3: Keep Provider forms in advanced settings with Tabs when provider count exceeds three.** Each tab shows configured/missing fields and a compact inline status.
- [ ] **Step 4: Make route changes invalidate detection and active streams.** Preserve drafts when changing related controls.
- [ ] **Step 5: Run `cd web && npm run build`, changed-file ESLint, and focused tests.**
- [ ] **Step 6: Commit.**

```bash
git add web/src/features/translation/SystemTranslationControl.tsx web/src/features/translation/TranslationProviderSettings.tsx web/src/features/translation/TranslationWorkspace.tsx web/src/features/translation/translation.module.css
git commit -m "feat(translation): expose direct execution targets"
```

### Task 5: Runtime acceptance and integration review

**Files:**
- Modify: `docs/architecture/design-patterns.md`
- Test: full focused Node tests, Swift typecheck, Web build

- [ ] **Step 1: Restart the local server and verify helper mode**: parent/server lifecycle, Services registration, native settings window, host-owned right-click, translation cancel and retry.
- [ ] **Step 2: Run a direct-provider fake transport** for Microsoft, Google, LibreTranslate and DeepL; verify secrets never appear in stdout/logs.
- [ ] **Step 3: Use the existing Edge tab to verify advanced Provider Tabs, target selector, loading/slow/done states, page translation progress/stop/undo.
- [ ] **Step 4: Run all verification commands.**

```bash
node --test test/*.test.js
xcrun swiftc -typecheck native/translation/*.swift
cd web && npm run build
cd web && npx eslint src/features/translation/SystemTranslationControl.tsx src/features/translation/TranslationProviderSettings.tsx src/features/translation/TranslationWorkspace.tsx
```

- [ ] **Step 5: Update design-pattern documentation with actual changed modules and evidence.**
- [ ] **Step 6: Commit the documentation and integration evidence.**
