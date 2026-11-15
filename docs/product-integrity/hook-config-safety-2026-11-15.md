# G01 native Hook configuration integrity — 2026-11-15

Continues the original M0–M5 plan. G02 managed state is the separate `711ddcdba` checkpoint. This package fixes explicit hook installation/uninstallation, not all native configuration writes or whole-product completion.

## Real defect

Actual `apps.Manager.InstallAppHooks` under an isolated HOME replaced `{broken USER_DATA` with a fresh Claude hooks document and returned success. OpenCode installation overwrote an unrelated same-name plugin; uninstall deleted it. Both symptoms occurred without mocks, real credentials or production configuration access.

Tracing adjacent entries found the independent Go `/provider-hooks/install` handler and legacy Node installers also contained separate unsafe file writers. They now delegate to the same Go installation port rather than retaining a second bypass.

## Implementation

- Strict JSON object decoding retains number tokens and rejects malformed/blank/null/array/duplicate-key/invalid Unicode documents. Non-map hooks or non-array event containers are explicit conflicts, not disposable data.
- `configsnapshot` provides bounded read, cooperative OS lock, canonical symlink path, inode/content/mode comparison, staged synced publication and a durable publication marker. Existing files use the shared file-exchange primitive so a late external edit is retained at the displaced path, not silently destroyed. Uncertain state blocks another write and reports recovery required.
- Repeated install compares semantic content and leaves unchanged bytes/inode/mode alone. Existing JSON symlinks remain links; permissions remain intact. User hooks, unrelated empty groups and unknown metadata survive removal.
- OpenCode files require an intact generated-content digest or an exact known legacy template. A marker substring alone is not ownership. Foreign/modified plugins and leaf symlinks are refused. Exact old Node template upgrades to the current managed representation.
- Hook command ownership requires the actual sender executable/explicit trusted path plus exact argv shape. Legacy Node sender shapes remain recognized. An `echo` command containing even the full AIH marker/argument sequence is preserved.
- Codex features use the existing `codexpreferences` writer lock and guarded replacement, not a second TOML writer. Parse/type/read failures are explicit in diagnosis; failure does not mean enabled/not installed.
- Shared `InstallProviderHooks`/`UninstallProviderHooks` preserve explicit events, hook name, timeout and dry-run options. The toolkit manager, authenticated/confirmed standalone HTTP installer and Node compatibility adapter all call this boundary. Node missing binary fails visibly, never falls back to the unsafe writer. Started-child failures return unknown outcome, not `changed:false`.
- Large `hooks.go` was split by responsibility into operation, document/ownership and Codex feature adapters; no changes to upstream native clients.

## Real acceptance

Records and hashes: `hook-config-safety-2026-11-15/manifest.json`.

- Bad JSON and unsafe shapes rejected with original bytes retained; no fabricated successful installation.
- Normal Claude install→repeat→uninstall succeeds. Repeat does not rewrite; mode0640, large integer 9007199254740993, user command and empty group retained.
- Existing config symlink retained; OpenCode foreign or user-modified content/symlink refused; exact owned uninstall succeeds.
- Actual legacy Node command and plugin template remain removable/upgradable without accepting arbitrary marker-bearing user commands.
- Custom AGY event list, timeout13, custom hook name and unknown scalar/array metadata survive the supported lifecycle.
- Concrete on-disk journal states before/after replace and before/after delete recover on retry. A mismatched displaced preimage remains preserved with pending recovery. These are real filesystem-state experiments, not a claim of power-loss durability on every OS.
- Real Codex binary version probe plus isolated native files: hooks feature false→true preserves other TOML content; malformed TOML leaves both config and hooks unchanged.
- Real loopback HTTP handler: missing confirmation400; dry-run corrupt400; confirmed corrupt400, all preserve data; confirmed valid200 preserves user fields. No shared gateway used/restarted.
- Node legacy API→actual Go CLI: bad config refusal, normal/duplicate/remove, dry-run with absent HOME creates nothing. Real failed/empty-output child processes are reported as unknown; missing executable is definite unavailability.

Go CLI/server/package builds, modified Node syntax checks and windows/amd64 cross-build pass. Rawls performed independent source review; reported deletion recovery, diagnostic Verified, sender ownership and subprocess-outcome issues were fixed and revalidated. No tests were added.

## Remaining / deliberately not claimed

- Windows publication is compiled/source-reviewed, not run on a Windows terminal/filesystem. True power loss, platform ACL preservation and malicious/non-cooperative filesystem replacement races are not fully proven.
- Hook JSON and Codex TOML are separate guarded files, not a cross-file atomic transaction. Partial progress is reported; no automatic native app restart is introduced.
- Late external edits are preserved and stop further writes; an administrator still must reconcile ambiguous transaction evidence instead of an automatic rollback overwriting the external edit.
- `toolkit/apps/open.go` desktop gateway preparation still has a separate shared empty-read/write path. It is explicitly deferred to the next work package, not included in G01 completion claims.
- Legacy internal pure-format helpers remain for compatibility; public install entries have moved to the shared boundary. Full native event delivery/inference and graphical WebUI/desktop acceptance are separate gates.
- No standard CLI/server deployment/restart or modifications to real user rc, native auth, account DB or upstream clients. Node bridge requires the matching rebuilt Go CLI at release; no silent fallback masks an old binary.
