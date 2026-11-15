# W3 default transaction recovery re-entry — 2026-11-15

## Scoped fixes

1. Windows initial publication can be interrupted after moving target to the recorded stage's `.displaced` file and before moving stage to target. Recovery previously rejected the missing target even with both genuine publication witnesses retained. `publication.go` now requires valid stage scope, the exact after-image at stage, and exact before-image at `.displaced` before a no-replace restore. Missing or inconsistent witnesses still reject an external deletion; a concurrent new native target is never overwritten.
2. On Unix, rolling back a formerly `0644` auth file correctly restores its previous bytes with private `0600` permissions. A second interruption before journal retirement formerly made the next recovery reject that safer file. `rollbackPreimageMatches` now recognizes exactly that private auth preimage, without loosening permissions or applying the exception to config files or changed contents.

Only `internal/host/codexdefault/files.go` (+7/-1) and new `publication.go` (+43) change. `staging.go` is unchanged. The original reviewer Kierkegaard independently compared object-store HEAD content against the physical files, bypassing a pre-existing shared-index reverse diff. Verdict: the two reported triggers are source-level closed, no new blocking finding in this patch. A further existing Windows rollback interruption window remains below.

## Actual full CLI verification (macOS)

The main agent built and ran **the complete production `cmd/aih`**, not copied functions. A restricted backup of the live single business database and a temporary HOME were used. The source database was opened read-only. Account 42's actual `set-default` operation generated the starting auth file; its existing token data was retained, with only valid pretty-JSON formatting and `0644` mode changed inside the isolated HOME. This ensures byte-different incoming auth without altering or damaging any token. No inference/network request, original auth write, shared service action, or synthetic journal was needed.

1. Full CLI `codex set-default 41 --json` generated its actual journal and published auth. On observing the real inode/content change while the journal existed, the controller sent SIGSTOP/SIGKILL to **that one newly launched CLI PID**.
2. Full CLI retry performed actual recovery. On observing the old auth bytes restored at `0600` with journal still present, the controller again stopped/killed only that new CLI PID.
3. The earlier full CLI `/tmp/aih-w3-cli-20261115` retried the exact retained journal: **exit 1, `codex_host_recovery_external_edit`**.
4. The newly built full CLI retried that same journal: **exit 0**, journal and stages retired, auth remained `0600`.

Final recorded run captured both interruptions on its first initial attempt. The actual journal's auth preimage mode was 420 decimal (`0644`). All temporary processes, credentials/database backups, and HOME files were removed after the operation. The evidence does not expose token contents.

```sh
go build -o /tmp/aih-w3-reentry-cli-20261115 ./cmd/aih
python3 /tmp/aih-w3-reentry-live-20261115.py
GOOS=windows GOARCH=amd64 go build -o /tmp/aih-w3-reentry-cli-20261115.exe ./cmd/aih
go build ./...
```

The builds exited 0. The Python operator script observes actual production transactions and sends OS signals; it does not supply fake journals or replace production functions. Its temporary pathname is not a durable verification artifact.

- Actual macOS CLI SHA-256: `55e5a8b9f67248b513b0db03474390d84c74c5521f6542e7d37ab114d792e3bf`.
- Low-sensitivity operator result: `/tmp/aih-w3-reentry-live-result-20261115.json` (ephemeral).
- Shared 9527 was not restarted. Neither new CLI nor server was deployed to the shared runtime.

## Explicitly excluded evidence / instruction deviation

The implementation subagent initially generated synthetic fixture data and a temporary component driver using copies of production functions. That violated the user's prohibition on new test cases, including temporary substitutes. The main agent stopped that work and excludes those results from CLI, platform, and business acceptance. No such driver or fixture is included in the commit. The full-CLI operation above replaced the claimed Unix acceptance evidence; it is not a relabeling of the component experiment.

A private LLDB version-only probe did not progress; its exact private debugger/child processes were terminated. It is not verification evidence and did not target the shared service.

## Follow-up status

The later `2026-11-15-codex-rollback-publication-acceptance.md` records the subsequent repair and real Windows instruction-level acceptance for the initial publication and rollback two-move gaps below. This document remains the earlier checkpoint; its historical gaps must not be read as the latest status.

## Remaining requirements at this checkpoint

- Windows initial publication's precise two-`MoveFileEx` interruption window has **source review and cross-compilation only**, not new native Windows execution in this checkpoint. The earlier Windows platform recovery record cannot prove this exact point.
- **Still open:** Windows rollback of an existing after-image calls `publishFile`, which creates an unjournaled `.aih-default-*` temporary. If rollback itself dies between its two Windows moves, the original stage is already gone and this patch deliberately cannot recover by guessing. A follow-up must journal/deterministically scope rollback publication evidence; it must not remove the two-witness guard.
- OAuth rotation, power-loss durability, Desktop/Edge acceptance, the complete W3 matrix, final release, and W0–W6 completion remain unproven. This checkpoint is not a declaration of global atomicity or complete crash recovery.
