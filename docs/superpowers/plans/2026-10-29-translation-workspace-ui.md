# 翻译工作台 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变翻译请求语义的前提下，把翻译 WebUI 做成首屏主线清晰、状态反馈完整、动效克制且好用的产品级工作台。

**Architecture:** 保留 `TranslationWorkspace` 的请求、检测、历史和页面翻译逻辑；只调整 JSX 层级、受控状态展示和 CSS token。输入/目标语言/主翻译动作成为首屏核心，Provider/模型/路由收进高级设置，整页任务和历史作为可扫描的辅助区域。

**Tech Stack:** React 18, TypeScript, Ant Design, CSS Modules, existing design tokens and motion tokens.

**Spec:** `docs/superpowers/specs/2026-10-29-translation-windows-ui-design.md`

## Global Constraints

- 继续使用 `PageScaffold`、现有 design tokens 和现有 `AppButton`，不引入新 UI 框架。
- 不使用大块 Alert、左侧粗彩条或装饰性 inset 条。
- 不新增测试文件；扩展已有 `test/translation-web-targets.test.js`，并运行 Web build 与改动文件 ESLint。
- 不改变 `translationAPI.stream`、`translationAPI.detect`、历史记录、整页翻译和系统取词 API 的请求语义。
- 所有新增动效必须在 `prefers-reduced-motion: reduce` 下关闭。

### Task 1: 建立首屏视觉层级与输入/输出操作主线

**Files:**
- Modify: `web/src/features/translation/TranslationWorkspace.tsx:620-1090`
- Modify: `web/src/features/translation/translation.module.css:1-620`

**Interfaces:**
- JSX keeps existing handlers (`handleTranslate`, `handleClear`, `handleSwap`, `handleCopy`, `stream.cancel`) and state unchanged.
- Add only presentational class names: `heroBar`, `heroLanguageControl`, `primaryAction`, `pane--source`, `pane--result`, `resultToolbar`, `taskStrip`.

- [ ] **Step 1: Add source-level failing assertions for the new structure**

Extend the existing test to read `TranslationWorkspace.tsx` and assert the source contains `heroBar`, `primaryAction`, `pane--source`, `pane--result`, and an `aria-live` result status. Keep the existing forbidden-decoration assertion.

- [ ] **Step 2: Run the focused source test and confirm it fails**

```bash
node --test test/translation-web-targets.test.js
```

- [ ] **Step 3: Reshape the JSX without changing handlers**

Wrap the current toolbar controls in a compact `heroBar`; keep source/target selects and swap in one group, show the selected model as a muted metadata chip, and keep floating translation/auto-copy as secondary controls. Move the page translation section into a `taskStrip` immediately below the hero. Add `pane--source` and `pane--result` classes to the two main panes, keep the textarea and output DOM, and put the result copy/stop/retry buttons into a `resultToolbar` beside the output pane title.

Make the primary translate button use `primaryAction`, keep it disabled while invalid/over-limit/same-language, and add `aria-live="polite"` to the status region without duplicating messages.

- [ ] **Step 4: Style the new hierarchy and responsive behavior**

Use existing variables for spacing, border, surface, accent, shadows, and motion. Give `.heroBar` a subtle raised/glass surface, `.primaryAction` a focused accent glow on hover/focus, `.pane--result` a slightly stronger active outline while streaming, and `.taskStrip` a compact inline task treatment. At `max-width: 1100px`, keep input before output and make the primary action full-width only below the narrow mobile breakpoint. Do not add a left border decoration.

- [ ] **Step 5: Run focused test and commit**

Run the source test and `git diff --check`, then commit only Workspace/CSS/test paths:

```bash
git add web/src/features/translation/TranslationWorkspace.tsx web/src/features/translation/translation.module.css test/translation-web-targets.test.js
git diff --cached --check
git commit -m "feat(translation): clarify workspace primary flow"
```

### Task 2: Improve streaming, completion, cancellation, and error feedback

**Files:**
- Modify: `web/src/features/translation/TranslationWorkspace.tsx:830-1010`
- Modify: `web/src/features/translation/translation.module.css:400-620`
- Modify: `web/src/features/translation/use-translation-feedback.ts:1-80` only if a display field is genuinely missing

**Interfaces:**
- Reuse `useTranslationFeedback` phase and elapsed labels.
- Preserve `stream.state` transitions and cancellation behavior.

- [ ] **Step 1: Identify the current feedback fields and add one narrow presentation guard**

Confirm `feedback.phase`, `feedback.label`, `feedback.hint`, `feedback.elapsedLabel`, `stream.state.status`, `stream.state.error`, and `stream.state.elapsedMs` are sufficient. If not, add only the missing derived label in the existing feedback hook; do not add a second reducer.

- [ ] **Step 2: Add explicit result phase attributes and action semantics**

Set `data-phase={feedback.phase}` on the result pane and add `aria-live="polite"` to the status caption. Render a compact “已停止，保留已翻译部分” state with a retry action, a success check state for copied output, and an inline error code only when supplied. Keep the output text and scroll behavior unchanged.

- [ ] **Step 3: Add motion and state styles**

Use a single status dot with pulse only for preparing/waiting/streaming, a success glow for done, and a quiet muted state for cancelled. Add a one-shot `copyConfirmed` animation to the button label/icon, a short output reveal animation on first content, and a streaming caret. Ensure all are disabled by the existing reduced-motion rule.

- [ ] **Step 4: Run WebUI build and focused tests**

```bash
node --test test/translation-web-targets.test.js
cd web && npm run build
```

- [ ] **Step 5: Commit the feedback checkpoint**

```bash
git add web/src/features/translation/TranslationWorkspace.tsx web/src/features/translation/translation.module.css web/src/features/translation/use-translation-feedback.ts
git diff --cached --check
git commit -m "feat(translation): refine streaming feedback states"
```

### Task 3: Make settings, page jobs, and history easier to scan

**Files:**
- Modify: `web/src/features/translation/TranslationWorkspace.tsx:650-900`
- Modify: `web/src/features/translation/translation.module.css:160-760`
- Modify: `web/src/features/translation/SystemTranslationControl.tsx:100-220`
- Modify: `web/src/features/translation/TranslationProviderSettings.tsx:1-100`
- Modify: `web/src/mobile/pages/MobileTranslation.tsx:120-370`
- Modify: `web/src/mobile/pages/MobileTranslation.module.css:1-220`

**Interfaces:**
- Existing callbacks and API types remain unchanged.
- `SystemTranslationControl` consumes platform-aware fields added by the platform plan; when absent, it falls back to current generic copy.

- [ ] **Step 1: Reorganize advanced settings and page task copy**

Group model, system translation, provider credentials, and routes under an explicit `高级设置` summary with a short description. Change the system description to platform-neutral wording. For page translation, show mode, current progress, failed segment count, stop, retry and undo in one compact task strip. Keep all buttons and handlers wired to existing callbacks.

- [ ] **Step 2: Improve history scanability**

Keep the current local history data and actions, but add a `historyItem--latest` class to the newest entry, show source/target and model metadata in a single line, clamp long text at four lines with `title`, and use action tooltips/aria labels. Do not add automatic deletion or server persistence.

- [ ] **Step 3: Align mobile layout and copy**

Keep the mobile single-column flow but make the primary action sticky within the toolbar while streaming, show detection and character count together, preserve the result caret, and make history entries collapsible or vertically separated without adding a large alert. Reuse shared language/model settings.

- [ ] **Step 4: Run changed-file lint, focused tests, and build**

Run the repository ESLint command against changed TS/TSX files, then:

```bash
node --test test/translation-web-targets.test.js
cd web && npm run build
```

- [ ] **Step 5: Commit the scanability checkpoint**

Commit only the listed WebUI files after inspecting the cached diff and status.

### Task 4: Real page verification and delivery audit

**Files:**
- No source changes unless verification discovers a concrete regression.
- Create: `docs/architecture/translation-platform-matrix.md` only if platform status needs a durable matrix.

- [ ] **Step 1: Run the complete translation-focused checks**

```bash
node --test test/desktop-runtime.test.js test/translation-execution-integration.test.js test/translation-web-targets.test.js
cd web && npm run build
```

Run ESLint on every changed WebUI file and `git diff --check`.

- [ ] **Step 2: Inspect the real WebUI without disturbing active services**

Use the existing logged-in Edge session if available. Verify `/translation` at desktop and narrow viewports: initial empty state, text input, language swap, detection chip, streaming output, stop/retry, copy confirmation, page task progress/undo, history copy/delete, advanced settings expansion, and system translation status. Do not restart any active `127.0.0.1:9527` process.

- [ ] **Step 3: Inspect macOS native behavior**

Use the existing desktop entrypoint to verify helper handshake, shortcut, selection, status, stream, cancel, restart, and full-app settings. Record real evidence separately from static tests.

- [ ] **Step 4: Record Windows/Linux evidence boundaries**

Windows requires a Windows build and real helper run before claiming full alignment. Linux should show the explicit deferred desktop status while WebUI translation remains available.

- [ ] **Step 5: Commit only verified documentation changes**

If a platform matrix is needed, commit it separately from source changes. Keep the goal active until every explicit platform requirement has real evidence.
