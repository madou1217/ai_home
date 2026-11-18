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


## 05:23 Node browser dispatcher 实际退役（非全 terminal 模块删除）

源码 `4bd40a68e4d25b90f25be69348daa7586b3672f1` 只删 `lib/server/web-ui-router.js` 的 terminal require 和末端分支，共7行；私有固定 base `a331e43b2609686c96df76737c388cfed3b87b19`，candidate SHA256 `b1576be0100571f3ca932ade6bfdb63d3391e3463fd54e93fde5d2dc3448888e`，manifest SHA256 `242b6e1366b310a28bd9198ffce201b60043873d2fbf9c3212929d702db068d7`。这是先有 Go 完整 browser alias，再停对应 Node caller，不是继续两套 owner。

实际命令 `python3 -u <root>/run-retirement-real.py` 运行私有标准 Go CLI（PID53927、SHA256 `e6fc5eb9c69734b6f816f5d84f5362d1e52b6911778047a649d6b4b79cbb67d3`、无front-door/supervise-node、PATH无node）及**真实第一方 Node CLI**（PID54141，actual `bin/ai-home.js server serve`，外部Go为同私有home；无账号fixture/业务上游/GUI）。依赖使用现有 node_modules只读解析，未安装或修改依赖。该组合用来验证旧私有端口不再承担 browser 入口，不代表最终默认拓扑。

- Node直接GET/POST六路径 sessions/open/input/mux/launch/probe 全部 `404 webui_not_found`，无key仍401。
- Go auth先判401、browser management-only launch404、未知remote target404、sessions200；真实 durable tmux shell54365、中文emoji文件精确、resize39×117、mux connected及实际PTY output均成立。
- **只终止本次自有 Node54141，exit0；同 shell54365继续写入 `NODE_SERVER_OFF_PTY_OK`。**Go close200、关闭后attach404、Go53927 exit0，已观察全部7对象末次无存活。
- 只通过源码可达性和实际HTTP404判定旧browser分派已停，**没有实测 `terminalRequest` counter，不能写成counter0**。tmux唯一自有socket最终kill-server返回1（session已关闭），原值保留；不报所有cleanup命令exit0，也未清理私有DB/log凭据目录。

Galileo原独立reviewer核唯一源码和两份低敏JSON给 **NO BLOCKING / SOURCE APPROVE**；未重跑DB/二进制或做Edge验收。一次性临时index、显式单path commit；pre cached/post show核对，主index原字节SHA `23b3e1cf…`、全entries `4f239d06…` 前后不变；peer旧暂存未同步。源码disk==commit。构件只私有加载，未改正式9527/标准binary/stamp，未操作用户草稿/终端/浏览器。

`webui-terminal-routes.js` **未整体删除**：账号launcher仍真实消费 `openWebUiTerminalSession`，已有benchmark脚本也还消费旧export；`go-core-host`/facade/stream方法因这些及未归零动态调用保持，不能从这次404外推无消费者。终端内Node `aih` shim、旧launch、全CLI parity、正式成对发布/Edge、remote/跨平台和全部42+7仍OPEN。

证据pointer `/tmp/aih-terminal-node-browser-retirement-latest-20261118.txt`；`evidence/source-manifest.json`、`retirement-operations.json`、`retirement-result.json`、`independent-source-review.json`、`commit-receipt.json`，私有log在root/private受限保留。没有新增测试、fixture、分支/worktree或第二份看板文档。


## 08:23 精确终端 list shim 转 Go（source checkpoint，未安装／未共享加载）

本次仅停止终端内 `aih ss --list` 与 `aih sessions --list` 的 Node 必要入口，不扩到其它 argv。适用批准为 `pm-253cb8cf`；原 R4 通过 `pm-a50396520248b5b4d0bddfe89b8a2a79` 明确释放独立 dispatch hunk，保留其后续 `__model-aliases-read` 插入区段。

四源码路径为 `internal/transport/http/webuiterminalapi/sessions.go`（仅委托）、同包新增 `aih_shim.go`、`cmd/aih/run.go`（global ss/sessions 后仅新增 `__terminal-sessions` 三行）、新增 `cmd/aih/terminal_sessions_entry.go`。没有复制旧 archive 的整份 `run.go`；当前 startup、detect、launch 等入口全部保留。新 shim 按正在运行的 package executable 位置选同目录 `aih-go`，不把 server 当 CLI、不搜索 PATH/递归 `aih`；路径逐项单引号转义、argv 保持 `"$@"`、无 eval。选中分支直接 exec，Go 缺失或失败都不回落 Node；即使 Node 不存在也生成 Go 分支。其它命令仍保留原 Node entry，Windows 原先不生成 shim 的边界未改。

仅私有内部 verb 补原 Node 列表 bootstrap：`AIH_HOST_HOME` → 非投影 HOME → OS user home；data root 为 `AIH_HOME_DIR` → `AI_HOME` → host/.ai_home。只读 `config:server` 中正常 typed management key/port，可选配置读取失败保留原注入值，覆盖只存在于本次 command lookup，不改进程全局环境，也不把 key 写入 shim/argv/log。任意非规范 JSON 的 JS String/Number coercion 不保证等价。复用现有 Go global list 业务；它会写 session cache，不能写成“列表零写”，所有实际运行均限定原有私有 HOME/namespace。

### 两条构件链与真实操作分列

1. **原批准私有链**：base `a331e43b2609686c96df76737c388cfed3b87b19` + 既有 retirement overlay `4bd40a68e4d25b90f25be69348daa7586b3672f1` + exact4，不能称为 current main 全树。CLI SHA256 `25ebe228075393cbf57d8efea0d0938fb5edb33ddcb6aed9ee4460c8d3643fba`，server candidate `1eb65594a3b33a9166f3c958939d5a963ac5913f472b3984d7f77ede9bf89810`（未 serve）。真实 generator 为另一制品 `0d9ec888d4202d4e455807de868ac3b7c5793a094d774e3b1275b4573eaee8ec`：overlay 替换 main 并在原包追加两个调用 wrapper，生产 helper 正文保持原字节；不是“产品 server 已生成”的证据。
2. **当前 main 集成链**：固定 committed base `2403e28874cf9b2ca32f5ac2759c37103eeb46cc` 的 git archive，仅叠本次 exact4，非共享 dirty cwd 构建。`go build -mod=readonly ./cmd/aih`、同 server build 与 focused `go vet ./cmd/aih ./internal/transport/http/webuiterminalapi` 均 exit0。新 CLI SHA256 `8db0eb72c9771c7977921279986b57527fd245666ad1be234e94356721da8258`、server `5cf646abfdc1e136228f5a9ed19e7f2c578cd2172af8228fa6f7ac15deb72496`。复用前述已批准 generator 制品在该私有 package 生成 shim，新 CLI 两种 list 均 exit0、输出相等，错误内部形态 exit1；没有新增 observer 或启动服务。构件是 base＋已列源码 overlay，不假称已内嵌待产生的 commit SHA。

原私有链的 22＋4 次操作观察含保留的重试/诊断，**不是 26 项独立要求通过**。真实 Node-absent 生成、两 literal list、AI_HOME/explicit host/nonprojected HOME、含空格和单引号的实际 CLI 路径均成立；额外参数、`-l`、大写 `SS` 均不命中新分支。Node 可用时选中缺 Go 实际 shell exit126；不可执行 Go 亦126；真实 Go broken stdout 为 SIGPIPE -13，均不能当正常业务成功、优雅取消或取消时延证明。没有 Node 回落由源码 exec 控制流及实际结果支持，不声明测得 Node counter0。

相邻命令确继续原 Node：纯 `__complete` 真实 exit0、298 bytes。原 `--version` 进入 Node app 后，因私有 Seatbelt 拒绝指向共享 node_modules 的 symlink，出现 `fs-extra MODULE_NOT_FOUND`；保留为环境诊断，**不计产品通过**，未为变绿放开真实 HOME 权限。初 missing-Go 操作误预期127、真实126，以及 generator 观察缓存复用错误，均只修操作脚本并保存原记录，未改产品语义。操作进程禁出站和读取/写入真实 `/Users/model`，无账号/会话/key fixture、无新凭据 DB 副本、无实际会话 input/abort/cleanup、无浏览器或远端动作。

### 审查、证据与未关闭门禁

- 原 Galileo source review `01a1ebf3-f087-7a91-9c51-488beb24e660`、冻结证据 review `01a1ebff-2319-7ac1-96ba-ba5a7906849b` 均 NO BLOCKING，仅 private exact4/source 与低敏绑定。后者复算21个文件，核52 raw 声明/大小但未重算 raw 内容；监督 `01a1eac1` 另核全部21＋52内容 hash/size 与26 own PID 已退出，审记 SHA256 `5cf287763cb53f197f3695b5ecaa33c7fae36809655141af58e2a8d7e0ce6f1c`。没有把两种 review 范围混写。
- 同既有证据 root（`/tmp/aih-terminal-node-browser-retirement-latest-20261118.txt`）中：`evidence/terminal-shim-private-ready-manifest.json` SHA256 `efd410775ece4c9cc961036e7de3146963db50d7bc11e62901a2c065e94dd92b`；`terminal-shim-private-result.json` `f9830566…`；`terminal-shim-failclosed-delta.json` `ba69c15a…`；`terminal-shim-current-main-build.json` `e591b1d1a9d9300ba00cc3ad38811017912bb506fbdac6d1c3c09de03eda20e9`；`terminal-shim-current-main-actual.json` `710ccccfb48bab8b4c220ce352e3ba70b7243f201d33a5ffb155a2649afaed9b`。原私有 DB SHA `0d18ac0ee53462a28386abae9da1629feae6fd6c660dc2d5e236e70ac0578eef` 前后一致；不是全 live DB 冻结声明。
- 允许的原私有 registry/projections 为空，两 list 是真实空 namespace 结果，**非空列表、真实持久化 management-key config 正例仍 OPEN**。未生成样本补齐；Linux/Windows运行与实际产品 server 生成 shim 尚未验。
- **source checkpoint 不等于 loaded/accept/Node 退役。**本次不替换标准 CLI/server、不改 stamp、不重启9527、不发布远端。既有标准 CLI `62ade266…`、server `9916c222…`仍保持；其旧能力不能拿新 source 代证。Terminal 其它 Node argv/旧 launcher/动态 caller、全 CLI 与最终第一方 Node 宿主退出，原42项＋7门禁，全部继续按原边界开放。

本次提交仅四源码＋本文追加；主索引原114个 peer entries（含本 paths 的反向旧暂存）保持，使用一次性临时 index 和显式 pathspec，提交前后 stat/blob/hash另存低敏 receipt。未写测试、未建分支/worktree、未清理私有或共享文件。
