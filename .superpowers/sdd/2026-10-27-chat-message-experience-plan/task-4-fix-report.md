# Task 4 fix report: preserve large-paste attachment boundary during session startup

## Change

- `web/src/features/chat-runtime/use-composer-controller.ts`
  - Attachment preparation remains available while a session is `starting`, even though the initial delivery is `after_turn`.
  - Attachment-bearing submission remains limited to the `turn` delivery. Queue and intervention deliveries cannot submit pending attachment IDs.
- `web/src/features/chat-runtime/Composer.tsx`
  - Clipboard files are rejected with compact feedback when the selected delivery cannot carry attachments.
  - Large plain-text paste always prevents the browser's inline insertion. It becomes a UTF-8 text attachment when attachment preparation is allowed; otherwise it shows an actionable compact error.

## Verification

- Changed-file ESLint: `cd web && npx eslint src/features/chat-runtime/Composer.tsx src/features/chat-runtime/use-composer-controller.ts --ext ts,tsx --report-unused-disable-directives --max-warnings 0` (passed).
- WebUI build: `cd web && npm run build` (passed; Webpack compiled successfully).
- Relevant existing tests/probes: no dedicated Chat composer test files are present in this checkout; focused source/behavior probes passed.
- Starting-state probe: confirmed the controller exposes attachment preparation for `projection.state === 'starting'`, and the paste handler routes threshold text to `buildPastedTextFile` while preventing default input.
- Idle-state probe: confirmed the existing `delivery === 'turn'` path remains the attachment upload/submit path, including attachment IDs.
- Incompatible-delivery probe: confirmed threshold paste calls `preventDefault()` and compact error feedback when `canAttach` is false, so full text never enters the textarea.
- `git diff --check`: passed.

## Design pattern reporting

- `use-composer-controller.ts` -> capability/policy gate -> separates attachment preparation from attachment submission so startup can retain pending state while queue/intervention payloads remain attachment-free -> changed-file ESLint and WebUI build passed.
- `Composer.tsx` -> boundary-preserving event adapter -> intercepts threshold clipboard input before native textarea insertion and routes it to the attachment or feedback path -> focused source/behavior probes passed.
- SOLID/KISS/DRY/YAGNI review: the fix stays in the existing composer policy and handler seams, adds no provider branches, new environment variables, tests, or UI containers.
