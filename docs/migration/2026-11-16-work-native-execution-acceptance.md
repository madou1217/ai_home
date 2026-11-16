# WORK native execution/composer checkpoint — 2026-11-16

## Status and ownership

This continues the approved W0–W6 plan, not a replacement goal. Code checkpoint
`e036cf01f0e2e435551f1ca0b56a7570f3dd3776` contains 21 production paths
(1801 additions / 62 removals). Prerequisite `987a3d026` contains the immutable
protocol route/catalog views and its own evidence. Main owner is `01a1d99a`;
Gibbs delivered native execution and Mendel delivered the composer resolver.
Both workers froze their implementation before integration. The main owner
reviewed, validated and committed the integrated slice. Source checkpoint
`e036cf01f` was then pushed to `origin/main` with command-scoped SSH routing
through the existing AWS relay; no persistent Git/SSH/proxy configuration was changed.

**This is not full WORK or W0–W6 completion.** Authenticated AGY, global Claude
WORK parameter compatibility, remaining native transports, current-Edge visual
acceptance and shared WORK release remain open. No new tests, fixtures, mock
providers or copied-function test drivers were added.

Ordinary Chat is a separate owner/slice. Its separately approved shared release
uses source `85851ec39` and artifact `079a565db2f1be7ae138b1006e55558f48c966909f00776a974c8a1e4cbfc644`;
it excludes both our protocol-view prerequisite and this WORK checkpoint.
The Chat owner's release evidence is in
`../product-integrity/chat-gateway-routing-2026-11-16.md`. This session did not
restart shared services or replace the standard server binary.

## Implemented boundaries

- A focused `internal/host/worknative` adapter reuses account selection,
  credential resolution, provider strategies, projection and Capture. The
  credential-free execution descriptor is shared by composer and runner;
  catalog reads do not refresh credentials or write projection files.
- Child environments remove inherited account-scoped credentials and use the
  chosen strategy/projection. Logical provider names are distinct from actual
  executable aliases; Windows environment keys are normalized on all overlays.
- Preparation is released exactly once after process completion; release uses
  a bounded non-cancelled context. Capture failure remains a failed,
  non-retryable terminal even when the user requested interruption, instead of
  being hidden by an interrupted/success result.
- Actual start/resume transport and argv support govern eligibility. Unsupported
  gateway/ACP/Desktop paths fail explicitly rather than falling back to host
  credentials or claiming a native capability that is not implemented.
- Installed AGY 1.5.6 stream-json support is capability-checked with bounded help
  output. Init identity/order, step content, SUCCESS/ERROR and reported usage are
  parsed; authentication diagnostics are redacted. After SUCCESS the reader
  drains to EOF/process/stderr completion with a bound, rejecting malformed,
  duplicate or error tail data rather than immediately accepting success.
- Native composer and submission use one session-scoped model/default resolver.
  Account facts, enabled state, last-good discovery and unknown/empty/read
  failure differ explicitly. No unsupported reasoning-effort choice is silently
  passed or fabricated.
- Global gateway scope stays global, filtered by the actual client protocol,
  using one published route/model view. Ordered canonical resolution handles
  aliases and wildcard overlaps; an image-shadowed raw text name is excluded.
  Readiness is labelled `independent_current`, not misrepresented as the same
  generation as route state.
- Legacy provider-only default selection no longer overrides the new native
  composer default. Explicit payload/session model selection is validated and
  never silently replaced by another model.

## Exact code pathspec

```text
internal/host/aihserver/composition.go
internal/host/aihserver/webui_chat_runtime_routes.go
internal/host/aihserver/webuiroutes.go
internal/host/worknative/commands.go
internal/host/worknative/environment.go
internal/host/worknative/service.go
internal/host/worknative/strategies.go
internal/runtime/chatruntime/driver_native.go
internal/runtime/chatruntime/native_agy_process.go
internal/runtime/chatruntime/native_agy_stream.go
internal/runtime/chatruntime/native_launch.go
internal/runtime/chatruntime/native_launch_lifecycle.go
internal/runtime/chatruntime/native_model_account_catalog.go
internal/runtime/chatruntime/native_model_catalog.go
internal/runtime/chatruntime/native_model_gateway_catalog.go
internal/runtime/chatruntime/native_prepared_process.go
internal/runtime/chatruntime/native_stream_process.go
internal/runtime/chatruntime/service.go
internal/runtime/chatruntime/turn_lifecycle.go
internal/runtime/providercli/sessionchat/command.go
internal/runtime/providercli/sessionchat/transport.go
```

No ordinary-Chat production files changed: `gateway_catalog.go`,
`driver_gochat.go` and `lib/server/server-singleton.js` physically matched HEAD
at the ownership audit.

## Dependency and shared-index safety

The live checkout also contained six real, non-owned changes:

- `internal/runtime/configsnapshot/lock.go`
- `internal/runtime/claudedesktopconfig/{plan,prepare,publication,types}.go`
- `internal/runtime/toolkit/apps/open.go`

They were not staged, committed or reverted. Already committed
`configsnapshot` files and `providercli/launch_preparation.go` physically matched
HEAD; the new lock/Desktop files did not belong to this owner.

To rule out an accidental dependency on those files, validation exported
committed `987a3d026` with `git archive`, then overlaid only this owner's 21 source
files and plan. This is an ordinary temporary directory, **not** a worktree or
branch. Build/vet succeeded without the six peer changes. After the source
commit, all 5780 non-document files in its archive matched the accepted source
directory. The only intervening peer commit was documentation (`906a38799`).

A single-use temporary index was initialized from current HEAD. The exact
21-path staged set and `git diff --cached --stat` were checked before the explicit
pathspec commit, followed by `git show --stat` and committed-blob/physical-source
comparison. Primary `.git/index` SHA-256 remained
`56076bfccb9195863e4207acf59d3737285e7728ae573ff1308bb32cf8f19dea` before and after.
Stale reverse entries were preserved, not submitted as removals or broadly
synchronized. A targeted source credential-pattern scan found no matches.

## Independent review

Hubble reviewed host launch boundaries, immutable protocol views, model modules
and driver callback integration. Fixes included logical/binary alias separation,
false headless declarations, Windows environment casing, nonempty capability
encoding, canonical protocol/scope handling, wildcard display-name retention
and the legacy-default override. Its final model/callback review found no
remaining blocking finding in that scope.

Mendel independently cross-reviewed Gibbs' native execution/lifecycle code.
Three findings were corrected and re-reviewed: Capture failure masked by stop,
premature SUCCESS termination, and missing/duplicate/out-of-order AGY init.
Final narrow re-review also checked stable error-code recognition after driver
error reconstruction and that resume's prefilled session ID cannot hide a
missing init-event ID. The final review found no blocking finding in that
limited scope. These are source reviews, not authenticated AGY runtime proof. The final evidence
review also narrowed the pinned-Claude claim: that result does not prove a
file-projection or Capture path executed.

## Build and real operations

Production closure build and static verification both exited 0:

```sh
go build -o <private-artifact> ./cmd/aih-server
go vet ./internal/runtime/chatruntime ./internal/runtime/providercli/sessionchat ./internal/host/worknative ./application/inferencecatalog ./application/inferencegateway
```

All 21 source files passed `gofmt -l` (no output) and targeted `git diff --check`.
Accepted artifact SHA-256:

```text
f915dfa3dd19f5b73eed51cadc529f1bce4ea0fa713fc9be131ad00b7c0b305e
```

Closure manifest pointer: `/tmp/aih-work-native-closure-latest-20261116.txt`.
The same artifact was used for final real management API and installed-Claude
operations. Each service used an isolated loopback port, HOME/project directory,
private keys and a private SQLite backup; the source DB was opened read-only.
Operations deleted their private sessions, stopped only their own child server
and removed the private HOME/DB/project directory. No shared account/settings
mutation or replacement of the running server occurred.

| Actual operation | Observed result | Evidence boundary |
|---|---|---|
| Earlier committed-candidate baseline | Claude stored2 and CodeBuddyCN stored20, but WORK composer returned 200/empty; AGY gateway also success-empty | Actual private catalog reads, no native turn |
| Final pinned WORK catalog | Claude stored2/catalog2; CodeBuddyCN stored19/catalog19 | Counts reflect the current copied DB, not fixed assertions |
| Final Claude global gateway catalog | 200, 224 entries, `gateway_published` | Global protocol scope, not provider-local; not inference proof |
| Invalid native model submit | 422 `native_model_unavailable`, persisted failedTurn | Explicit rejection, no silent default |
| AGY gateway / absent AGY account | 422 `native_gateway_execution_unsupported` / 404 `native_account_not_found` | Capability/account errors, not authenticated AGY inference |
| Alias publication through real private management API | 200; wildcard `work-demo-v1` retained; image-shadowed `gpt-6.1-sol` excluded; removing shadow restores it; image model absent; generations42→43 | Ordered catalog result; operator's `acceptedIDs`/`dropped` fields were null and are not acceptance claims |
| Installed Claude 2.1.325, pinned account, `deepseek-flash` | submit202, completed assistant, idle; answer matches `WORK_NATIVE_OK`; no active turn remains | Actual account-bound native launch/request/output; projection/Capture lifecycle is source-reviewed, not exercised by this result; direct upstream had no new gateway usage-ledger rows |

Final operation records:

- `/tmp/aih-work-native-validation-closure-result-20261116.json`
- `/tmp/aih-work-catalog-alias-closure-result-20261116.json`
- `/tmp/aih-work-native-claude-pinned-closure-result-20261116.json`

All three record the artifact hash above and `privateResourcesRemoved=true`.
The earlier reviewed artifact (`76fae38a...`) observed CodeBuddyCN20/global223;
the final current-copy run observed19/224. These are different live snapshots,
not a claim that model inventory is constant.

### Additional limited evidence, not broadened into completion

- Last-good handling was observed on an earlier artifact
  `2d643fa872091338c8806b5e65c4e14b32e205ea930b146a849ede0574000607`:
  changing the private DB's existing probe outcome to failure retained Claude's
  two models and exposed `stale=true`, `discovery_failed`. This was a real local
  DB operation, **not a demonstrated upstream discovery outage**. Actual account
  PATCH enabled=false returned200; subsequent composer returned409
  `native_account_disabled`. Record:
  `/tmp/aih-work-catalog-lastgood-result-20261116.json`.
- Installed AGY1.5.6 natural no-credential execution exited1 after65.584s with
  authentication failure/timeout, without an external timeout. Isolated
  HOME/XDG, DEVNULL stdin and no credentials were used. Help/no-auth evidence:
  `/var/folders/nj/0mx5gymd41x8f64xcfm635440000gn/T/aih-agy-native-20261116-2oltx0e4/`.
  This is not an authenticated SUCCESS/resume/Capture run and not final-artifact
  proof of those paths. A fresh read-only account count still found zero AGY
  accounts on2026-11-16.

## Open gates / next work

1. **Authenticated AGY:** real account input/authorization is missing. Do not log
   in, copy unrelated credentials or invent a token. SUCCESS/resume/account
   projection and Capture still need genuine accepted business operations.
2. **Global Claude WORK:** an actual Claude2.1.325 native request reached private
   Go at `POST /v1/messages?beta=true` (model `gemini-2.5-flash`,12 tools) but got500
   "上游拒绝当前请求参数" and native exit1. No completed turn or usage acceptance.
   The trace recorded request key names only, not private payloads or credentials:
   `/tmp/aih-work-claude-protocol-result-20261116.json`. Reaching the correct
   endpoint does not make this business flow accepted.
3. **Transport/profile coverage:** currently unsupported cases such as Gemini
   PTY, Cline ACP resume, ZCode desktop and refreshable Claude OAuthProxy remain
   separate capability work; explicit rejection is not implementation of them.
4. **Visual/release:** no current-Edge WORK visual acceptance; no shared WORK
   deployment. The current Chat release does not contain this code. A later
   release needs its own reviewed candidate and coordinated authorization.
5. **Original scope:** preserve every remaining item in
   `2026-11-16-requirement-evidence-audit.md`. Do not close W0–W6 from this
   checkpoint, and do not treat the specific AGY credential gap as a reason to
   abandon unrelated actionable requirements.
