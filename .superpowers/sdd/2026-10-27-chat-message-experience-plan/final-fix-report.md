# Final whole-branch fix report

## Fixes

- `native/chat/ChatPanel.swift` and `native/chat/ChatPanelContent.swift` now share the Chat large composer rule: file reference at `>= 12,000` grapheme-safe characters or `>= 48 KiB` UTF-8 bytes. The short inline branch, atomic temp file, compact JSONL path reference, draft retry, and cleanup remain intact.
- `web/src/features/chat-runtime/use-composer-attachments.ts` retains the server returned `attachmentId` in pending state. `use-composer-controller.ts` uploads only attachments without IDs, records IDs before submit, and retries submit with the same IDs after a failed turn. Failed uploads remain retryable; browser state contains IDs and no server paths.
- Native snapshot restore now projects assistant item ID, turn ID, provider, model, duration, TTFT, and tokens/sec metadata through `restoreMessages`, preserving user rows and assistant identity maps for later streaming updates. Missing metrics remain absent.
- `lib/server/webui-chat-routes.js` keeps the provider-facing native/harness prompt with controlled persisted paths, while API-proxy messages use validated document text fallback and a safe original-note plus attachment-name marker. OpenCode session begin and pure Chat history persistence use the redacted prompt.
- `lib/desktop/chat/chat-runtime-bridge.js` accepts only native-owned temporary references (`$TMPDIR/aih-chat-<uuid>.txt`), verifies realpath ownership and regular-file type before reading, and never unlinks a rejected arbitrary path. Native temporary references continue to upload and clean up atomically.

## Verification

- Native threshold matrix probe:
  `node <<'NODE' ... NODE`
  Output: `native threshold matrix probe passed: short stays inline; exact Unicode and UTF-8 boundaries use file reference`.
- Upload-once/retry-ID reuse probe:
  `node <<'NODE' ... NODE`
  Output: `upload-once/retry-ID source probe passed: only missing IDs upload; submit reuses stored IDs`.
- Native snapshot metadata projection probe:
  `node <<'NODE' ... NODE`
  Output: `native snapshot metadata projection probe passed: provider/model/metrics feed restored row metadata with stable item identity`.
- API-proxy redaction probe:
  `node <<'NODE' ... NODE`
  Output: `API-proxy redaction probe passed: history/OpenCode use safe marker prompt while native retains controlled path projection`.
- Native path ownership probe:
  `node <<'NODE' ... NODE`
  Output: `path ownership probe passed: native temp uploaded/cleaned; arbitrary temp path rejected/preserved`.
- Focused existing desktop/chat/runtime suites:
  `PATH=/Users/model/.nvm/versions/node/v22.21.0/bin:$PATH node --test test/desktop-chat-runtime-bridge.test.js test/desktop-chat-runtime-client.test.js test/desktop-runtime.test.js test/desktop-translation-protocol.test.js test/chat-harness-gateway.test.js test/web-chat-mini-window.test.js`
  Output: `1..50`, `# tests 50`, `# pass 50`, `# fail 0`.
- Swift typecheck:
  `xcrun swiftc -typecheck native/desktop/*.swift native/translation/*.swift native/chat/*.swift`
  Output: exit 0, no diagnostics.
- Changed Web ESLint:
  `cd web && npx eslint src/features/chat-runtime/use-composer-attachments.ts src/features/chat-runtime/use-composer-controller.ts --report-unused-disable-directives --max-warnings 0`
  Output: exit 0, no diagnostics.
- Web build:
  `cd web && npm run build`
  Output: Webpack completed; `event - Build index.html`; `stamp-sw-cache: CACHE_NAME=aih-hos6-pwa-f2790d80 (197 files)`.
- Node syntax:
  `node --check lib/server/webui-chat-routes.js lib/desktop/chat/chat-runtime-bridge.js`
  Output: exit 0.
- Diff check:
  `git diff --check`
  Output: exit 0.

## Concerns and limits

The native UI was typechecked but not manually clicked through in a macOS GUI session. The one-off probes cover threshold boundaries, upload reuse, snapshot projection, redacted API-proxy persistence, and temporary path ownership/cleanup. No repository test file or environment variable was added.

## Design pattern review

- `ChatPanel` / `ChatPanelContent` -> typed projection boundary with identity-preserving row state -> snapshot metadata and streaming updates share the same row IDs and metadata formatter; Swift typecheck and focused desktop tests passed.
- `useComposerAttachments` / `use-composer-controller` -> idempotent resource state machine -> upload is a one-time transition to `uploaded`, while later retries submit the retained attachment IDs; Web lint/build and the source probe passed.
- `webui-chat-routes.js` -> dual prompt projection -> controlled paths remain provider-facing, while API-proxy/session persistence receives a redacted user-facing prompt; syntax, build, and redaction probe passed.
- `chat-runtime-bridge.js` -> ownership guard at the I/O boundary -> only AIH-created temporary references under the OS temp root can be read and cleaned; path ownership probe passed.

SOLID/KISS/DRY/YAGNI review: the wave reused existing attachment IDs, metadata formatter, runtime event identity, and document validation. It adds no provider routing, environment variable, or parallel upload protocol.
