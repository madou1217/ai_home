# G06 restore integrity guard — 2026-11-15

This is the first G06 corrective checkpoint, not completion of the backup consistency work package or M0–M5.

## Real pre-fix observations

Using actual `runTargetBackup` and the product SSH strategy against this session's loopback OpenSSH, a synthetic account was backed up as OLD. Uploading the next plan's NEW account object and closing before publishing manifest left the manifest byte-identical but its stable-path object changed. **The existing “manifest last” comment was not an object-generation guarantee.**

Replacing that referenced object with another accountRef/content still made real restore dry-run report `ok:true`, with the different ref marked planned. The record contained only `DISPLAY_ONLY_VALUE`, not actual credentials. No production accounts were exported/restored.

## This checkpoint

- Focused `remote-backup-integrity.js` validates v1 manifest shape/version/entries before use; malformed entries are not silently skipped.
- Each active object must match actual byte count, valid UTF-8 and strict single-account `aih-accounts` v1 schema, provider/accountRef, and existing canonical **record** SHA-256. The old sha field is not reinterpreted as a file-byte digest.
- SSH strategy exposes raw bytes for verification while retaining its existing text-read interface for older consumers.
- **All objects are verified before importer invocation.** Any missing/corrupt object fails the whole restore preflight; dry-run follows the same path. This is not a rollback transaction for failures inside the account importer.
- Importer's invalid/failed counts are reflected as `ok:false / backup_import_incomplete`, not a misleading success. CLI prints affected refs and stable error codes without credential content.

## Actual acceptance

See `backup-restore-integrity-2026-11-15.json`:
- valid existing-format backup still produces a successful dry-run plan;
- same-length changed content → hash mismatch;
- same-length different accountRef → identity mismatch;
- wrong length → bytes mismatch;
- malformed manifest entry → manifest invalid, not skipped;
- missing object with dryRun=false → failure before importer; isolated home remained empty;
- actual `bin/ai-home.js backup restore ... --dry-run` → exit1 and per-ref hash failure;
- raw malformed UTF-8 → object invalid;
- integrity-valid unknown provider → importer invalid and overall failure.

Real cross-runtime follow-up: a Go-produced v1 object with Chinese/U+2028/U+2029/HTML text initially failed Node verification because Go historically escapes the two Unicode separators. The verifier now accepts that exact historical canonical encoding as well as the Node encoding; actual Go SSH upload → Node restore dry-run succeeds. This is not permission to skip hashes, and other legacy numeric/UTF-16-key-order edge cases remain unverified.

No new tests, shared service rebuild/restart, DB migration or real credential operation. Syntax checks and independent source review supplement—not replace—the real SSH/CLI evidence.

## Next required work (still open)

Immutable objects and manifest publication must be solved in Go **and** Node; old same-path overwrite is not fixed by refusing restore of a mismatched snapshot. Planned boundary: separate v2 namespace, content-addressed immutable native documents, strict non-missing-vs-invalid distinction, verified legacy read compatibility, skipped-export preservation, cooperative writer exclusion and truthful uncertain-publication outcomes. Do not publish v2 at the old v1 filename: old writers currently treat unknown versions as empty repositories. No GC/deletion of old backups is authorized by this repair.

Hash/bytes/identity validation detects inconsistency; it is not authentication against an attacker controlling both manifest and objects. Resource limits, simultaneous writers, object publication failure, v3 non-atomic manifest recovery and real cross-runtime migration remain acceptance gates.
