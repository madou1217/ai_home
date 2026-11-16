# WORK native execution and composer repair

## Goal and original boundary

Continue the original W0–W6 native/runtime requirements. Ordinary Chat remains gateway-owned and independent of native CLIs; WORK (nonempty projectPath) and terminals retain native runtimes. Do not reinterpret All accounts as a provider-local pool merely because the UI has a provider label.

The ordinary-Chat owner records its code, private acceptance and separately user-approved shared9527 deployment in `../../product-integrity/chat-gateway-routing-2026-11-16.md`. Its released candidate is based on `85851ec39`; it does not contain this WORK integration. This work does not change `gateway_catalog.go`, `driver_gochat.go`, ordinary-Chat routes, or the Node singleton repair, and does not authorize any shared restart.

## Ownership / disjoint write sets

| Work slice | Owner | Writable boundary |
|---|---|---|
| AGY stdout, native account environment, actual transport | Gibbs `01a1e041-4e70-7113-a206-544d22e4f13c` | `driver_native.go` excluding composer method; `native_stream_process.go`; focused new native runtime files; necessary AGY hunks in `providercli/sessionchat/{command,transport,helpers}.go` |
| Non-Codex WORK composer source/default/turn validation | Mendel `01a1e041-ce36-75d2-970c-2f1678526c14` | focused `native_model_catalog.go` / related new files; native-only catalog branch if needed; no ordinary-Chat source |
| Shared contracts and host/service composition, acceptance, review and delivery | Main W0–W6 owner `01a1d99a-db6e-7d82-b2ba-90fe5fb41e23` | exact callback/dependency hunks in `service.go`, `webui_chat_runtime_routes.go`, `webuiroutes.go`, `composition.go`, focused host adapter; composer driver hunk only after coordination |

Only the main owner stages/commits this slice after review. Every commit uses explicit pathspec and before/after staged/committed scope inspection. Peer stale index reversals are not worktree deletion and are never reset/cleaned/committed.

## Current evidence and plan

- [x] Recover original owner/scope and check current physical source against HEAD, not stale cached diffs.
- [x] Confirm ordinary Chat and WORK separation; old Node WORK gateway reader preserves a global pool, while actual CLI endpoint/env/transport determines whether it can consume that pool.
- [x] Real baseline using committed production server hash `079a565db2f1be7ae138b1006e55558f48c966909f00776a974c8a1e4cbfc644`: pinned Claude has2 stored models and CodeBuddyCN20, yet both WORK composer reads return200 with zero models/default. AGY gateway likewise returns success-empty. Private session creation/catalog reads only; no native turn or credentials executed. Evidence `/tmp/aih-work-catalog-baseline-result-20261116.json`.
- [x] Establish a shared, credential-free native execution descriptor (account-native vs gateway, actual client protocol, confirmed account/CLI) supplied by the same launch policy the runner uses.
- [x] AGY: inspect installed 1.5.6 help and its actual natural no-auth ERROR output; implement/review stream-json identity, content, terminal and usage handling. Authenticated SUCCESS/resume remains a separate unchecked gate below, not inferred from help.
- [x] Account launch implementation and pinned Claude real acceptance: reuse existing account selection, credential resolver, provider strategy and projection/CAS capture. Never inherit host credentials or HOME for a selected account merely because an AccountRef was supplied.
- [x] Actual transport must govern runner/approval behavior. Unsupported gateway/ACP/Desktop paths must be explicit, not silently substituted with host-native execution or falsely advertised.
- [x] Native composer and turn validation share one session-scoped catalog/default rule. Explicit account scopes require provider/account facts; global gateway scopes retain global meaning only through their actual protocol. Unknown/read failure/known empty/unsupported are distinct.
- [x] Preserve explicit model selection: a provider command mapping that cannot represent a chosen model may not silently omit it and run a different default.
- [x] Independently review the focused source, build only the committed dependency closure plus owned changes, and validate real private management APIs, invalid submissions, alias publication and pinned Claude native output/cleanup. Hubble and Mendel source findings closed; see the acceptance document for which runtime gates remain unproven.
- [x] Check ordinary Chat production sources remain unchanged and commit only 21 owned source paths as `e036cf01f`; primary index bytes preserved. Build and real acceptance are recorded separately from push and runtime loading. No shared WORK deployment is implied.
- [ ] Authenticated AGY inference, resume, selected-account projection and Capture: no registered local AGY account; no login or credential fabrication.
- [ ] Global Claude WORK native request compatibility: real `/v1/messages?beta=true` reaches the private Go gateway but upstream rejects parameters. Not closed by ordinary-Chat success.
- [ ] Other genuinely unsupported native transport/gateway cells, current-Edge visual acceptance and separately authorized WORK release remain open; original W0–W6 Goal is not complete.

## Acceptance restrictions

No new tests, fixtures, mock providers or temporary copied-function drivers. No new worktree/branch, no history rewriting, no user credential/rollout edits and no service restart. Do not touch terminal recovery/draft files.

Current local account inventory contains no registered AGY account. Official CLI help/version and isolated no-credential failure operations are legitimate protocol evidence, but are not OAuth or successful AGY inference. Do not log in, fabricate credentials, or use an unrelated provider's success as AGY proof. Any genuine business capability/input gap remains explicit.

Real browser acceptance must use a supported connection to the existing Edge only, with no focus-stealing launch or AppleScript/Apple Events. API/catalog success cannot replace visual acceptance.

## Current checkpoint boundary

The two owners delivered their disjoint files and the main owner integrated the shared host/service/turn callbacks. Actual WORK composer baseline and after-readings, alias collision/wildcard cases, account disabled rejection, last-good observation, and a pinned Claude native completion are recorded separately. Full AGY authenticated execution remains unverified because no registered AGY account is available. Global Claude WORK through Messages gateway produced a real500 upstream-parameter rejection and remains a separate unresolved protocol/business path; it is not replaced by the successful pinned native observation.

The snapshot-scoped protocol-view prerequisite was independently reviewed and committed as `987a3d026`; the bounded WORK integration is committed as `e036cf01f`. Authenticated AGY and the other open gates above remain subsequent work, not a completed full-WORK claim. No shared service restart or ordinary Chat source change is included.

## Checkpoint evidence

`../../migration/2026-11-16-work-native-execution-acceptance.md` records the exact source paths, peer dependency exclusion, independent review corrections, closure artifact hash, dynamic catalog observations, successful pinned native turn, and remaining runtime gaps.
