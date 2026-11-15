# W1 Codex actual response service tier — 2026-11-15

## Scope and root cause

W1 of `../superpowers/plans/2026-11-14-node-go-next-development-plan.md` requires request and actual response tiers to be observed separately. The Responses request already preserved `service_tier` through Canonical and translated native `fast` to `priority`. The upstream response DTO, Canonical lifecycle events, and Responses renderer had no corresponding observed-tier field. This caused the client's final response to omit the upstream's actual tier.

The fix carries optional, immutable `ResponseMetadata` on started/completed/failed lifecycle snapshots. The terminal snapshot **replaces** creation-time metadata, including when the terminal field is absent or null. It never echoes the request tier, treats `default` as a real observation, and does not infer entitlement or delivery speed. JSON and SSE use the same response builder. Failure metadata travels with the existing classified `AttemptFailure` into the Coordinator's existing failure event; it does not emit an extra event, change visibility/retry policy, or manufacture a started event. Non-streaming HTTP error responses retain their existing format.

## Real request boundary

- Built a temporary server from the shared working tree, then ran it on an independent loopback port with isolated HOME/AIH_HOME and a permission-restricted SQLite backup of the live single business database. The original database was opened read-only; all account disabling, alias setup, and credential endpoint changes were **only in the disposable backup**.
- Used the existing Codex API-key account previously approved for minimal live inference. A transparent local relay forwarded the actual request/body and real response bytes unchanged, recording only model, effort, tiers, terminal state, and usage. No model output, credentials, or private conversation was written to repository evidence.
- Local alias `w1-live-tier` resolved to exact model `gpt-6.1-sol`, deliberately entering Canonical rather than native HTTP passthrough. Input was `Reply with only OK.` Requested effort `none`, tier `priority`.
- Each observed success sent `reasoning.effort=low` and `service_tier=priority` upstream. Upstream creation reported `auto`; completion reported `default`. This proves the local mapping and final-tier fidelity, **not that the account was granted priority scheduling**.
- No shared service restart, deployment, original credential/config write, database merge, migration, or test-case addition. Temporary processes, relay sockets, and private database backups were removed after every run.

## Observed results

| Run | Client status | Upstream tier → client tier | Actual upstream POSTs | New local usage rows |
|---|---|---|---:|---:|
| Before patch, JSON | 200 | completed `default` → absent | 1 | 1 |
| After patch, JSON | 200 | completed `default` → `default` | 1 | 1 |
| After patch, SSE | 200 | created `auto` → `auto`; completed `default` → `default` | 1 | 1 |
| After patch, controlled disconnect | 200, then `response.failed` | created `auto`; no upstream terminal → failed tier absent | 1 | 0 |

Every successful round had input=11, output=5, reasoning=0, total=16, consistent between the upstream terminal, client terminal, and the one new ledger row. These are token accounting observations, not a cost/price claim.

The disconnect run closed the transparent relay immediately after the first **real upstream** `response.output_text.delta`; it did not synthesize a response. The client received a failed terminal with no tier, did not retain provisional `auto` or requested `priority`, and the relay saw no second POST. No complete upstream usage was received, so zero new usage rows is an **unknown final usage boundary**, not evidence of zero provider charge.

An initial bounded-output attempt was rejected locally with `unsupported_parameter` before any upstream call: this existing Codex Canonical adapter rejects same-protocol `max_output_tokens`. Removing that unsupported field allowed the fixed short prompt to reach the actual upstream. This checkpoint does not change that separate adapter contract.

## Build / operator commands and artifact identity

```sh
go build -o /tmp/aih-w1-tier-before-20261115 ./cmd/aih-server
python3 /tmp/aih-w1-tier-live-20261115.py /tmp/aih-w1-tier-before-20261115 before-json
go build -o /tmp/aih-w1-tier-after-20261115 ./cmd/aih-server
python3 /tmp/aih-w1-tier-live-20261115.py /tmp/aih-w1-tier-after-20261115 after-json
python3 /tmp/aih-w1-tier-live-20261115.py /tmp/aih-w1-tier-after-20261115 after-sse stream
python3 /tmp/aih-w1-tier-live-20261115.py /tmp/aih-w1-tier-after-20261115 after-cut cut
go build ./...
```

All builds above exited 0. The temporary Python operator driver executes real HTTP/business operations against the disposable server and actual upstream, not mock responses or repository test cases. Its `/tmp` location is ephemeral; the observations and hashes below are the durable evidence boundary.

- Before binary SHA-256: `af094b171f5516925e9bc75718877e5bce61ab81efa5dadfc7bd57d14d82a780`.
- After binary SHA-256: `4fa0cf97826e7a17512ce8ac11235e675e5a3739253ea44f7a9a28ef9b1f2c55` (same artifact for JSON, SSE, and disconnect).
- Shared source HEAD at first build was `bc26672a5`; concurrently advancing main is not an exact source/artifact identity. The binary digests above identify the actually exercised artifacts.
- Shared `127.0.0.1:9527/readyz` remained ready in the post-validation read-only check. The new binaries were **not loaded into shared 9527**.

## Independent review

Original reviewer Locke (`01a1ddec-f990-7021-a868-d29c4f49fb0c`) read the 9 tracked source diffs plus all 3 added metadata files against `39c4f8b47`. Verdict: **no blocking findings**. Review specifically covered terminal replacement/unknown clearing, immutable value metadata, `forStaticSecret` preservation, and unchanged failure classification, visibility, retry, sequence, and accounting flow. This is source review, separate from the main agent's live operations above.

## Remaining gates

This closes this reproducible response-field loss, not all W1 or W0–W6. Not established by these runs: upstream-granted priority, upstream failed/completed snapshots without a tier in a successful business response, genuine failed snapshots containing a tier, WS multi-turn omission/resume/fork/cancellation matrices, actual OAuth refresh/rotation, Desktop/Edge visual acceptance, or final shared-service release. Missing and null handling and explicit failed-snapshot metadata forwarding are source-reviewed behavior; the real disconnect establishes the unknown-final-tier branch. No artificial paid failures or token damage were used to claim those remaining gates.
