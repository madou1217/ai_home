# Offline distribution data preparation

Installer integration API:

```go
report, err := distributiondata.Prepare(ctx, distributiondata.Options{
    Home: liveHome,
    BackupDir: uniqueTxnDir,
})
// Continue only if err == nil and report.State == "prepared".
// Bootstrap config/keys in report.PreparedHome, preserving existing config KV.
// Keep all source writers stopped throughout preparation and publication.
err = distributiondata.VerifySource(ctx, report.SourceFingerprint)
// The installer owns durable publish/journal/rollback and service lifecycle.
```

`uniqueTxnDir` must be outside `liveHome`. This package creates one private
`data-preparation-*` child; it does not overwrite caller files or clean up any
artifacts. Failed runs keep their partial artifacts and report with state
`failed`; these must never be published.

AIH has exactly one business database, `aih.db`. There is no legacy database
copy, seal or migration step. Artifacts in that private child:

- `prepared/`: standalone `aih.db` with the canonical schema initialized or
  upgraded in a scratch home before publication.
- `backup/` (`BackupHome`): pre-upgrade SQLite Backup API snapshot under the
  original database filename. This is a standalone logical recovery backup; do
  not combine it with WAL/SHM/journal files from the old home.
- `original/` (`OriginalBackup`): byte-preserved original database plus any WAL,
  SHM and rollback-journal sidecars. SQLite never opens this directory or live
  Home.
- `source-fingerprint.json`: home existence and each DB/sidecar's existence,
  byte size, mode, modification time and SHA-256. Absence is meaningful during
  rollback: fresh installs originally had no database files.
- `report.json`: artifact paths, source state, table-verification and
  account-initialization/import boundaries. It contains counts, not credentials.

To avoid even source-side WAL/SHM creation by read-only SQLite, source files are
captured using ordinary read-only file handles and checked again for changes.
SQLite recovers only a mutable private capture; its Backup API then makes the
consistent original snapshot. Source fingerprints are checked after capture,
after all preparation, and by the installer immediately before publish. This is
not a substitute for the installer's stop/writer-exclusion contract.

All pre-existing canonical tables are checked with bidirectional `EXCEPT`,
grouped multiplicities, binary text comparison and SQLite storage types. SQLite
integrity and foreign keys are checked on the backup and prepared file.
Conflicts, corruption and orphan sidecars fail closed. Interrupted super-journal
transactions also fail closed: private recovery must not follow absolute journal
references into the source home.

The minimal compatibility bootstrap opens the private DB with
`appstate.OpenWritable`, then explicitly ensures the adapter's existing `app_kv`
DDL (opening alone does not create this lazy table). No placeholder key is
written. Other compatibility tables are copied unchanged or initialized by their
existing owners. No defaults replace old KV rows. No `config.keys` or other
non-DB home files are created/copied here; those belong to the installer's
bootstrap/backup scope. `AlreadyReady` describes the input's current canonical
schema, not permission to skip publishing the prepared result. `Fresh` only
means the source database did not exist; it does not mean non-DB home files can
be overwritten.

`Accounts.SchemaInitialized` means canonical **schema** exists. It does not mean
accounts that only existed in the legacy ledger were imported. Compatibility
rows/credentials stay intact; `NodeImportPerformed` is always false. The report
directs the installer to the existing startup sync and native-import
translation, not fabricated Go rows.

All created data files are private and individually synced. Unix staging
directories are synced too. Windows directory sync is intentionally a no-op
**only** for these private artifacts: the state is `prepared`, never `published`.
The installer must provide write-through file exchange, durable journaling,
rollback and service recovery for live publication.
