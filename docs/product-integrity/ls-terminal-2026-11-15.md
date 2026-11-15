# Go `aih ls` narrow-terminal rendering — 2026-11-15

Scope: the existing M0–M5 goal, CLI/native rendering work package. This is not completion of M0–M5. No new test cases, database cutover/rollback, shared service restart, Node fallback or upstream-client changes.

## Reproduction and cause

Actual macOS PTYs, tmux 3.8, independent socket `aih-ls-01a1da12`. The standard `/opt/homebrew/bin/aih ls` against the existing 41-account database reproduced staircase alignment at 80×24, fragment overwrites at 60×24, and stale fragments after widening to 120 columns. The account reader is read-only; no production account/profile was edited.

1. Raw input disables ONLCR: bare `\n` in the initial/full frame retains the previous column. Later cursor addresses assumed those lines started at column 1.
2. Size was read only once. Resize did not invalidate layout or the cached physical screen mapping.
3. A logical account row was treated as a physical terminal row; hard truncation silently dropped trailing identity/quota/model fields.
4. The local rune table did not account for combining marks, variation selectors or ZWJ graphemes. ANSI parsing and width were embedded in the list animator.

## Implementation

- Shared `internal/runtime/terminalui`: pinned `rivo/uniseg v0.4.7` display-cell/grapheme adapter; SGR-preserving wrap with complete content; physical lines include exact width and continuation indent. Unsafe cursor/OSC controls are not emitted from display text.
- `cmd/aih/ls_animator.go`: remeasure size on the existing 100ms tick, explicit CRLF, full repaint on resize, row-diff after wrapping; activity/rotation/filter semantics preserved. Animation runs **after** layout and cannot change line boundaries. One latest layout per logical row, not an unbounded text cache.
- Normal refresh with a changed physical row count rewrites the visible tail with CUP/EL, without scrolling a duplicate snapshot into history. Initial/resize/exit retain full normal-screen snapshots; no forced alternate screen, scrollback clearing or pagination.
- Exit renders all static identity/usage/throttle variants within the current filter. Non-TTY formatting is unchanged.
- I/O failures propagate; synchronized-update termination is attempted on partial-write errors and terminal restore. No injected-writer test was added; this error branch has source review, not live partial-write proof.
- Empty queries no longer construct unused complete search projections. Nonempty queries still search complete fields, not only the rotating candidate.

## Real acceptance

Evidence directory: `ls-terminal-2026-11-15/`. ANSI captures store ESC as literal `\x1b`; real emails are replaced character-for-character to preserve column positions. Source hashes and redacted hashes are in `manifest.json`. Raw local captures/builds: `/tmp/aih-ls-terminal-20261115` (private directory).

| Journey | Observed result |
|---|---|
| Live 41-account list, 120→80→60→120 | left alignment, complete wrapping, new width used, no stale fragments in current viewport |
| `/cline`, Enter, clear; unmatched long Chinese query | complete search fields retained, status wraps, previous rows cleared |
| Isolated local SQLite data through real Go CLI/PTY | long Chinese/account/model names, `Zoë`, `👩🏽‍💻`, default/disabled badges and quota values remain complete; SGR resumes on continuation lines |
| 3×2→1×1→60×24 | explicit minimal size marker, safe recovery with full data |
| Actual quota snapshot changed in isolated directory; 12s rotation | long/short variants change wraps without scrolling duplicate frames: history 0→0 |
| Live account refresh, 10s | history 239→239 at fixed size |
| q / Ctrl+C | exit 0 / 130; termios restored (`icanon`, `echo`, `opost`, `onlcr`); final snapshot contains all usage variants |
| Redirected output | before/after `cmp` exit 0, including long fields and multiple model variants |
| Build | darwin/arm64 real CLI build and run; windows/amd64 cross-build only |

Performance observation: independent before/after 120×24 PTYs, same live 41-account source, 15.008 seconds. CPU time delta 0.26s→0.25s (1.73%→1.67% of one core); RSS endpoint 29,152→29,632 KiB. This is a short non-regression observation, **not** a statistically significant speedup or a long-run leak claim. Search-projection short-circuit was added after this sample; it is not credited with those numbers.

## Limits and remaining work

- Terminal/font width conventions vary. Real acceptance here is tmux/macOS; Windows was compiled, not visually executed. Other emulators remain unverified.
- <4 columns or <3 rows (or a single grapheme wider than available cells) shows a size hint instead of pretending the list fits. Exiting in that extreme state does not print a full snapshot; resize or non-TTY output is required.
- Existing scrollback semantics retained: offscreen live intermediate states are not individually archived. Initial/resize/normal exit snapshots retain all fields. A short terminal cannot show every account simultaneously.
- Independent reviewer Carver reviewed the actual shared renderer and animator; CRLF, physical-tail mapping, layout-before-animation, cache bounds, static exit and sync-end fallback addressed. No tests were written.
- Source checkpoint and standard CLI installation are distinct. This record initially validates the isolated built Go binary; do not infer a gateway restart or production deployment from it.
