# W1 WebSocket follow-up effort alignment — 2026-11-15

## Reproduced root cause

The initial and switched-model WebSocket frames called `Handler.prepareClientFrame`, applying exact-model effort alignment and continuity sanitization. The ongoing `pumpClientToUpstream` loop only called `normalizeClientFrameModel`. Therefore later `response.create` frames silently bypassed the shared preparation policy.

A real, same-connection two-turn request reproduced the original user-facing failure:

| Turn | Client model | Client effort | Observed upstream effort | Outcome |
|---|---|---|---|---|
| 1, before patch | `gpt-6.1-sol` | `none` | `low` | completed |
| 2, before patch | omitted | `none` | **`none`** | upstream `error`, `unsupported_value` |
| 1, after patch | `gpt-6.1-sol` | `none` | `low` | completed |
| 2, after patch | omitted | `none` | **`low`** | completed |

Both before/after second frames had the concrete model restored upstream; the defect was missing alignment, not failed model inheritance. This evidence refutes any claim that first-frame success established full WS parity.

## Minimal change

- `internal/transport/http/codexresponsesws/handler.go`: call the client pump as a Handler method; fresh-peer preparation composes the shared bound-frame policy with its existing sanitization.
- `internal/transport/http/codexresponsesws/session.go`: after the existing serial/model checks and foreign-account reasoning stripping, send every subsequent frame through `handler.prepareBoundClientFrame(payload, observer.model, observer.route.ModelID().String())`.
- New focused `frame_preparation.go`: normalize the bound model and align effort, without deleting this connection's `previous_response_id` or same-account encrypted reasoning.

The same live ladder source and effective routed model now govern initial, switched-model, and continuing frames. Independent review rejected an earlier draft that reused full fresh-peer sanitization on later frames; the final patch deliberately retains continuity on the existing peer, with the existing foreign-account stripping still conditional. Existing client-observer identity, serial validation, model-switch handoff, upstream writes, error handling, and usage flow remain unchanged. No test cases were added.

## Real network evidence

Built the complete Go server, ran it on an independent loopback port using a permission-restricted backup of the single business DB and isolated HOME, and selected the existing approved Codex API-key account. A transparent WebSocket relay forwarded the actual upstream handshake and frames; it did not supply simulated responses. The client sent exactly two `response.create` frames with the short prompt `Reply with only OK.`, `none`, and `priority`, omitting model only on the second frame. The final verification also passed the **actual first response ID** as `previous_response_id` on the second request while retaining `store:false`; the transparent relay confirmed that reference was present upstream, and both rounds completed. No response ID contents were persisted in the report.

After the patch:
- Relay recorded exactly two outbound frames, each `gpt-6.1-sol`, effort `low`, tier `priority`; the second frame retained its actual continuation reference.
- Both actual upstream and client received created `auto` → completed `default`; each success had 11 input / 5 output / 16 total tokens.
- Exactly **two** new usage rows existed beyond the clone's pre-request maximum usage ID, one per completed round.
- An earlier timestamp-only observation counted a history row included in the concurrently active DB backup. That count was not duplicate-write evidence; the operator was corrected to an ID boundary and the live two-round exchange was repeated. The final result uses the ID boundary.
- The client socket was deliberately terminated by the operator only after both terminal responses; recorded close 1006 is teardown behavior, not evidence of a graceful close or a failed inference round.
- All isolated runtime processes, relay sockets, and database/HOME backups were removed; no original DB or credentials were modified, and shared 9527 was not restarted.

```sh
go build -o /tmp/aih-w1-ws-after-20261115 ./cmd/aih-server
node /tmp/aih-w1-ws-live-20261115.js
go build ./...
```

Builds exited 0. The temporary JavaScript operator opens real client and upstream WebSockets and records bounded facts, not mocks or test fixtures.

- Before binary SHA-256: `4fa0cf97826e7a17512ce8ac11235e675e5a3739253ea44f7a9a28ef9b1f2c55`.
- After binary SHA-256: `2130c21f5d1415e4cf56b52efe3390eaa0304ac54813500b1f1e6776843704bb`.
- Low-sensitivity results: `/tmp/aih-w1-ws-before-result-20261115.json`, `/tmp/aih-w1-ws-live-result-20261115.json` (ephemeral).

## Review capability resolution and explicit commit bypass

The original independent reviewer identified that an earlier draft calling full fresh-peer `prepareClientFrame` on follow-up frames would erase `previous_response_id` and encrypted reasoning. That finding was accepted, not waived: the final focused `prepareBoundClientFrame` only normalizes model and aligns effort, and the actual same-peer continuation run above verifies delivery of the real reference.

Final independent re-review could not finish: original reviewers `01a1ddec-f990-7021-a868-d29c4f49fb0c` and `01a1db22-22d7-75c2-87b4-bcdef3ae7a3c`, followed by replacement `01a1df02-54d6-7993-b504-c287d4e0cb8c`, all terminated with tool-protocol HTTP400 (`No tool call found for function call output`). This is a review-runtime failure, not approval. No native review tool was available through capability discovery.

**Documented narrow bypass:** following AGENTS' reviewer_subagent → native_review → self_review resolution, the main agent uses explicit self-review plus actual final-artifact validation for this scoped commit. Self-review traced all three sending paths, confirmed the observer's model/route are immutable during each pump pair, serial/model-switch checks run before preparation, alignment mutates only `reasoning.effort`, and after-model-switch observers are replaced only after both old pumps end. It checked that foreign-account stripping remains unchanged and the continuation path does not call the sanitizer. `go build ./...` and scoped `git diff --check` passed. The risk retained is absence of an independent final review and the unexecuted broader matrix, not an assertion of complete approval. No shared-service restart/deploy, account mutation, or destructive action is included in this bypass; the goal remains active.

## Remaining gates

This proves the native same-model follow-up omission case, not the full W1 matrix. Native CLI resume/fork, same-account encrypted reasoning with actual encrypted content, changing model/account, client cancellation/idle/reconnect, tool replay, low/max capability matrices, unknown catalog behavior, upstream-granted priority, and shared-runtime deployment remain separate requirements. `priority` was delivered but the provider reported actual `default`; this must remain truthful.
