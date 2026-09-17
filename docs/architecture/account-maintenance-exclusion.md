# Account maintenance: mutual-exclusion checkpoint

## Accepted scope

This checkpoint establishes cross-process exclusion for the future identity
maintenance tool. It does **not** approve production rekey, data rewriting,
backup/restore completeness, crash recovery of account data, or Node-to-Go
ownership cutover. The separate migration command remains plan-only.

Ordinary Node account connections and normal Node CLI/server processes share a
SQLite rollback-journal read lease in `run/maintenance/access.sqlite`. A dedicated
maintenance/recovery entry acquires an exclusive transaction **before** reading
or replacing its durable owner. Two recoverers cannot both claim a stale PID.
The lock store contains one constant row, not accounts, tokens, timestamps or
another authoritative account database.

The OS releases transaction locks when a process exits or is killed. A durable
`oauth-rekey.lock` gate is intentionally separate: process death does not prove
that an interrupted data migration completed. Ordinary clients remain blocked
until the maintenance coordinator has resolved that state.

## Defects reproduced and fixed in this checkpoint

1. Passing the real `DatabaseSync` constructor explicitly bypassed the lease.
   Native constructors and subclasses now participate; isolated fake test
   adapters keep their existing injected boundary.
2. A failed process registration stayed in a Map and could return an unlocked
   cached handle on retry. Failed acquisition now removes that registration.
3. Repeatedly closing an old process handle could delete a newer registration.
   Close is idempotent, identity-checked and removes its exit listener.
4. A native database close failure released the lease in `finally`, even when
   the connection was still alive. Exclusion now remains until close succeeds.
5. Two new readers could both attempt initialization; an unnecessary
   `INSERT OR IGNORE` then waited for an exclusive commit against the first
   reader. Initialization now rechecks under `BEGIN IMMEDIATE`, creates table
   and row atomically, and rolls back without writing when already initialized.

Five newly added regression cases fail against the previous working draft;
all pass after the fixes. Existing tests alone had missed these paths.

The first full-suite run exposed a fixed-300ms timing assumption in the existing
Codex preflight-switch test. It now waits for the actual replacement spawn with
a bounded deadline; exact account, resume arguments and one-spawn assertions
remain unchanged. No production delay or assertion was removed.

## Composition and non-goals

`lib/cli/app.js` is the **ordinary** process composition root. It holds a shared
lease until process exit so native file work between individual DB calls stays
excluded from maintenance. A fresh, read-only HOME check does not create state.

Maintenance/recovery must use the dedicated entry which calls
`acquireRekeyLease`, not import `lib/cli/app.js` and then try to upgrade its own
read lock through a second connection. No environment flag silently drops the
ordinary lock, and no live apply route was added in this checkpoint.

The lease no longer imports the larger migration journal/inventory pipeline.
`maintenance-owner-file.js` owns only a bounded, secret-free owner document.
Normal lock acquisition does not require directory `fsync`, preserving the
portable normal DB path. Durable owner writes still require their fsync policy;
this is not a claim of native Windows power-loss recovery validation.

Processes which open SQLite outside the integrated Node boundary are not
magically enrolled. The future live coordinator must still drain/verify old
clients and detached runtimes; `lsof`/process probes are additional conservative
checks, not the source of mutual exclusion or a whole-machine guarantee.

## Executable evidence

```sh
node --test test/account-maintenance-lock.test.js test/account-maintenance-races.test.js
npm test
```

The focused tests use real child processes, actual temporary SQLite databases,
IPC readiness acknowledgements and an owned child's `SIGKILL`. They cover shared
readers, exclusive exclusion without a gate, owner immutability under a losing
recovery, simultaneous recovery with exactly one winner, normal CLI rejection,
constructor/close failures, lifecycle cleanup and concurrent first use. Fixture
cleanup never terminates a user's real process or reads production credentials.

The full test gate is run from a snapshot of the **scoped index**, not from the
larger uncommitted migration workspace, under a temporary HOME and a local-only
network sandbox. Synthetic-driver tests are not reported as native App tests.

## Pattern and boundary review

| Module | Pattern | Why | Evidence |
|---|---|---|---|
| `account-maintenance-lock.js` | Reader/writer lock + lifetime lease | OS ownership closes check/open and stale-PID races | Real subprocess exclusion and crash tests |
| `app-state-store.js` | Resource-lifetime adapter | Couple actual native connection closure to lease release | Native constructor/subclass/failed-close regressions |
| `rekey-lease.js` | Exclusive coordinator | Serialize recovery owner replacement without lock upgrade | Simultaneous recovery and owner-byte checks |
| `maintenance-owner-file.js` | Focused persistence adapter | Keep metadata I/O independent of account migration | Recovery tests and bounded owner validation |

SOLID/KISS/DRY/YAGNI: native locking, owner persistence, process lifecycle and
migration policy stay separate. Reuse SQLite already required by the project;
no new dependency, account table, generic lock server, permission layer or
public migration feature is introduced. Data-migration review remains separate.
