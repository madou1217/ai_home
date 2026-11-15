# G06 canonical account restore closure — 2026-11-15

Continuation of M0–M5 and `6205bf76e`. The immutable repository protocol is not reimplemented here. Real non-dry restore exposed a missing downstream chain that dry-run could not prove.

## Verified defect

A real valid-shape manual API-key account was imported into isolated Node compatibility tables, backed up over this session's OpenSSH, and restored with `dryRun=false`. Restore reported success, but Go `aih ls` on the same destination returned `no such table: accounts`. Compatibility rows alone did not restore the canonical Go account.

Further observed loss: typed exports discarded extension env settings such as `OPENAI_WIRE_API`/`AIH_UPSTREAM_HEADERS`; Claude OAuth export lacked the separate identity config required by its own native decoder. Go generic JSON decoding also converted numeric tokens before the backup encoding boundary.

## Architecture

- `portableaccount`: shared portable-document credential adapter extracted from HTTP. HTTP types remain aliases and delegation preserves existing callers. Native envelope conversion explicitly maps Codex `auth_json`, Claude `credentials_json/global_config_json`, and other native providers.
- `backupaccounts`: canonical local/online composition. The offline private `__backup-accounts` command requires an explicit HOME and uses bounded private JSON pipes, no daemon startup or network refresh. A verified already-running same-home daemon uses its authenticated Management backup route and live store/index. Unknown identity never authorizes offline writes; HTTP failure never falls back to local writes.
- `accountwriterlease`: exclusive OS lock shared by daemon initialization/lifetime and offline import. It prevents the offline path from updating SQLite while an online daemon's routing index is left stale. Export uses an existing read-only store without schema initialization, alias reconciliation or orphan cleanup.
- SQLite restore uses a write transaction: identity reuse first, unused source ref and CLI number preserved, number conflicts allocate a free value, ref conflicts refuse overwrite. Existing enabled state is retained. OAuth credential replacement uses generation arbitration, not arrival time; restored historical profile refs require profile/credential identity equality.
- Compatibility mirror is projected from canonical **post-commit** records, not another independent import. Content and credential/profile versions come from the same snapshots; a transaction checks versions before writing compat. Stale readback is rejected. A mirror failure is reported as partial completion; canonical data is not rolled back.
- Portable supplements preserve unknown configuration metadata in the same database/restore transaction, bound to the credential version. Canonical credential fields win; known competing auth env and legacy config aliases cannot be resurrected by supplements. No host auth file or default selection is changed.
- Claude export uses its existing official config/secure-storage encoders and profile; AGY keeps client ID/client secret/ID token. Native payload and ZCode decryption paths retain exact JSON number tokens with `UseNumber`; unsupported numeric values are rejected before Node/JCS can silently publish a rounded value.

## Real acceptance

Evidence directory `backup-canonical-roundtrip-2026-11-15/`:

| Journey | Actual result |
|---|---|
| Canonical-only source → Node backup → new destination restore | canonical source has one Go account and no compat ref table; backup includes it; destination Go list exit0 and compat count1 |
| Ref/alias/state | source ref and ID7 retained, disabled retained; second restore unchanged, no new account |
| Alias conflict / source-ref conflict | new identity gets next free ID8; existing other identity's ref is not overwritten |
| Claude full roundtrip | credentials + identity config restore, ID9/source ref/client ID retained |
| AGY fields | custom client ID/client secret/ID token survive canonical readback |
| Old/new OAuth generations | older backup keeps newer canonical credential; newer generation updates; stale mirror fails, fresh mirror contains newest |
| Extension configuration | OPENAI_WIRE_API and upstream-header extension retained |
| Mixed auth/config aliases | canonical OAuth excludes competing API/Bearer env; stale globalConfig does not override canonical config; unknown non-auth fields retained |
| Live daemon adapter | isolated real server import/export succeeds through Management with nonexistent pipe binary supplied; accounts visible in its management list |
| Offline/live exclusion | private importer rejects while isolated daemon holds lease; daemon startup rejects while an owned independent lease is held |
| Unverifiable daemon identity | corrupt own runtime identity returns `backup_core_state_unknown`, no offline fallback |
| Dry-run / invalid batch | no home/database creation; malformed credential anywhere refuses before SQLite import |
| Native numeric export | original large integer/fraction tokens retained as json.Number; unsupported unsafe integer exported as explicit skipped, not rounded backup |
| Read-only export | existing database mtime unchanged; no writable-store initialization |

Go CLI/server builds and windows/amd64 cross-build pass; modified JS syntax checks pass. No test files/cases were added. Rawls independently reviewed snapshot-version pairing, live/offline exclusion, historical profile binding, supplement authentication precedence and config aliases; owner ran the real acceptance.

## Boundaries

- Manual keys/tokens used only in isolated data; no real OAuth login, refresh request or paid inference occurred. This is storage/restore usability evidence, not proof of provider authentication.
- No shared server restart/deployment. A running older binary lacking the Management backup port fails explicitly rather than silently switching stores. For the offline/daemon lease guarantee, both processes must use the new implementation; existing old processes do not retroactively acquire locks.
- Account importer is per-account transactional, not all-account rollback. Entire credential shape/integrity preflight occurs first; write-time conflicts may still produce explicit partial results. Mirror can be retried idempotently.
- Numeric preservation is improved at the inspected source boundaries; arbitrary precision import across all providers and historical Node parsers remains unverified. Unsafe values fail/skip and do not cause tombstone deletion.
- Cross-store identity mapping is conservative: canonical ref and explicit/predictable links win. Unresolved historical identity ambiguity is not guessed. Broader provider/native reauthentication and platform matrices remain in the original goal.
- Supplemental settings are only used with their matching credential version. After an independent credential refresh, historical supplements are not silently merged into the new generation; broader configuration ownership remains a separate audit gate.
