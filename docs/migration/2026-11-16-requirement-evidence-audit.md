# W0–W6 requirement-by-requirement evidence audit — 2026-11-16

## Scope and status semantics

Authoritative requirements remain **all** of `../superpowers/plans/2026-11-14-node-go-next-development-plan.md`, not the subset already implemented. Its42 work-package checkbox requirements and7 shared delivery gates are retained below in original order. No checkbox is removed, no route count is a completion percentage, and the goal is **active / not achieved**.

This audit read the current plan, source/contracts, execution ledger, owned acceptance documents, actual low-sensitivity results and current worktree/commit state. Other owners' review documents are integration evidence only; they do not become this session's repeated runtime acceptance. Dates/artifacts remain attached to the observation that produced them.

Status labels:
- **Verified scope**: the stated requirement's bounded process/source obligation has direct evidence. It does not close its containing work package.
- **Partial**: meaningful implementation/runtime evidence exists but the requirement is broader.
- **Source only / gap**: code suggests behavior, or the required evidence is missing; not achieved.
- **Needs input/capability**: particular acceptance cannot be safely completed with currently available credentials/browser/permissions; other goal work continues.

## Evidence key

| Key | Authoritative source / boundary |
|---|---|
| E1 | `2026-11-14-node-go-execution-ledger.md`, original W0–W6 chronology and scoped commits. |
| E2 | `2026-11-15-codex-response-tier-acceptance.md`, `2026-11-15-codex-ws-followup-acceptance.md`: real Canonical JSON/SSE, same-peer follow-up, explicit final-tier fidelity and controlled disconnect. |
| E3 | `2026-11-15-codex-managed-resume-tier.md`, `2026-11-15-codex-exec-resume-tier.md`: actual native new/resume/fork/typed controls, argv/profile/lease/stdin behavior and independent source review. |
| E4 | `2026-11-15-codex-default-platform-acceptance.md`, `2026-11-15-codex-default-reentry-acceptance.md`, `2026-11-15-codex-rollback-publication-acceptance.md`: native config/default journaling and actual Mac/Windows/Linux filesystem/CLI recovery, with precise-window boundaries. |
| E5 | `2026-11-16-standard-cli-windows-native-acceptance.md`, `2026-11-16-linux-native-exec-acceptance.md`: standard Mac CLI publication, actual Windows0.163.0/Linux0.167.2 business matrices and cleanup. |
| E6 | `2026-11-16-model-write-contention.md`: actual model-write contention, retry admission, cancellation, last-good retention and source-reviewed commit/publication boundary. |
| E7 | `2026-11-15-entry-inventory-checkpoint.md`; source scanner outputs and actual dynamic node-RPC21 leaves/30 operations; candidate inventory is not full feature verification. |
| E8 | `../reviews/2026-11-15-route-ownership-facts.md`, current `contracts/routeownership` and generated projection; health/readiness public/private direction. |
| E9 | `../reviews/2026-11-15-webui-management-checkpoint.md`, `...webui-assets-checkpoint.md`, `...native-session-watch.md`, `...session-watch-resources.md`: other owner’s scoped management/assets/watch records, not a rendered-page acceptance. |
| E10 | `../product-integrity/cli-contract-map.md`, `runtime-protocol-map.md`, `web-feature-map.md`, `extension-remote-install-map.md`, plus corresponding later committed reviews; initial audit findings need current-source reconciliation, not blind replay. |
| E11 | `../reviews/2026-11-15-desktop-host-migration.md`, `../product-integrity/backup-canonical-roundtrip-2026-11-15.md`, `hook-config-safety-2026-11-15.md`: parallel domains' explicit scopes and remaining limits. |

## W0: traceable baseline (6 requirements)

| ID | Original obligation | Status / evidence / remaining action |
|---|---|---|
| W0.1 | Recheck git state, cached scope and recent commits; distinguish ownership | **Verified scope, recurring:** each checkpoint inspects shared index, uses an allowlist/single-use index, verifies committed blobs. Stale reverse index entries remain peer-owned; never treated as physical deletion. |
| W0.2 | Restore set-default/effort/none/restart/status reproductions and artifact/PID linkage | **Partial:** E1–E5 cover actual failures and artifacts; latest complete lifecycle/status deployment correlation is not established for all platforms/current shared topology. |
| W0.3 | Inventory CLI/HTTP/WS/jobs/hooks/WebUI, retain unknowns | **Partial:** E7/E10 cover declarations/candidates and several dynamic leaves; every background/native/UI action still needs a leaf owner+behavior row. |
| W0.4 | Resolve public/private health/readiness owner by actual dispatcher | **Verified bounded source/route scope:** E8 plus current contract distinguishes Go public and Node private; peer Node-host incident shows why Go ready is not UI health. Whole-service usability is still separate. |
| W0.5 | Inventory scanner dynamic/subrouter/WS blind spots | **Verified inventory obligation, not coverage:** E7 retains four unexpanded Go expressions and asymmetric14-Node-candidate comparison; dynamic RPC manually reconciled. More runtime leaves remain. |
| W0.6 | Declare writable paths and safe integration order | **Verified scope, recurring:** own explicit boundaries/peer coordination in E1; no branch/worktree creation or reset/rebase/revert. Future overlap must be rechecked. |

## W1: model intent and transport consistency (7 requirements)

| ID | Original obligation | Status / evidence / remaining action |
|---|---|---|
| W1.1 | Follow effort/service_tier across HTTP, initial/follow-up WS, Canonical aliases, resume/fork | **Partial, substantial real coverage:** E2/E3/E5 cover these named paths and the original none failure. Account-switch/reference/tool subcases remain broader than these runs. |
| W1.2 | Evidence-based ladder mapping, unknown capabilities remain unknown | **Partial/source:** shared `effortalign` uses exact effective model; actual none→low and explicit low observed. Full low/max/unsupported/unknown-model matrix remains, including cross-protocol budget/reasoning preservation. |
| W1.3 | Model metadata exact-match, version, freshness, provenance and errors; not entitlement | **Incomplete:** `codexmodelcatalog.Reader` is exact-match with1h cache/1min error retention, but does not bind cache identity to binary version or expose a per-observation provenance/freshness contract. Current catalog augmentation and account-authority interpretation need completion; native fallback ≠ entitlement. |
| W1.4 | Actual profile/-c/CODEX_HOME/host precedence, preserve explicit overrides | **Partial:** E3/E5 prove current native root/profile/explicit controls and standard+Windows+Linux exec paths. Unusual profile provider/permission overrides, multiple candidates, non-AIH concurrent writers and legacy native versions beyond these remain. |
| W1.5 | Observe requested and final tiers separately, never forge priority | **Verified for exercised response paths:** E2/E3/E5 show priority delivered and actual default retained. Failed snapshots carrying a tier and every client renderer are not all runtime-covered. |
| W1.6 | Bounded transport retry; no replay after output/tools/cancel; no duplicate accounting | **Partial:** real post-output cut and helper loss show no replay; generation usage rows match. Tool side-effect retry and all transports' pre-output retry/timeout boundaries remain. Peer WS tool-continuation fix is separate evidence. |
| W1.7 | Cancellation/idle/reconnect/resume/account-switch continuity cleanup | **Partial:** E2–E5 include real cancellation/process/lease/continuation; no exhaustive idle/reconnect/account-switch encrypted-reasoning matrix. |

**W1 matrix still open:** maximal effort, deliberately unsupported/unknown capabilities, all protocol/model/account combinations, precise tool replay and final cost semantics. The account returning default despite priority is an external observed capability boundary, not a local speed-success claim.

## W2: lifecycle and config safety (6 requirements)

| ID | Original obligation | Status / evidence / remaining action |
|---|---|---|
| W2.1 | Identify actual executable/argv/listener/process tree, not basename | **Partial:** E1 records real two-instance/MCP-helper/forced-parent validation and creation-identity fixes. Current platform services/installer variants require renewed authoritative observation. |
| W2.2 | Separate Node fingerprints from Go build identity | **Partial with new delivery proof:** E5 records769 committed dependencies, stable build window and standard CLI hash; does not prove running server loaded all current source. |
| W2.3 | Stop/restart scope restricted to current home; do not stop unrelated instances | **Partial:** E1 real macOS dual-instance and helper isolation; complete Linux/Windows service lifecycle matrix is still missing. |
| W2.4 | Build/start failure retains previous service/artifact/config | **Partial:** atomic CLI publication preserved old executable and didn't touch server; full failed release/start rollback remains unexecuted under current restrictions. |
| W2.5 | Preserve comments/CRLF/profile/symlink/mode; reject bad TOML/concurrent overwrites | **Partial with direct evidence:** E4/E5 cover real cross-platform file semantics/crash recovery; power-loss and every adversarial edit window unproven. |
| W2.6 | Real managed-service/PID semantics on three platforms, not old reports alone | **Incomplete:** native CLI execution is now real on all3, but that's not systemd/launchd/scheduled-task restart/stop/boot acceptance. Existing job observations are read-only. |

The plan's complete start→status→restart→status→stop→start maintenance matrix is not waived. Shared-service restart is explicitly prohibited in the current authorization; no command is run merely to satisfy a checklist. OS reboot acceptance remains separately gated.

## W3: remaining Codex CLI migration/discoverability (6 requirements)

| ID | Original obligation | Status / evidence / remaining action |
|---|---|---|
| W3.1 | ID/ref/gateway/default/policy/home/version/mobile semantics | **Partial:** E1/E3/E4 and actual CLI source map cover most; set-mobile/unset-mobile and every account-selection variant need current real acceptance. |
| W3.2 | Go default ownership, coherent account/auth/config/App effects | **Partial:** single-store transaction and public/legacy front doors committed; real journal/default recoveries verified. Desktop reload/restart effects remain explicit Node compatibility and lack complete real App-state proof. |
| W3.3 | App absent/stopped/running/reload failure distinguished | **Source/partial:** CLI effect contract preserves warnings and committed default; actual four-state Desktop matrix missing. No App restart is inferred authorized. |
| W3.4 | Strict dispatch/escape; invalid params never become prompts or silent fallback | **Partial:** real exec argv/identity/stdin/unknown-option failures and Go dispatch covered; full command/legacy entry matrix remains. |
| W3.5 | Help/completion/TAB resolves to same executed command | **Partial/source:** help and completion include effort/default; other owner records shell/TAB work. All Codex actions need real shell acceptance across supported platforms. |
| W3.6 | Remove duplicate logic only with traceable owner/exit conditions | **Partial:** defaults and native control use focused Go modules; Node default/TUI/legacy adapters remain intentionally explicit, not fully retired. |

## W4: credentials/catalog/routing recovery (6 requirements)

| ID | Original obligation | Status / evidence / remaining action |
|---|---|---|
| W4.1 | Coordinate resolver/force-refresh/recovery ownership | **Verified process scope:** peers' files respected, focused model-write scope announced; no blanket ownership transfer. |
| W4.2 | Refresh singleflight, version/CAS, old snapshot retention, cancellation | **Partial:** API-key async refresh dedup and snapshot failure retention real; OAuth rotation/singleflight/CAS remains source-only because current local Codex accounts are two API-key accounts and zero OAuth. |
| W4.3 | Distinguish401/403-WAF/429/5xx/network; no permanent bad account for transient failure | **Partial/source:** observers/guard code and real disconnected-directory retention exist; safe actual taxonomy across account types remains unverified. No token sabotage or quota exhaustion is used. |
| W4.4 | Atomic discovery replacement/manual policy, coherent routing generation | **Partial:** E6 actual refresh retains policy and last-good on failure; commit/publication ordering reviewed. Full concurrent route-generation/account-version business matrix remains. |
| W4.5 | Bounded SQLite conflict handling and visible errors | **Partial:** E6 repairs and proves the two model-writing paths; other credential/profile/quota/rules writers are not implicitly covered. |
| W4.6 | Recovered model/route/quota/UI share observed account version | **Incomplete:** some API/source facts align, no full authenticated browser/account journey with actual OAuth version change. |

## W5: management/WebUI journey (6 requirements)

| ID | Original obligation | Status / evidence / remaining action |
|---|---|---|
| W5.1 | Login/session/auth/assets/public-management aliases/errors without loops/bypass | **Partial:** E7/E9 actual auth/method/not-found/assets scopes; current shared Node incident owned by peer. Full login/authenticated UI not established by ready/HTML200. |
| W5.2 | Account list→detail→config/rules→auth job→refresh→actual launch, single writer | **Incomplete:** individual backend operations real, end-to-end rendered journey missing. |
| W5.3 | Watch initial/incremental/reconnect/auth change/close | **Partial, peer evidence:** E9 reports actual native watch lifecycle/resource checks; current browser reconnect/render and all remote identities remain. |
| W5.4 | Cache/remote key/TTL/invalidation/identity/error isolation | **Partial/source:** source contracts and several auth endpoints checked; full cross-identity cache/remote journeys not closed. |
| W5.5 | Unknown/unsynced/zero quota/token/cost, reconcile retries/cancel | **Partial:** real generation/prewarm usage counts documented; cost/price and all unknown-versus-zero UI presentations remain unverified. |
| W5.6 | Real existing Edge desktop checks, no replacement browser or banned automation | **Needs capability:** Edge PID1219 exists but no listening CDP port and no usable browser tool found. No AppleScript/Apple Events/browser launch workaround. Build/API checks are not a substitute. |

## W6: remaining domains/legacy exit/release (5 requirements)

| ID | Original obligation | Status / evidence / remaining action |
|---|---|---|
| W6.1 | File-level child plans for each other Provider/extension, no Codex inference | **Partial:** E10/E11 identify16 providers/14 CLI and domains; explicit child implementation/acceptance plans and each current leaf status remain to be consolidated. |
| W6.2 | Remove double writes/implicit Node fallbacks before owner flip; deletion evidence | **Partial:** single DB/default/model writes and selected native routes have evidence. Protocol/native/desktop/compatibility residuals still require caller/traffic proof; no broad deletion. |
| W6.3 | Unique contract/projection/help/install docs/build/package completeness | **Partial:** manifest checks pass, standard CLI and helper delivery tracked; complete package/installer release closure needs current artifact-specific review, not count65/67. |
| W6.4 | Actual install/upgrade/start/config-preserve/stop/recover on3 OSes | **Partial:** current native CLI business/crash checks real; full global install/upgrade/service lifecycle not done. Temporary official package ≠ global installation. |
| W6.5 | Scoped release/rollback artifacts, never reset/revert peers | **Verified bounded process:** old standard CLI retained with hash, atomic publish, no history rewrites; broader release rollback strategy remains tied to future package/runtime delivery. |

## Shared delivery gates (7 requirements)

| ID | Requirement | Current proof boundary |
|---|---|---|
| G.1 | Root cause, retained behavior, precise files | Owned checkpoints explicitly document each; missing domains remain open. |
| G.2 | Real before/after commands with date/version/PID/account-safe evidence | Owned E2–E7 records provide it; do not borrow another platform/version's proof. |
| G.3 | Success/failure/cancel/retry/restart/recovery/adjacent paths | Partial by exact matrix; do not infer unexecuted cells. |
| G.4 | Actual parameters/config/terminal/usage-cost/cleanup, not HTTP200 | Parameters/terminal/usage/cleanup observed in owned scope; full cost and UI still missing. |
| G.5 | Independent review intent/fallback explicit | Initial capability failures and narrow self-review bypasses documented; Hubble later independently closed exec and model-write findings and reviewed platform evidence. Not retrospective approval of all old work. |
| G.6 | Build/contract/diff checks; no new test cases | The original plan §6 command list continues to apply. Fresh checks recorded per checkpoint; earlier subagent temporary-fixture deviation was stopped/excluded, not hidden. No new test files in owned commits. |
| G.7 | Source/build/load/accept/commit/push separate | All owned source checkpoints pushed with explicit allowlists. Standard CLI now loaded; model-write server patch only isolated validated/committed, not deployed. Shared server restarts by peers are not this session's release evidence. |

## Next executable actions and capability requests

1. **W1 metadata provenance:** finish exact model/binary identity/freshness/error reporting and version invalidation; validate with actual installed native releases without modifying shared CODEX_HOME. Preserve current entitlement distinction.
2. **W1 transport and effort cells:** run bounded real low/max/unsupported/unknown model checks and cancellation/reconnect/reference transitions; cooperate with the peer's WS-tool work instead of rewriting it.
3. **W2/W3 lifecycle/discovery:** use isolated real services/CLI shells where safe; do not restart shared gateway. Complete remaining mobile/default/help/TAB and App-state evidence with required user-visible authorization boundaries.
4. **W4:** expand conflict handling only after real evidence in the next writer domain; actual Codex OAuth rotation requires an approved OAuth account/flow that is currently absent. No fake token/refresh fixture is acceptable.
5. **W5:** request/use a supported background connection to the already-running Edge; absent that capability, retain the visual gate. OAuth/account write journey needs explicit safe account selection and final-state scope.
6. **W6:** reconcile peer domain findings with their later commits, create remaining file-level child plans and validate release artifacts; do not revive already-fixed historical issues or mark scope done from directories/contracts.

**Completion decision: not achieved.** No completion/blocked/paused status update is justified: concrete safe remaining implementation work exists, while credential/browser/service restrictions apply only to particular acceptance cells.

## Independent audit review

Hubble independently checked numbering/order (42 work-package items plus7 shared gates), reference existence and evidence limits, and reported **no blocking documentation/evidence issue**. The original plan §6 commands remain authoritative; shared restart still requires the applicable authorization. The reviewer did not repeat runtime operations, alter files/index or change goal status. This review approves the accuracy of the unfinished-work ledger, not completion of the project.
