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
| Native long-result wrapping and scrolling | After recovering computer use, the full Chinese result and its continuous Latin identifier wrapped inside the same 420 px panel. The vertical scrollbar reached value 1 and the final sentence remained readable. Pin toggled on and off. |
| Extension connection configuration | Read the existing management key through `aih server config --show-secrets --json`, as explicitly directed by the user. Saved it in the local extension settings, cleared the temporary clipboard, and closed the one-use loopback handoff. The key was not printed or persisted in task files. |

## Root causes and changes

- `lib/desktop/translation/macos-build.js`: registered and vended Services were absent from actual menus. Adding only `NSRequiredContext={}` made them appear without restarting Edge or the live helper. This is backed by a before/after TextEdit menu check, not merely PBS cache entries.
- `web/public/translation-extension/background.js`: task-scoped AbortControllers now cover asynchronous settings reads and fetch/stream consumption. HTTP and SSE failures share a status classifier; authorization, unavailable service and rate limiting stop the page task.
- `web/public/translation-extension/content.js`: validate service with the first segment, then run bounded parallel workers. Stop, close and replacement tasks cancel old requests; generation and connection guards suppress stale DOM writes. Closing also restores task-owned page changes.
- `native/translation/TranslationPanelContent.swift`: allow the source preview to truncate instead of determining window width; explicitly configure the result text container for bounded-width wrapping and vertical scrolling.
- Follow-up page-language fix: forward normalized element `lang` when available. For pages without language metadata, translate a representative full passage before short fragments and reuse its resolved source. Explicit fragment language takes priority. This avoids repeating source-detection confirmation for short navigation labels.
- Native language preflight now uses the same existing bounded local detector for both execution targets. Removed the separate AIH Server `/translation/detect` request; execution, authentication, cancellation and language intent guards retain their existing boundaries.

## Validation

- Native helper build and registration: success; existing live helper process was not restarted for the Services metadata fix.
- `node --test test/desktop-chat-shortcut.test.js test/desktop-translation-protocol.test.js`: 14 passed.
- Translation integration/port/Web target/protocol existing tests: 19 passed.
- ESLint on both changed extension JS files, with their browser globals declared on the command: zero errors/warnings.
- Full `web` build: passed with Node 22.21.0. Initial Homebrew npm invocation selected an incompatible runtime and failed at Umi's `http_parser` dependency; using the installed Node 22 toolchain resolved it.
- Independent one-off VM probes: cancellation while settings are pending sends zero fetches; cancellation isolates tab and frame identities; HTTP 401 and HTTP-200 SSE errors with status 401/429/503/0 are fatal. No test files added.
- Live authorized API comparison: `Domains` with `source:auto` returned 409 `source_detection_required`; the same text with `source:en` completed SSE with `域名`. A one-off content-script probe verified representative-passage ordering, inherited source for unlabelled fragments, and explicit `fr-FR` normalization/precedence.
- Local detector benchmark (100 warmups, 1,000 samples): 54-character English p50/p95/max 0.0086/0.0100/0.0937 ms; 4,000-character English 0.7245/0.8254/1.0014 ms; 4,000-character Chinese 0.4436/0.5009/2.1557 ms. Eleven scripts/input classes were measured. These are computation timings, not UI-to-result latency or an accuracy claim.
- Native runtime/protocol/execution/integration/Web-target suites: 37 passed. One-off two-target probes sent zero language-detection fetches; same-language and unknown-language guards still prevented automatic execution. The existing server process has not loaded this source change yet.

## Still unverified or incomplete

- A successful whole-page extension translation, including successful-page undo, is not yet verified. Authentication is configured. IANA's page has no language metadata and exposed the short-word confirmation loop; the follow-up source-context patch still needs extension reload and live completion. Edge foreground was repeatedly switched to unrelated administration pages during reload; a short stable-focus interval was requested to avoid misdirected input.
- Terminal's native context menu has not been exercised: the computer-use tool denied access to `com.apple.Terminal`. TextEdit results are not evidence of Terminal acceptance.
- Wikipedia's per-text-node segmentation produces 4,127 requests and remains unsuitable as evidence of a polished paragraph-level reading experience.
- Native typography, trigger appearance, and overall visual polish remain below the requested product quality even though long-text layout now passes the focused live check.
- Local millisecond language detection is implemented and benchmarked, but the shared server still needs to load it before an end-to-end desktop latency check. Selection-trigger false positives, refined native trigger design, and the expanded provider settings model remain open.
- The existing server process retains its previously imported builder module. A helper restart during this run regenerated the old Services metadata; rebuilding with the current module restored both menu entries. The next server restart must load the committed builder. The shared server was not restarted during this acceptance run.
- Edge was reloaded after the final SSE classifier refinement. The subsequent representative-passage source-context patch is the version still awaiting a confirmed reload.
- The user explicitly deferred desktop acceptance while operating Edge. Stop all browser/desktop interaction until they resume it; source validation and scoped checkpoints may finish without taking focus.


## Follow-up: Pin, timing, reading and model selection

The user reported that Pin moved the window to the screen top and confirmation showed 340.8 seconds. The earlier live check only toggled Pin and did **not** establish correct stacking/position semantics. The following changes are source/build verified; the current shared helper/server and Edge extension have **not** been restarted/reloaded because desktop acceptance remains deferred.

- Native Pin now toggles normal/floating level and outside-click persistence only. It no longer changes frame geometry or uses status-bar level. An already-visible window also keeps its position during retry, target and model changes.
- Confirmation invalidates the timer and hides elapsed time. The service emits start before connecting, and native start/attempt events select model-waiting state. Eight-second waiting feedback describes the model response, never language identification. Human confirmation time is excluded from execution timing.
- Native reading uses a 480px initial panel with a 440px text viewport, 16px type, 5px additional line spacing and 12px paragraph spacing. Long source/model labels compress; output wraps, scrolls and appends without resetting selection or scroll position. Window resizing remains an explicit user action.
- Model menus load configured candidates asynchronously; default display follows the actual route selected by the Server. Both protocol boundaries and the HTTP executor forward explicit model/provider selection. Default selection preserves the fallback route chain; manual entry is supported. Directory completion preserves active drafts, and server changes invalidate previous temporary selections.
- `sourceAuto` is a provider capability checked across the actual route chain. Supported adapters can translate short/uncertain source text without a separate source-language confirmation; undeclared adapters retain the concrete-source guard.
- Native entry is a circular system-material button without the nested bezel. Passive entry requires a drag/multiclick and rejects menu/control ancestors. Host right-click events remain untouched.
- Pinned output keeps its accepted replacement snapshot when the user makes a new, unaccepted selection. Replacement checks both text and range before one complete AX write; this also fixes the former even-length output truncation and removes nested-run-loop writes.
- Extension UI now has an isolated Shadow DOM shell, bounded fixed reading viewport, dragging, pin persistence, explicit streaming/stop/retry/copy feedback, folded source, page progress/stop/undo, light/dark treatment and reduced-motion support. Stream completion keeps the same reading element/Text node and scroll position. Settings support catalog/default/manual model selection.

Validation after final changes:

- Complete native helper compiled with `xcrun swiftc` to `/tmp/aih-translation-ux-check`; no app registration, launch, or running-binary replacement.
- Offscreen AppKit probe (no windows shown): confirmation at 340.8 seconds has no elapsed display; start enters model-waiting state; empty saved model displays actual default; more than 14K characters plus a continuous identifier preserve window geometry. Reading viewport was 440 × 219, text layout width 439.984375 with vertical document height 21475. Selected range and scroll origin survived an appended delta. This is layout/state evidence, not foreground visual acceptance.
- Existing desktop runtime/protocol/shortcut and translation execution/Web-target suite: **46 passed, 0 failed** on the final source. No test files added.
- Scoped ESLint for extension background/content/panel/options: **0 errors/warnings**. Browser globals are declared in each file. An initial invocation redundantly declared them on the command line and failed no-redeclare; rerunning without duplicate declarations passed.
- Full `cd web && npm run build` using installed Node 22.21.0 after final extension review fixes: **passed**, Webpack 19.82 seconds. Generated artifacts were not staged.
- Implementation-agent one-off probes: model/provider forwarding, cancellation before settings completion, fatal 401, model catalog generation isolation, manual/default settings persistence, and stream completion retaining the original Text node and scrollTop 173 passed.
- Default-model probes used a temporary settings store and real route handler: configured selection route, disabled/page-only route skipping, and saved model with empty routes all produced identical GET default and stream-start model/provider. Mock transport confirmed auto-source short text traversed handler/adapter/SSE successfully. These probes did not call a real upstream model.
- Independent read-only review found and verified the corrections above; `git diff --check` passed. SOLID/KISS/DRY/YAGNI review retained existing execution and view boundaries, reused one route resolver for advertised/executed defaults, and added only the scoped catalog/source-policy and extension-view modules needed for this behavior.

Still pending: load this source into the shared server/helper, reload the existing Edge extension, then verify actual Pin stacking without movement, native visual/layout transitions and replacement/undo in an editor, and successful whole-page translation/undo. The earlier Wikipedia segmentation issue and broader native provider-management redesign are not closed by this checkpoint.


## Follow-up: page-language confirmation screenshot

The next user screenshot showed the old `AIH 整页翻译` title, raw `zh-Hans` option, and conflicting light header/footer on the dark panel. These match the historical light-DOM renderer (before `29a92380`): host-page `header`/`footer`/control styles could reach the extension content. This is source/screenshot correlation, not a live inspection of the current Edge tab.

The current Shadow DOM shell already isolates those selectors. The confirmation state now has a dedicated, consistently styled form: localized language names, title and secondary explanation, full-width language picker, quiet keep-original action and primary start action. It includes keyboard form submission, busy feedback, duplicate-submit suppression, recoverable inline errors, and a disabled empty-language state with a settings action. Existing task orchestration and cleanup callbacks remain in the content script.

Validation: scoped ESLint on content/panel passed; 14 existing translation Web-target/execution tests passed; full Web build passed after the narrow-window review fix (Webpack 21.32 seconds, Node 22.21.0). One-off DOM-model probes exercised localization, candidate deduplication, busy state, duplicate submission, error recovery, empty targets and keep-original status. No test files were added. These checks do not establish visual quality or live CSS isolation; actual Edge reloading and visual acceptance remain pending the user's response to the desktop-availability question.


## Follow-up: AIHome brand icon

Reused the same canonical `assets/brand/ai-home-app-icon.png` imported by WebUI. The extension packages a 128px derivative for the panel, settings and toolbar icon; only this public PNG is web-accessible. Native trigger reads the original from bundle Resources without template tint. Builder includes the logo bytes in its existing fingerprint and verifies cached resource contents. No new architectural abstraction was needed (KISS/YAGNI); view loading and build I/O remain separate.

Verification: 23 existing desktop-shortcut/translation tests passed; scoped panel ESLint passed; full Web build passed (18.89 seconds). An isolated temporary bundle completed real Swift compilation and ad-hoc signing, contained byte-identical canonical logo data, and reused the second-build cache. Services registration calls were stubbed only in the one-off probe, so no installed app or foreground desktop was changed. No test files added. Actual extension reload/helper refresh and visual acceptance remain pending.

## Real-device acceptance continuation — 2026-10-27

The existing Microsoft Edge profile was used. No new browser or login was created.

- `edge://extensions` showed AIH Translation 0.1.0 loaded from `/Users/model/projects/feature/ai_home/web/public/translation-extension`; the unpacked extension was reloaded from that page.
- On `https://www.iana.org/help/example-domains`, a blank-area native context menu visibly contained `AIH 翻译当前页面`. Clicking it opened the AIH page panel and started the real task. The first pre-refactor run exposed the old `42` text-node granularity and was not counted as completion evidence.
- On `https://example.com`, the current extension grouped the page into **7 semantic segments**. Each segment displayed a task-owned skeleton and `等待翻译`/`正在生成译文…` state before its result. The task ended with `页面翻译完成 · 成功 7 · 失败 0`; the panel reported `已复用 3 段本机缓存` during the same run.
- After pressing Edge reload, the extension restored the page automatically. The panel showed `已恢复页面译文 · 成功 7 · 失败 0` and `已恢复 7 段本机缓存`. This was observed in the existing Edge tab. Restoring did not auto-copy.
- Clicking `撤回页面译文` visibly restored the original page text and changed the panel to `已撤回页面译文`.
- Holding Control while left-clicking English body text opened the AIH `选区翻译` panel directly. It showed model connection, skeleton output and then the translated result, without the normal page context menu flow.
- The browser's own Edge translation UI was also visible on example.com. AIH's `AIH 翻译当前页面` entry and panel were separately visible and functional.
- In TextEdit, selected `Translation helps people communicate across languages.`. TextEdit → Services visibly contained both `AIH Chat 选中内容` and `AIH 翻译选中内容`. Clicking the translation service opened the native panel with the exact Services text, model `gemini-3.8-flash-low`, and a completed result. The native Pin toggle changed to `取消置顶` while the window stayed in its existing position. Clicking the Chat service opened the AIH Chat panel, showed the selected user message and a streamed AIH reply.
- The running helper and installed bundle were previously checked against the current source fingerprint, installed Resources logo bytes, `NSRequiredContext={}`, LaunchServices and PBS service records. A later source-only change made to the helper (`Services` payload authority and browser Control-click delegation) was compiled and tested in isolation; the shared helper was not restarted during the user's active desktop session.
- Terminal was not clicked. The computer-use tool explicitly denied access to `com.apple.Terminal`; no AppleScript, CGEvent or other bypass was used. Therefore Terminal's own right-click menu remains unverified. TextEdit is evidence for the shared macOS Services registration and Chat/Translate dispatch, not a Terminal-specific acceptance claim.
- Playwright Edge attach did not establish a browser handle during this run; native CUA was used with the already-open Edge instead. The user's existing tabs were preserved.

Final validation for this continuation: scoped extension ESLint passed; JavaScript syntax checks passed; relevant existing desktop/translation tests **28/28** passed; complete Web build passed with Node 22.21.0 and Webpack 26.85 seconds; native Services-source Swift compile passed. No test files were added. Unrelated account/ZCode files remain unstaged and were not included in translation commits.
