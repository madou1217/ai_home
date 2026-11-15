# Native read-only Codex state pages — 2026-11-15

## Production scope and algorithm

The old production page path queried all matching rows from every vendor `state_*.sqlite` with Node `.all()`, retained full row arrays, built global spawned-child IDs, de-duplicated and sorted all rows, then sliced a page. Hidden-thread discovery likewise materialized a whole array per database.

The production `readStateThreadListPage` and hidden-ID reader now invoke native Go:

- Discover top-level/nested versioned vendor state files and open one explicit read-only/query-only transaction per source. SQLite writes, schema changes and AIH business DB access are absent.
- Stream candidate rows one at a time, preserving the legacy source/model/project/archive filters and title fallback rules. Keep bounded winner metadata (ID/source/timestamps/completeness), not every full row. Determine duplicate winners **before** applying the cursor so a stale duplicate cannot reappear on a later page.
- Select only limit+1 winners using a heap and fetch their detailed rows by ID from the same per-source snapshots. Session-index title data is scanned once; fallback transcript titles are bounded and memoized for this call.
- Preserve `aih-state-v1:` filter fingerprints, sort/ID continuation and existing wire projection. Literal U+2028/U+2029 versus backslash-u text are not confused during cursor serialization. Default/explicit project and allProjects semantics remain unchanged.
- Bound source count16, metadata identity storage32 MiB/200k candidates, page size1,024, per-row/page string data, title scan and input/output size. Exceeding a limit is an explicit error, never an incomplete successful page.
- Corrupt/locked/unsupported sources fail explicitly rather than silently returning no sessions. AIH cursor failure is returned as an RPC error, not sent to the official server as if it were an upstream cursor. Hidden-ID failures do not silently expose unfiltered data.

The original pure helpers and exported legacy full-list helper remain for compatibility, but the production database page/hidden paths do not use their all-rows implementation. This checkpoint does not claim the whole stdio hook is native.

## Actual acceptance

Private evidence: OS temporary `aih-statepage-real-parity-vy3axzg6`. Actual vendor state copied with SQLite read-only backup into mode0700/0600 private directories. A nested second copy of the same real database exercises cross-source duplicate precedence; no invented session records.

- Initial51 page comparisons passed. Expanded final15 scope/sort combinations traversed **144 pages to completion**: each raw row, projected wire data, hasMore and continuation cursor matched the pre-change implementation; no duplicate rows across pages. Includes all/project, provider filter, explicit exec/vscode sources, archive, updated/created/recency sorts.
-272 hidden IDs matched exactly. Source database SHA-256 hashes were unchanged across native adapter reads.
- Special filter strings containing actual U+2028, literal `\\u2028`, HTML punctuation, slashes and emoji preserved cursor bytes exactly.
- `aih-statepage-errors-7cyj04ri`: real truncated SQLite file, FIFO,17 discovered DB files, actual exclusive SQLite lock and oversized page request fail explicitly with no page stdout. A genuinely empty source directory returns an empty page.
- `aih-statepage-stdio-live-uZl15Q`: actual production stdio script + official Codex0.167.2 with external networking denied. A real AIH cursor returned the exact5-row continuation through Go; wrong-sort reuse returned-32602 `codex_state_cursor_invalid`; a following official config/read still worked. EOF exit0 and private DB hashes unchanged. No inference or live DB writes.
- Final default native lookup returned the same page as explicit helper selection. Corrupt DB through the actual response patch produced `codex_state_read_unavailable`, not fake empty history.

## Measurements and limits

`resources.json`: actual two-source private clone,3 separate process runs per path, warm filesystem. Page sizes7/50:

| Reader | Total process wall | Peak RSS |
|---|---|---|
| old separate Node | 0.10–0.28 s | 57.0–57.3 MB |
| native Go | 0.02–0.07 s | 38.9–39.6 MB |

Old already-loaded Node query itself measured about12–17 ms on these small real databases. Native process startup may therefore increase latency in that context; no universal latency speedup or globally optimal memory claim. The guaranteed structural improvement is bounded row retention/selection and native I/O ownership. These are per-source snapshots, not a distributed atomic snapshot across independent vendor databases, and separate page calls can observe later updates.

Native/full isolated snapshot build, production-source vet, JS syntax and Linux/Windows leaf-package cross-builds passed. Windows runtime/GUI/full CLI picker behavior remains unverified.

## Artifact, review and shared-worktree boundary

Ignored local helper: `bin/native/darwin-arm64/aih-codex-state-page`, SHA-256 `139ab56661eceb77f549f443484fbbbdff3716b4f452f0fb2f461203558a3e8a`. It was exclusively added, not substituted for the running standard gateway. Releases rebuild the standard aih-server subcommand. No shared restart or standard artifact replacement by this session.

Original reviewer contexts are exhausted; documented owner self_review checked read-only DSNs, transaction lifetime, cross-source precedence, cursor serialization, bounded fallbacks and failure semantics. Independent final approval is not claimed. No new test cases, mocks, real credential exports, live DB/config mutation or push. Peer main-index reverse changes remain preserved via an isolated one-use explicit-path commit. Full migration goal stays active.
