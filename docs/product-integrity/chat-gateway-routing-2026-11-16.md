# Chat gateway routing repair and real acceptance

## Ownership and scope

The original ordinary-Chat work belongs to session `01a1dd52-79e3-73d3-b500-5edfe47c0ca4`, including commit `7c3dcffc7` and `docs/plans/2026-11-15-chat-gateway-independence.md`. That session is absent from the current peer registry. Follow-up session `01a1dfb7-34fe-7582-ab9b-ad8b8e55f2d6` owns this repair and its evidence. Coordination messages were sent to the recovery coordinator and W0–W6 owner; queued delivery is not an acknowledgement or release approval.

This change covers ordinary Chat (`projectPath` empty), including an AGY-labelled session using All accounts. All accounts retains its global gateway meaning. Native WORK execution is a separate runtime.

## Confirmed causes

1. Chat constructed its model list from account discovery and usage snapshots instead of the gateway's published execution catalog. On the actual 9527 service, its composer offered 238 IDs while `/v1/models` exposed 224. Its first/default model, `DeepSeek-Flash`, was absent from the gateway and failed with 503. Selecting the actual published `gemini-2.5-flash` completed with `ROUTE_AGY_OK`. The exact historical OpenAI-related wording from the user's original failure was not recovered; this is the independently reproduced failure mechanism.
2. Gateway display models are deduplicated by model ID. Using that display list to recover account eligibility loses providers when several providers carry the same ID. A private-service acceptance caught this intermediate error; the final implementation retains all provider/model carrier tuples independently of the public display list.
3. A compiled alias can be valid for one client entry or provider only. Chat must read aliases that resolve through OpenAI Chat Completions and intersect their actual compiled providers with eligible carriers. An auto-target alias must not imply support by relay providers without alias routes.
4. The supervised Node singleton read its Go parent's public `server.pid` and treated the parent as a competing server. Node exited and was relaunched approximately every second. `/readyz` still returned 200 while `/ui/chat` returned `502 node_unreachable`.

## Final behavior

- The host injects the existing atomic gateway catalog and account candidate source into Chat. A focused Chat adapter supplies composer choices and validates every turn against that published catalog. Historical snapshot-only names do not become executable models.
- All provider/model carriers survive display deduplication. A pinned account is checked with the actual routing-candidate source, including disabled/excluded status. Metadata and reasoning effort come from the eligible target provider.
- Aliases are resolved against one published route snapshot for the actual OpenAI Chat Completions entry. Claude-only aliases, aliases with incompatible pinned providers, and known non-text output models are omitted.
- Missing model input resolves through the same current catalog. Invalid explicit selections fail before upstream inference with 422 and `所选模型当前不可用，请重新选择模型后发送`.
- The Go-supervised Node child uses `server-node-<private-port>.pid` only when its complete managed role, parent PID, AIH directory, loopback endpoint and ports agree. Current Go runtime identity records are supported even when direct Go launch has no public `server.pid`; the older public-PID fallback remains. Standalone singleton behavior and owner-only cleanup remain active.
- Loopback recognition uses Node's IP-aware block list for `127.0.0.0/8` and `::1`, including mapped IPv4. This matches Go's loopback IP contract rather than assuming only `127.0.0.1` is legal.

## Real acceptance

No test cases were added or edited, and no automated test suite was run. Validation used compiled production code, actual HTTP calls, real upstream inference, SQLite reads and the existing Microsoft Edge connection.

The private Go service ran at `127.0.0.1:19127` with its own AIH directory and an online SQLite backup. Account keys were read in memory for the requests and never written into this report. Live account and alias configuration were not changed. Temporary aliases and routing exclusion were applied through management HTTP in the private copy only, then restored.

| Scenario | Observed result |
| --- | --- |
| Catalog with original enabled-alias configuration | 223 Chat IDs / 224 gateway IDs; no Chat-only names; the only gateway-only ID is the known image-output model `gpt-image-2`. |
| OpenAI alias / Claude-only alias / image alias | OpenAI alias completes `ALIAS_REAL_OK`; Claude-only and image-only aliases are absent and explicit submissions return 422. |
| Pinned shared-model carriers | Codex keeps its eligible aliases; WorkBuddy and CodeBuddy retain 18 and 26 models, including their shared GPT model, and receive no Codex-only alias. |
| Disabled or routing-excluded account | Composer returns 422. Restoring the private account's routing inclusion restores its catalog. |
| Stale model / image model | `DeepSeek-Flash`, `gpt-image-2`, Claude-only alias and image alias all produce a failed command with 422 before inference. |
| Missing model, controlled default | With a private alias sorting first and targeting published `gpt-6.1-sol`, omission of `model` completes `DEFAULT_FINAL_OK`; ledger records 53 input / 7 output tokens. This is distinct from the original configuration's `auto` default. |
| Pinned actual send | `PINNED_FINAL_OK`, 47 input / 6 output tokens, actual pinned Codex API-key account. |
| Provider context changes | Separate codex, claude, agy and workbuddy-labelled Chat sessions using All accounts all complete their expected `CONTEXT_*_OK` response with `gemini-2.5-flash`. These exercise context-independent gateway routing, not four separate upstream account types. |
| Existing Edge, actual sends and multi-turn history | Browser command completes `EDGE_CHAT_OK`; follow-up asking for its first English token completes `EDGE`. Final ledger entries are 81/5 and 110/1 input/output tokens. The visible timeline contains one item per message ID. |
| Shared Node recovery | Existing Go supervisor launches Node PID 13684 under unchanged Go PID 70830. `/ui/chat`, stylesheet, JavaScript and logo return 200; public Go PID ownership is preserved. |
| Direct Go parent and IPv6 | Real Go+Node services with no public PID file work on private `127.0.0.1` and `::1` endpoints. IPv6 Go PID 43832 owns 19128; Node PID 44336 owns private port 54962 and only its private PID file. Both `/readyz` and `/ui/chat` return 200 after more than two minutes. |
| Standalone Node guard | A standalone launch on a different port still reports the existing public owner. Adding an external Go URL alone does not bypass the singleton. |

Edge was reused through its existing Playwright socket in the background. Existing user tabs were not closed or brought forward. The acceptance tab used an isolated private origin. Because the application intentionally suspends event handling in hidden documents, that tab alone had its page visibility and animation-frame lifecycle emulated as visible for background interaction; production JavaScript was not modified. This limitation is part of the browser evidence.

`127.0.0.2` cannot bind on this macOS host without adding a network alias (`can't assign requested address`), so that particular address has source-level verification only. No interface configuration was changed. IPv6 and the default IPv4 address were exercised with real services.

Build verification completed with exit 0:

```sh
go build ./application/inferencecatalog ./internal/runtime/chatruntime ./internal/host/aihserver
go build -trimpath -o <private-evidence-dir>/aih-server.fixed-v2 ./cmd/aih-server
node --check lib/server/server-singleton.js
git diff --check -- <explicit-changed-paths>
```

Independent review covered the complete Chat change and identified the loopback-address omission, which was corrected. The incremental reviewer verified the final subnet handling and supervisor role predicates before its tool continuation failed with HTTP 400. Root self-review verified that `serveridentity.Publish` completes before `nodeSupervisor.Start`, and checked the remaining incremental code. Review fallback is explicit; no missing review was silently treated as approval.

## Checkpoints and candidate artifact

- `4c05e9c2b`: `fix(server): isolate supervised Node instance locks`, one source file, 53 additions / 2 removals.
- `85851ec39`: `fix(chat): validate models against published gateway routes`, ten source files, 244 additions / 40 removals; the shared composition file contains only the one-line `ChatModels` dependency injection.
- Both commits used a separate temporary index and explicit commit pathspecs. The shared index SHA-256 stayed byte-for-byte identical during each operation. Existing staged peer entries were not included or cleaned. Subsequent staged reverse entries against these new commits are the unchanged shared index relative to the advancing `HEAD`, not a reason to reset it.
- A source archive of committed `85851ec39873946cd9dbb4e74de8d110adc9be47` was compiled separately as `aih-server.release`. Its SHA-256 is `079a565db2f1be7ae138b1006e55558f48c966909f00776a974c8a1e4cbfc644`. Its build stamp passes binary, package-version and route-manifest validation.
- That exact committed candidate then ran on private 19127 as PID 55649. A new AGY-labelled All accounts session completed `COMMITTED_RELEASE_OK` through `gemini-2.5-flash`, with one usage-ledger row for 48 input / 7 output tokens. The catalog remains 223 IDs. Session: `session-b85a6221-4d4b-4ad7-a5d6-88de7ced8680`.
- Loading the private candidate initially overlapped the previous private process's graceful shutdown and correctly returned `backup_core_writer_busy`. After the previous process exited and released its OS lease, a new launch succeeded without removing the lock file. The private IPv4/IPv6 supervisor acceptance parents and their Node children were stopped gracefully; their owned runtime/PID files were cleaned by the normal release path.

## Remaining runtime boundaries

- The live/shared Go PID 70830 on 9527 has not been restarted or replaced. It still runs the previous binary and previous Chat model catalog. The new Go behavior above is accepted on the private compiled service, not deployed on 9527. The Node recovery is already effective under the existing supervisor. Loading the Go change requires a coordinated service restart; this report is not release approval.
- With the original enabled-alias configuration, the new catalog's alphabetical default is `auto`. That model is published by the custom API-key upstream but returns 503. A direct request to the same account's `/v1/responses` also returns `upstream_unavailable`, independently of Chat. No model availability, account settings or error semantics were falsified to make that request appear successful. Explicit `gemini-2.5-flash` and the controlled `gpt-6.1-sol` default completed.
- The live database has no AGY account. The successful AGY-labelled Chat request was served through the global pool by a Codex API-key account with a custom upstream. It does not prove AGY OAuth/native execution.
- Native WORK audit found separate possible gaps: AGY plain stdout versus JSON-only parsing; account environment/fake HOME injection; declaration-versus-execution transport selection; WorkBuddy embedded CLI discovery; and host model/default callbacks. These are source-audit findings, not repaired or accepted native end-to-end behavior. They were included in ownership coordination messages and require their own real-runtime acceptance.
- The shared index contains more than 100 parallel-session staged changes, including reverse/deletion entries. This repair must be checkpointed with an explicit path allowlist and isolated temporary index. The shared index must not be reset, cleaned, or folded into these commits.

Local evidence directory: `/Users/model/.ai_home/run/aih-chat-routing-repair-20261116/`.

The principal artifacts are `final-acceptance.json`, `release-acceptance.json`, `aih-server.release.build.json`, `catalog-parity-final.json`, `private-carriers-v2.json`, `context-send-final.json`, `multiturn-final.json`, `edge-multiturn-final.png`, `managed-ipv6-go-evidence.json`, `managed-direct-go-evidence.json`, `managed-node-before.json`, `managed-node-after.json`, `shared-runtime-final.json`, and `auto-direct-responses.json`. Earlier V1 artifacts in that directory are superseded where V2 evidence exists.
