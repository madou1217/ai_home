# Desktop host migration — 2026-11-15

Status: implementation/isolated acceptance in progress; full Node→Go objective remains active. No production restart, registration/permission mutation, desktop selection capture, UI automation or paid translation request was performed.

## Ownership being migrated

Node previously owned native helper build/start/JSONL, selection/focus/target state, translation execution and local Chat bridge. The Go implementation separates:

- `desktopbuild`: native source snapshots, package identity/icons/signature/disclaim, bounded tool output, cached artifacts, OS environment allowlist, explicit registration opt-in.
- `desktopprotocol`: versioned bounded JSONL and payload projections, no silent chat/message truncation.
- `desktoplauncher`: one helper, start singleflight, bounded in/out queues and bytes, writer deadlines, handshake, retry budget, process-group/reaper cleanup.
- `desktoptranslation`: latest-selection worker, independent operation/delivery/config contexts, focus leases, target-scoped model catalog and existing translation runner reuse.
- `desktopchat`: local bindings/subscriptions over the real canonical Service, not ownership of persistent sessions.
- Focused HTTP handler for system/focus and host composition. Node child receives an explicit Go owner flag and skips the old helper; old standalone Node topology remains compatibility-only.
- Standalone `aih-server __desktop-translation`; the old `bin/aih-translation.js` is only a process-launch shim, no Node business host fallback.

## Migration details recovered and fixed

- `WriteSettingsPatch` had omitted desktop fields that its reader normalized (enabled, server targets, execution target, shortcuts, theme). Writes now use existing SQLite `UpdateKV` to serialize read-modify-write and preserve stored unknown fields while rejecting unknown patch mutation.
- Local management key is sent only to the exact local origin or its private native configure pipe. Another loopback port receives no local key. Remote credentials require an explicit persisted profile with matching origin; redirects are refused.
- Selection cancellation, target/config changes and child exit invalidate separate delivery identities. Normal operation completion does not cancel queued final frames. Control cancel is enqueued before new configuration/selection; already-written frames cannot be retroactively retracted.
- Direct gateway translation routes build canonical translation messages; explicit model selection filters selection-capable routes and prefers exact provider/model before the existing provider fallback.
- Translation output is budgeted by encoded JSON size, split at UTF-8 boundaries; partial done omits the text key (Windows would otherwise clear output on empty text). Enqueue failures cannot be followed by a false success.
- First authoritative SSE terminal closes the body rather than waiting for EOF; errors cannot coexist with OK=true or be reversed by later done. Partial text is retained on a read failure.
- Chat close/late open/overflow never deletes canonical history or implicitly interrupts accepted turns. No DeleteSession capability is present in the bridge interface.

## Real native build/protocol evidence

Builder checkpoint `eca78b8b6` includes 9 exact paths, independently reviewed/frozen. Evidence root `/tmp/aih-desktop-build-20261115-a81ew62b`.

macOS arm64 and Windows amd64, both helper and full-app, were actually built and run in `--protocol-only`: hello→ready/status, configure/status, unsupported permission/focus rejection, version error, shutdown→exit0 with stdin kept open. This mode branches before AppKit/WinForms/AX/Services/shortcuts/clipboard initialization. No fake helper protocol is used.

A real macOS failure was found: Foundation read(upToCount:) withheld hello until EOF. POSIX read fixed the persistent-pipe handshake. Earlier EOF-only evidence is not counted as duplex success. Signed bundle identity/LSUIElement verified; cached rebuilds reused artifacts (mac 21/50ms, Windows91/97ms), no compiler obj/bin pollution in repo or native process remnants. Registration remains explicit and was not executed.

## Go launcher / service evidence

- `/tmp/aih-desktop-launcher-20261115-*/lifecycle-reaper-race.jsonl` and final replay: eight concurrent starts produced one build and one real helper; configure succeeded; killed wrapper was reaped and replaced; Stop/re-enable/Close succeeded with no child remnants. Dedicated child process groups avoid leaving the disclaim child alive.
- Same actual native full-app protocol executable sent shutdown: launcher Wait returned nil/stopped with no child. Normal host now waits for child exit, not only SIGTERM.
- `/tmp/aih-desktop-service-20261115-cpATjN/service-final-race.jsonl`: actual protocol helper enable, concurrent focus/status, execution-target switch, disable/close. Different loopback origin keyless, matching profile uses its own key, profile/origin mismatch rejected.
- `atomic-settings-race.jsonl`: concurrent actual SQLite patches retained enabled/execution/shortcut/theme/target/chat-shortcut fields plus existing `futurePeer` metadata.
- `/tmp/aih-desktop-api-20261115-wvvaw7yf/observations.json` (full Go race server, disabled helper): system wrong key401; settings POST/GET200 with desktop fields persisted; focus200; system reflects execution target and enabled=false; no helper children; SIGTERM exit0 in1.019s, no race report. Does not prove rendering or successful inference.
- `/tmp/aih-desktop-standalone-20261115-76fcOA`: built actual full-app source through standalone Go command with protocol-only and exited0.

## Chat bridge evidence

`/tmp/aih-desktopchat-proof-2juWxW` records real Service/SQLite/Actor/attachment behavior and official Claude local `/cost`/`/help` with OS network denied. Concurrent idempotent opens, events before dispatch ACK, contiguous seq, stop-before-accept, generation/identity rejection, actual attachment persistence and symlink rejection, bounded overflow, late-open suppression, and close preserving history were observed. Ten sessions remain persisted; bridge listeners zero; no process remnants or race stderr. Only explicit chat.stop interrupts; closing view/bridge does not delete or stop canonical sessions.

## Unverified boundaries

Normal native UI, desktop capture, permission prompts, successful paid translation, remote translation profile network behavior, and full-app/window rendering remain unverified. Protocol-only validates actual IPC/process behavior, not those UI capabilities. Linux native UI remains unsupported as before. Callback implementations must honor context and return promptly; Go cannot forcibly stop arbitrary host code. Build interruption can leave a lock that times out explicitly rather than deleting an unknown writer.

## Local checkpoints and final checks

- `eca78b8b6` — real native build and safe protocol-only mode (9 paths).
- `d59df1fc7` — bounded Desktop Chat bridge preserving canonical history (8 paths).
- `2d3fb2e2d` — protocol, launcher, translation host, atomic settings and system/focus adapter (14 paths).
- `c4070b895` — helper/standalone ownership composition and Node compatibility boundaries (13 paths).

Final independent scoped source review cleared the reported P1/P2 items, including JSON-encoded output budgets, delivered-partial completion, disabled stale helper requests, writer unknown-field preservation and standalone child-exit handling. Full `go build -mod=readonly ./...`, focused vet, Windows/Linux package cross-builds, JS syntax checks, generated manifest check and whitespace checks passed on the current tree. No test cases or mock suite added.

All commits used explicit paths with staged and committed scope checked. For shared composition, a one-use temporary index selected only this slice's hunks; patch commit explicitly rejected both peer hunks, committed blob hash was verified, and only unchanged owned main-index entries advanced. Peer worktree changes remained untouched. No push, deployment or production restart by this session. Manifest owner changes refer to precise new registrations, not full feature/visual acceptance or production adoption. The standalone JS process shim and other remaining runtime domains mean the whole project is not Node-free.

## Legacy topology single-owner follow-up

`79eb54c9` explicitly marks Node-supervised Go children as desktop-managed-by-host, while Go-supervised Node children remain owner=go. The legacy flag skips Go helper/system/focus assembly rather than starting both helpers; standalone remains Go-owned. A real isolated race server with persisted systemEnabled=true and owner=node returned404 for its unowned system path (no Node front door configured in that verification), spawned no children, and exited0 in1.014s. Normal Go-owner system200 was verified separately. Evidence: `/var/folders/nj/0mx5gymd41x8f64xcfm635440000gn/T/aih-desktop-topology-20261115-1xn0an0i/observations.json`. Independent scoped review passed; composition peer hunks excluded with the same one-use-index safeguards. No production topology was changed.
