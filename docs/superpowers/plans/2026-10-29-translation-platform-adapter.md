# 翻译平台适配器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将翻译桌面 helper 的平台选择、能力状态和 Windows 首期构建接入现有 JSONL 生命周期，同时对 Linux 桌面版暂缓保持诚实可见。

**Architecture:** 新增平台描述符门面，服务层只消费当前平台描述符；macOS 构建保持原实现，Windows 使用独立构建器和 helper 源码目录，共用 `desktop-protocol`、`desktop-launcher` 与 Node 翻译执行端口。Windows helper 首期通过全局快捷键和剪贴板选区捕获，不把凭据或 HTTP 监听放进 native 进程。

**Tech Stack:** Node.js CommonJS, existing JSONL desktop protocol, Windows .NET SDK/Win32 APIs, existing Swift/AppKit macOS helper.

**Spec:** `docs/superpowers/specs/2026-10-29-translation-windows-ui-design.md`

## Global Constraints

- 不新增 `AIH_*` 环境变量；平台配置走现有 server/UI/settings 入口。
- 不改动或覆盖工作区已有未跟踪的 `provider-manifest`。
- 不新增或修改测试文件；验证只运行现有测试、静态检查、构建和真实运行态。
- Linux 桌面版暂缓必须通过 `supported: false` 和可理解文案显式呈现。
- Windows 未经 Windows 实机/CI 构建和运行验证前，不得在报告中声称 native 完整对齐。
- helper 不持有凭据、不监听 HTTP，翻译执行继续经过 Node execution port。

### Task 1: 建立平台能力描述符门面

**Files:**
- Create: `lib/desktop/translation/platform-adapter.js`
- Modify: `lib/desktop/translation/service.js:9-46`

**Interfaces:**
- `getTranslationPlatformAdapter(platform, options)` returns `{ id, supported, build, mode, captureModes, permission, shortcut, statusText }`.
- Supported `id` values are `darwin`, `win32`, and `linux`; only `darwin` and the Windows builder are eligible to build a helper.
- `createSystemTranslationService()` calls the facade once during construction and uses its descriptor for `supported`, `build`, and status detail.

- [ ] **Step 1: Use existing runtime tests as the regression baseline**

Use the existing desktop runtime tests and inspect their platform injection paths; do not add test files or modify tests.

```js
assert.equal(getTranslationPlatformAdapter('linux').supported, false);
assert.match(getTranslationPlatformAdapter('linux').statusText, /Linux.*桌面版/);
assert.equal(getTranslationPlatformAdapter('darwin', { build: async () => '/tmp/mac' }).supported, true);
assert.equal(getTranslationPlatformAdapter('win32', { build: async () => 'aih-translation.exe' }).id, 'win32');
```

Run the existing service coverage with `platform: 'linux'` and an injected `build` to confirm explicit dependency injection remains testable, while the default Linux adapter remains unsupported.

- [ ] **Step 2: Run the existing focused tests before implementation**

Run:

```bash
node --test test/desktop-runtime.test.js test/translation-execution-integration.test.js
```

Expected: the existing suite remains green before the production change.

- [ ] **Step 3: Implement the facade without provider/platform branching in service flow**

Implement `platform-adapter.js` with a registry of descriptor factories. The macOS factory delegates to `buildMacTranslationHelper`/`buildMacTranslationApp` based on `mode`; Windows delegates to `buildWindowsTranslationHelper`/`buildWindowsTranslationApp`; Linux returns `supported: false` and `build: null`. Allow `options.build` only as an explicit dependency injection for tests and preserve `mode` in the descriptor.

Replace `ADAPTERS` and `mode === 'full-app' && platform === 'darwin'` in `service.js` with one `getTranslationPlatformAdapter(platform, { mode, build: buildImpl })` call. Use descriptor `statusText` for the initial snapshot detail and add `platform` plus `captureModes` to `getStatus()`.

- [ ] **Step 4: Run focused tests and verify platform state**

Run the same two test files. Expected: all existing tests plus the new platform assertions pass, and Linux default status is `unsupported` while injected builders remain testable.

- [ ] **Step 5: Commit the adapter checkpoint**

```bash
git add lib/desktop/translation/platform-adapter.js lib/desktop/translation/service.js test/desktop-runtime.test.js test/translation-execution-integration.test.js
git diff --cached --check
git commit -m "feat(translation): add desktop platform capability adapter"
```

### Task 2: Add Windows helper source and builder contract

**Files:**
- Create: `native/translation/windows/Program.cs`
- Create: `native/translation/windows/AihTranslation.csproj`
- Create: `lib/desktop/translation/windows-build.js`
- Modify: `lib/desktop/translation/platform-adapter.js`
- Modify: `lib/desktop/runtime/desktop-protocol.js:1-80`

**Interfaces:**
- `buildWindowsTranslationExecutable(aiHomeDir, { mode, runImpl, platform, arch })` returns the executable path or throws a stable `windows_helper_build_unavailable` error.
- `native/translation/windows/Program.cs` reads newline-delimited JSON from stdin, writes newline-delimited JSON to stdout, emits `ready` after `hello`, and never logs secrets.
- The helper supports `configure`, `translate-intent`, `translate`, `cancel`, `settings`, and `request-permission` events through the existing protocol vocabulary.

- [ ] **Step 1: Inspect existing protocol/runtime coverage for the Windows contract**

Use the existing protocol/runtime coverage and manual Node probes to verify bounded capability metadata, Windows capture modes, and injected builder dependencies; do not modify test files.

- [ ] **Step 2: Run the existing focused tests before implementation**

Run:

```bash
node --test test/desktop-runtime.test.js
```

Expected: the existing suite remains green before the production change.

- [ ] **Step 3: Implement the Windows builder with atomic runtime output**

Use `fs/promises`, `path`, `os`, and `child_process.execFile` (injected as `runImpl` for tests). Resolve the repository project path, call `dotnet publish <project> -c Release -r win-<arch> --self-contained true -p:PublishSingleFile=true -o <temporary-output>`, then atomically rename the produced executable into `<aiHomeDir>/run/desktop-translation/windows/<mode>/aih-translation.exe`. Cache by a hash of source files, project file, mode, platform, and arch; never use `cp` or truncate an executable in place. When `dotnet` is missing, throw `windows_helper_build_unavailable` with an actionable message.

- [ ] **Step 4: Implement the minimal Win32 JSONL helper**

`Program.cs` should:

1. Set UTF-8 stdin/stdout and read JSON lines.
2. Answer `hello` with `{ version: 1, type: "ready" }`.
3. Keep configuration in memory and register a global hotkey from the configured shortcut when possible.
4. On the hotkey, save clipboard text/format, send `Ctrl+C` to the foreground window, read plain text, restore the original clipboard in `finally`, and emit `translate-intent` with a fresh id.
5. Emit `status` with `trusted: true` when the process is running; emit `error` with `windows_shortcut_registration_failed` or `windows_clipboard_capture_failed` for failures.
6. Forward `cancel` and `settings` as lifecycle state without attempting translation itself.

Keep the first helper window intentionally small and native: a borderless topmost Win32 window with source/target/status text and a multiline output control. The Node service remains the source of translation events; the helper renders `start`, `delta`, `done`, and `error` events.

- [ ] **Step 5: Extend protocol normalization for capability/status metadata**

Allow bounded `platform`, `captureModes`, `shortcut`, and `permission` fields on `configure`/`status` events. Do not broaden the generic sanitizer or allow credentials. Preserve the current version and event allowlist.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
node --test test/desktop-runtime.test.js
git diff --check
```

Commit only the Windows source, builder, platform facade, protocol, and existing test changes:

```bash
git add native/translation/windows lib/desktop/translation/windows-build.js lib/desktop/translation/platform-adapter.js lib/desktop/runtime/desktop-protocol.js test/desktop-runtime.test.js
git diff --cached --check
git commit -m "feat(translation): add windows desktop helper contract"
```

### Task 3: Surface platform capability and shortcut semantics in WebUI

**Files:**
- Modify: `web/src/types/index.ts:3903-3940`
- Modify: `web/src/features/translation/SystemTranslationControl.tsx:1-220`
- Modify: `web/src/features/translation/TranslationWorkspace.tsx:730-738`
- Modify: `web/src/features/translation/translation.module.css:718-760`

**Interfaces:**
- `SystemTranslationStatus` gains optional `platform`, `captureModes`, `shortcut`, and `permission` fields.
- `SystemTranslationControl` renders platform-specific title, capture description, shortcut hint, permission action, and Linux deferred state from the status object.

- [ ] **Step 1: Add source-level assertions for platform-aware copy and forbidden decorations**

Use the existing translation target source check and a manual source inspection to verify platform-aware branches/copy and the existing no-Alert/no-border-left invariant; do not modify test files.

- [ ] **Step 2: Run the existing WebUI source test before implementation**

Run:

```bash
node --test test/translation-web-targets.test.js
```

Expected: the existing source test remains green before the production change.

- [ ] **Step 3: Implement capability-aware status rendering**

Use a small pure helper in `SystemTranslationControl.tsx` to map `platform` and `captureModes` to:

- macOS: `系统取词` / `选中文本后可直接翻译` / permission is Accessibility.
- Windows: `桌面取词` / `使用快捷键复制选区后翻译` / permission is Clipboard/shortcut.
- Linux: `桌面取词` / `Linux 桌面版暂未提供，可继续使用 WebUI 划词翻译` and disable the system switch.

Render the configured shortcut in a `<kbd>` token, keep status/error/action inline, and do not change API request behavior. Change the Workspace advanced-settings description to a platform-neutral `桌面取词、全局快捷键和权限状态`.

- [ ] **Step 4: Run the existing WebUI source test and commit**

Run:

```bash
node --test test/translation-web-targets.test.js
```

Then commit only the listed WebUI/type/test files after `git diff --cached --check`.

### Task 4: Platform verification and documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-10-29-translation-windows-ui-design.md`
- Modify: `docs/providers/agent-cli-usage.md` only if the platform command surface is documented there; otherwise create `docs/architecture/translation-platform-matrix.md`
- Modify: existing runtime tests only when a verified gap is discovered

- [ ] **Step 1: Run Node verification**

```bash
node --test test/desktop-runtime.test.js test/translation-execution-integration.test.js test/translation-web-targets.test.js
```

- [ ] **Step 2: Run WebUI verification**

```bash
cd web && npm run build
```

Run ESLint only on changed WebUI files using the repository's configured ESLint command.

- [ ] **Step 3: Verify real macOS behavior without restarting active services**

Use the existing desktop translation entrypoint to check helper handshake, shortcut, selection, streaming delta, cancel, restart, and full-app mode. Record platform status and any permission boundary. Do not restart a running `127.0.0.1:9527` instance.

- [ ] **Step 4: Verify Windows when a Windows runner is available**

Build the published helper, launch it in helper and full-app modes, send `hello`/`configure`, trigger the shortcut in Notepad or another text editor, verify clipboard restoration, stream a translation, cancel it, and observe parent-exit cleanup. If no Windows runner exists, report the exact missing evidence and keep the goal active.

- [ ] **Step 5: Commit verified documentation only**

Update the platform matrix with implemented/tested/real-runtime states and commit the documentation separately.
