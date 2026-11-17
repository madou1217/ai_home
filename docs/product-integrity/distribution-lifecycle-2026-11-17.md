# Distribution lifecycle release — 2026-11-17

## Delivery status and evidence boundary

**Published: 1.0.4. AWS, Windows and Linux run the same release source.** AWS and Windows completed the real official-release scheduled update; Linux completed the same full release artifact through the product installer after its official online check failed due to a host network/DNS reachability problem. **Linux online update and real-browser visual acceptance remain unverified.** Do not label this delivery an unconditional three-platform online-update/visual pass.

This work implements the ordinary-user lifecycle: a complete platform installer owns runtime resources, data preparation, launcher/service activation and recovery. The update panel reports versions and accepts an explicitly confirmed immediate or future restart-to-install appointment. Users are not asked to replace executables, install Node/npm, or manipulate databases. Initial provider login is still necessary; installing a CLI does not create an account.

No test cases were added. The evidence below comes from complete packaged installations, real processes, real databases, authenticated HTTP/WebSocket requests and an AWS AGY upstream request. Synthetic scheduler results and source inspection are not substituted for official-release acceptance.

## Immutable release identity

- Version/tag: `1.0.4` / `v1.0.4`.
- Release source and tag commit: `9491e4602edc6c3f14c47e53965fae7348ee83f1`.
- GitHub release ID: `448714264`; published **2026-11-17 22:17:13 +08:00** (`14:17:13Z`).
- Published release, tag SHA, public Latest selection, five asset sizes/digests and both release workflows were rechecked at **2026-11-17 22:51:32 +08:00**.
- The five assets are the Linux installer, Windows installer, their two SHA256 sidecars and `aih-1.0.4-manifest.json`.
- Previously published `1.0.2` tag/assets were not changed. `1.0.3` was an internal candidate, not a public release.
- Release workflows `366548997` and `405519016` were temporarily disabled for publication only; no inflight runs were present, and both original `active` states were restored and rechecked.
- This report is a later documentation checkpoint, **not** a rebuild, retag or replacement of `1.0.4`.

| Full installer | Bytes | SHA256 |
| --- | ---: | --- |
| `aih-1.0.4-linux-x64.run` | 122556576 | `aa9529d735620d68a85912805a8388753a94e1c741155ff242ad8ec93bd916cf` |
| `aih-1.0.4-win32-x64.exe` | 116234752 | `3ba6a906f1e23735dd3f1a5cbc9811fd24e062ada7bfb056675a2718fd1d0cc3` |

Both packages were built from a fresh `git archive` of the exact release commit, including a full Web build and bundled runtime. Terminal repair commits `ec0da8192` and `924851765` are ancestors of that source. A blank `sourceSha` in an older installation is not accepted as traceable provenance.

## Product-owned installation and update contract

Implementation boundaries:

- `internal/runtime/distributiondata`: consistent private snapshots, offline data preparation and verification.
- `internal/runtime/distributioninstall`: bundle checks, installation lock/journal, owned-service stop/start, data publication, health/identity verification and recovery.
- `internal/runtime/distributionrelease`: fixed official repository/HTTPS source, manifest/size/digest validation and download.
- `internal/runtime/distributionupdate`: persisted read-only checks, confirmed fixed-target appointments, cancellation and busy-state deferral.
- `internal/host/distribution` and `internal/transport/http/webuidistributionapi`: composition and authenticated transport; no separate transport-owned installer.
- `web/src/components/settings/DistributionUpdatePanel.tsx`: compact version/status/actions in Server Setup, with inline confirmation rather than a large warning panel.

The configured defaults are a first background check after 30 seconds, subsequent checks every six hours, and a one-minute appointment tick. Checking may persist version hints but does not authorize installation. Scheduling freezes the server-checked release target and requires explicit confirmation. Queued/deferred appointments can be cancelled; an installer already handed off is not presented as cancellable. Busy or unobservable occupancy is not permission to kill user work.

The installer owns backup/data upgrade/service activation; neither the three-host deployment nor the Linux fallback was a binary-only replacement. The exact current source, receipt, running executable and installer transaction were checked. The implemented recovery boundary was reviewed, but this final report does not claim an exhaustive power-loss/failure-injection matrix for every final package.

## Three-host formal acceptance

| Host | Actual installation path | Data and service observations | Codex acceptance |
| --- | --- | --- | --- |
| AWS | Installed internal `1.0.3` → published `1.0.4`: official check, confirmed schedule, official download, product installer/restart; schedule `succeeded` | Exact `9491e4602` receipt/build/running hashes; transaction `complete`; SQLite integrity `ok`, FK violations `0`; accounts `22` (`agy=8`, `codex=9`, `kiro=5`); health HTTP200, ready `true` | Existing official standalone `0.169.0` recognized; product CLI exit0; WS101, initialize, model/list `12` |
| Windows | Same real official `1.0.3` candidate → published `1.0.4` chain; schedule `succeeded` | Exact source and receipt/build/running hashes; process alive; transaction `complete`; SQLite integrity `ok`, FK violations `0`; accounts `14`; health HTTP200, ready `true` | Existing official standalone `0.163.0` preserved and recognized; product CLI exit0; WS101, initialize, model/list `11` |
| Linux | Official check failed; identical verified final `.run` installed through the full product installer; exit0, transaction `complete` | Exact source and receipt/running hashes; service `active`; SQLite integrity `ok`, FK violations `0`; accounts remain `0`; health HTTP200; ready endpoint HTTP200 with **ready `false`** because no account is available | Previously missing CLI installed through the real Toolkit job; product CLI `0.169.0`; WS101, initialize, model/list `12` |

The account counts and integrity/FK checks are the verified data-preservation boundary; they are not a claim that every stored business record was individually compared. The DB contains nine AWS Codex accounts while readiness reports seven available Codex accounts; these are different measures, not two totals of the same field.

**Version-path limit:** the official online updates above began from installed internal candidate **1.0.3**, not public `1.0.2`. Do not describe these runs as real `1.0.2 → 1.0.4` acceptance.

### Future appointment, process restart and cancellation

A separate AWS private home was installed using the unmodified complete `1.0.3` product entry with `--no-service`, then its private packaged server was run on a loopback-only unused port. No formal service, credentials or appointment was reused.

Actual official check → future appointment evidence:

1. Official check HTTP200 discovered public `1.0.4` and the exact final Linux artifact.
2. `confirm=false` returned HTTP400 `explicit_confirmation_required`.
3. `confirm=true` queued appointment `IMDYOVHADY6CWVEIMPEZSV3XYI` for **2026-11-17 23:51:47 +08:00**.
4. Graceful stop exit0 and restart preserved the same queued ID and unchanged `fixedReleaseInfo`.
5. Explicit cancellation returned HTTP200 and `cancelled` for the same ID.
6. Private installed version remained `1.0.3`; final schedule was `cancelled`; final private process stopped exit0. The future install was intentionally not executed. This is graceful application-process restart persistence, not an OS reboot, a service auto-recovery check, or an appointment-expiry installation run.

The first AWS probe incorrectly called a native executable with the public `install` verb and failed before installation; retry used the product launcher and passed. Windows private future-check attempts returned 503, with the detailed retry reporting upstream HTTP403; both private processes stopped exit0 and no appointment was created. These failed probes are retained, not counted as passing Windows future-persistence acceptance.

## Legacy Codex Node hook: cause and product resolution

The warning “检测到旧 Codex Node hook，但没有可用的官方上游 CLI” must not be hidden or answered by asking a novice to replace a binary. The resolver distinguishes a usable official installation from an orphan hook, including existing standalone originals/backups, while preserving explicit overrides and failing closed on invalid/untrusted selections. A genuinely missing CLI exposes `codex_official_cli_missing` and `action=install_official_cli`, directing the user to **工具箱 → 应用管理 → Codex CLI → 安装并确认**.

Two final-package blockers were corrected in `b7aa6c669`:

- `internal/runtime/codexappserverws/process.go`: after the existing host-readiness guard, create only a nonempty explicitly selected Codex runtime home (`0700`) before launching app-server. The official CLI could previously print its version yet app-server exited because that fresh `CODEX_HOME` did not exist. No auth/config defaults are written and no recovery gate is bypassed.
- `lib/cli/services/server/autostart.js`: the generated Windows background `.cmd` now prepends `%AIH_PACKAGE_ROOT%\runtime` to PATH. A service launched without system Node/npm can therefore run the Toolkit installation with bundled runtime. Existing Linux/systemd and macOS paths already persist their bundled runtime path; they were not broadened here.

### Real missing-CLI acceptance

**Final complete Windows package, fresh private home, service enabled:**

- No prior host Codex config and no Node/npm in the parent PATH (`System32` only).
- Restarted the product-generated `.cmd` unmodified; bundled-runtime PATH was present.
- Before installation: Toolkit `installed=false`; app-server503, `codex_official_cli_missing`, actionable install intent.
- Explicit Toolkit job `app-install-c02991a8-57e3-4650-81f9-8862b887bc4e` succeeded using bundled npm.
- Product CLI `0.169.0`, WS101, initialize and model/list `12` passed; config remained absent during the recorded post-install probe rather than being auto-generated by the installer.
- Private process stopped exit0; only the private owned scheduled task was removed, exit0.
- An earlier immediate restart hit a log-file sharing conflict. Its failed evidence is separate; only the later real retry is counted as passing.

**Linux formal missing-CLI recovery:**

- Explicit Toolkit job `app-install-9482cfae-b776-43e3-b72a-0dc1178f3272` succeeded.
- Managed CLI prefix: `~/.local/share/aih-cli/codex`; product CLI `0.169.0`.
- The real probe reported `NATIVE_CONFIG_UNCHANGED True`; no account was added. This retained summary does not expose independent before/after hashes for each config/auth file, so it is not a separately reproducible per-file hash comparison.
- WS101, initialize and model/list `12` passed. With zero accounts this proves CLI/app-server availability, **not authenticated Codex inference**.

The retained Toolkit responses still report `hookInstalled=false` / `missing_events`. This closes official CLI availability and installation recovery, not acceptance of every Hook event. Existing official AWS/Windows installations were discovered without forcing a version upgrade. Windows formal intentionally remains `0.163.0`. No model/list result is expanded into proof of a model inference request.

## AWS AGY real business request

After formal `1.0.4` installation, AWS performed the actual upstream request:

- `POST /v1/chat/completions`, `X-Provider: agy`, model `gemini-2.5-flash`.
- Prompt: `Reply with only OK.`
- HTTP200; response provider header `x-aih-server-provider: agy`; content `OK`.
- Usage: prompt 6 + completion 1 = total 7 tokens; elapsed about 4.34 seconds.
- The formal read-only account observations recorded eight AGY accounts; this report does not claim per-field identity validation.

This business acceptance ran on AWS, not against nonexistent local AGY accounts. It is one observed successful upstream request, not a general all-provider/all-model guarantee.

## Remaining limitations and next acceptance gates

1. **Linux official online chain remains failed/unverified.** The separately retained `distribution-1.0.4-linux-network-boundary.log` records that at **2026-11-17 22:58:53 +08:00**, `api.github.com` resolved to `104.244.46.165` and `2a03:2880:f10a:83:face:b00c:0:25de`; the direct official HTTPS request failed with `[Errno 101] Network is unreachable`. These are network observations, not proof of a particular DNS failure mechanism. The authenticated product check was repeated at **2026-11-17 22:59:56 +08:00** (`distribution-1.0.4-linux-official-check-recheck.log`), again HTTP503 (`release request failed: context deadline exceeded`); it created no appointment. No DNS/proxy/TLS configuration was changed. Final update state records `checkError=check_failed`, with no schedule. Installing the exact full offline artifact does not turn this online failure into a pass. Do not weaken TLS, official URL/manifest validation, or rewrite the host network merely to obtain a green result; re-exercise official check/download/schedule on an actually reachable network.
2. **Real-browser visual acceptance is not complete.** The supported existing-Edge bridge/owner was unavailable. No new browser, foreground switch, AppleScript/Apple Events or parallel bridge commands were used. Source/build/API evidence cannot certify that the rendered update panel obeys the compact/no-large-Alert/no-decorative-left-bar rules. Desktop visual acceptance must use the existing single bridge, an agreed exact URL and its own page scope.
3. **Windows private future-persistence run did not pass**, owing to the upstream 403 described above. Formal immediate scheduled update passed; future/restart/cancel passed on AWS, not all three hosts independently.
4. No final-package public `1.0.2 → 1.0.4` online run, authenticated Linux inference, Codex generation request, macOS final package, or exhaustive rollback-failure matrix is claimed here.

The delivery is therefore qualified by these boundaries. The existing overall goal remains `blocked` on unavailable browser acceptance and the failing Linux official network path; it is not marked complete.

## Evidence retention, privacy and shared-work safety

Private evidence root is retained locally outside the repository:

`~/.ai_home/retained-evidence/distribution-20261117-1.0.4/`

The private retention directory and its parent are `0700`; retained files are `0600`. Result logs and release identity summaries include:

- `distribution-1.0.4-public-final-recheck.json` and `github-1.0.4-published-release.json`.
- `distribution-1.0.4-{aws,windows,linux}-final-acceptance.log`.
- `distribution-1.0.4-{aws,windows,linux}-final-recheck.log`.
- `distribution-1.0.4-windows-clean-service-retry.log`.
- `distribution-1.0.4-linux-toolkit-codex-acceptance.log` and `distribution-1.0.4-linux-network-boundary.log`; `distribution-1.0.4-linux-official-check-recheck.log`.
- `distribution-1.0.4-aws-real-future-schedule-retry.log` and the separate failed probes.
- `distribution-1.0.4-aws-agy-inference.log`.
- `distribution-1.0.4-{web-build,package}.log` and artifact verification JSON.

To obtain sufficient AWS space for the real update, exactly two **this-session, completed old** installation histories were streamed into a private local archive, verified against a 52-member content/type/mode/uid/gid source manifest and gzip CRC, then their original remote directories were removed through the scoped cleanup approval. The active journal and its latest history were independently checked and left untouched. No automatic retention/pruning policy was enabled.

Sensitive retained archive: `aws-completed-history-retained-20261117.tar.gz`, 1,911,876,422 bytes, SHA256 `4c8a4b7878a129989ddbb649abdca17e1893a0b6f17dcd95fbb550c5752aece4`. Its source manifest is retained separately. The durable retention path is a verified same-volume hard link to the original private temporary file; it avoids temporary-directory expiry without another 2 GB copy. The deleted AWS histories are retained in an **off-host archive on this Mac**. The temporary and retained paths are hard links to **one local copy**, not independent backups; no second-device or off-Mac copy is claimed. The old AWS original restore paths no longer exist: restoration would require this Mac-retained archive. Never commit, upload or expose its contents.

Only explicit owned paths were used for source/release commits `b7aa6c669` and `9491e4602`. The shared index's 35 peer-staged paths (`+168/-1294`) and other dirty work were not cleaned, reverted or included. No branch/worktree was created, no history was rewritten, and the local shared 9527 service was not restarted by this delivery. Reviewers assessed source changes and evidence boundaries; their read-only review is not itself a remote or browser execution result.
