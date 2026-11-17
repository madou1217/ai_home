# Codex managed runtime lifecycle implementation plan

> Approved scope: the user's request to close the reviewed `codex.aih-original` lifecycle improvements and update AWS, Windows and Linux using complete distributions.

**Goal:** ordinary users install/use/update Codex without managing backup filenames, runtimes or databases, while preserving existing sessions, configuration and rollback material.

**Architecture:** a focused Codex runtime module owns side-by-side generations and an atomic current/previous receipt outside AIH release directories. Canonical CLI/app-server discovery, application management and the existing provider updater share that selection. Legacy hook snapshots remain compatible inputs, not files to rename/delete blindly. Existing distribution update scheduling remains the AIH restart-to-install owner.

**Constraints:** shared main; no new branch/worktree; preserve all peer changes and staged paths; explicit-path commits with before/after index review; no new test cases; real CLI/process/installer acceptance only; no browser commands without a coordinated supported existing-Edge bridge; do not restart local shared 9527. Credentials and private evidence stay outside Git.

## 1. Managed runtime and safe selection
- Add `internal/runtime/codexruntime/`: host-local root, side-by-side generation transaction, bounded/validated receipt, cross-platform lock and atomic replacement, native official npm payload discovery.
- Prefer an activated managed generation after an explicit user override, before PATH; retain unactivated legacy install discovery and safe `.aih-original` traversal. Never silently bypass corrupt/unsafe explicit selections.
- Keep existing legacy snapshots; make executable snapshot copies streaming and atomic.
- Verify by building all affected packages and invoking actual installed official Codex versions in private homes. No synthetic executable success.

## 2. Install/update integrations
- Application lifecycle jobs install npm into a fresh managed generation, verify the exact candidate with real version plus app-server boot, and activate only after success. Existing current/previous generations survive failed installation or verification.
- Existing provider auto-update resolves the same CLI, recognizes managed ownership, and performs pinned installs/rollback through the same generation transaction instead of global npm or a second resolver.
- Expose compact usable/error status and one-click recovery through existing application UI; keep hook/security details in diagnostics.
- Verify existing CLI execution, legacy fallback, current selection after successful install, and unchanged selection after a genuine invalid-version install failure.

## 3. Complete release and three-host delivery
- Independent review/self-review of exact changes; build native affected packages and cross-compile Linux/Windows.
- Explicit-path focused commits, then prepare a uniquely versioned complete distribution from an immutable committed archive, full web build and bundled Node/npm. Do not package peer uncommitted source.
- Confirm all remote host identities, release/receipt/process state, accounts and maintenance occupancy via authenticated read-only probes; no AGY local-account assumptions.
- Publish immutable full release assets; use product update check/scheduling/installer on AWS, Windows and Linux. Network errors must remain visible; only verified complete artifact fallback is allowed, never manual binary swaps.
- Verify actual executable identity, receipt/source hash, complete installer transaction, health/readiness (distinguish Linux's missing accounts), canonical Codex selection/version/app-server and accounts preserved on each host.
- Recheck official update hints and scheduled restart-to-install; real desktop acceptance only through coordinated existing Edge. Record unresolved gates honestly; do not mark complete until required evidence exists.
