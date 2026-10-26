# Desktop translation acceptance — 2026-10-26

This is a partial runtime acceptance record, not a completion claim. All browser actions used the already running Microsoft Edge profile; Chrome was not launched.

## Verified live

| Requirement | Observation |
| --- | --- |
| Browser extension installed in the user's existing browser | Loaded `web/public/translation-extension` through Edge's Load Unpacked UI. AIH Translation 0.1.0 is enabled. |
| Web page context menu | On `https://en.wikipedia.org/wiki/Translation`, the native context menu now contains `AIH 翻译当前页面`. |
| Selection context menu | A real drag selection shows `AIH 翻译选中内容`; the browser's Copy, Look Up and other original entries remain available. |
| Native Services visibility | Both TextEdit and Edge Services menus contain `AIH 翻译选中内容` and `AIH Chat 选中内容` after adding empty `NSRequiredContext` dictionaries. |
| Native translation invocation | TextEdit Services translated `Translation helps people communicate across languages.` to `翻译帮助人们跨语言交流。` with `gemini-3.8-flash-low`. |
| Browser to native translation | Edge → selection context menu → Services → AIH translation opened the native panel and returned Chinese translation of the selected Wikipedia sentence. |
| Native Chat invocation | TextEdit context menu → Services → AIH Chat submitted the selected sample, streamed a response, and returned to `就绪`. This validates the existing action, not the requested future Chat redesign. |
| Whole-page authentication failure | Before fix: Wikipedia was split into 4,127 text nodes; HTTP 401 failures continued past 1,294 requests. After fix: UI stops at `翻译已暂停 · 成功 0 · 失败 1`, shows the authorization cause, and opens connection settings. |
| Native source-preview width | Before: a roughly 170-character selection expanded the panel to 953 px. After reducing the preview label's horizontal compression resistance, a roughly 640-character selection including a long unbroken identifier stayed at 420 px and truncated the preview. |

## Root causes and changes

- `lib/desktop/translation/macos-build.js`: registered and vended Services were absent from actual menus. Adding only `NSRequiredContext={}` made them appear without restarting Edge or the live helper. This is backed by a before/after TextEdit menu check, not merely PBS cache entries.
- `web/public/translation-extension/background.js`: task-scoped AbortControllers now cover asynchronous settings reads and fetch/stream consumption. HTTP and SSE failures share a status classifier; authorization, unavailable service and rate limiting stop the page task.
- `web/public/translation-extension/content.js`: validate service with the first segment, then run bounded parallel workers. Stop, close and replacement tasks cancel old requests; generation and connection guards suppress stale DOM writes. Closing also restores task-owned page changes.
- `native/translation/TranslationPanelContent.swift`: allow the source preview to truncate instead of determining window width; explicitly configure the result text container for bounded-width wrapping and vertical scrolling.

## Validation

- Native helper build and registration: success; existing live helper process was not restarted for the Services metadata fix.
- `node --test test/desktop-chat-shortcut.test.js test/desktop-translation-protocol.test.js`: 14 passed.
- Translation integration/port/Web target/protocol existing tests: 19 passed.
- ESLint on both changed extension JS files, with their browser globals declared on the command: zero errors/warnings.
- Full `web` build: passed with Node 22.21.0. Initial Homebrew npm invocation selected an incompatible runtime and failed at Umi's `http_parser` dependency; using the installed Node 22 toolchain resolved it.
- Independent one-off VM probes: cancellation while settings are pending sends zero fetches; cancellation isolates tab and frame identities; HTTP 401 and HTTP-200 SSE errors with status 401/429/503/0 are fatal. No test files added.

## Still unverified or incomplete

- A successful whole-page extension translation, including successful-page undo, is not yet verified. Extension settings have no management key and the server returns 401. Connection settings were opened for local credential entry; credentials were not requested in chat.
- Terminal's native context menu has not been exercised: the computer-use tool denied access to `com.apple.Terminal`. TextEdit results are not evidence of Terminal acceptance.
- Wikipedia's per-text-node segmentation produces 4,127 requests and remains unsuitable as evidence of a polished paragraph-level reading experience.
- Native long-source preview sizing now passes the live 420 px check, but long-result wrapping and scroll acceptance remain incomplete: computer-use observations timed out twice after changing the target language. The source-level wrapping configuration and native build are not a substitute for that remaining visual check.
- Local millisecond language detection, selection-trigger false positives, refined native trigger design, and the expanded provider settings model require their own implementation and acceptance.
- The existing server process retains its previously imported builder module. A helper restart during this run regenerated the old Services metadata; rebuilding with the current module restored both menu entries. The next server restart must load the committed builder. The shared server was not restarted during this acceptance run.
- Edge was reloaded for the HTTP 401 failure check before the final SSE classifier refinement; the final refinement passed independent VM checks and the full Web build, but still needs an extension reload and live success-path check.
