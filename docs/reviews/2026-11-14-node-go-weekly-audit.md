# Node → Go weekly migration review — 2026-11-14

Status: **in progress; not a completion certificate or production release**.

## Objective and evidence rules

Review the last week of migration against the Node behavioral contracts, repair missing details, and complete the remaining runtime migration with measured performance/resource behavior. Go HTTP ownership, successful compilation, cross-compilation, and an isolated run are different evidence levels. No new test cases were added; verification uses actual commands, processes, HTTP endpoints and SQLite state. No production credentials, account settings, hooks or services were changed by this review.

Window: 2026-11-07 21:19 +08 through 2026-11-14. Starting historical baseline `80ac14148`; initial audit tip `6ea0697f0` (622 commits in window). Concurrent main commits continue to land: the audit is not a claim that every later commit has been reviewed. Existing dirty/untracked work, including inference service-tier, routing/auth/frontdoor and server-lifecycle changes, remains owned by its other sessions.

## Reviewed areas and actionable findings

| Area | Source evidence / contract | Status |
| --- | --- | --- |
| Model discovery authentication | `responses/model_catalog.go` collapsed HTTP401 into catalog unavailable; coordinator retried all failures. Current official static-key account returned real `401 invalid_api_key`, not an OAuth expiration diagnosis. | Fixed in working tree; static-key failure/recovery verified against real local gateway in an isolated Go instance. Official network later timed out. |
| Credential recovery concurrency | `accountcredentials` singleflight/CAS already exists; rejected credential generation must be checked both before and inside refresh, including shared-flight errors. | Version-aware recovery introduced; concurrent OAuth/re-key behavior requires further real verification. |
| Probe observations | Model replacement had credential CAS, probe writes did not. An old rejection could overwrite new-credential facts. | Probe record carries optional credential version; atomic SQL guard added without schema change. Zero-version pre-read failures remain an explicit exception. |
| Model re-key propagation | Account recovery decorator checked the old ref even when the application had committed a re-key. | Explicit refresh snapshot port carries actual ref; legacy/manual paths retain strict identity checks; coordinator carries ref through retry budget. Real re-key not exercised. |
| Native event tail | `cdb2528d5` / `driver_native.go`: main loop handles result content/thinking; separate exit drain did not. Node event bridge uses one mapper. | One event-consumption loop now drains through channel closure before completion; a received Done disables late cancellation during tail drain. Compiled/source reviewed; no paid CLI turn generated. Existing producer-send cancellation cleanup still needs separate work. |
| Claude successful result | `c6936fcf5`: stream-json stdin remains open and successful result does not finish process; Node tracks steer/result and performs controlled shutdown. | Open P1; needs bounded terminal state machine preserving queued steer. |
| Codex RPC recovery | Sole RPC read loop synchronously calls overflow recovery, which requests `thread/read` and waits on the same reader. Background contexts bypass default timeout. | Open P1; needs ordered bounded dispatch and request deadlines, not goroutine-per-message. |
| Codex resource release | `ReleaseThread` merely unbinds; zero-reference pool entries stay retained. Node sends unsubscribe/awaits closed and releases last idle lease. | Open; needs protocol release confirmation and bounded idle lifecycle. No RSS leak magnitude claimed. |
| Hook installers | `58be7d89c`, `c8014265b`: provider-hooks writes native sender; toolkit installer still wrote Node sender. | Shared native command builder; real isolated install/replace/uninstall and sender delivery verified. Windows generated/configured and cross-built, not Windows execution. |
| Shutdown | `c7bc1c973`: remote-backup worker's ctx cancellation calls `Stop`, waiting on a WaitGroup containing itself. | Reproduced with actual isolated server and goroutine stacks; non-waiting worker stop plus externally awaited shutdown implemented. Race-instrumented full server exited 0 after real concurrent requests. |
| CLI and service lifecycle | package launcher, root CLI update/shell/server routes, Node daemon detached startup remain. | Open; another concurrent session is editing daemon startup. Do not overwrite it. |
| WebUI open CLI | Go HTTP handler still spawns `node bin/ai-home.js` in `webuiopenappapi/cli_launcher.go`. | Open; direct Go CLI startup must preserve account/env/cwd/session semantics. |
| Desktop translation | `/system` and `/focus` explicitly fall back to Node; local process chain confirms Node owns translation helper. | Open; Go translation endpoint != complete desktop feature migration. |
| Windows restart | Task-scheduler autostart exists; native restart adapter only handles launchctl/systemctl. | Open; HTTP202 is not evidence of process replacement. |
| Plugins / Codex hook proxy | Go supervisor still starts JS plugin host and Node stdio proxy helper. | Runtime dependency remains; preserving plugin compatibility and replacing execution are separate requirements. |
| Route inventory | Generated ownership shows 61 Go / 4 Node / 0 exemptions, but health/management ownership is stale and translation residuals are not separate entries. | Inventory is not a completion metric; full entry → handler → executor audit remains necessary. |

## Actual verification evidence

### Compilation / structural checks

- `go build ./...`: passed on multiple current working-tree snapshots.
- `go run ./cmd/route-ownership-manifest --check`: passed; only proves generated artifact consistency, not semantic/runtime completeness.
- Focused TypeScript `tsc --noEmit` on account client/error modules: passed.
- Focused `go vet` across all changed Go modules: passed.
- `git diff --check`: passed on examined working tree.
- No new test files, no unit/mock suites, no production restart/deploy.

### Authentication: real upstream and before/after

Production database read-only observation: the currently failing Codex account uses API Key auth. One real official `/v1/models` GET returned HTTP401 with allowlisted `invalid_api_key`; raw error text/key was not logged. Another gateway account's stored successful directory contained 224 models. A separate gateway transport returned 403; it must not be conflated with the official invalid-key finding.

The later official-network verification failed at transport timeout. To exercise the actual application path without mock servers, isolated Go servers used the existing local AIH gateway's real `/v1/models` endpoint:

- Old on-disk server build (build metadata `e800dacddc82+dirty`): **4 distinct 401 probe writes in 10 seconds**.
- New build: first background failure records `authentication_rejected`, observer **attempts=1**, no retry probe within 6 seconds.
- Manual refresh: **HTTP422 / model_authentication_rejected**.
- Wrong Management Key: **HTTP401**, preserving management-session semantics.
- Rotation of the temporary isolated account only, using the existing local gateway client key: **HTTP200, 224 models, error cleared, enabled=1**.
- Copied gateway key was removed from the isolated DB with secure deletion/WAL truncation after shutdown. No production key rotation.
- Actual frontend `BrowserServerTransport → AccountManagementClient → formatAccountManagementError` over HTTP returns the fixed account-credential message for 422, and Management Key message for 401. Unknown upstream messages/codes are still not exposed.

Local, non-portable artifacts (do not commit raw runtime databases):

- `/var/folders/nj/0mx5gymd41x8f64xcfm635440000gn/T/aih-before-catalog-20261114-no83vo9e`
- `/var/folders/nj/0mx5gymd41x8f64xcfm635440000gn/T/aih-live-gateway-catalog-20261114-9ar_rzbg`
- `/var/folders/nj/0mx5gymd41x8f64xcfm635440000gn/T/aih-live-client-20261114-lx9pfdgm/client-results.jsonl`

This proves static-key authentication failure stops the current retry generation and later recovery is allowed. It does not prove real expired OAuth refresh, high-contention CAS/re-key, browser rendering, or production adoption.

### Hook migration

Artifacts: `/tmp/aih-s1-hooks-NYArvu`.

Both real installation entrypoints produced the same native sender, including when called by a non-server host. Same-directory/PATH resolution and explicit path containing spaces/quotes were exercised. Actual command execution with no Node PATH returned exit 0 / `{}` / no stderr and the real receiver persisted `s1-resolver-followup`. Repeat uninstall reported unchanged; user hook/gateway configuration preserved. Default dependency absence remains explicit rather than falling back to Node. No user hook file was modified.

### Shutdown reproduction

Artifacts: `/private/tmp/aih-shutdown-review-20261114-ery27x9w/{observations.json,server.log}`. Isolated server still alive 15 seconds after SIGTERM. SIGQUIT stack showed main in `HousekeepingDaemons.Close → Scheduler.Stop → wg.Wait` and the scheduler's counted worker in `Start.func2 → Stop → wg.Wait` on the same WaitGroup. Only this isolated PID was signaled. Earlier isolated verification processes needed forced termination; that is a failure, not successful shutdown evidence.

The scheduler repair was additionally exercised without race instrumentation: a zero-account full server exited 0 in 2.505 ms, and an invalid-key full server (actual local gateway 401; management refresh 422) exited 0 in 12.511 ms. Neither needed SIGQUIT/KILL. Evidence: `/private/tmp/aih-remotebackup-stop-20261114-4kjq90tm/runtime-verification.json`. No actual SFTP transfer was in flight, so in-flight transfer shutdown is not yet verified.

### Race-instrumented real concurrent requests

`go build -race -o /tmp/aih-review-20261114-server-race ./cmd/aih-server`, then a new empty HOME/data root and the real local gateway upstream. Eight manual catalog refreshes (four concurrent workers) all returned `422/model_authentication_rejected`; no race-detector warning was emitted on that exercised path. SIGTERM exited **0 in 1.016 seconds**, including the race runtime exit delay. Observed RSS was 93,952 KiB with race instrumentation; this is not a production memory baseline or optimality claim. Evidence: `/var/folders/nj/0mx5gymd41x8f64xcfm635440000gn/T/aih-live-race-catalog-20261114-zhgdjyoc/observations.json`.

## Local checkpoints (not pushed or deployed by this session)

- `7ec08ba3d` — model authentication recovery, typed rejection, generation guards, re-key propagation, safe UI business code.
- `46fd3f956` — single native event drain on normal exit.
- `8d442a83a` — shared native Hook sender command across both installers.
- `76373d794` — remote-backup shutdown self-wait repair.

Each commit used exact file pathspecs with staged scope checked before, and `git show --stat` after. Concurrent work was not staged. Reviewers checked the credential-generation/identity/error boundaries, Hook installation, and event-drain control flow; remaining runtime gaps above are not waived by review.

## Next completion gates

1. Finish and re-verify current bounded repairs, including independent review; record a narrow checkpoint, never stage concurrent work.
2. Fix RPC reader/recovery deadlock, Claude result/steer terminal semantics, and thread-release/pool lifecycle with actual CLI/protocol evidence (no paid prompts without appropriate authorization).
3. Inventory every supported provider's auth/import/refresh/catalog/routing/inference/stream/cancel/usage/error/cooldown/export path against Node. This review covered selected high-risk slices, not that full matrix.
4. Remove actual Node runtime ownership across CLI, service lifecycle, open-app, translation, plugin/hook execution and packaging. Preserve official client behavior; third-party CLI requiring Node is not the same as AIH itself retaining Node orchestration.
5. Measure real memory/CPU/latency/backpressure and idle cleanup on representative runs. Removing redundant loops and futile requests is source-level improvement, not proof of optimal memory use.
6. Verify supported OS behavior and actual desktop pages through supported background Edge access; no AppleScript. Keep compile, isolated runtime, production release and visual acceptance claims separate.

Goal remains active. Full migration and performance completion are not established.
