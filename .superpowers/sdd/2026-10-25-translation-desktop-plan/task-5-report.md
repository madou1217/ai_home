# Task 5 report: runtime acceptance and integration review

## Scope

This review covered the translation execution chain, macOS desktop helper/full-app lifecycle, the native Services boundary, the WebUI target/provider controls, and page translation progress/cancellation/undo. The pre-existing `lib/server/web-account-auth.js` working-tree modification was left untouched and unstaged.

## Runtime acceptance

The local AIH Server initially reported `stale: source_changed`, so it was restarted with `/opt/homebrew/bin/aih server restart`. The post-restart status was:

```text
server is running (pid=95344)
base_url: http://127.0.0.1:9527/v1
ready: true
entry: /Users/model/projects/feature/ai_home/lib/cli/app.js
```

The restarted server had a native Go child (`aih-server --host 127.0.0.1 --port 19550`) and the translation helper child:

```text
PID 95649  PPID 95344  .../aih-server --host 127.0.0.1 --port 19550
PID 98791  PPID 95344  .../AIH Translation.app/Contents/MacOS/aih-translation
```

The generated helper `Info.plist` contains `LSUIElement=true` and an `AIH Translation` Services entry with `translateSelectedText`, accepting `public.utf8-plain-text`, `public.plain-text`, and `NSStringPboardType`. Source inspection confirms `main.swift` registers both `NSApp.servicesProvider` and `NSRegisterServicesProvider`, and clears the contextual selection on right mouse up so the host menu remains owned by the host application.

The deterministic runtime tests cover helper ownership, full-app selection, parent exit, restart generation handling, cancellation, retry, and direct-provider/server target behavior. A running native GUI process and the artifact metadata were observed after restart. This review does not claim that an operator manually clicked the macOS Services menu, accessibility permission prompt, or native settings window.

## Direct-provider fake transport and redaction check

An inline Node 22.21.0 smoke script composed `createDirectProviderExecutor` with a fake `fetch` and the built-in descriptor/factory registry. It ran one `selection` route for each service:

| Provider | Fake endpoint | Result | Attempts | Observable events |
| --- | --- | --- | ---: | --- |
| Microsoft Translator | `https://ms.fake/translate` | `微软结果` | 1 | `attempt_start`, `delta`, `attempt_success` |
| Google Translate | `https://google.fake/language/translate/v2` | `谷歌结果` | 1 | `attempt_start`, `delta`, `attempt_success` |
| LibreTranslate | `https://libre.fake/translate` | `Libre 结果` | 1 | `attempt_start`, `delta`, `attempt_success` |
| DeepL | `https://deepl.fake/v2/translate` | `DeepL 结果` | 1 | `attempt_start`, `delta`, `attempt_success` |

The fake transport asserted that each configured secret reached only the request boundary. The script serialized each result and emitted event list and asserted that the corresponding secret was absent. No provider secret appeared in stdout, result text, attempt metadata, or observable events. The adapters also retain the shared HTTP transport's behavior of returning bounded, generic upstream errors rather than reflecting response bodies.

## Existing Edge tab evidence

The already-open logged-in Microsoft Edge tab was reused; no new browser or login was created. The tab was opened at `http://127.0.0.1:9527/ui/studio/translation` and its DOM was inspected after each action.

- Advanced settings rendered all five provider tabs: AIH Gateway, Microsoft Translator, Google Translate, LibreTranslate, and DeepL. The four unconfigured providers showed `待配置` plus the correct missing field and did not expose secret values.
- The system target selector rendered `AIH Server · 已配置` as selected and `Provider 直连 · 待配置` as disabled, with the local AIH Server target selected.
- A short `你好` request visibly transitioned from `翻译中` to `翻译完成`, with `Hello` rendered and no failure state.
- Page translation visibly entered `正在翻译页面 · 已处理 25 段`; the stop action produced `已停止页面翻译 · 已处理 165 段`.
- A completed page run showed `页面翻译完成 · 已处理 274 段` and `撤回页面译文`; clicking the undo action removed the undo control and returned the page panel to the normal `翻译当前页面` action.

These are DOM state observations from the existing Edge tab. They are evidence for the WebUI state transitions, not a substitute for manually checking native macOS permission prompts or pixel-level visual acceptance.

## Verification commands

All commands below used the working Node 22.21.0 installation where applicable.

| Command | Result |
| --- | --- |
| `PATH=/Users/model/.nvm/versions/node/v22.21.0/bin:$PATH node --test test/*.test.js` | **39 passed, 0 failed** |
| `PATH=/Users/model/.nvm/versions/node/v22.21.0/bin:$PATH xcrun swiftc -typecheck native/translation/*.swift` | **passed** |
| `cd web && PATH=/Users/model/.nvm/versions/node/v22.21.0/bin:$PATH npm run build` | **passed**; Webpack compiled successfully in 23.33s and service-worker stamping reported 206 cached files |
| `cd web && PATH=/Users/model/.nvm/versions/node/v22.21.0/bin:$PATH npx eslint src/features/translation/SystemTranslationControl.tsx src/features/translation/TranslationProviderSettings.tsx src/features/translation/TranslationWorkspace.tsx` | **passed with no output/errors** |
| Focused translation/desktop tests (`translation-execution-port`, `translation-execution-integration`, `translation-web-targets`, `desktop-runtime`, `desktop-translation-protocol`) | **30 passed, 0 failed**; included in the full 39-test run |

The working tree still contains only the unrelated pre-existing `lib/server/web-account-auth.js` modification plus this review's documentation/report files. No generated `web/dist` files are tracked.

## Design patterns and verification evidence

- `lib/translation/executors/direct-provider.js` + `lib/translation/adapters/` -> **Adapter + Factory Registry + Dependency Injection** -> provider request/response shapes are isolated behind descriptors and injected fetch/config boundaries; all four fake transports succeeded and secret-redaction assertions passed.
- `lib/translation/route-planner.js` + `lib/translation/route-runner.js` -> **Chain of Responsibility** -> descriptor-based operation/priority planning and observable attempts keep fallback/cancellation semantics provider-neutral; the full Node suite passed 39/39.
- `lib/desktop/translation/service.js` + `lib/desktop/runtime/desktop-launcher.js` -> **Target Adapter + lifecycle state machine** -> helper and full-app ownership, target switching, cancellation, and generation suppression remain in one lifecycle boundary; focused desktop tests and the live server/helper parent relationship passed/observed.
- `native/translation/main.swift` + `TranslationSettingsWindow.swift` -> **Host Capability Boundary + Services Adapter** -> Services, AX selection, clipboard fallback, right-click ownership, and settings window are kept in the native host; Swift strict typecheck and helper `Info.plist` inspection passed.
- `web/src/features/translation/` + `page-translation.ts` -> **Capability descriptor projection + Bounded Scheduler + Command** -> WebUI renders declared provider/target capability state and page translation exposes progress, stop, and undo transitions; existing Edge DOM evidence, Web build, ESLint, and Node contracts passed.

SOLID, KISS, DRY, and YAGNI review: no provider-name dispatch was added, no new environment variable or parallel configuration path was introduced, and no additional abstraction was needed for this integration-only review. The design-pattern inventory was updated in `docs/architecture/design-patterns.md` with the concrete modules and evidence above.
