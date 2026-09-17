# Account maintenance: database/filesystem recovery checkpoint

## Accepted scope and public gate

Step 3 verifies compensation and process-crash recovery for an explicitly
planned account identity migration. Step 2's shared/exclusive OS lease remains
in force. It does not approve changing production accounts, native App state,
Go database ownership or automatically stopping old clients. The dedicated
`scripts/oauth-identity-maintenance.js` accepts read-only `plan`; public `apply`,
`recover` and `rollback` continue to return `live_migration_not_approved`.
No hidden environment variable enables them. Recovery tests invoke the service
against entirely owned temporary files and real SQLite databases.

The reviewed scope is AIH-owned runtime addressing metadata. Shared native
history is not followed through symbolic links or moved out of its host store.
Historical prompts, tool output and usage deduplication keys are immutable.
Unknown executable references, conflicting destinations, unsupported metadata,
unsafe paths, schema SQL references and stale plans stop rather than guessing.

## Checked state machine

| Durable state | SQLite transaction marker | Recovery action |
|---|---|---|
| Owner exists, first journal not published | Absent | Clean only the exact operation's empty preparation; do not invent a snapshot |
| `preparing` / `prepared` / `applying` | Absent | Restore reversible filesystem edits and verify the full original database and inventoried files |
| `commit_ready` / `completed` | Present and matches plan | Keep the new state; verify post-state before declaring completed |
| `rollback_requested` | Present | Resume the same explicit rollback; do not return to forward apply |
| `rollback_requested` / `rolled_back` | Absent | Verify the original state and finish the rollback journal |
| Any inconsistent marker, later write or unknown file state | Inconsistent | Keep recovery gated; never overwrite an unexplained third state |

The transaction marker commits **in the same SQLite transaction** as account,
default and typed-reference changes. File edits happen under exclusive ownership
and have checksummed undo data. No cross-resource atomicity is claimed: this is
a Saga with an explicit durable decision, reversible steps and verified terminal
states. Ordinary clients are excluded from intermediate states.

## Defects reproduced in the earlier working draft

Five new regression cases failed before the corrections:

1. A COMMIT could succeed then throw before the in-memory flag changed. The
   catch path attempted ROLLBACK and removed the gate. Once COMMIT is attempted,
   errors now retain the gate; a fresh connection decides from the real marker.
2. An exception immediately before COMMIT also needs the same conservative
   resolution. Connection closure rolls back any uncommitted SQL; recovery does
   not infer the durable outcome from an exception alone.
3. Restoring selected files was treated as successful compensation without
   rechecking the rest of the inventoried state. Recovery now checks the original
   DB fingerprint, full inventoried file fingerprint and edited-file security
   metadata before marking `rolled_back`. Later writes are preserved and block.
4. A forward value replacement could merge two equal text values in a column
   with no UNIQUE constraint; reversal then could not identify the old row set.
   Such destination-value collisions are now plan blockers before mutation.
5. Recovery rotated its process owner token and lost the original operation ID
   when it crashed again before the first journal. The bounded owner record now
   keeps stable `operationId` separate from its changing ownership `token`.

## Backup and preservation invariants

- `VACUUM INTO` makes a consistent private backup including committed WAL data;
  it is checked with `quick_check` and the expected semantic DB fingerprint.
- Backup bytes and the containing directory are flushed before publishing
  `prepared`. Backup hashing streams in bounded chunks instead of loading a
  production-sized SQLite file into memory.
- Text updates preserve JSON numeric literals, whitespace and unmodified bytes;
  a 64-bit integer is never parsed and reserialized through a JavaScript Number.
- Row counts, values, foreign keys, default relations, credential bytes and usage
  totals are checked. Unexpected trigger side effects roll back the transaction.
- Native configuration permissions, owner/group, ACLs and extended attributes
  are checked and preserved through the platform metadata adapter. Unsupported
  platforms fail closed; Windows power-loss behavior has not been validated.
- Repeated recovery is idempotent. A failed or ambiguous recovery leaves the
  durable gate, not a success message or a destructive full-database restore.

## Tests and limitations

```sh
node --test test/rekey-recovery-invariants.test.js test/oauth-identity-maintenance.test.js test/rekey-json.test.js test/account-maintenance-lock.test.js test/account-maintenance-races.test.js
npm test
```

New subprocess tests use actual SIGKILL at file edit, link retarget, path move,
SQL updates, before/after COMMIT, rollback link restore and rollback COMMIT.
There is also a kill immediately after atomic rename but before directory fsync,
a two-crash pre-journal case, a COMMIT acknowledgment-loss injection, WAL-resident
committed data and a real xattr round-trip. Exit handlers are not relied upon.

The OS-probe fixture checks both lsof and ps availability. The isolated full
suite intentionally forbids ps execution; that run asserts conservative
`quiescence_unverifiable` rejection, while focused native runs verify the
permitted-OS success path. No production guard is weakened for sandbox tests.

Ubuntu's first full run exposed a second fixture issue: concurrent temporary
data roots reused the same synthetic upstream account, so a real process probe
correctly detected another test's CLI as active. Each fixture now has distinct
old and stable identities. A new regression first fails against the fixed-ID
helper, then passes after isolation; no process detection or migration assertion
is disabled.

These are real process-crash and fault-injection tests, not a physical power-cut,
storage-controller or real-account migration certification. Generic rogue
writers which bypass AIH's participation must still be drained/checked by a
future production execution procedure. No production process or account data
was changed for this checkpoint.

## Design and review map

| Module | Pattern | Reason | Evidence |
|---|---|---|---|
| `oauth-identity-maintenance` / `rekey-maintenance-recovery` | Saga + explicit state machine | Resolve non-atomic DB/filesystem steps from a durable marker | Before/after-COMMIT and repeated rollback crashes |
| `rekey-journal` | Write-ahead journal + compensating operations | Record intent and reverse only known before/after states | Rename-window, edit/link/move and interruption tests |
| `rekey-consistency` | Postcondition/invariant boundary | Undo calls alone do not prove the original state | Later-write rejection and whole-state comparison |
| `rekey-backup` | Bounded persistence adapter | Isolate snapshot creation, verification and streaming checksum | WAL backup, checksum failure and recovery tests |
| `rekey-json` / reference policy | Lossless transformation + explicit policy | Preserve exact data and distinguish addresses from history | 64-bit literals, collisions and opaque-history tests |

SOLID/KISS/DRY/YAGNI review: orchestration, validation, filesystem IO, metadata and
reference grammar are separate. Existing SQLite, credential identities and OS
leases are reused. No new runtime dependency, shadow account table, privilege
system or blanket reference substitution is introduced. A requested independent
review could not complete because the reviewer model was at capacity; this
limited code checkpoint uses recorded self-review and negative regressions, not
an asserted independent approval of live migration.
