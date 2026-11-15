# Codex request recovery and project-scoped resume — 2026-11-15

## Scope and safety

Repair the repeated `invalid_request_body` failure in the current project's recent
Codex sessions, and make session/resume selection project-scoped across AIH's
provider-neutral CLI and Codex app-server transports.

No test cases or synthetic session fixtures were added. Verification used actual
saved sessions, native CLIs, local HTTP/WebSocket services, and real provider
history. No branch/worktree was created. Original sessions, peer edits and live
credentials/configuration were not rewritten.

## Request-body root cause

Affected saved threads included:

- `01a1d99a-db6e-7d82-b2ba-90fe5fb41e23`
- `01a1da12-9ab6-7a70-929e-581822624377`

The original gateway returned HTTP 400 with `x-aih-decode-rejected: 1` before
contacting an upstream. The native HTTP reader, native Responses WebSocket and
Node Codex decoder had a 16 MiB limit, smaller than the other 32 MiB inference
ingress paths. Long histories contain substantial encrypted reasoning even when
the ordinary messages/tool results are much smaller.

An ephemeral, read-only native fork produced a **16,862,842-byte valid JSON**
request. Authorized replay to the original local gateway reproduced the exact
400 `invalid_request_body`. This particular request was Codex's own pre-sampling
checkpoint compaction: retrying and native compaction were both blocked at the
same byte boundary, not by bad account credentials or malformed history.

### Implemented

- Native HTTP and Responses WebSocket share a 32 MiB ingress limit in
  `internal/transport/http/codexwire/limits.go`.
- Node uses the same limit; wire and decompressed sizes remain bounded.
- Oversize HTTP requests return the explicit, shared 413 `request_too_large`
  contract instead of being mislabeled malformed JSON or handed back for replay.
- Invalid JSON/unsupported encoding remain errors. There is no unlimited buffering,
  destructive transcript trimming, or blind retry of an unchanged invalid body.
- Existing compressed-native passthrough/sanitization semantics are unchanged;
  the codec checks below establish decoding/size parity, not upstream sanitation
  parity for every compressed request.

### Real verification

| Observation | Result |
| --- | --- |
| Authorized replay, original local gateway | 400, `invalid_request_body`, decode-rejected |
| Actual captured body through patched Node identity/gzip/zstd decoder | 16,862,842 decoded bytes in each case; byte-identical content |
| Same real body with explicitly configured 16 MiB decoder limit | `request_too_large` for all three encodings |
| Actual large history through native Responses WebSocket | 16,862,867-byte frame; 3,736 upstream events; terminal `response.completed` |
| First saved thread, native `exec fork --ephemeral`, read-only sandbox | `RECOVERY_OK`, `turn.completed`, exit 0 |
| Second saved thread, committed-source verification build | 16,805,295-byte HTTP request, 200, no decode-rejected header; `RECOVERY_SECOND_OK`, `turn.completed`, exit 0 |

Both original rollout files were left intact. Private request bodies and database
snapshots remain outside the repository, in a mode-0700 temporary evidence directory.

## Session scope root causes and implementation

- Node's `collectOnly` path returned all rows before display filtering; interactive
  pickers therefore bypassed the filter. Initial, returned and refreshed rows now
  follow the same project scope.
- Session-name prefixes were treated as project identity. Membership now requires
  a known absolute project path; unknown cwd and similar names do not qualify.
- Provider-neutral Node/Go history, Go persistent lists and global pickers now
  default to the current directory. Shared collection/cache remains host-wide.
- Native remote Codex TUI sends `cwd:null` by default. Its local WS bridge had
  explicitly disabled cwd injection; the stdio proxy also omitted the caller cwd.
  These paths now inject the launch directory and honor `-C`/`--cd`.
- Go app-server WS uses the client's connection/request cwd, **never the server's
  own cwd**. Response pages are filtered too. With neither a cwd nor explicit all
  intent it returns no rows and no continuation cursor.
- Explicit cross-project access remains available through `--all-projects`, the
  existing `sessions --all` history alias, native `resume --all`, and app-server
  all-projects intent.

Directory matching is exact after path normalization, not parent-directory or
Git-root inference. Launching inside `ai_home/lib` does not implicitly select the
`ai_home` root's sessions. Third-party TUI filter labels are not modified; native
remote Codex can still display `Filter: All` while its actual rows are scoped.

### Real verification

| Entry | Current-project evidence | Explicit all evidence |
| --- | --- | --- |
| Native Codex TUI through local WS → stdio | ai_home first page 25/25; `--cd shalou` 24/24 | Cross-project rows restored |
| Go HTTP/WS → native app-server | ai_home two pages 50/50; shalou 24/24; missing client cwd 0 with no cursor | URL and request all intent both restore cross-project rows |
| Full Node stdio proxy | ai_home 25/25; shalou 24/24 | Cross-project rows restored |
| Node/Go Codex persistent list | 5 | 7 |
| Go global list and actual interactive picker | 7, covering Claude/CodeBuddyCN/Codex | 9 |
| Native history readers | Claude 27; CodeBuddy/WorkBuddy 217; Cline 46; Qoder 1; OpenCode 87 | 37; 325; 57; 13; 3325 respectively |

Real CodeBuddy/WorkBuddy history also contained unknown-project rows; none entered
current-project results. An independent review also found and closed a Node
stdio missing-cwd loophole: explicit all intent is now preserved through response
aggregation/state pagination; an unavailable launch cwd fails closed. A real native
app-server started in a temporary directory that was subsequently removed returned
zero rows/no cursor by default, and cross-project rows only with explicit all.
Real state cursors were used, not synthetic session fixtures.

These checks do not claim every third-party vendor's own
interactive picker was launched.

The scope-only patch was also applied to an ordinary `git archive` source snapshot:
`go build ./cmd/aih`, the two changed Go app-server packages, and Node syntax checks
passed without the peer's unfinished resume/schema changes.

## Build/runtime boundary — do not silently cross

The full shared working tree builds, but contains a peer's **uncommitted schema 31
migration**. Live storage remains at schema 30. A whole-worktree runtime rebuild
would activate unrelated changes.

A committed-source Go server build exposed a pre-existing partial-commit dependency:
`webui_management_ops_routes.go` references `webuimanagementapi.PublicPrefix`, whose
declaration is present only in a peer's dirty handler. For isolated verification
only, an independently reviewed build overlay supplied this one declaration:

```go
const PublicPrefix = "/v0/management"
```

No peer authorization or alias-normalization behavior was copied. This is **not an
unmodified clean-main build**. In that snapshot the public restart alias is not
fully implemented, so it must not be used as a deployment/recovery mechanism.
The fresh verification database stayed at schema 30. CLI auto-upgrade and apply
were disabled; no Node/live fallback was configured.

The original local Go service and Node supervisor were **not restarted**. Even a
schema-30 Go artifact would cause the supervisor to reload the current dirty Node
entrypoint, which also includes unrelated peer changes. Therefore isolated
success does not establish that the already-running shared gateway has loaded
these fixes. Reconcile that runtime/source boundary before a shared-service update;
then repeat the real saved-session fork against the public endpoint. Existing CLI
processes likewise need a fresh launch to load changed local proxy modules.

## No-restart recovery investigation

The user subsequently confirmed that only the two old threads fail and asked for
recovery without restarting the shared service. At inspection both original
rollouts remained open in their old native app-server owners (not merely present
on disk). Starting another writer against those same IDs is not safe while the
old owners retain loaded history.

A recovery rehearsal therefore used private, independent copies of both the
rollouts and consistent SQLite backups. Native `thread/compact/start` on the first
copy, through the patched isolated gateway, completed with a `contextCompaction`
item. The 16,869,505-byte request returned 200. The original 22,201,985-byte prefix
was preserved exactly in the copied rollout; native appended a compaction record
whose 12 replacement-history items occupied approximately 83 KB. This proves
native compaction can shrink the *next prompt* without deleting the saved history;
the rollout file itself grows, which is expected.

Before applying this operation to an original ID, its old client must leave or
normally unsubscribe the thread and actual closure must be verified. `idle` or an
unsubscribe from a different newly opened connection is insufficient. No original
history should be edited or compacted concurrently with its loaded owner. Only
these two thread owners need release/reload; the shared gateway and unrelated
sessions need not be restarted. This is bounded session recovery, not replacement
of the already-running gateway's 16 MiB code limit.
