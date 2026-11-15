# W1 native exec-resume tier intent — 2026-11-15

## Original requirement and production boundary

This continues the original W0–W6 plan's requirement that current speed intent and explicit overrides survive native resume, not just HTTP/WS first frames. Earlier checkpoints demonstrated that installed Codex0.167.2 ignores root/-c/profile tier changes when raw `exec resume` restores a historical fast thread. The official typed `thread/resume` + `thread/settings/update` + `thread/unsubscribe` path was verified first with an actual temporary thread; this checkpoint connects that path to **Go CLI launch and the existing Node default launcher**.

No vendor rollout or SQLite is edited directly. The user-selected thread setting is changed via the official API immediately before the requested native resume. This is a deliberate persisted native setting update, not a temporary response rewrite and not a global account/gateway mutation.

## Implementation responsibilities

- `internal/runtime/codexexecintent`: recognize exec/e resume; resolve current CODEX_HOME/cwd/config and the selected profile's root tier; exact UUID/name lookup or provider/cwd-scoped `--last`; reject ambiguity/unknown options before mutation; retain an OS lease; perform official tier update and unsubscribe; pin the foreground argv to the resolved UUID.
- `internal/runtime/codexlaunchrpc`: bounded serial control connection, existing whole-process-group owner, private stderr/config handling, 8MiB line cap and15-second caller budget. No generated turns, model output, or raw upstream errors are fabricated/logged.
- `internal/runtime/providercli`: optional preparation callback invoked after final environment/account projection, held through foreground exit. Other providers and non-resume commands retain their existing path.
- `internal/host/aihcli`: composes this callback. Real terminal checks now require both descriptors to be actual terminals; piped stdin uses ordinary exec, not PTY.
- `internal/host/codexexecpreflight` and `cmd/aih-server/exec_intent.go`: private Node bridge accepts command/argv on stdin, holds the lease until owner EOF/exit, monitors parent lifetime, emits one bounded reply. No shared server startup.
- `lib/server/codex-exec-intent.js`: native capability check, private-pipe request, Windows native/npm-node launcher resolution, helper lifetime and lease-loss notification.
- `lib/server/codex-default-cli-launcher.js`: narrow exec-resume call site only; foreground is stopped and reports exit1 if its lease helper unexpectedly dies. Unrelated default/TUI launch behavior is retained.

Canonical direction remains caller intent → exact native thread selection → official setting update → native CLI → ordinary gateway/provider transport. No `priority` completion response is manufactured.

## Input, selection and concurrency rules

- Supports `-c/--config`, attached short values, profile, explicit model, cwd, UUID/name and `--last` selection without scanning prompt text as commands. Literal `--` preserves prompt-boundary semantics; standalone `-` remains the native stdin sentinel.
- The native app-server owns effective base/project/-c parsing. It does not accept native `-p`; this focused adapter reads the current `<CODEX_HOME>/<profile>.config.toml` root service-tier scalar with the existing validated TOML scanner, stable file identity/size/mtime checks and4MiB bound, then places it before explicit `-c` options. It does not project or rewrite unrelated profile settings.
- UUID lookup reads metadata only; name matching is exact and rejects duplicates. `--last` uses bounded native paging, current provider and cwd unless `--all`, then replaces `--last` with the exact UUID before launch. Cursor repetition/limits are explicit failures.
- Lease inode lives beside the canonical shared sessions directory, so account projections sharing sessions contend for the same thread. It is never deleted/replaced as a lock-release technique. The lease covers native control and foreground execution; failure cleanup closes/waits for the old native owner before releasing it.
- Metadata and latest persisted-turn state are checked after the lease. Active-turn observations reject. This is protection for cooperating AIH launches plus observed native state, **not a claim of absolute exclusion against an unrelated native process racing after inspection**.
- Unsupported/unknown option shapes, profile syntax errors, capability errors, provider mismatch and release errors fail visibly before foreground execution. Explicit remote/OSS paths remain native. `--ignore-user-config` without profile/explicit tier remains native rather than inventing an override.

## Actual validation, not test cases

All runs used the real installed native0.167.2, complete Go CLI/server, restricted database backups/isolated CODEX_HOME/cwd, and short `OK` prompts against the approved actual account through a transparent relay. Existing user threads and host files were never used as mutation targets. No mock server, fake rollout/journal, repository test file or production test hook was created.

### Successful and rejected business operations

| Operation | Actual result |
|---|---|
| Native fast baseline → AIH fast off → Go `codex -- exec resume <UUID>` | exit0, same thread, `OK`, outgoing default form (tier omitted), upstream final default |
| Same thread, fast profile | exit0, outgoing priority |
| Fast profile plus explicit `-c service_tier="default"` | exit0, default form; explicit wins |
| `exec resume --last` | exit0, same selected thread pinned; default form |
| Exact name set via official `thread/name/set`, then Go resume by name | exit0, same thread, default form |
| Nonexistent exact name | exit1 `codex_exec_thread_not_found`; no upstream frame |
| Unrecognized native option | exit1 `codex_exec_intent_option_unrecognized`; no upstream frame |
| Production Node preflight → actual native exec resume | exit0, same thread/default; helper exits after close |
| Existing production default launcher in a separate Node process, with its existing managed-launch/account boundary | exit0, same thread/default; stdout JSON preserved |
| A second Node preflight while first holds the lease | explicit `codex_exec_thread_busy`, no second foreground admitted |
| Go stdin prompt `exec resume <UUID> --json -` | after true-terminal fix: exit0, same thread/OK/default; stdin EOF preserved |

The five-generation matrix had exactly5 new usage rows; Node three-generation journey3 rows; named journey3 rows; stdin journey2 rows. Native prewarm/control resume can emit `generate:false` frames, which are not extra generated turns. All actual generation completions reported upstream final default, even when priority was requested. Request intent is not priority entitlement or a price claim.

Two initial validation setups used a thread created under `aih_live` but a launch forced `aih_server` (and later a cloned native-account default). Official resume correctly rejected provider mismatch with -32600 before another upstream frame. The operator aligned its own temporary initial provider/managed-launch state; production ownership was not weakened to make the check pass.

### Review-discovered failures and actual closure

Independent reviewer Hubble resumed successfully (no tool400 this time) and found:
1. Failure defer released lease before closing control owner. Fixed: close/wait first, then unlock.
2. Post-ready helper death was ignored. Fixed: explicit lost notification; launcher terminates foreground and returns1, even if native would otherwise succeed.
3. `-` stdin sentinel rejected. Fixed parser, then actual operation exposed the pre-existing pointer-only TTY detection; fixed with real `term.IsTerminal` checks.

The first re-review accepted those main paths and reported two remaining guards: Windows npm wrapper descendants on helper loss, and unlocking after a timed-out Close. Both were then corrected: Windows loss handling calls a focused checked `taskkill /PID /T /F` process-tree operation before wrapper exit, with3s timeout and explicit status/error handling; native control Close now waits for actual Done after the existing TERM→KILL escalation, rather than treating an observation timeout as exit. An OS-level unkillable process consequently retains the lease and wait; a timeout does not authorize another writer. A final direct Windows process-tree operation was executed as described below; complete Windows npm/CLI integration remains separately unverified.

Actual failure verification:
- The relay held a real generating frame after native foreground sent it. The operator identified both exact child PIDs of its own Node launcher, killed **only its lease helper**, and observed foreground exit plus explicit `codex_exec_intent_lease_lost`, launcher exit1 in6ms initially and7ms on the final-artifact rerun, no still-live foreground, and no new generated usage after the baseline. The held request was not sent upstream and no fake response was supplied.
- A real control subprocess was SIGSTOPped, then its private owner's stdin was closed. Helper exited in14ms initially and13ms on the final-artifact rerun; stopped native PID no longer existed; no fallback kill was needed.
- The final unchanged production Node module was copied to a verified private TEMP on the authorized Windows host. The operator launched an actual node parent with its actual node child, called `terminateWindowsExecTree`, and observed both PIDs absent after989ms. Calling the same function for the now-exited parent produced the expected explicit `codex_exec_intent_process_tree_termination_failed` from the real nonzero taskkill. Module hash, private scope and PID absence were checked before cleanup; existing scheduled task was only observed. This is real Windows helper coverage, not a complete native npm-shim business run.
- Stdin validation initially timed out (90/30 seconds) before any resumed upstream generation, proving parser-only acceptance was insufficient. After actual-terminal gating, the same real pipe completed normally. These timeouts are not counted as successful acceptance.

## Commands, artifacts and evidence boundary

```sh
go build -o /tmp/aih-w1-exec-intent-cli-final-20261115 ./cmd/aih
go build -o /tmp/aih-w1-exec-intent-server-final-20261115 ./cmd/aih-server
go build ./...
go vet ./internal/runtime/codexexecintent ./internal/runtime/codexlaunchrpc ./internal/host/codexexecpreflight ./internal/runtime/providercli ./internal/host/aihcli
node --check lib/server/codex-exec-intent.js
node --check lib/server/codex-default-cli-launcher.js
```

Final CLI SHA-256: `55da52171f9e4016f374eace554f13087ffc449ed77c27cce7ec10e0225adf7c`. Final helper/server SHA-256: `ed4ebf809076512cba7bf261a01e23fe4664b54508a1d808a3cfda2b1969ad23`. Final-artifact cancellation and helper-loss operations were repeated after review changes; earlier business matrices identify their own preceding artifacts rather than silently relabeling them.

Linux/Windows CLI cross-builds passed; they are not real-platform runtime evidence. Node Windows supports native executable or recognized npm Node shim without shell construction; unrecognized cmd/bat shell wrappers fail explicitly rather than risk bad quoting.

Ephemeral results under `/tmp`: `aih-w1-exec-final-artifact-result-20261115.json`, `aih-w1-exec-node-final-output-20261115.json`, `aih-w1-exec-name-result-20261115.json`, `aih-w1-exec-stdin-result-20261115.json`, `aih-w1-exec-lease-loss-result-20261115.json`, `aih-w1-exec-control-cancel-result-20261115.json`, `aih-exec-windows-tree-result-20261115.json`, `aih-exec-windows-tree-cleanup-20261115.json`. Results identify actual commands, outgoing intent, identity and per-run usage boundaries; all private resources were removed. Source/build snapshots advanced during review: acceptance of a prior matrix is not claimed as proof of an unexecuted later failure branch.

## Independent final review

Original reviewer Hubble (`01a1dac9-7f34-7260-892a-356a9d0c2daa`) completed the narrow final review at2026-11-15 23:17:53 Asia/Shanghai. It verified both final guards in source, read the Windows helper evidence, and reported **no remaining must-fix finding within the agreed scope**. Earlier three findings and the two subsequent cleanup guards are retained above as a correction trail. This is source/record review, not a claim that the reviewer independently repeated the business operations.

Windows cleanup is now separately confirmed by the main operator: exact module hash matched, both private PIDs were absent, the exclusively created TEMP directory was removed, and the pre-existing scheduled-task numeric state remained4. No existing service/task or unrelated process was changed.

## Remaining acceptance scope

This does not establish all W1/W0–W6. Unverified edges include names colliding across historical provider scopes, multiple-thread ordering of `--last`, unusual profile provider/permission overrides, concurrent non-AIH native writers, Windows/Linux runtime and generic shell shims, OAuth projections/rotation, full cancellation/reconnect/model ladder matrix, Edge UI and shared runtime delivery. No new branch/worktree, shared service restart, original DB merge or rollback occurred. Only this owner's explicit allowlist may be committed; peer staged reversals and other dirty files are excluded.

## Local delivery without shared-service restart

After the main checkpoint, the standard local `aih-server` capability probe did not advertise `__codex-exec-intent`; replacing running services was prohibited. The Node resolver now checks standard first, then the exact sibling `aih-codex-exec-intent` companion when there is **no explicit override**. An explicit old/invalid binary fails closed and never falls through. This follows the existing caller-local helper delivery pattern, not a separate routing implementation.

Published the new ignored companion with create-exclusive semantics (no prior file was overwritten), SHA-256 `ed4ebf809076512cba7bf261a01e23fe4664b54508a1d808a3cfda2b1969ad23`. The standard server and standard Go CLI were not replaced, and the shared gateway was not restarted. Future normal builds/package releases contain the same private command in `aih-server`; the companion is a local staged delivery artifact, not a claim that standard CLI/server artifacts were refreshed.

Actual production Node preflight/default-launcher validation was repeated **without AIH_GO_CORE_BINARY or a supplied goServerBinary**: real native resume completed, same thread, default tier,3 generated-turn usage rows, duplicate lease rejected, helpers/private state cleaned. Explicitly choosing the old server returned `codex_exec_intent_binary_missing_or_outdated` as expected. Ephemeral evidence: `/tmp/aih-w1-exec-companion-result-20261115.json`.

Hubble independently reviewed the follow-up resolver hunk against the HEAD blob/physical file and reported no blocking findings. The default resolver business run remains main-agent execution evidence, not a claim of reviewer re-execution.
