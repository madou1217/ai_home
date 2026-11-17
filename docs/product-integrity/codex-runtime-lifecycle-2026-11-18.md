# Codex managed runtime lifecycle — 2026-11-18

## Scope and current evidence boundary

This change makes the official Codex CLI a product-managed installation with side-by-side generations. The legacy `.aih-original` remains a compatible upstream source; neither updating Codex nor updating AIH requires users to replace executables or change databases. Desktop/VSCode bundled runtimes remain independently owned. The first complete lifecycle release is **1.0.5 / a7bccdc58**; the delivery chronology below is superseded by the 1.0.6 checkpoint at the end, which distinguishes exact-package acceptance, formal online/offline delivery and remaining AWS/visual gates. This is **not an unconditional three-host acceptance claim**.

No test cases were added. Local evidence is from actual official Codex/npm downloads, actual processes and authenticated private-service HTTP calls. Initial lifecycle mutation used a task-owned private host home. Later authorized formal-host delivery is recorded separately below. Local shared 9527 was not restarted, user Codex config/auth was not edited, and parallel working files were not changed.

## Implementation contract

- `internal/runtime/codexruntime`: bounded receipt, platform/native official npm layout, cross-process OS lock, fresh generation staging, streaming hash validation, current/previous atomic publication, retained receipt recovery and offline previous selection.
- `providercli`: user override first, activated managed runtime second, internal discovery hint/legacy PATH candidates afterward. Invalid managed receipt is a typed repair condition, not permission to silently run another executable.
- `toolkit/apps`: application install/update stages npm with bundled runtime into a new prefix; the exact candidate must report a version and boot an actual isolated app-server before activation. Failed candidates do not overwrite selected files. Explicit override is not rewritten.
- `providercliupgrade`: existing policy/soak/idle/ledger owns automatic checks; the managed channel uses the same generation transaction and exact pinned version, with offline retained previous rollback. External package-manager channels retain their own channel adapters.
- `codexhooks` and Node compatibility helper: a separate CLI-owned launcher keeps managed native payloads immutable. Only CLI-owned proxy calls follow managed selection; Desktop/VSCode upstreams and lifecycle are not replaced by CLI selection or tombstones.
- Internal Node discovery uses `AIH_CODEX_DISCOVERED_BINARY`, never masquerading as a user's `AIH_CODEX_BINARY` override.
- Application uninstall deactivates the managed entry using a tombstone so legacy PATH does not resurrect the CLI; config, generations and in-use executables are retained. It is not a disk purge of rollback files.
- Go and Node legacy executable snapshot copies avoid loading hundreds of MB into a single memory buffer.

## Local actual acceptance

Private evidence root: `~/.ai_home/retained-evidence/codex-runtime-20261118/` (outside Git; private server state includes ephemeral secrets and must not be published).

- Official registry reported Codex `0.169.0`; private application install downloaded it, verified actual `--version` and app-server boot, then published a managed selection.
- A second application update created a different generation and retained the previous selection. Both payloads remained on disk.
- Actual stdio app-server `initialize` and `model/list` succeeded (9 models observed in the no-account private boot). This is protocol availability, not authenticated model generation.
- Application uninstall reported success, inventory reported not installed/installable, disabled receipt retained both existing generations; reinstall succeeded without user file manipulation.
- A privately corrupted receipt digest produced not-installed + installable repair state on a fresh inventory request. User-confirmed product reinstall succeeded and retained a `runtime-recovery-*.json` containing the old receipt.
- Interrupting this task's actual npm installation child produced a failed job; selected receipt bytes were unchanged and current official CLI continued returning `codex-cli 0.169.0`.
- Actual pinned managed updater install `0.169.0` succeeded. A genuine official npm request for `0.0.0-aih-does-not-exist` failed `ETARGET`, leaving the existing selected executable unchanged.
- With a deliberately invalid current digest and an intact real previous generation, managed rollback selected the previous generation with HTTP/HTTPS proxies pointing at unreachable loopback; old generation files remained. No network install was needed.
- Real shared Node helper with desktop-owned state returned original `codex-cli 0.167.2`; CLI-owned invocation returned managed `0.169.0`. With CLI disabled, desktop-owned `--version` remained successful while CLI-owned launch failed visibly.
- Original machine `.aih-original --version` remained `codex-cli 0.167.2` after private operations.
- Affected Go packages passed native build/vet and Linux amd64/Windows amd64 cross-build; changed JS files passed `node --check`. No automated case additions are implied by these commands.

## Independent review gates

First review withheld release for: shared helper accidentally overriding Desktop/VSCode upstream; internal discovery being misclassified as explicit override; broken current preventing independent previous validation/managed rollback dispatch. These were corrected before the release checkpoint. Focused follow-up review closed all three findings with no new Critical/Important finding in the reviewed paths. This is source review only; final immutable-package real acceptance is still required.

## Delivery gates still required

1. Focused explicit-path commit completed as `cf13ed88f`; no peer staged or uncommitted artifacts were included.
2. Full immutable 1.0.5 distribution completed from a fresh `git archive a7bccdc58`, with bundled runtime and a fresh full Web build.
3. Official release publication and authenticated complete-installer updates on AWS, Windows and Linux; no binary-only deployment.
4. Three-host process/receipt/source/hash/health/account-preservation and real Codex selection/app-server evidence.
5. Official AIH update hints/scheduled restart-to-install proof; Linux online network failures must not be hidden by offline installation.
6. Real desktop acceptance through the coordinated existing Edge single bridge only. Source/build/API evidence is not visual evidence.


## 1.0.5 immutable publication and final-artifact evidence

- GitHub release `449029094`, tag `v1.0.5`, published **2026-11-18 02:24:14 +08:00**; exact source `a7bccdc58fc74d26699789588df7af428df1ad9e`. Anonymous Latest, exact tag SHA and all five asset sizes/server digests were checked again at **02:29:56 +08:00**. Previously published 1.0.4 assets/tag were unchanged; both temporary release-workflow freezes were restored to their original active states.
- Linux installer: 122626208 bytes, SHA256 `8e2b1356e72ae73234cb4b53581b1d95c0ef209b2692685182f6708d4874a1f5`.
- Windows installer: 116289536 bytes, SHA256 `b90d1e98caec748d34f7ab3011be22cc9afbf03701e2a8bc073fb9e594e43f70`.
- The exact final installers ran successfully in task-owned private homes on AWS Linux and Windows. Installed receipt/source/build/runtime hashes matched. Application-management jobs installed the real official Codex 0.169.0 into managed generations; canonical selection, direct official `--version`, product CLI and actual WebSocket app-server initialize/model-list (12 models) succeeded. Both task-owned private processes exited 0. These are protocol results, not authenticated model-generation claims.
- The first AWS private install used `/tmp` and failed extraction with `disk quota exceeded`; `/tmp` is a quota-enabled 953 MiB tmpfs. The same unchanged artifact passed on the user-home filesystem. This failure is retained rather than counted as package acceptance.

## 1.0.5 formal Windows/Linux delivery

- Windows official check returned HTTP 503 with upstream HTTP 403; Linux official check returned HTTP 503 with a request deadline. Neither queued an appointment. These online failures remain visible and are **not** recorded as successful official online upgrades.
- After idle/authenticated account checks and full-artifact digest verification, both hosts ran the complete product installer with service/data migration/activation, not a binary swap. Their installation journals reached `phase=complete`; receipt, running executable, actual file hash, build source and runtime record all matched 1.0.5 / a7bccdc58. The immediate helper's first post-restart fetch failed transiently; independent new SSH/HTTP observations then confirmed recovery. No duplicate installer was submitted because of that fetch error.
- Windows retained 14 account rows and the same provider-count distribution; Linux retained its zero-account state. The original operational digest did not establish account identity preservation. Native Codex `config.toml`/`auth.json` hash or absence preservation was checked separately. Windows `/healthz` and `/readyz` succeeded with ready=true; Linux health succeeded and ready=false correctly reflected no configured accounts.
- Both formal application-management **update** jobs migrated the compatible legacy CLI selection to a managed 0.169.0 generation. Exact selection hashes, official/product CLI and real app-server WS101/model-list12 passed; native Codex config hashes remained unchanged. Windows' standalone `.aih-original` and Linux's older prefix were not renamed or deleted.
- Linux's first actual background scheduler cycle reported `aih_managed`, version 0.169.0 and `up_to_date`. Windows' first cycle exposed the npm command issue below; CLI availability is not a claim that its background update check passed.

## Additional Windows background npm check finding

Actual 1.0.5 service-equivalent PATH can find bundled npm.cmd, but the old background `cmd.exe /c` command manually quoted every argument. npm received literal quotes and reported `Unknown command: ""view""` to **stdout**, while the old error path recorded only stderr/exit status. This was reproduced against the actual host; direct bundled Node + npm-cli.js with identical registry/userconfig arguments returned 0.169.0. A failed check leaves historical channel/path ledger fields untouched, so the stale standalone path is not evidence of canonical managed selection reverting.

The focused follow-up shares a shell-free paired Node/npm resolver between Query, Fetch and managed install, preserves official-registry and timeout policy, fails closed for a configured missing runtime, and keeps bounded stderr -> stdout -> original-error diagnostics. Its operational crosscompiled CLI (outside Git, not a test case) actually queried the official latest and timestamp table on Windows with System32-only PATH and Linux with `/usr/bin:/bin`; both returned 0.169.0, a nonzero publish timestamp and 211 stable release entries. Candidate review, exact-source new-version packages and background first-cycle acceptance are still required. **Do not replace any published 1.0.5 asset.**

## AWS source/maintenance freeze

AWS formal package receipt still identifies released 1.0.4 / 9491e4602, but parallel sessions changed its package-local executable. The first observed 0eb71550 binary was not clean 6230ae1fd: the preserved producer tree contains that commit plus an early uncommitted composer.go. The same exact-commit reconstruction produced a93115c2; the extra file explains the difference. A later read-only observation found running 89395cda / PID709478 and a repair manifest declaring source commit 0ae8a37ae. This task did not perform either binary replacement or formal restart.

The AWS official checker can see 1.0.5 and its exact artifact, but formal installation remains frozen until parallel ownership, exact source/manifest and a non-regressing complete-package maintenance handoff are resolved. 1.0.5 does not contain the later peer/HUD/database commits; it must not overwrite those parallel fixes. Final real existing-Edge visual acceptance and an actual future due-time install for this release also remain outstanding. No test cases were added and no shared Mac service or browser was restarted.


### Focused Windows npm repair checkpoint (not a new release claim)

The read-only background registry commands and managed install commands now share a focused Node/npm resolver. Packaged execution invokes the corresponding `npm-cli.js` with raw argv, never `cmd.exe`; an explicitly selected runtime missing Node/npm fails closed. Query APIs and timeouts/official registry flags are unchanged. Failure diagnostics retain bounded stdout when npm emits no stderr. No cycle/ledger/apply gate was relaxed.

Actual cross-compiled operational commands invoked the changed public Query and Fetch functions against the official registry on Windows with System32-only PATH and Linux with `/usr/bin:/bin`; both returned Codex 0.169.0, its publish timestamp and 211 stable releases. Native package build/vet and native host CLI/server build completed without adding or running test cases. Focused independent review approved the exact three-source-file patch for an explicit-path checkpoint. This is not final-package/background-tick/1.0.6 release approval.


## 1.0.6 immutable release and formal delivery checkpoint (2026-11-18)

### Exact package, not the later shared working tree

- Source/version checkpoint: `162207bdb3b81c86c99f4391c235814c977bda8d`; npm argv fix: `2ff1d21aea917eb988bfaeb98668f5706556bdce`. A fresh immutable `git archive` plus full WebUI build and bundled Node/npm produced the complete installers. Later `2075e22f2` and parallel dirty/index changes were not folded into these bytes.
- Linux x64: 122671264 bytes, SHA256 `9f0e3fc48442607b49a73d328ce1cd69ae45b798ab9480778f6f20395eb95327`. Windows x64: 116337152 bytes, SHA256 `d4780208bd9430510219db8b24ff0b83817026ff20629b6ac420d3bd5abcaa8f`.
- Both exact final artifacts passed actual full private installation, receipt/source/server-hash agreement, official Codex 0.169.0 application installation, canonical managed selection, official/product CLI and real app-server WS101/model-list12. Each then waited for the default 300000ms background startup tick: `aih_managed`, 0.169.0, `up_to_date`, no check error. Both task-private servers stopped with exit0. No synthetic test cases were introduced.
- GitHub v1.0.6 was published at **2026-11-18 03:00:55 +08**, release ID 449067747. Anonymous Latest/tag/five-asset size/digest verification passed at 03:02:13 +08. v1.0.5 release/asset IDs, sizes and hashes were unchanged. Both temporarily disabled clobber-capable release workflows were independently restored to active, with no inflight run; the publisher does not blindly rerun after uncertain outcomes.

### Windows: actual future scheduled restart-to-install passed

- The official product `/check` returned 1.0.6 and the exact Windows artifact. One explicitly confirmed appointment `JJ5GK7B72WCUZJLGPHB2FOWTSL` was submitted at 03:03:28 +08 for **03:05:03.534 +08**, 95 seconds in the future. Returned and durable states matched ID, exact instant, timezone, confirmed flag and fixed release/artifact.
- Without a manual tick, duplicate appointment, cancellation, direct installer call or forced stop, the natural scheduler began download at **03:05:07.076 +08**, then handed off installation and reconciled the same appointment as succeeded at 03:05:53 +08. The complete installer journal was `complete`; the new receipt/build/running executable and actual hash matched 1.0.6/source162. PID changed 38808 → 48696. Health succeeded and ready=true.
- Real official/product CLI and WS101/model-list12 passed afterward. The formal service's natural provider startup tick recognized the managed CLI and returned up_to_date without the former npm.cmd quoting error.

### Linux: complete offline product installation passed; online check did not

- Official `/check` returned HTTP503 with upstream deadline exceeded, before any appointment was queued. This remains a failed online check, not evidence of online update success.
- The same published full Linux installer was verified by hash and executed once. Its own service stop, data backup/migration, service activation and post-start verification completed. No binary or database was manually substituted. The journal reached `complete`; receipt/build/runtime/actual hash matched 1.0.6/source162, PID2543143 → 2548797.
- Health succeeded; ready=false correctly remains the zero-account boundary. Official/product Codex 0.169.0 and WS101/model-list12 passed, followed by a natural managed background tick with no check error. Historical installation backups were explicitly retained.

### Account evidence correction and stronger read-only supplement

The earlier operational helpers used HTTP `[row.id, row.provider]`, but the actual API field is `accountRef`. Therefore those original digests prove only provider-count distribution, **not account identity**. They are not used as identity proof.

After installation, a separate read-only helper followed the actual `receipt.transaction` → `journal.data.backup_home` and compared the complete sorted canonical `accounts(account_ref, provider_id)` arrays from the consistent pre-migration snapshot and current database. Windows retained all 14 identities (both SHA256 `c20a2e3811505ae636124a46c6d0f206fa881418421c4aad1e157369c513a6ba`); Linux retained its empty set. Both databases passed integrity checks with zero foreign-key violations.

Additional read-only projections matched account/provider/CLI-ID/enabled rows, credential associations (without reading secret contents), profile-row existence and default-account edges. This is not a claim that every refreshable model/usage record or credential JSON stayed byte-identical. Native `~/.codex/config.toml` and `auth.json` hashes or absent-file states were separately compared and remained unchanged (Linux auth.json was absent before and after).

### AWS known drift and remaining visual boundary

The prior AWS owner explicitly released maintenance at 02:55:39 +08. Independent inventory confirmed live893, 22 canonical accountRefs, the original tmux process/start identity, 27 retired peer records and 20 read receipts, no pending peer/install work or maintenance gate, and a canonical-only `aih.db` (legacy `app-state.db` absent), integrity ok/FK0. All 15 patched source paths were already proven present in source162. Old receipt/BUILD still identify original872/source9491, so they must not be falsified as clean893 source metadata.

A focused independently reviewed single-shot complete-product installer procedure preserves and hashes the complete old patched package, candidate manifest, original receipt/BUILD/stamp, launcher/binding and service metadata before applying the exact new package. It retains all installation history, uses the product's own busy/lock/stop/activation gates, never patches a binary or old metadata, never kills/retries after timeout, and does not claim an installer failure is success. The installer completed with exit0, journal `complete`, no pending marker, and new PID726191 (previous709478). Receipt/build/runtime/actual server hash matched 1.0.6/source162. Independent post-install observations returned health200 and ready=true; all 22 canonical identities, native config states, original terminal identities, 27 retired records and 20 read receipts matched. The old 9088-file patched package remained byte-identical, old metadata was not rewritten, and a separately verified complete backup is retained at `/home/ubuntu/aih-release-1.0.6-baseline-20261117T192415Z`. This proves complete product installer delivery, not a scheduled AWS online installation. The subsequent formal Toolkit `update` job `app-install-8b37ac82-ea8e-453e-a10e-12f431d85715` succeeded, selecting managed generation `runtime-1241623451` / official Codex0.169.0. Exact selected payload hash, official/product CLI and real app-server WS101/model-list12 passed; native Codex configuration states were unchanged and the legacy `.aih-original` was not renamed or removed. The subsequent natural formal background startup tick passed: tickCount=1, managed Codex installed/latest 0.169.0, healthy/up_to_date, no check/apply error and no manual tick or restart. The retained receipt is `aws-1.0.6-natural-background-tick.json`.

The existing Edge single bridge was handed over, then an external Shalou inflight operation was observed and serially coordinated. This task created no page, did not navigate/reload user pages, steal foreground, restart/switch browsers or use Apple Events. The attached bridge rejects browser-level CDP; its installed page creation adapter calls `chrome.tabs.create({url})` without inactive creation support, so creating a page could steal focus. With no task-owned reusable page, final update-panel/Codex-card visual acceptance remains explicitly unverified. Bridge ownership was returned; API/installer evidence does not substitute for that visual gate.

A private AWS future-install helper was reviewed but **never executed**; its cleanup assertions were not approved, and no private future service was created. The actual Windows formal future appointment above supplies the future-expiry→download→installer→restart evidence instead. No claim of whole-product Node retirement is made.


## Task-owned acceptance process retirement — 04:08 to 04:09 +08

The later provider-process audit found three old acceptance instances owned by this delivery task, not additional formal installations. Fresh executable/start identity, no task/chat/install jobs, no installer pending marker and no future distribution appointment were checked before a one-shot normal stop. No process-name cleanup or forced termination was used.

- Local private Go PID64053 / port59587 accepted authenticated shutdown with HTTP202 and exited; it had no children. Formal PID84956 / port9527 retained the same start identity, executable hash and health200.
- Linux private Go2483852 + Node2483870 / port52785 exited after stopping/disabling only `com.meadeo.ai_home.af8e9f54.service`; the retained unit is inactive/disabled with MainPID0. Formal Go2548797 retained its start identity, executable hash and health200.
- Windows private Go20524 + Node4160 / port3266 exited after disabling only private logon task `com.meadeo.ai_home.8f359ec3` and one authenticated shutdown POST (HTTP202). No taskkill or forced task termination was used. Formal Go48696 retained its start identity, executable hash and health200.

This removed five task-owned processes. Packages, database homes, registration definitions and all receipts/logs remain; only private acceptance auto-starts were disabled. Review intent resolved explicitly to documented self-review for this narrow cleanup (`private-service-cleanup-review-20261118.json`); peer non-use was not treated as authorization. Independent post-observation and stop receipts live outside Git in the evidence root above.

OpenCode, live Codex/TUI/MCP processes, shared Edge and all AWS AGY processes were left untouched in this audit. Exact attribution, counts and remaining optimization proposals are recorded in `provider-process-audit-2026-11-18.md`. This operational cleanup is not implementation or acceptance of a cross-terminal pool, and it does not close the outstanding visual acceptance gate.
