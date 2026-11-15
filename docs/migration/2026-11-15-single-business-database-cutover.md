# Single business database cutover — 2026-11-15

The local installation now uses `~/.ai_home/aih.db` as the only writable AIH
business database. The retained `app-state.db` is sealed against business writes
and supplies the cutover receipt for startup validation. Provider-native and
Codex state/history/log databases remain outside this boundary.

## Recovered intent and incident

The source of the design is Codex session
`01a1dd2b-7f02-7922-87d2-cfa278ed2fe3`, coordinated by
`01a1db81-6373-7ba0-9fae-5fde28efad17`. Its final evidence covered isolated copies,
not activation of the local installation. The source CLI had already activated
the migration gate, while the live installation still lacked both receipts.
Consequently `aih codex` failed in `lib/cli/app.js` before launch.

The recovered design keeps Go account tables authoritative, copies 32 source
tables, rejects unexplained conflicting rows, retains backups, seals the legacy
database and switches consumers together. Four incompatible source tables retain
the previously implemented `compat_` mapping: credentials, quota detector state,
quota reset events and quota window samples. The credential schemas are different:
Go stores `auth_kind/credential_json`, whereas the Node projection stores
`env_json/native_auth_json`. Other migrated business table names remain unchanged.

The user explicitly approved stopping the local public and private services,
completing the migration and restoring service.

## Source changes completed

- Codex host defaults and compatibility KV now share one connection and one
  transaction in `aih.db`; neither default-state operation attaches the old file.
- Account, appstate, rules, plugin, usage and chat storage entry points validate
  cutover readiness before opening or mutating a business database.
- Codex environment, account rules/live views and CLI completion use the mapped
  compatibility tables and canonical database path.
- The migrator preserves identifiers that do not need mapping. Existing index
  definitions compare by SQL tokens, preserving values and token boundaries.
  Unequal SQL containing comment markers is conservatively rejected.
- Go initialization accepts a Node-created first-install database only when its
  application ID/version are zero and every object is a recognized compatibility
  table or index. Unknown objects still fail closed.
- The source CLI recognizes a frozen service release using the current home's
  runtime record and OS process creation identity. An untrusted path hint only
  filters command prefixes before identity validation; it cannot authorize a
  process. This avoids incorrectly starting another service on port 9527.

## Data reconciliation and publication

The target contained an earlier bootstrap projection. Initial differences were
34 dynamic Node state/cache rows and two migration timestamps. The operator
preserved both full database snapshots and both versions of each differing row
before selecting the original running Node projection. Unknown keys and an older
legacy projection were rejected. A competing restart subsequently refreshed
derived state, including `cache:webui-models-snapshot.json`; that exact cache key
was added to the operator allowlist, with the same preimage preservation and
timestamp check. No general latest-value-wins policy was added to the migrator.

Direct in-place migration repeatedly returned SQLite `database disk image is
malformed` while integrity checks and migration of exact SQLite-backup copies
succeeded. A service restarted by another session was stopped during this window,
but the error also reproduced without an observed competing consumer. Its lower
level cause has **not** been established; this record does not claim otherwise.

The completed cutover therefore used the verified offline publication path:

1. Copy the current stopped databases with the SQLite backup API.
2. Complete the original transactional migration on those copies.
3. Verify all 32 source tables with `EXCEPT`, preserve canonical account/default/
   credential/model/ledger contents, and run integrity and foreign-key checks.
4. Checkpoint both prepared files and sync them to disk.
5. Retain original files, write a publication journal, atomically publish the
   prepared target and then the sealed legacy file, and verify matching receipts.
   A process starting between the two publications is rejected by the receipt gate.
6. Start the frozen release through the existing launchd service.

## Actual acceptance

No test cases were added. Evidence below comes from actual SQLite databases,
native commands and local services.

| Check | Observed result |
| --- | --- |
| Source migration | 32 tables; 1,252,532 inserted rows |
| Canonical accounts / credentials | 41 / 41; original content preserved before startup |
| Source table content | All 32 source tables preserved |
| SQLite integrity / foreign-key violations | `ok` / 0 |
| Stored API and management keys | Unchanged, nonempty; values not printed |
| Legacy INSERT / UPDATE / DELETE | All rejected with `aih_database_migrated_use_aih_db`; probes rolled back |
| Migration rerun on actual home | `already_complete`; matching receipts |
| Public `/readyz` | Ready; 224 models; 448 routes |
| Authenticated `/v1/models` | HTTP 200; 224 entries |
| Authenticated management and WebUI account lists | HTTP 200; 41 accounts each |
| Native gateway credential helper | Exit 0; output equals persisted key |
| Installed `aih codex --help` | Exit 0; no migration error |
| Installed `aih codex --version` | Exit 0; official Codex 0.167.2; no autostart collision |
| Actual `aih codex` TUI | Official interface reached `Ready`; validation UI exited |
| Node-first fresh installation | Real Go service became ready; schema 31; Node configuration retained |
| Build and static verification | `go build -mod=readonly ./...`, focused `go vet`, JS syntax and whitespace checks passed |
| Independent source review | Completed before cutover and after lifecycle identification repair |

## Runtime and recovery evidence

- Initial frozen release, retained for recovery:
  `~/.ai_home/run/releases/20261115-single-business-db`.
- launchd label: `com.meadeo.ai_home`; Go supervises its private Node child.
- Observed service PIDs: Go 25325 on 9527, Node 25355 on private port 60330.
  PIDs and private port are runtime observations, not permanent configuration.
- Backup/evidence root:
  `~/.ai_home/run/aih-db-repair-20261115-9jhjiybz`.
- `live/before-reconciliation`, `live/publication-preimage` and the original
  target before reconstruction preserve source material. `live/reconciliation.json`
  and `live/retry-reconciliation.json` retain differing row preimages privately.
- `final-cutover/migration.json`, `live/publication.json` and
  `live/acceptance.json` record staging, publication and actual acceptance.
- The previous launchd definition is retained as `live/before-service.plist`.
  Restoring old software against the sealed database is not a valid automatic
  rollback; any data restoration must be an explicitly coordinated offline action.

No branches/worktrees were created. No peer changes were reverted. No Git commit
or push was performed. The broader Node-to-Go migration remains separate from
this installation's completed business-database cutover.

## Follow-up: close the standard startup entry point gap

The initial acceptance was incomplete. It proved the frozen release and a Codex
request but did not update the standard workspace native artifacts selected by
the installed `aih` entry point. The user subsequently reported
`账号数据库结构不兼容`.

The installed `/opt/homebrew/bin/aih` resolves to this workspace. Its Go CLI,
Node supervisor and macOS launch agent select `bin/native/darwin-arm64/aih-go`
and `aih-server`. Those two files were still builds from before schema 31.
Launching the old standard server against the actual home reproduced the exact
error. Launching the preserved old server against a fresh SQLite-backup copy
also exited 1 with the same error. This was a software/database version mismatch;
the successful frozen service did not establish standard startup compatibility.

The repair preserved both old executables and the server stamp, then ran the
repository's `npm run go:build`, which rebuilds both standard artifacts through
temporary files and atomic rename. Against the same database copy, the new
standard server reached readiness, returned 41 accounts and shut down with exit
0. No further schema change or data migration was needed for this repair.

The actual installed `/opt/homebrew/bin/aih server restart` then replaced the
frozen launchd entry with the standard workspace server. Fresh runtime identity
and file hashes agree:

- Server: `bin/native/darwin-arm64/aih-server`, SHA-256
  `bd3d328af08e3cc34734148c52ee9cb714c2abfb735ec21aef075ed083e6dee5`.
- CLI: `bin/native/darwin-arm64/aih-go`, SHA-256
  `7c0c16cb746095227bba031a82915766fa084d41390437da0e7668fcb97f756d`.
- Observed new Go PID 7485 and supervised Node PID 7794, private port 64522;
  these are observations, not configuration constants.
- `aih server status` reported ready with no source-stale marker.

Fresh business acceptance used the installed CLI and actual service:

- `aih codex -- exec --skip-git-repo-check --sandbox read-only --json ...`
  returned `AIH_NATIVE_STARTUP_OK`, emitted `turn.completed` and exited 0.
- `aih codex sessions` listed existing project sessions. The history command
  also read the shared Codex history successfully.
- An actual TUI resumed existing coordinator session
  `01a1db81-6373-7ba0-9fae-5fde28efad17`, displayed its saved conversation and
  reached `Ready`; the validation client disconnected cleanly with exit 0.
  Prior failed-turn errors remain historical conversation content. This check
  did not submit another user turn or resume its stalled Goal.
- `/ui/`, public WebUI bootstrap, management accounts, public WebUI accounts
  and projects all returned HTTP 200; counts were 41 accounts and 18 projects.
- Message reads for all five previously blocked parent sessions returned HTTP
  200 with nonempty saved content, including the Shalou session.
- Fresh SQLite integrity was `ok`; foreign-key violations were 0; canonical
  accounts/credentials remained 41/41 and compatibility credentials 39.
- Since the new server's listening marker there were no new schema,
  missing-table/column or migration-required errors, and the Node child had not
  exited or restarted during observation.

Operational evidence is under
`~/.ai_home/run/aih-db-repair-20261115-9jhjiybz/entrypoint-repair/`:
`native-before-after.json`, `http-acceptance.json`, `database-acceptance.json`,
`running-acceptance.json`, the retained standard artifacts and previous plist.
An independent read-only reviewer verified standard entry point resolution,
runtime identity, hashes and both native artifact updates. Legacy diagnostic
scripts still using `app-state.db` were not used for acceptance and are not
normal startup dependencies.
