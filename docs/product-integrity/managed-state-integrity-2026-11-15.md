# G02 managed-resource state integrity — 2026-11-15

Part of the original M0–M5 goal, not overall completion. No new tests or shared service/database operations.

## Reproduction

Actual Go `nativeresources.Service.Operate(skill/install)` against an isolated `aih.db` with `native-resources.managed.v1 = {broken-managed-state` returned success, created a projection and replaced the original KV with a new one-record state. Read-side errors alone did not protect the mutating path.

## Repair

- Shared Go strict decoder for get/update: only absent KV initializes. Existing blank/null/array/malformed/duplicate-key documents, unknown schema, invalid counters/records and exhausted revision fail before the mutation callback.
- Go retains numeric tokens and unknown top-level, record and MCP-spec fields instead of discarding them through typed projection. Known installs preserve prior unknown metadata.
- Plugin snapshot creation moves inside the validated update callback, so corrupt state cannot cause an install-side snapshot before the check. Node corresponding caller follows the same order.
- Serialization errors are no longer ignored. Final state is validated; no-op keeps existing raw text. Node validates the same required structure and rejects numbers it cannot rewrite without rounding rather than changing unknown metadata.

## Real acceptance

`managed-state-integrity-2026-11-15.json` records:
- blank/null/array/unknown-schema/wrong-type/duplicate/exhausted inputs rejected, original KV unchanged and no skill projection;
- normal Go skill install→disable→enable→remove succeeds;
- unknown top-level and per-record fields, including a large integer, survive Go lifecycle changes;
- actual Node store update rejects corrupt state before invoking its mutator; normal update increments revision and retains extra metadata.

Go packages/server/CLI compile; Node syntax checks pass; windows/amd64 cross-build is static evidence only. Rawls independently reviewed the mutation-before-validation risk and its closure; owner performed the actual operations.

## Remaining boundaries

SQLite state and host projections are not one crash-atomic transaction. A later filesystem/commit failure still requires the existing drift/recovery semantics; this checkpoint does not claim full plugin/skill/MCP lifecycle fault atomicity. Node rejects unsupported numeric precision instead of claiming lossless support. Complete cross-platform native resource activation and UI acceptance remain open.
