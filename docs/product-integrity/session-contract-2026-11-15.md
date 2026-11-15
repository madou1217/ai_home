# Native session verb contract checkpoint

## Purpose

Preserve user-requested resume/fork intent across Node and Go without maintaining different native argument recipes. Current Provider identity manifest remains the single source: `NativeSessions.Resume/Fork` holds argument arrays with one `{sessionId}` slot, plus the documented no-ID form. No shell eval, no official-client patch.

## Implementation ownership

- `core/providers/model.go/native.go/builtins.go/session_command.go`: optional explicit templates + contract validation (identity slot count, native declared flag membership).
- `core/providers/catalog.go`: defensive cloning of new arrays; unrelated catalog semantics preserved.
- `application/providerlaunch/session_verb.go`: pure intent-to-argv expansion, no account/network/process I/O.
- `lib/runtime/provider-session-command.js`: same expansion using generated manifest.
- `cmd/aih/resume_account.go`: shared planner before account resolution, replaces unconditional --resume and fork ordering guesses.
- `lib/runtime/provider-resume.js`: preserves persistent identity/file restore strategies; interactive compatibility projections derive from contract, not another hand-maintained table.
- `lib/cli/services/pty/session-identity.js`: continuation flags use shared resume template, excludes fork modifier so account switching does not accidentally write the original conversation.

## Verification boundary

`session-command-evidence-2026-11-15.json`: actual Go application builder + installed official CLI `--help` executions; no conversation generation, no credential fixture, no assertion-based test suite. 64 template combinations compare identically with Node; 29 native help invocations exit0, 21 explicit rejection cases, 14 not launched. Source parity or help acceptance is **not** proof of actual conversation continuation/fork identity.

Actual installed help checked at this time: AGY --conversation; Cline --id; Gemini --resume latest; OpenCode run --session + --fork; Qoder/Grok/CodeBuddy --resume + --fork-session. WorkBuddy desktop-only fork remains undeclared rather than assuming CodeBuddy CLI evidence applies to a different executable.

`go run ./cmd/provider-manifest --check`, real `go build -o /tmp/aih-product-cli-20261115 ./cmd/aih` pass. New Go CLI in empty isolated HOME with a dead gateway and ephemeral distinct key:
- native Codex `-- --help`, `-- 999999 --help`, `-- delete --help` reach official help, no management action/inference.
- `gemini login --no-browser --help` returns login usage instead of unsupported relay.
- Cline no-ID and Kiro unsupported resume reject before account lookup.
- pre-marker `acct_...` in numeric-only Go typed API explicitly rejects instead of unpinned gateway launch. Node supports and validates accountRef on its own existing path.

## Review corrections and open items

Independent reviewer found accidental object splice merging Qoder and family persistent strategies; corrected immediately. Current vs pre-change HEAD actual restore functions now match across 16 providers × with/without representative identity; this is compatibility code evidence, not an existing-session restore.

Early native boundary dispatch in Go delegates to unchanged common launch composition; mode/selector parsing only sees prefix. Bin family restart scans prefix only. Missing Node session option values cannot consume marker and expose destructive AIH verbs.

Open: actual saved-session resume/fork on every supported provider; version drift (especially OpenCode top-level vs run), persistent exact identity and cancellation; generic Go accountRef resolving remains unsupported (explicit failure, not guessed); Go uniform-help已由独立本地formatter消费模板：真实cline 999999 resume --help、gemini resume --help、kiro resume --help均exit0，不查账号/不启动原生程序。 Other main worktree/account/lifecycle changes remain peer-owned.

## Output pipe lifecycle

New `pipe-lifecycle.js` maintains one process-scoped observer through child cleanup/output drain and login→chat handoff. Only EPIPE triggers shutdown; other stream errors are not suppressed. Closed output prevents delayed launches, including auth retry/post-login startup; completed auth reconciliation remains in existing exit path. No kill-by-name.

Actual `aih codex -- exec --help | head -1/-6` previously produced unhandled EPIPE. Current short consumer runs show no stack, 141 when closure was observed, or 0 when complete output was already buffered before closure. Full output remains exit0 with complete tail. `pipe-lifecycle-evidence-2026-11-15.json` has repeated runs. Auth-complete→handoff race and long streaming cancellation still need real business evidence; not certified by help-only runs.

最新窄审查确认relay acct_前缀拒绝缺口关闭；bare/direct与relay selector都显式拒绝未支持的持久ref，marker后ref仍保持native text。实际账号pin/跨provider仍待真业务验收。
