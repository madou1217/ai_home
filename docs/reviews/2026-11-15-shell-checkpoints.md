# Shell and completion recovery checkpoints — 2026-11-15

## Scope and ownership

The resumed owner continues the Node-to-Go migration goal, first saving completed work in small, explicit-path commits. Archimedes independently reviewed the existing 17 dirty shell/completion source paths. This record does not claim that all shell functionality or the overall migration is complete.

The shell lifecycle checkpoint contains only the command router, integration/generator adapters, and the three new focused helpers (`rc-file`, `rc-block`, `snippet-settings`). Shared database changes, Provider session contracts, and related completion projections are excluded.

## Shell lifecycle checkpoint

- Strictly validate managed rc blocks and reject malformed blocks rather than truncating user configuration.
- Resolve symlink targets, preserve permissions/encoding, use exclusively created temporary files, and recheck the observed snapshot before replacement.
- Separate generated snippets by rc path; require ownership evidence before deleting them.
- Preserve chosen feature settings, reject missing/unknown arguments, and keep JSON/exit status consistent.
- Retain shell-specific quoting, fallback, repeated-source, and history behavior fixes already reviewed in the pending source.

## Fresh verification

- `node --check` on all nine shell source paths: exit 0.
- Generated snippets parsed by actual Zsh, Bash 3.2, Bash 5, and Fish interpreters: exit 0.
- Actual `node bin/ai-home.js shell <action> --shell <shell> --rc-file <isolated-path> --json` for Zsh/Bash/Fish, each using apply → apply → status → remove → remove: 15 successful operations.
- Isolated rc symlinks, mode 0600, and original CRLF bytes survived the lifecycle. Paths containing spaces and a single quote were included.
- Malformed managed blocks: apply/remove exit 1 and preserve the file. Missing `--rc-file` value: exit 2 without creating a file named `--json`.
- Commit closure check: exported HEAD `bbeb54ba2` with `git archive` into a temporary directory, then overlaid only the nine shell paths plus three bounded-history/protocol paths. Repeated the 15 actual CLI lifecycle operations against that snapshot successfully. No branch/worktree was created and no shared files were replaced.

## Limits

No new test cases were written. No real user rc, database, shared service, or installed application was changed. Windows/PowerShell execution and Linux-host behavior remain unverified. The final comparison-to-rename interval is not cross-process CAS; ACL/extended-attribute preservation is not certified. Current real CLI checks do not replace interactive TAB acceptance.

Option-value completion remains separate because its candidate reader contains the single-DB work line's uncommitted dependency. Provider action completion remains separate because its new session-command contract has not landed. Neither dependency is silently included here.
