# R7 browser terminal prefix: direct Go checkpoint

Observed 2026-11-18 02:54–03:04 Asia/Shanghai. Owner: original supervisor `01a1df63`; original W0–W6 / R7 scope, not a new terminal implementation.

## Delivered source and unique owner

- Source commit: `441a527c37f86e26501ea63598a8d2f379fe6641`. Exactly two production paths, +50/-2:
  - `internal/host/aihserver/router.go`: mount the browser prefix on the existing terminal handler.
  - `internal/transport/http/webuiterminalapi/browser.go`: explicit browser method/action allowlist and existing path rewrite.
- `/v0/webui/terminal/*` now reaches the **same Go handler/session service** as `/v1/management/webui/terminal/*`; no new PTY, mux, persistence or state writer.
- Existing management authorization runs for both forwarded and rejected requests. Browser `/launch`, `/probe`, unknown actions and unsupported methods cannot expose management-only capabilities.
- `openBody` still accepts only cols/rows/muxId/cwd/sessionKey. Arbitrary executable, argv, environment and SSH launch fields are not decoded by browser open.
- Unconsumed `X-Aih-Server-Id` is rejected through the authenticated JSON 404 path. This is a local-fallback guard, **not** completion of remote profile transport; the R6 owner is separately wiring that transport.
- Original protocol, missing-tabs UI, handler, sessions, tmux and SSE implementations were not edited.

## Immutable build inputs

The actual private source is an archive plus exactly the two reviewed overlay files, not an unfrozen shared dirty cwd:

| Input / artifact | SHA-256 / identity |
| --- | --- |
| Base source | `162207bdb3b81c86c99f4391c235814c977bda8d` |
| Base git archive | `bc8d2f4988b7f975050c0e0293185547cae1694e6e8c0258c23eac753c44be1e` |
| Router overlay | `7c672c42646848998de4ad71649f98b5ee27f61503d778ab2ebe990ef3dc688e` |
| Browser adapter | `87bb4eda61be9b8f2e55c56e69a29d63aba754a1ff961f3c61e3bf65c4c9b694` |
| Baseline standard server | `3576a2b41c7c47403733b8e634cc00a800d2b5c6fedb21db960163753de7c657` |
| Candidate standard server | `fa93c74be99a57e13b972c0467b987197b00375297217cac712aa88f7e495dce` |
| Private production-host bootstrap | `2587dd1495e23d86bfc0fa6a2daf18b4079fd5fbcf2ed6adc43d511a548f32d7` |

`CGO_ENABLED=0 GOWORK=off go build -mod=readonly` succeeded for baseline and candidate `./cmd/aih-server`. Focused `go vet -mod=readonly ./internal/transport/http/webuiterminalapi ./internal/host/aihserver` exited 0. No test cases, test files, mocks, fixtures, branches or worktrees were added.

## Standard production CLI: actual HTTP / PTY / tmux / filesystem

Private empty HOME/AIH_HOME/DB, unique loopback ports and unique session/socket keys. No `--front-door`, `--supervise-node`, Node base URL or first-party Node server was configured. No shared service or real account was used.

| Actual operation | Observed result |
| --- | --- |
| Baseline browser sessions / management sessions | 404 / 200: existing management implementation was present but browser alias was missing |
| Candidate missing key / wrong key | 401, including forbidden browser paths before endpoint dispatch |
| Candidate browser sessions | 200 |
| Browser launch / probe / unknown action | Authenticated JSON 404 |
| Unresolved remote sessions / open | 404; no local terminal opened |
| Browser open | 200, durable=true, own bash/tmux session |
| Extra executable / argv / env in open | No escape file; environment override stayed unset |
| Actual input | UTF-8 Chinese/emoji reached the shell and produced the exact expected file bytes, not just an echoed SSE marker |
| Resize / focus | 200; actual `stty size` returned 37 rows / 119 columns |
| Mux and historical single stream | Both received actual shell output |
| Single-stream client disconnect | Reader ended; same shell PID continued accepting input and wrote the expected file |
| Clipboard image | 201; actual existing product logo persisted under own cwd with identical SHA-256 and mode 0600 |
| Idle mux observation | 94.134 seconds, three heartbeat comments, stream still open |
| Stop/start **private** Go server, attach same key | Original shell PID 94858, exported environment and cwd preserved |
| Close / subsequent attach | 200 / 404; no replacement shell was silently created |
| Cleanup | All observed private Go/shell PIDs gone in a fresh audit; own socket kill targeted only its unique key |

The 94-second observation establishes idle streaming continuity, **not a new saturated-output/backpressure or browser-DOM acceptance claim**.

Two short-lived absolute-path Node child processes were observed under the standard candidate Go PID (94898/94899, parent 94842). This run did not retain their argv, so they remain unclassified here; no retroactive third-party attribution. PATH lacking Node is **not** reported as OS-level zero Node. The standard CLI evidence proves the browser path works without an AIH Node server/front door, not that no Node executable ever ran.

## Separate strict Node-off production-host evidence

A private operational bootstrap invokes the actual exported `aihserver.New` / `Serve` / `Close`; it copies no production functions, injects no fake service or response, and adds no repository code. It omits the standard CLI identity publisher, so this evidence must not be called full standard-CLI OS-noexec acceptance.

- OS policy denied absolute Node execution, outgoing IP connections and access to the real AIH/repository roots. Actual absolute Node control failed with EPERM/exit 71; an outgoing connection to the already-listening private port was rejected.
- Required tmux Unix-socket communication remained permitted; no Node RPC or outgoing IP transport was enabled.
- Actual production host PID 1370 served browser sessions 200, rejected missing auth 401, opened a real durable shell 200, accepted actual input and wrote `R7_STRICT_GO_ONLY` to its private cwd, rejected launch/probe/unresolved remote 404, closed its session 200 and exited 0.
- Operational binary SHA is listed above; bootstrap source SHA-256 is `07241c4516a77ccd58b933a5108e472cb647664bc3c0db9dd9deff59606c035c`.

### Failed attempts retained, not product fixes

1. Standard CLI under Seatbelt exited 1 before serving: macOS setuid `/bin/ps` used by `serveridentity.Publish` was denied. No identity source was changed or fabricated.
2. First HTTP run expected image status 200; actual correct contract is **201**. This was an operator assertion error, retained separately; the final run used fresh runtime directories to avoid stale-file/PID evidence.
3. Initial strict policy denied all outbound networking, which also denied tmux Unix-socket attach. A real unique tmux socket control reproduced EPERM; restricting the network denial to outgoing **IP** restored Unix attach while the actual Node-exec and outgoing-IP controls still failed. The failed strict result remains retained, not counted as success.

## Review and commit/index safety

Independent read-only reviewer Goodall reported no Critical/Important source findings, bound to the two exact overlay SHA-256 values above. It did not claim runtime acceptance. The source commit used a single-use temporary index and an explicit two-path commit; mandatory pre-cached stat and post-show stat matched. Non-owned main-index entries had identical SHA-256 before/after: `01bd0829e26e42a915924648448913018a476c99eab162b6e14a16a4dd9da766`. All 35 unrelated stale staged entries remained untouched.

## Evidence and delivery boundaries

Local private evidence root: `/var/folders/nj/0mx5gymd41x8f64xcfm635440000gn/T/aih-r7-browser-nodeoff-20261118-j2lddtit` (0700). Pointer: `/tmp/aih-r7-browser-nodeoff-latest-20261118.txt`.

- `evidence/baseline-manifest.json`, `overlay-manifest.json`: exact input/archive/overlay chain.
- `evidence/cli-final/final-result.json`, `operations.jsonl`: complete actual standard CLI operations, topology and clean exit.
- `evidence/strict-ip-host/result.json`: separate strict production-host operations and controls.
- `evidence/initial-seatbelt-cli-failure/`, original `evidence/final-result.json`, `evidence/strict-host/result.json`: failures above.
- `evidence/tmux-unix-transport-sandbox-control.json`: transport-policy root cause.
- `evidence/independent-source-review.json`, `source-commit-receipt.json`, `post-run-pid-audit.json`.

Source is committed; push is a separate transport action and requires a fresh remote check. Artifacts were loaded **only in private short-lived processes**. No shared binary replacement, stamp mutation, production restart, remote deployment, credential operation or browser action was performed. At 03:04 local 9527 remained Go 84956 supervising Node 85251, runtime/disk SHA `9916c222…`; it was not replaced by this candidate.

**R7 / whole-migration Node retirement is NOT complete.** Terminal-internal `.runtime-bin/aih` still generates Node+public-wrapper launch; old in-process launch callers and Node adapter exports remain. Actual public CLI parity, R6 transport, shared exact-source paired release, existing Edge acceptance and full caller/traffic-zero evidence must precede removing those old paths. This commit does not reopen the separately accepted garbage-character repair or claim all 42 requirements / seven gates passed.
