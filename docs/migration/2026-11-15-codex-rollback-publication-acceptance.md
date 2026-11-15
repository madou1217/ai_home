# W3 recorded rollback publication and exact Windows crash points — 2026-11-15

## Requirement and root cause

This continues W3 recovery, not a new task or a replacement for W0–W6. The remaining finding in `2026-11-15-codex-default-reentry-acceptance.md` was that rolling back an existing after-image called `publishFile`, which used a random temporary not related to the journal. Windows `Exchange` moves the current target aside before moving the restored file into place. A crash between those moves left the target absent and the rollback backup unlocatable by the next invocation.

## Focused implementation

- Remove that anonymous rollback writer from `files.go`; `rollbackFiles` calls `publishRollback(change, current)`.
- Derive rollback paths exclusively from the validated journal stage: `Staged + ".rollback"` and its `".displaced"`. Existing version-2 journals need no rewrite.
- Write/sync a complete preimage into a private scratch file, then publish its fixed recovery name **no-replace** before touching the target. An incomplete scratch write cannot become a valid recovery witness.
- For an existing expected after-image, use the platform exchange and retain the displaced image through journal cleanup. For a missing target, restore no-replace **only** when either original-publication or rollback-publication before/after witnesses match.
- Validate and clean four path-specific candidates, not arbitrary files matching a wildcard. Unix exchange and Windows two-step exchange have different valid candidate roles. Unexpected contents, mode/ACL changes, symlinks, or concurrent native replacements fail closed/preserve evidence.
- Auth rollback remains private `0600`/restricted DACL; config retains its original mode. No database schema, shared fileexchange implementation, HTTP routing, or Desktop effects change.

Files: `internal/host/codexdefault/{files.go,publication.go,staging.go,recovery_stages.go,rollback_publication.go}`.

## Actual macOS CLI acceptance

The complete production CLI was built and run against a restricted live-DB backup and isolated HOME. It generated a real journal during an actual account-default switch. As in the preceding acceptance, the same real auth data was merely reformatted and made `0644` inside the private HOME, without changing token contents. The controller observed actual publication, SIGSTOP/SIGKILLed that one CLI, then SIGSTOP/SIGKILLed its retry after private auth rollback with journal still present.

Result: both crash points captured; old full CLI returned `codex_host_recovery_external_edit`; new full CLI returned 0, retired journal/stages, and left auth `0600`. The private backup/HOME and processes were removed. This exercised the new deterministic rollback path with actual production functions, not copied-function fixtures.

- Binary SHA-256: `876b0b5a1e53ac564aa5a1e7368c5c9e42969e5b8fb73ff508d97e31e3739dc6`.
- Operator result: `/tmp/aih-w3-rollback-macos-result-20261115.json` (ephemeral).

## Actual Windows CLI acceptance — precise instruction windows

Used the previously authorized Windows host through its existing SSH channel. Created **only** a fresh `aih-w3-rollback-*` directory under that account's TEMP, with isolated AIH_HOME/HOME, an empty isolated single DB, and local-only gateway configuration. No real account token or original host config was copied or changed. No existing task/service was restarted.

The machine has debugger support DLLs but no installed `cdb`/WinDbg executable. The operator therefore used Windows' native debugger API to **launch only the explicitly named temporary CLI** under `DEBUG_ONLY_THIS_PROCESS`. From the exact binary's Go symbol/disassembly information it set one private in-memory INT3, then terminated that child when the real instruction was reached. Disk binaries, production Go code, and journal contents were not modified. The control script is a debugger/operator, not a fixture generator or alternate implementation.

Breakpoints in the exercised x64 artifact:
- RVA `0x5edbd5`: the real `fileexchange.Exchange` instruction after the first successful `MoveAside`, before the second one.
- RVA `0x5fe5f8`: the actual default transaction just before DB `Commit`, after native publication.

| Actual operation | Observed exact state | Result |
|---|---|---|
| Initial default publication terminated between two moves | target absent; forward stage equals journal after-image; forward displaced equals journal before-image | next full CLI exit0; journal gone; stageCount0 |
| Native publication terminated immediately before DB commit | target present; original preimage retained at forward displaced; journal v2 present | supplies an actual pending rollback, not fabricated state |
| Retry terminated between **rollback's** two moves | target absent; rollback stage equals journal before-image; rollback displaced equals journal after-image | precise formerly unhandled window captured |
| Old full CLI retries that same journal | target and both rollback witnesses retained | exit1, `codex_host_recovery_external_edit` |
| New full CLI retries that same unchanged journal | no-replace restoration, then requested default completes | exit0; journal gone; stageCount0 |
| Repeat actual rollback gap, then independently edit native config | target now contains independent valid TOML; original witnesses/journal remain | new CLI exit1; external config hash unchanged; journal retained |

The error from the first old-CLI invocation was caught as PowerShell NativeCommandError because that shell had `ErrorActionPreference=Stop`. The operator changed only its error capture to Continue and repeated the old invocation: exit1 and the expected low-sensitivity error were recorded; the pending journal was still unchanged. This is not a product repair or fabricated response.

- Exact Windows binary SHA-256: `2954fa098799279697cac03b04316d716a998a334744070e9a358ff1b689c76f`; remote Get-FileHash matched before execution/cleanup.
- Interrupted child PIDs in order: initial10468; precommit8828; rollback1416; later external-edit sequence precommit2332/rollback5824. All debugger-owned processes exited; none was an existing service.
- Ephemeral records: `/tmp/aih-w3-windows-initial-gap-20261115.json`, `/tmp/aih-w3-windows-rollback-operations-20261115.jsonl`, `/tmp/aih-w3-windows-rollback-cleanup-20261115.jsonl`.

Remote cleanup checked the exact TEMP-prefix scope and binary hash, found no remaining private executable PIDs, and removed only this operation's directory (including its deliberately preserved external-edit state). The existing scheduled task reported state `3` before and after, with no task mutation. This numeric observation is not a claim that the shared task was running. Shared local 9527 remained ready throughout read-only checks.

## Build and operator commands

```sh
go build -o /tmp/aih-w3-rollback-cli-20261115 ./cmd/aih
GOOS=windows GOARCH=amd64 go build -o /tmp/aih-w3-rollback-cli-20261115.exe ./cmd/aih
python3 /tmp/aih-w3-rollback-macos-live-20261115.py
go build ./...
go vet ./internal/host/codexdefault ./internal/runtime/fileexchange
```

Windows operator modes were run in order: `initial-gap`, `recover`, `before-commit`, `rollback-gap`, `old-recover`, `recover`; then `before-commit`, `rollback-gap`, `external-edit`. Each invokes the complete CLI. No test cases, mock upstreams, fake journals, production hooks, or instrumentation branches were added to the repository.

## Review resolution / scoped commit bypass

The original reviewer was resumed with the five-file patch, but it again terminated with tool-protocol HTTP400 (`No tool call found for function call output`). Read-only review requests were also delivered through the existing peer mechanism to the recovery coordinator and an existing native Claude peer; both messages were read but no review verdict had been returned by this checkpoint. Delivery/read state is **not** a running review or approval.

No native review tool was discoverable. Per AGENTS' capability chain, this checkpoint explicitly falls back to **self_review**, supported by the actual Windows exact-window/independent-edit operations and macOS full-CLI re-entry above. This is a documented bypass for the narrowly scoped commit, not permission to restart/deploy shared services or perform destructive Git/database operations. Independent final review remains outstanding; any later concrete finding must be handled as a follow-up, not hidden by the current green operations.

Self-review checked the five crash states (before recovery-stage publication, after it, after Windows first move, after second move, cleanup re-entry), validated old version-2 compatibility and role-specific before/after matching, traced no-replace restoration plus after-image inode checks, and confirmed unexpected displaced files are retained rather than unlinked. `go build ./...`, focused `go vet`, and scoped staged `git diff --check` passed. Residual anonymous *preparation* scratch files can remain on process kill without changing target, as disclosed below; they are not accepted as recovery authority.

## Limits and remaining gates

Process-kill acceptance is not power-loss durability proof. Scratch preparation interrupted before fixed-name publication can leave an unreferenced private scratch file; it never removes the target, and this checkpoint does not introduce unsafe wildcard deletion. External modifications intentionally keep the journal for reconciliation. OAuth rotation, Desktop/Edge business acceptance, all W0–W6 requirements, and shared-runtime publication remain independent. No shared gateway restart or deployment occurred.
