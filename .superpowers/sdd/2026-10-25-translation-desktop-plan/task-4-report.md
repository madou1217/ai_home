# Task 4 report: Web advanced settings and direct target visibility

## Scope

The translation WebUI now exposes the desktop execution target as a capability-driven selector in Advanced Settings. The selector renders the `executionTargets` descriptor returned by the system translation service, including available/configured state, supported operations, streaming support, and configured direct Providers. It keeps an unavailable or unconfigured persisted target visible and disabled rather than guessing readiness from provider names.

Provider settings continue to live in Advanced Settings and keep the existing Tabs behavior when more than three providers are present. Each provider now reports `已配置`, `待配置`, or `不可用`, shows human-readable missing fields, and keeps the compact inline status/error flow.

Route edits now cancel an active translation stream as well as invalidating language detection intent. Provider drafts remain page-local and are preserved while related controls change.

## Changes

- `web/src/features/translation/SystemTranslationControl.tsx`
  - Renders `executionTargets` as a declarative target selector.
  - Shows capability hints (operations, streaming, configured direct-provider count).
  - Distinguishes configured, pending configuration, and unavailable targets.
  - Persists a selected execution target through the existing `/webui/translation/system` API.
  - Keeps initial status loading and request errors as compact inline status text.
- `web/src/features/translation/TranslationProviderSettings.tsx`
  - Adds explicit provider availability/configuration state and missing-field labels.
  - Preserves the existing provider form and `Tabs` threshold behavior.
- `web/src/features/translation/TranslationWorkspace.tsx`
  - Cancels the current stream when route order, provider, model, or operation settings change through the route editor.
- `web/src/features/translation/translation.module.css`
  - Adds compact target and missing-field styles without full-page alert blocks or left-edge status decorations.
- `web/src/features/translation/translation-settings-store.ts`
  - Carries the existing persisted `executionTarget` setting through WebUI normalization and save typing.
- `web/src/types/index.ts`
  - Adds execution target/provider capability descriptors and the persisted target field to translation types.
- `web/src/services/api.ts`
  - Adds `setSystemExecutionTarget` for the system status API.
- `lib/server/webui-translation-routes.js`
  - Handles `executionTarget` in the existing `/webui/translation/system` POST so selector changes affect the running desktop service. This is the smallest backend API wiring required for the selector to change behavior.

The pre-existing unrelated `lib/server/web-account-auth.js` modification was left unstaged and untouched.

## Verification

- `cd web && npm run build` — **blocked by the existing local Umi dependency/runtime issue**: `@umijs/preset-umi` fails to load `http-deceiver` because the installed Node runtime has no `process.binding('http_parser')`. The failure occurs before project compilation (`No such module: http_parser`).
- `cd web && npx eslint src/features/translation/SystemTranslationControl.tsx src/features/translation/TranslationProviderSettings.tsx src/features/translation/TranslationWorkspace.tsx src/types/index.ts src/services/api.ts` — passed with 0 errors.
- `node --test test/translation-execution-integration.test.js test/desktop-runtime.test.js` — 15 passed, 0 failed.
- `git diff --check` — passed.
- `npx tsc --noEmit` — reports the repository's existing unrelated type errors; no new Task 4 error remains after fixing the duplicate `kind` spread in the touched control.

## Design patterns

- `SystemTranslationControl.tsx` -> capability descriptor rendering -> keeps target readiness and feature display data-driven from `executionTargets` and avoids provider-name conditionals -> execution target integration status tests and lint pass.
- `TranslationProviderSettings.tsx` -> descriptor-backed status projection -> keeps forms generic across provider definitions while exposing missing/configuration state -> WebUI lint passes and existing provider Tabs path remains unchanged.
- `TranslationWorkspace.tsx` -> request-intent invalidation boundary -> prevents stale detection and stream deltas from crossing route changes -> focused desktop/translation integration tests pass.
- `/webui/translation/system` route -> narrow API adapter -> maps the UI target selection to the existing service `setExecutionTarget` contract without introducing a second persistence path -> desktop runtime and translation integration tests pass.

SOLID, KISS, DRY, and YAGNI review: the selector and provider status remain presentational projections of existing descriptors; no provider dispatch table, new environment variable, or additional state machine was introduced.
