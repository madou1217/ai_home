# Account maintenance: real-data read-only rehearsal

> Subsequent closure: native SQLite participants and confirmed public execution
> are documented in [native-store closure](account-maintenance-native-closure.md).
> The dated checkpoint below is preserved as historical evidence.

## Checkpoint and result (2026-09-17)

Step 4 examines the real account database and the existing planner's filesystem
scope without granting production write access. It does **not** authorize or
claim successful production migration. The public maintenance CLI remains
plan-only. The original accounts, native App state and service lifecycle were
not changed by this work.

**Result: the real-data copy is correctly blocked.** Four account identities can
be mapped without identity conflict, but 32 reference/inventory blockers remain.
Calling the existing migration service with this unmodified plan returns
`rekey_plan_has_blockers` before opening a maintenance transaction. No blockers
were deleted, no unknown native format was rewritten, and no fallback alias was
introduced to make the experiment pass. A successful migration/rollback of these
real records has not yet occurred; step 3's synthetic crash recovery is separate.

The historical review's requirements remain in force: an explicit mapping
ledger, stable subjects, no silent merge, and no shadow identity table. Old
review documents describe earlier revisions; this checkpoint records newly
observed data, not a rewrite of their earlier findings.

## Observed snapshot, not a stopped production system

| Observation | Verified value |
|---|---:|
| Main SQLite snapshot | 661,135,360 bytes |
| Tables / account rows | 29 / 29 |
| Usage records | 769,747 |
| Chat runtime events | 151,562 |
| Codex records | 8: 1 current, 2 to migrate, 5 API-key not applicable |
| Grok records | 2: both to migrate |
| Identity conflicts / unverifiable selected identities | 0 / 0 |
| Planned text-value change groups | 251 |
| Planned configuration edits / path moves | 7 / 10 |
| Blockers in source plan and copy plan | 32 / 32 |

The main DB's full semantic fingerprint in the pinned read transaction equals
the standalone copy. The account mapping in the earlier source plan equals the
mapping derived from the later copy. Production continued running; usage can
increase between those observations. This is not a claim that every file and
table in the whole live system was captured at one global instant.

The successful addressing-scope copy inspected 113,234 entries, with 84,137
ordinary files, 28,286 directories, 763 symbolic links, 22 native SQLite captures
and 26 sidecar entries represented by their database captures. The summed source
file sizes were 3,113,152,423 bytes, not a measure of allocated disk space.

No external link was followed. Six internal absolute links were explicitly
relocated into the copy. Excluded native history/resources remained excluded by
the existing planner scope; DB strings were not rebased. Therefore this is an
addressing-scope rehearsal, not a complete runnable clone of every native App.

## What blocks the actual data

| Class | Count | Meaning |
|---|---:|---|
| Structured DB reference requiring classification | 1 | Historical file-change detail contains an unclassified path |
| Unknown/native binary reference | 4 | Includes native SQLite state/log data and an old configuration backup |
| Unclassified machine-file format | 22 | Primarily Chromium/LevelDB diagnostic `LOG` files |
| File exceeds current parser budget | 5 | Cached/native binary payloads are not safely treated as text configuration |

These are 32 **conservative planner stops**, not 32 proven application bugs.
Diagnostic history and immutable downloads may eventually have explicit policies,
but that does not justify ignoring the genuine native database addresses.

Read-only SQL inspection, then inspection of the isolated native copies, found
**three `threads.rollout_path` values across two `state_5.sqlite` files** that
contain old account-directory references: two in one database and one in the
other. Every one changes under the proposed account-path mapping. These fields
locate native session files; they cannot be relabeled as ordinary log prose.
The copied plan retains those blockers. Native `logs_2.sqlite` also contains an
old reference in `feedback_log_body`, a distinct historical-diagnostic category.

The next bounded implementation is a reviewed native SQLite reference participant
with its own backup/transaction/recovery evidence, plus explicit classification
of the immutable resource cases. It must not change or move shared native history.

## Snapshot boundary and safeguards

`rekey-readonly-snapshot` uses SQLite's online backup from a pinned **read-only**
source transaction, including committed WAL pages. It does not use `immutable=1`
and does not copy only a live main DB file. The destination alone is checkpointed
and converted to a self-contained DELETE-journal snapshot, integrity-checked,
semantically compared and fsynced.

A native WAL database may need to recreate SHM even when opened SQL read-only.
The actual OS-denied-source-write experiment exposed that case. Rather than
relaxing source protection, `rekey-native-snapshot` captures a stable ordinary
main/WAL file set without opening source SQL, checks source inode generations
before/after and copied byte hashes, and lets SQLite recover **only in private
staging**. Nonempty rollback journals, changing source files, links and unsafe
files fail closed. This is an offline/stable-file method, not an assertion that
arbitrarily active native databases can always be captured.

The first capture stopped on the SHM requirement; a later capture stopped when
an earlier plan's configuration version had changed during traversal. Only the
third capture was certified. Metadata is now captured with its own current file
version, not taken from the older plan. This changes snapshot construction, not
the migration tool's stale-plan checks.

Actual capture ran under a macOS sandbox denying all source writes and all
network access; a read/write open of the source DB was explicitly denied. Copy
assessment additionally denied reads of the production account/config roots.
The blocked apply attempt left the copied DB's bytes and the complete inventoried
filesystem fingerprint unchanged and created no maintenance gate.

SQLite read-only mode alone may update permitted SHM reader bookkeeping. Tests
therefore do not falsely assert generic SHM byte immutability; the real source
protection came from the OS policy, independently exercised in a subprocess test.

Full plans, mappings and copies contain credentials and were kept in a private
0700 scratch root with 0600 database/plan files. They are not committed, attached,
or included in this document. Only aggregate results and redacted field names are
reported; the generated sensitive scratch is removed after verification.

## Tests and implementation boundaries

```sh
node --test test/rekey-rehearsal-snapshot.test.js
node --test test/rekey-rehearsal-snapshot.test.js test/rekey-recovery-invariants.test.js test/oauth-identity-maintenance.test.js test/rekey-json.test.js
npm test
```

The new 11-case suite covers exact integer/blob/WAL preservation, source stability,
private output, destination collisions, directory traversal, symbolic links,
size limits, native SHM recovery only in the copy, metadata capture, nonempty
rollback-journal refusal, and the unchanged blocked-copy outcome. A macOS-only
subprocess test proves source write denial; other platforms do not claim that
specific OS-policy experiment. A parent sandbox also prevents installing a
nested macOS sandbox; an explicit capability probe reports that one test as
skipped in the already-isolated full suite, never as an executed success.
Node 22 and Node 26 each passed all 11 in native focused runs;
the combined related suite passed 72 cases before the final full-suite gate.

| Module | Pattern | Reason | Evidence |
|---|---|---|---|
| `rekey-readonly-snapshot` | Snapshot + persistence adapter | Pin source DB state without mutating it | WAL, integer/blob and semantic-fingerprint tests |
| `rekey-native-snapshot` | Isolated staging adapter | Recover native WAL only in an owned copy | Missing-SHM, source-change and OS write-denial tests |
| `rekey-rehearsal-copy` | Bounded copy orchestrator | Keep link handling, metadata capture and copy receipts explicit | Link, path, size and metadata tests |
| `rekey-inventory-scope` | Shared immutable policy | Planner and copy must not drift in inspected scope | Existing planner suite plus actual unchanged blocker count |

SOLID/KISS/DRY/YAGNI review: source read adapters, native staging, copy orchestration
and migration execution remain separate. No new runtime dependency, public write
route, native-process launch, credential refresh or new identity registry was
added. This checkpoint is self-reviewed with executable negative cases; it does
not claim an independent approval of live migration.
