# OAuth rekey: native SQLite participants and complete rehearsal

## Scope and admission

This closes the native-store gap found by the real-data rehearsal. The earlier
32 stops were conservative classifications, not 32 proven application defects.
The implementation now handles the two concrete native Codex state databases,
preserves explicitly historical/immutable resources, and continues to block
unknown machine-addressable references.

The public `scripts/oauth-identity-maintenance.js` accepts `plan`, `apply`,
`recover`, and `rollback`. Mutation requires an exact confirmed plan digest,
private backup/journal storage, exclusive cross-process admission, verified
absence of native database openers, and fresh source-state comparison. There is
no `--force`, no silent fallback alias, no automatic credential merge, and no
service-killing behavior in the migration command. A rejected admission does
not justify terminating an unrelated user's task.

## Native store contract

`rekey-native-policy.js` is a versioned storage adapter for `.codex/state_*.sqlite`
and `.codex/logs_*.sqlite`, not a generic text replacement inside database files.
Only `threads.rollout_path` and the same addressing field in native migration
bookkeeping may change. Vendor schema, `_sqlx_migrations`, IDs, permissions,
64-bit integers, BLOBs, sequence counters, header application/user versions and
historical messages remain unchanged. Unknown columns, BLOB references, schema
SQL containing an old reference and reverse-value collisions block the plan.

Native `logs.feedback_log_body` and recorded thread titles/messages are historical
facts, not current account routing. Historical `file_change` event paths are
preserved only under that event kind's validated detail shape. Adjacent active
runtime addresses still migrate; future operation fields do not inherit this
exemption.

The native participant uses a full semantic before/after fingerprint, not just
row counts or a 'done' boolean. Every affected native store has its own verified,
private SQLite backup before any native commit occurs. The original vendor
schema gets no AIH migration table. Native connections close before their account
parent directories move, avoiding SQLite reopening a WAL by an obsolete path.

## Commit and compensation order

1. Acquire exclusive admission and revalidate the exact main/file/native plan.
2. Durably publish journal and verified main/native backups.
3. Start the main DB write transaction; update and commit each native participant.
4. Rewrite controlled configuration, move account-owned paths, update main SQL.
5. Compare complete expected states; commit the main transaction with its marker.
6. Publish completion and release admission only after connections close.

Before the main marker commits, an error restores directory names, then reverses
only native stores exactly matching the known after-state. Stores already in the
before-state are idempotent. An unexplained third state is never overwritten.
A crash after the main commit preserves the after-state. Explicit rollback records
its intent before reversing any participant, so a second crash resumes rollback.

A killed DELETE-mode transaction can leave a cold, nonempty journal even though
SQLite reports the original committed data. After a full before-state proof,
recovery asks SQLite to cycle TRUNCATE → DELETE to settle its own journal. The
tool never unlinks an arbitrary vendor journal. Interruption during that settlement
is tested. A native close failure retains the gate for fresh-process recovery.

## Immutable file classification

- Timestamped `config.toml.aih-bak-*` files retain their historical bytes.
- Chromium/LevelDB uppercase `LOG`/`LOG.old` are diagnostic history; numbered
  LevelDB `*.log` files are **not** exempted.
- Known CRX-cache locations require CRX/ZIP magic; native download locations
  require ELF/Mach-O/PE magic. A script in the same directory is not accepted.
- These files remain fingerprinted, not deleted or replaced. Shared session
  links are never followed into the host's history during copying or migration.
- Native WAL/SHM/journal entries are represented by the main store's checked
  logical state. An orphan sidecar remains a blocker.

## Real-data evidence

The fresh source plan mapped four identities with no identity conflict and no
remaining actionable blocker. A separate source-read-only database snapshot and
addressing-scope copy were created in an owner-only temporary directory. All
source writes were denied by the OS. Copy execution additionally denied reads
of the original account/config directories and denied network access.

On that full copy, both native stores (three rollout pointers) and the main DB
successfully migrated together. The main transaction updated 45,888 rows while
preserving the 29-account graph. Explicit rollback then restored the exact
original main/file/native plan digest. This is a real-data **copy** result, not
by itself a claim that the original production accounts have been changed.
Production execution and service-restoration results must be recorded separately.

The copy contains source-native absolute strings. No global root rebase was used
to erase references. Rehearsal validates pointer transformations and store state;
it does not run the vendor GUI or send a real inference request. Shared history
remains an external resource, not a secretly duplicated account store.

## Executable checks and review

`test/rekey-native-participant.test.js` covers DELETE/WAL modes, two participants,
actual SIGKILL before/after native and main commits, interrupted compensation,
second-participant failure, lost commit acknowledgement, close failure, corrupted
backup, later native writes, unknown fields/schema/BLOBs, orphan sidecars and
public CLI apply/rollback/recovery with exact confirmation.

`test/rekey-immutable-artifacts.test.js` rejects location-only exemptions and
keeps live configuration and numbered LevelDB logs out of the immutable class.
The native focused runs execute the public CLI roundtrip. In the full macOS
isolation profile, system process inspection is denied; that same admission test
instead requires the exact refusal code, no gate, and unchanged DB/file state.
It does not disable admission checks or count that branch as a CLI roundtrip.
Existing lock, main/file crash recovery, snapshot and lossless-JSON suites remain
unchanged in strength. The formerly unknown-store fixture now deliberately uses
an unknown native field, so it still proves refusal instead of testing an
addressing field that has become supported.

Independent read-only review was attempted with the installed native reviewer,
but returned its account usage-limit error before producing a review. This scope
therefore records self-review plus negative/crash tests under the user's explicit
authorization; it does not claim an independent approval. Public production
admission still executes all real guards, never a test `assertQuiet` replacement.

| Module | Pattern | Why | Evidence |
|---|---|---|---|
| `rekey-native-policy` | Strategy / typed reference policy | Distinguish live addresses from vendor history | Unknown field, BLOB, schema and historical-path tests |
| `rekey-native-inventory` | Snapshot adapter | Inspect vendor WAL only in a private copy | Read-only source, stable-file-set and plan tests |
| `rekey-native-participant` | Saga participant + compensation | Coordinate independent SQLite commits without claiming cross-DB atomicity | Multi-DB roundtrip, lost ack, SIGKILL and second-failure tests |
| Existing maintenance orchestrator/recovery | State machine | Main durable marker selects the direction | Main/native mixed-state recovery tests |
| `rekey-immutable-artifacts` | Explicit classification policy | Preserve binaries/history without hiding live addresses | Magic, path and negative classification tests |

SOLID/KISS/DRY/YAGNI review: source inspection, reference rules, native IO and
transaction orchestration are separate. Existing backups, fingerprints, SQL
updates, metadata validation and admission locks are reused. No new dependency,
account shadow table, general-purpose workflow framework, vendor protocol
reverse engineering, WebUI redesign or Node→Go ownership switch is introduced.

## Runtime observations outside the selected identity transaction

The first original-store attempt correctly refused four long-lived foreground
AIH terminal clients holding SQLite connections; no migration ran and the service
was restored. Their exact tmux sessions and native processes were subsequently
preserved through replacement direct terminal attachments, then only those old
foreground attachments were detached. Empty, disconnected, zero-loaded-thread
account app-server engines were gracefully retired after explicit inspection.

A second attempt stopped on a stale plan, again without changing identities.
Read-only comparison found no changed planned edit or native participant. It found
only `run/account-activity.json`, `run/codex/cli-hook-state.json`, and diagnostic
SQLite content belonging to other, unmapped accounts. These can legitimately
advance while the selected account graph is offline.

`rekey-live-observation-policy` now defines a narrowly scoped distinction:
recognized account-activity/hook observation JSON with **no old or new target
identity reference** is not a restoration target. Its presence, path, ownership
and mode remain checked. Unknown schemas, arbitrary files and records mentioning
a target identity retain the old strict content fingerprint. Native diagnostic
rows outside both target roots may append; their schema is still fingerprinted
and every column is still inspected for unknown machine references. Native logs
inside a migrated root remain fully state-checked. No file is overwritten or
cleared to achieve quiescence.

New filesystem plans record `observationPolicy: 1`. Old durable journals without
that field explicitly retain the original strict policy, so this refinement does
not reinterpret their previously recorded before/after state. The policy is not
a command-line override and unknown policy versions are rejected.

`test/rekey-live-observation.test.js` verifies unrelated observation updates survive
both apply and rollback, target-identity/escaped-identity refusal, strict metadata
and arbitrary-file checks, unrelated native diagnostic append, unknown native
fields/schema, mapped native log updates, and legacy-journal compatibility.

Pattern: `rekey-live-observation-policy -> scoped Strategy -> separate derived
unrelated liveness from the transaction's authoritative inputs -> seven positive
and adversarial tests`. Main SQLite still receives the full before/after check;
no account, credential, usage or native pointer consistency rule is weakened.
