# W4 model-write contention and cancellation — 2026-11-16

## Reproduced failure

W4 requires bounded SQLite contention handling, preserved old state, visible failure and coherent DB/routing publication. On an actual full Go server at a private port with a permission-restricted live-DB backup, an external SQLite connection held `BEGIN IMMEDIATE`. A real authenticated GET account models succeeded (200/14ms), but a real PATCH manual policy returned **500/internal_error in1ms**. The model policy stayed unchanged; after releasing the external write lock, PATCH returned200.

The model store began a deferred transaction and read account existence before upgrading to a writer. That upgrade may fail immediately under another writer; a configured5-second SQLite busy timeout does not turn that sequence into safe retry. Generic error mapping hid the expected contention as internal_error. The initial cancellation probe encountered an already-closed socket after this early500 and failed at shutdown; it is **not counted as cancellation acceptance**.

## Focused repair

Production scope is four files only:
- `application/accounts/models.go`: typed `ErrModelWriteBusy` sentinel.
- `internal/adapters/accounts/sqliteaccount/model_transaction.go`: connection-local model transaction admission and cleanup.
- `internal/adapters/accounts/sqliteaccount/model_store.go`: discovered-model replacement and manual policy writes use the helper; surrounding domain logic stays unchanged.
- `internal/transport/http/accountsapi/error_mapping.go`: busy maps to503, stable `account_model_write_busy`, `Retry-After: 1`.

Admission covers the in-process `routingWrites` mutex, connection acquisition and `BEGIN IMMEDIATE`, with a2-second context and25–200ms backoff. The acquired connection's original busy_timeout is read, changed to0 for context-controlled BEGIN admission, then restored on cleanup. Only BEGIN is retried, before any business mutation. No upstream call, model write, COMMIT or tool execution is replayed.

After admission, statements use the caller context. COMMIT first checks cancellation; once finalization starts it uses `context.WithoutCancel(ctx)` so a successful SQLite commit cannot be retroactively reported as canceled and skip route publication. A successful snapshot is published while `routingWrites` is still held; only then does deferred cleanup restore connection state/release the lock. Cleanup errors discard the connection instead of returning a live transaction or altered timeout to the pool.

**Two seconds is an admission budget, not a whole-request SLA.** Actual SQL work, finalization, cleanup and existing model-probe recording have separate boundaries. This patch does not claim to fix every account/profile/credential write path.

## Actual final-artifact operations

All mutations were to the disposable backup; the original `aih.db` was opened read-only for backup. No shared database lock, migration, service restart or real account-state write occurred. No tests, fixture databases, fake provider responses or production instrumentation hooks were added.

| Operation | Final observation |
|---|---|
| External writer owns backup; GET model catalog |200 in11ms |
| Same lock retained; PATCH manual policy |503 in2003ms, `account_model_write_busy`, `Retry-After: 1`; old `inherit` retained |
| One actual PATCH waits; external writer releases after350ms |200 in385ms without client resend; policy becomes force_disable |
| Write after released lock |200 in3ms |
| Restore original policy before cancellation |200 in3ms |
| Send actual PATCH while locked; close client, then unlock |after6 seconds policy still `inherit`, no late write |
| New write after cancellation |200 in5ms; policy becomes force_disable |

A separate actual refresh chain used the same final artifact and transparent relay to the approved real model-directory upstream:
- explicit manual force_disable succeeded;
- with the backup initially writer-locked then released, refresh returned200 in3137ms overall (including real network/credential/probe work);
- exactly1 real upstream catalog call,224 catalog rows, manual policy retained;
- after intentionally closing only the private transparent relay, refresh returned502/model_refresh_failed and the complete last-good catalog plus manual policy remained unchanged.

The3137ms is not a contradiction of2-second admission: the request has other stages, and the controlled lock was released after400ms. It also is not proof that this particular refresh reached admission before unlock; the direct PATCH wait/release operation establishes that branch.

## Independent review correction trail

Original reviewer Hubble first identified two concrete issues: request cancellation racing a completed COMMIT could skip route publication; and admission budget expiry during PRAGMA read/set could leak generic500. Both were corrected as described above. Final narrow source review at2026-11-16 01:03:45 Asia/Shanghai reported **no new blocking finding**. That review covered the two model-writing paths, not all W4 writes; final-artifact business results were completed by the main agent afterward.

## Build and evidence

```sh
go build -o /tmp/aih-w4-model-contention-server-final-20261116 ./cmd/aih-server
python3 /tmp/aih-w4-sqlite-contention-final-live-20261116.py
python3 /tmp/aih-w4-model-refresh-final-live-20261116.py
go build ./...
go vet ./internal/adapters/accounts/sqliteaccount ./internal/transport/http/accountsapi ./application/accounts
go run ./cmd/route-ownership-manifest --check
```

Build/vet/manifest checks exited0. Final exercised server SHA-256: `06a2613fc14e7cd8bd5150bd5e3dfd717a3a2c8627c47ca415c45cf8a14bb258`.

Low-sensitivity results: `/tmp/aih-w4-sqlite-contention-result-20261116.json` (before), `/tmp/aih-w4-sqlite-contention-after-result-20261116.json` (final), `/tmp/aih-w4-model-refresh-after-result-20261116.json` (final refresh). Results and repository evidence contain no credential body or private session text.

Private servers, relay, DB backups and HOME directories were removed. A copied-state warmup had briefly left a Homebrew curl whose output path belonged to the exact private HOME; it was separately inspected and was gone before final reporting. Later operations set Homebrew auto-update suppression and did not treat a removed directory alone as process cleanup proof. Shared9527 and peer Node/terminal fixes were not touched.

## Remaining plan boundary

No production release/restart is included. Precise post-COMMIT cancellation was source/driver-reviewed, not artificially instrumented into a new test case. Disk/IO/commit ambiguity, all other SQLite write domains, OAuth refresh/rotation, WebUI rendered outcomes, and full W0–W6 remain independent requirements. This closes a concrete model-write contention defect and its adjacent real cancellation/recovery path, not the full account concurrency program.
