# Chat 消息体验与大文本引用实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 WebUI Chat/Workbench 的消息展示、复制、模型/耗时信息和大文本粘贴文件引用形成统一且可恢复的闭环。

**Architecture:** 复用现有 `ChatMessage.metrics`、`MessageMetadata`、附件验证/上传/持久化和 canonical `attachmentIds` 协议。前端先把 legacy/canonical 消息投影到统一展示组件；composer 用显式附件状态机拦截超过阈值的文本粘贴；服务端继续在受控目录落盘并只向 harness/provider 投影真实文件路径。

**Tech Stack:** React 18 + TypeScript + Ant Design + Umi Webpack；Node.js CommonJS；现有 Chat Runtime SSE/session store；现有 `contracts/chat-attachments.json` 限制与附件服务。

**Spec:** `docs/superpowers/specs/2026-10-27-chat-message-experience-design.md`

## Global Constraints

- 不新增 `AIH_*` 环境变量；不改变 provider 路由、凭据或模型选择策略。
- Web 源码改动必须执行 `cd web && npm run build`、改动文件 ESLint 和相关现有测试。
- 不新增测试文件；使用现有测试入口、纯函数探针和真机 WebUI 检查。
- 保留并行会话已有修改，不暂存 `lib/server/web-ui-router.js`、`web/src/pages/Toolkit.tsx` 等无关路径。
- 大文本阈值为 200 个 Unicode 字符，达到即转为文本附件（2026-10-31 由 12,000 字符 / 48 KiB 下调）。

### Task 1: 统一消息元数据与复制反馈

**Files:**
- Modify: `web/src/components/chat/MessageMetadata.tsx`
- Modify: `web/src/components/chat/MessageIconActions.tsx`
- Modify: `web/src/components/chat/MessageBubble.tsx`
- Modify: `web/src/features/chat-runtime/TimelineItemView.tsx`
- Modify: `web/src/components/chat/message-bubble.module.css`

**Interfaces:**
- Consumes: `ChatMessage.model`, `ChatMessage.metrics`, `TimelineItem.detail.model`, `TimelineItem.detail.metrics` and rendered message content.
- Produces: one metadata row per message with actual model/provider label, duration/TTFT labels, progress timer, and a unified copy action with `copied` state.

- [ ] **Step 1: Write the failing behavior probe.** Use a one-off TypeScript runtime probe (do not add a repository test file) to assert that missing metrics produce empty labels, zero duration remains valid, and copy input is message content only. Run it before editing and confirm the intended UI contract is absent.
- [ ] **Step 2: Trace all call sites.** Run `rg -n "<MessageMetadata|MessageIconActions|copyText=" web/src/components web/src/features`; record any call site that falls back to the current composer model.
- [ ] **Step 3: Implement the metadata/action boundary.** Keep `MessageMetadata` responsible for time/model/metrics and `MessageIconActions` responsible for clipboard feedback. Assistant rows show only real duration, TTFT, and tok/s fields.
- [ ] **Step 4: Wire legacy and canonical messages.** Pass historical message model/metrics/content from `MessageBubble` and `TimelineItemView`; never read current composer selection for history.
- [ ] **Step 5: Add stable streaming presentation.** During progress show `生成中 · X.Xs`; after completion replace it with server metrics without changing row geometry.
- [ ] **Step 6: Verify and commit.**
  ```bash
  cd web && npx eslint src/components/chat/MessageMetadata.tsx src/components/chat/MessageIconActions.tsx src/components/chat/MessageBubble.tsx src/features/chat-runtime/TimelineItemView.tsx
  npm run build
  git add web/src/components/chat/MessageMetadata.tsx web/src/components/chat/MessageIconActions.tsx web/src/components/chat/MessageBubble.tsx web/src/features/chat-runtime/TimelineItemView.tsx web/src/components/chat/message-bubble.module.css
  git diff --cached --check
  git commit -m "feat(chat): unify message metadata and copy feedback"
  ```

### Task 2: Shared large-paste conversion and attachment state

**Files:**
- Modify: `web/src/components/chat/attachment-files.ts`
- Modify: `web/src/components/chat/use-chat-file-input.ts`
- Modify: `web/src/features/chat-runtime/use-composer-attachments.ts`
- Modify: `web/src/features/chat-runtime/Composer.tsx`
- Modify: `web/src/features/chat-runtime/ComposerAttachmentPreview.tsx`
- Modify: `web/src/components/chat/ComposerAttachmentGallery.tsx`
- Modify: `web/src/components/chat/MessageArea.tsx`
- Modify: `web/src/components/chat/composer/composer.module.css`

**Interfaces:**
- Consumes: browser `ClipboardEvent`, `ChatDocumentAttachment`, existing `ChatRuntimeAttachmentUpload`.
- Produces: `LARGE_PASTE_CHAR_LIMIT`, `LARGE_PASTE_BYTE_LIMIT`, `shouldConvertLargePaste`, `buildPastedTextFile`, and pending attachment states.

- [ ] **Step 1: Write the failing pure conversion probe.** Probe short and 200-character strings and assert only threshold content becomes a UTF-8 `.txt` attachment.
- [ ] **Step 2: Add conversion helpers.** In `attachment-files.ts`, use `Array.from(text).length` and `TextEncoder().encode(text).byteLength`; generate `pasted-text-YYYYMMDD-HHmmss.txt`.
- [ ] **Step 3: Extend pending state.** Add `preparing|ready|uploading|uploaded|failed` and an error field while retaining document text for retry.
- [ ] **Step 4: Intercept canonical Composer paste.** If no clipboard files exist and text reaches either threshold, prevent default, create a File, and add it through the existing attachment controller; short text stays native.
- [ ] **Step 5: Intercept legacy MessageArea paste.** Reuse the same helpers and preserve existing image/file paste behavior.
- [ ] **Step 6: Render chips.** Show file name, byte size, state, remove, and retry actions using compact inline styles rather than an Alert block.
- [ ] **Step 7: Verify and commit.** Run changed-file ESLint, full Web build, pure helper probe, and a browser DOM check for short paste, large paste, removal, and failure; commit only Task 2 paths with `feat(chat): convert large paste to file references`.

### Task 3: Attachment reference submission and server projection

**Files:**
- Inspect/Modify: `web/src/chat-runtime/api-types.ts`
- Inspect/Modify: `web/src/chat-runtime/api-client.ts`
- Inspect/Modify: `web/src/features/chat-runtime/use-composer-controller.ts`
- Inspect/Modify: `web/src/features/chat-runtime/session-runtime-actions.ts`
- Inspect/Modify: `lib/server/webui-chat-routes.js`
- Inspect/Modify: `lib/server/chat-attachment-persistence.js`
- Inspect/Modify: `lib/server/chat-document-attachments.js`
- Inspect/Modify: `lib/server/chat-attachment-validation.js`

**Interfaces:**
- Consumes: uploaded attachment IDs, pending file contents, existing `materializeChatAttachments` and `appendDocumentPathsToPrompt`.
- Produces: idempotent submit payload with `attachmentIds`; server-side prompt projection containing controlled paths without exposing arbitrary paths to browser state.

- [ ] **Step 1: Trace contracts.** Inspect `api-types.ts`, `api-client.ts`, the upload/submit section of `webui-chat-routes.js`, and the attachment repository before changing fields.
- [ ] **Step 2: Write the failing no-inline probe.** Assert large text submit content contains only the optional user note while `attachmentIds` contains the uploaded ID; assert server prompt uses the persisted path rather than browser text.
- [ ] **Step 3: Keep canonical submit reference-only.** `dispatchComposerInput` uploads once and submits `content + attachmentIds`; it must not append document text.
- [ ] **Step 4: Align legacy submission.** Route new legacy documents through the same upload/materialization path; preserve historical message compatibility.
- [ ] **Step 5: Preserve server safety.** Reuse path sanitization, atomic writes, UTF-8/MIME/size validation, and attachment ownership; reuse an existing attachment ID without rewriting it.
- [ ] **Step 6: Verify and commit.** Run focused existing Chat/attachment/server tests, changed-file ESLint, Web build, and no-inline probe; commit only Task 3 paths with `fix(chat): submit large text as persisted references`.

### Task 4: End-to-end verification and handoff

- [ ] **Step 1:** Run relevant existing tests, all changed-file ESLint, `cd web && npm run build`, and `git diff --check`.
- [ ] **Step 2:** In the already-open Edge session verify streaming timer, actual model/provider, duration/TTFT, copy feedback, short paste, large-paste chip, send reference, and retryable failure.
- [ ] **Step 3:** Verify browser-visible attachment state contains ID/name only while provider prompt receives a controlled persisted path; redact credentials and file contents.
- [ ] **Step 4:** Review projection/facade, attachment state machine, capability-preserving adapter boundaries, and unrelated worktree paths.
- [ ] **Step 5:** Report commits, tests/build/lint, real UI evidence, and remaining limitations; do not claim completion without fresh evidence for every acceptance item.

### Task 5: macOS native Chat parity

**Files:**
- Modify: `native/chat/ChatPanel.swift`
- Modify: `native/chat/ChatPanelContent.swift`
- Modify: `lib/desktop/chat/chat-runtime-bridge.js`
- Modify: `lib/desktop/chat/chat-runtime-protocol.js`

**Interfaces:**
- Consumes: native timeline events, runtime model/metrics detail, existing JSONL chat bridge and text submission path.
- Produces: native Chat message rows with actual model/provider, elapsed/TTFT metadata, copy action, and large pasted-text file reference instead of an 8,000-character hard rejection.

- [ ] **Step 1: Trace native event payloads.** Identify the runtime timeline item/detail fields carrying model and metrics and the existing native composer event path; preserve identity guards.
- [ ] **Step 2: Write a failing Swift/Node protocol probe.** Assert a message event with model/metrics reaches the native projection and that a large text reference payload is accepted by the bridge protocol without putting the full body in the normal text field.
- [ ] **Step 3: Render native metadata and copy.** Add compact metadata below assistant rows and a copy button that writes only the row content to the pasteboard with temporary “已复制” feedback; preserve streaming selection.
- [ ] **Step 4: Add native large-text reference path.** For text beyond the shared threshold, emit a file-reference attachment command through the existing host bridge; keep short text inline and retain failure/retry state in the native composer.
- [ ] **Step 5: Verify and commit.** Run Swift typecheck, Node protocol/bridge tests or probes, and native helper build checks; commit only Task 5 paths with `feat(desktop-chat): add message metadata and file references`.
