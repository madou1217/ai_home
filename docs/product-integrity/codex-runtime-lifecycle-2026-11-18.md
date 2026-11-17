# Codex managed runtime lifecycle — 2026-11-18

## Scope and current evidence boundary

This change makes the official Codex CLI a product-managed installation with side-by-side generations. The legacy `.aih-original` remains a compatible upstream source; neither updating Codex nor updating AIH requires users to replace executables or change databases. Desktop/VSCode bundled runtimes remain independently owned. This document is a work-in-progress implementation record, **not a release or three-host acceptance claim**.

No test cases were added. Local evidence is from actual official Codex/npm downloads, actual processes and authenticated private-service HTTP calls. All mutation used a task-owned private host home, never local shared 9527, user Codex config/auth or parallel working files.

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

1. Focused explicit-path commit, including no peer staged or uncommitted artifacts.
2. Full immutable versioned distribution with bundled runtime and fresh web build.
3. Official release publication and authenticated complete-installer updates on AWS, Windows and Linux; no binary-only deployment.
4. Three-host process/receipt/source/hash/health/account-preservation and real Codex selection/app-server evidence.
5. Official AIH update hints/scheduled restart-to-install proof; Linux online network failures must not be hidden by offline installation.
6. Real desktop acceptance through the coordinated existing Edge single bridge only. Source/build/API evidence is not visual evidence.
