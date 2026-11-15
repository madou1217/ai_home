# Native read-only Codex history hot paths — 2026-11-15

## Scope and findings

Two production Node paths decoded history in memory: fast thread/read repeatedly allocated/parsed2/4/8 MiB tail windows, and per-turn model decoration read/split the entire rollout for each response. This slice moves file reading and projection into a focused Go module, leaving account/config/state-row orchestration unchanged.

The first comparison appeared equal because both implementations returned empty turns for modern histories. This was **not** accepted as completion. Source and actual vendor inspection showed modern `history_mode=paginated` and `item_completed` history must not be replaced by the legacy projection. An initial private clone lacked the vendor thread-history store/indexes and also returned empty pages; after copying only this thread's actual rows and native index definitions into the isolated clone, official Codex returned16 turns and a3-turn page with241 items and a continuation cursor. No live vendor/business database was modified.

## Design

- Legacy event format: stream a bounded window, decode relevant payload fields once, and retain detailed items only for the most recent requested turns using a rank heap. Item IDs, models, timestamps, status normalization, command-output truncation and window-selection semantics remain compatible.
- Model decoration: reverse128 KiB block scan, stop after requested turn IDs are found, and retain only their final model assignment. Bound IDs, split-line memory and execution time; missing IDs can require a full byte scan without a full decoded file allocation.
- Paginated header or native item history explicitly marks the fast projection ineligible. The original official app-server receives thread/read and retains its complete contract/read state/pagination behavior. Empty or failed fast projections do not synthesize empty success.
- Open regular files only; Unix nonblocking open prevents a FIFO replacement hang. A stable size/identity check rejects truncation, replacement or observed same-size rewrite. Append-only growth is read from the original captured prefix. No claim of atomic snapshots across arbitrary concurrent in-place rewrites.
- Node's file-read hot paths call the native read-only subcommand; pure legacy helper exports remain for compatibility. Native unavailability/failure yields the original official read or unchanged model response, not a second Node full-file scanner.

## Real acceptance

Private evidence root: OS temporary directory `aih-rollout-parity-y3rip9el`. Actual history snapshots, only count/shape/hash summaries published; content remains outside Git with0700/0600 protection.

- Six actual legacy histories (2.6–13.5 MB), turn limits2/20/60:18 deep field-for-field comparisons passed against the pre-change Node reader.
- Three actual paginated histories (26–38.5 MB): the native helper and production buildFastThreadReadResponse explicitly decline the legacy shortcut. Actual official store read/page verified as described above, not an empty parity result.
- Model assignments match old full-file scans for all9 actual files, including missing requested IDs. Production response-decoration adapter is also exercised with actual turn IDs/models.
- `aih-rollout-io-guards-nzfn5oaz`: real FIFO/no writer rejected, regular history symlink accepted, excessive byte/ID limits rejected, and an actual copied history truncated during reading failed explicitly. Only the observed race is claimed.
- Native/full snapshot build, production-source vet, Node syntax and Linux/Windows leaf-package cross-builds pass. No new test cases, mocked storage or synthetic history records.

## Measurements, without conflating latency scopes

`resource-measurements.json` uses `/usr/bin/time -l`, three separate processes per path, warm filesystem. Model lookup on38,522,154 bytes:

| Reader | Total process wall time | Peak RSS |
|---|---|---|
| old Node | 0.16–0.21 s | 164.7–164.8 MB |
| native Go | 0.02–0.08 s | 38.8–39.9 MB |

Legacy20-turn lookup on13,524,920 bytes: old separate Node0.11–0.13 s/60.7 MB, Go0.02 s/41.0–42.9 MB. These are **separate-process** measurements; existing Node-in-process tail parsing was about7–12 ms, and native process launch can make that small-tail latency worse. No universal speedup or globally optimal memory claim. The large full-history model scan is the measured hot-path improvement; legacy parse migration primarily bounds retained state and transfers ownership.

## Delivery / safety

Standalone `__codex-rollout-read` performs no DB writes/config changes or shared-server assembly. Local development has an ignored companion so the older running gateway binary need not be replaced/restarted; release uses a rebuilt standard aih-server. A bounded capability fingerprint cache avoids probing the same unchanged helper for every call. The exact local helper hash and commit verification are in the follow-up handoff.

During native-history cloning local disk temporarily ran out of space. Only the failed own copy and five previously created/reconstructible `/tmp` git-archive exports were removed; no worktree, user history or shared artifact was deleted. Initial empty/incomplete clone observations and the failed clone were not counted as acceptance.

Review capability uses documented owner self_review because original reviewer contexts are exhausted. Source guards, legacy parity, actual official pagination, I/O failure boundary and explicit commit scope were inspected. Main-index reverse peer diffs are preserved. No new tests, live DB mutation, shared restart, push or full stdio/Desktop/plugin completion claim. Full migration goal remains active.

Local ignored artifact: `bin/native/darwin-arm64/aih-codex-rollout-read`; SHA-256 `e564c84f517e35313cda88b028068b53190b24697afcf6a215ecfeb108f50182`. Standard gateway binary untouched.
