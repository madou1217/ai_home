# Management Key Durability and QR Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent normal configuration and WebUI flows from clearing a configured Management Key, and let `aih server config --show-secrets --qr` hand Server URL plus key to a phone setup form.

**Architecture:** Keep `config:server` as the only server credential persistence boundary and thread an explicit clear intent through the CLI only after a confirmation flag. Isolate QR payload/encoding/rendering in a Node CLI service, and isolate camera decoding/payload validation in a controlled WebUI component reused by desktop and mobile setup forms.

**Tech Stack:** Node.js CommonJS, existing server config command/store, package-free QR encoder and ANSI terminal renderer, React 18 + TypeScript + Ant Design, browser `BarcodeDetector` and `MediaDevices` APIs, existing control-plane profile connection service.

**Spec:** `docs/superpowers/specs/2026-10-25-management-key-qr-design.md`

## Global Constraints

- Normal updates preserve an existing non-empty Management Key when the input omits it or supplies an empty value.
- Clearing requires `--clear-management-key --confirm-clear-management-key`; an unconfirmed clear must not write.
- QR payload is versioned JSON containing `v:1`, `type:"aih-server-credentials"`, `endpoint`, and `managementKey`.
- Credentials never enter URLs, logs, process arguments, or ordinary DOM attributes; QR mode intentionally displays the secret as a scannable terminal image.
- Do not add any `AIH_*` environment variable.
- Do not create or modify repository test files; use temporary `/tmp` assertion scripts plus existing test files and real CLI/runtime checks.
- Every WebUI source change requires `cd web && npm run lint` for changed files and `npm run build` before its checkpoint commit.
- Use short, single-purpose commits and stage only the checkpoint files.

---

### Task 1: Make Management Key clearing explicit and durable

**Files:**
- Modify: `lib/server/server-config-store.js`
- Modify: `lib/server/server-config-command.js`
- Modify: `lib/server/server-config-schema.js`
- Modify: `lib/cli/services/server/usage.js`
- Test with temporary script: `/tmp/aih-management-key-durability-check.cjs`

**Interfaces:**
- `mergeServerConfigPatch(currentConfig, patch, options)` keeps the existing key for an empty/omitted normal patch and accepts an internal `allowManagementKeyClear` option only for the confirmed CLI path.
- `parseServerConfigArgs(args)` returns `confirmClearManagementKey` and marks a clear request without mutating storage.
- `runServerConfigCommand()` rejects an unconfirmed clear with exit code `1` and the exact required flag in the message.
- `buildServerUsageText()` and `printConfigUsage()` document both flags.

- [ ] **Step 1: Write a temporary failing assertion script.** Create `/tmp/aih-management-key-durability-check.cjs` that imports the store and command modules, checks that `mergeServerConfigPatch({managementKey:'old-key'}, {managementKey:''})` still returns `old-key`, checks that `parseServerConfigArgs(['set','--clear-management-key'])` marks an unconfirmed clear, and invokes `runServerConfigCommand()` with a writer spy asserting it is not called. Run it and capture the failure showing the current empty patch clears the key or the parser lacks the confirmation state.

- [ ] **Step 2: Add the store mutation boundary.** Change `mergeServerConfigPatch` so an empty `managementKey` is ignored unless `options.allowManagementKeyClear === true`. Preserve a non-empty replacement exactly as today. Update `writeServerConfig` to pass the option through without persisting it, so ordinary callers cannot accidentally clear a configured key.

- [ ] **Step 3: Add CLI confirmation parsing.** Add `confirmClearManagementKey: false` to parser state, parse `--confirm-clear-management-key`, and reject any `--confirm-clear-management-key` without `--clear-management-key`. For a clear request without confirmation, `runServerConfigCommand` prints `Management Key 清理需要同时传 --confirm-clear-management-key。` and returns `1` before calling `writeServerConfig`. For a confirmed request, call `writeServerConfig(parsed.patch, { allowManagementKeyClear: true })`; keep all other writes on the normal path.

- [ ] **Step 4: Update help and usage text.** Add `--confirm-clear-management-key` beside `--clear-management-key` in `printConfigUsage()` and `lib/cli/services/server/usage.js`. Keep `server config list`’s single descriptor table authoritative; describe the confirmation requirement in the Management Key summary without exposing a secret.

- [ ] **Step 5: Run the temporary red-green check.** Re-run `/tmp/aih-management-key-durability-check.cjs`; expect the unconfirmed writer spy to remain untouched, normal empty patches to retain `old-key`, and confirmed patches to produce an empty key only when the option is true. Delete the temporary script after the check.

- [ ] **Step 6: Run focused existing checks and inspect the diff.** Run `node bin/ai-home.js server config --help`, `node bin/ai-home.js server --help`, `git diff --check`, and `git diff --cached` after staging only the four implementation files. Commit:

  ```bash
  git add lib/server/server-config-store.js lib/server/server-config-command.js lib/server/server-config-schema.js lib/cli/services/server/usage.js
  git diff --cached --check
  git commit -m "fix: require confirmation before clearing management key"
  ```

### Task 2: Add the QR payload, encoder, and terminal renderer

**Files:**
- Create: `lib/cli/services/server/management-key-qr.js`
- Modify: `lib/server/server-config-command.js`
- Modify: `lib/cli/services/server/usage.js`
- Test with temporary script: `/tmp/aih-management-key-qr-check.cjs`

**Interfaces:**
- `buildManagementKeyQrPayload({ endpoint, managementKey }) -> string` returns compact JSON with the four required payload fields and rejects a missing/invalid key.
- `parseManagementKeyQrPayload(value) -> { endpoint, managementKey }` validates the same contract for reuse by CLI checks and WebUI documentation.
- `renderQrTerminal(value, options?) -> string` returns a quiet-zone terminal matrix using high-contrast block cells and no raw payload text.
- `printManagementKeyQr(config, io?) -> void` prints the QR plus concise scan instructions without printing the key separately.

- [ ] **Step 1: Write a temporary failing assertion script.** Create `/tmp/aih-management-key-qr-check.cjs` with assertions for exact payload JSON, rejection of a short key and non-HTTP endpoint, a rendered matrix containing equal-width rows and quiet-zone blank cells, and `parseServerConfigArgs(['show','--qr'])` requiring `--show-secrets`. Run it and confirm the missing module/flag behavior fails before implementation.

- [x] **Step 2: Implement payload validation.** In `management-key-qr.js`, normalize endpoint with `new URL`, accept only `http:`/`https:`, require a 32–4096 character key without CR/LF/NUL (matching the WebUI profile and browser transport limit), and serialize `{v:1,type:'aih-server-credentials',endpoint,managementKey}` with stable key order. Export a parser that returns only endpoint and key after checking all fields.

- [ ] **Step 3: Implement the package-free QR encoder.** Add the MIT-licensed byte-mode QR implementation required for this payload (Nayuki-style `QrCode.encodeText`/matrix logic) inside the focused module or a sibling private helper. Select the smallest supported version at error-correction level M, choose the best mask, and expose a boolean matrix with a four-module quiet zone. Do not read from the network or shell out to `qrencode`.

- [ ] **Step 4: Implement terminal rendering.** Render two matrix rows per terminal line with `\u2588`/ANSI background or equivalent high-contrast blocks, preserve the quiet zone, detect non-TTY output without writing the raw key, and include only `扫码后在手机 Server Setup 中确认并提交` as explanatory text.

- [ ] **Step 5: Wire CLI flags.** Parse `--qr`; reject it unless `--show-secrets` is present with a non-zero exit and no secret output. In JSON mode, return the existing public config plus a `qr` marker only when requested; in human mode call `printManagementKeyQr` after reading the persisted config. Update server usage text with `--qr` and keep plain `--show-secrets` output unchanged.

- [ ] **Step 6: Run the temporary QR checks and real CLI.** Run `/tmp/aih-management-key-qr-check.cjs`, then run `node bin/ai-home.js server config show --show-secrets --qr` with output redirected to a temporary file. Assert the file contains the QR instruction and no literal `managementKey` JSON field or known key prefix. Run `node bin/ai-home.js server config show --qr` and confirm it exits non-zero without reading secrets. Delete temporary files.

- [ ] **Step 7: Commit the CLI checkpoint.** Stage only `management-key-qr.js`, `server-config-command.js`, and `lib/cli/services/server/usage.js`, inspect the cached diff, and commit:

  ```bash
  git add lib/cli/services/server/management-key-qr.js lib/server/server-config-command.js lib/cli/services/server/usage.js
  git diff --cached --check
  git commit -m "feat: show management key as terminal qr"
  ```

### Task 3: Add shared browser QR scanning to setup forms

**Files:**
- Create: `web/src/components/control-plane/ManagementKeyQrScanner.tsx`
- Create: `web/src/components/control-plane/ManagementKeyQrScanner.module.css`
- Modify: `web/src/mobile/pages/MobileServerSetup.tsx`
- Modify: `web/src/mobile/pages/MobileServers.tsx`
- Modify: `web/src/pages/FabricServerSetup.tsx`
- Modify: `web/src/pages/Settings.tsx`
- Modify: `web/src/components/control-plane/use-server-setup-profiles.ts`
- Modify: `web/src/components/control-plane/use-control-plane-servers.ts`

**Interfaces:**
- `ManagementKeyQrScanner` props are `{ open, onClose, onDecoded, onError? }`; `onDecoded` receives `{ endpoint: string; managementKey: string }`.
- The scanner uses `navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })`, `BarcodeDetector` when available, and stops every track on close, decode, error, and unmount.
- `onDecoded` is called only after the same `v/type/endpoint/key` validation contract as the CLI payload.

- [ ] **Step 1: Write a temporary TypeScript contract check.** Create a temporary `/tmp/aih-management-key-scanner-contract.ts` containing the expected props and a call to the exported payload parser through a copied pure helper import. Run the existing TypeScript compiler/build path and confirm the component/helper symbols are absent before implementation; do not add the temporary file to the repository.

- [ ] **Step 2: Implement the scanner component.** Add a compact Ant Design modal with a video element, start/stop lifecycle, camera permission error text, decoder-unavailable text, and a manual “关闭并手动输入” action. Use `BarcodeDetector`’s `detect(video)` on a short animation-frame loop, parse `rawValue`, stop tracks immediately after a valid result, and never put the raw value in an element attribute or URL.

- [ ] **Step 3: Add scanner actions to forms.** Add a `扫描二维码` button beside the Management Key input in the desktop setup, mobile setup, mobile server management, and desktop Settings Server form. Each form owns `scannerOpen` state, passes decoded values to `form.setFieldsValue`/`setFieldValue`, and leaves the existing required validation and submit handler unchanged.

- [ ] **Step 4: Preserve empty-edit semantics.** Ensure scanner decode writes a non-empty key, while form reset after successful save clears only the in-memory input field. Keep `connectControlPlaneProfile`’s omitted-key behavior and the profile service’s existing merge behavior; no scanner path may call `removeControlPlaneProfile` or write a blank key.

- [ ] **Step 5: Run WebUI gates.** Run eslint only for the changed/new files, then run `cd web && npm run build`. Fix all TypeScript/import/runtime errors before staging. Use a browser smoke with a stubbed `BarcodeDetector` to confirm valid payload fills endpoint/key, invalid payload leaves fields unchanged, and closing the modal stops tracks.

- [ ] **Step 6: Commit the WebUI checkpoint.** Stage only the scanner component, stylesheet, and the four form/hook files, inspect the cached diff, and commit:

  ```bash
  git add web/src/components/control-plane/ManagementKeyQrScanner.tsx web/src/components/control-plane/ManagementKeyQrScanner.module.css web/src/mobile/pages/MobileServerSetup.tsx web/src/mobile/pages/MobileServers.tsx web/src/pages/FabricServerSetup.tsx web/src/pages/Settings.tsx web/src/components/control-plane/use-server-setup-profiles.ts web/src/components/control-plane/use-control-plane-servers.ts
  git diff --cached --check
  git commit -m "feat(webui): scan management key qr in server setup"
  ```

### Task 4: End-to-end verification and checkpoint audit

**Files:**
- Verify: `docs/superpowers/specs/2026-10-25-management-key-qr-design.md`
- Verify: all files from Tasks 1–3
- Temporary only: `/tmp/aih-management-key-e2e-check.cjs`

**Interfaces:**
- The running Server remains the authoritative persistence/runtime target; verification must compare redacted key metadata, never print the credential.

- [ ] **Step 1: Verify repository state.** Run `git status --short --branch`, `git log --oneline -5`, and `git diff --check`; confirm both feature commits are present and no temporary files are tracked.

- [ ] **Step 2: Verify CLI behavior.** Run `node bin/ai-home.js server config --help`, `node bin/ai-home.js server config show`, and the QR command. Run a temporary injected-writer check for unconfirmed and confirmed clearing. Confirm plain `--show-secrets` remains backward-compatible while QR mode omits raw key text.

- [ ] **Step 3: Verify live management status without exposing the key.** Read the persisted config and active profile, print only configured/length/hash-prefix metadata, request `GET /v0/webui/management/status` with the key in the process environment of a one-shot script, and record only HTTP status plus `ok`/`error` fields. Confirm HTTP 200 and unchanged key digest after empty edit attempts.

- [ ] **Step 4: Verify WebUI gates and visual path.** Run changed-file eslint and `cd web && npm run build` again after the final checkpoint. Open desktop and mobile Server Setup in the existing browser session, confirm the scan action is visible without a large Alert block or left-side status bar, and confirm manual entry remains usable when camera decoding is unavailable.

- [ ] **Step 5: Review against the completion audit.** Check each explicit requirement in the spec: no implicit clear, confirmed clear only, QR payload fields, scanner validation/lifecycle, no secret leakage, current status 200, and clean/staged history. Report any missing evidence instead of claiming completion.

- [ ] **Step 6: Remove temporary verification files and report design patterns.** Delete only the named `/tmp` scripts, run `git status --short`, and in the final report list the concrete pattern locations, rationale, and verification evidence for the mutation boundary, QR service boundary, and shared scanner facade.
