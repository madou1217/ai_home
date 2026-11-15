# W1 native Codex fast / resume / fork precedence — 2026-11-15

## Actual runtime and isolation

Executed the installed official `codex-cli 0.167.2` binary directly, not a mock executable. Used isolated HOME, explicit CODEX_HOME, a private working directory outside any repository, read-only sandbox, no rule loading, and the prompt `Reply only OK. Do not run tools.` The gateway was the full new Go server on an independent loopback port, using a restricted backup of the live business DB and the previously approved Codex API-key account. A transparent HTTP/WS relay recorded only model, effort, request tier, generation flag, reference presence, status, and token counts; it did not modify request/response bytes.

No user conversation was read or copied. The threads below were created by the actual native CLI and persisted only inside the temporary CODEX_HOME until cleanup. No synthetic rollouts, test cases, mock providers, or private content were added to the repository. The operator records the native thread ID only to prove resume/fork identity; full transcripts and credentials were removed with each temporary HOME.

- Official native binary SHA-256: `97bc82fd46f117cf10efb95e6ff0c81dc4784f5797bcdc2cb75093ba09e4def0`.
- Actual Go gateway binary SHA-256: `30a214e9ade8e6015cc93fcd137de34c1fc54f63070864563e82a14432432643`.
- Preference writer: full Go CLI `/tmp/aih-w3-rollback-cli-20261115`, same scoped artifact as rollback acceptance.

## Confirmed business paths

| Actual invocation/configuration | Identity/result | Observed outgoing intent |
|---|---|---|
| `aih-go codex effort fast` in explicit isolated CODEX_HOME | exit0; root `service_tier="fast"` saved, root effort `none` retained | no inference from preference command |
| Official `codex exec …` new thread | exit0, `turn.completed`, final `OK` | native WS warm-up + real turn both `low / priority` |
| Official `codex exec resume <id> …` | same native thread ID, exit0, final `OK` | `low / priority`, actual continuation reference retained |
| Official `codex exec fork <id> … -c service_tier="default" -c model_reasoning_effort="low"` | a distinct native thread ID, exit0, final `OK`; root remains fast | `low`, no service_tier field (native default form) |
| `aih-go codex effort fast off`, then official new `exec` | root `service_tier="default"`; exit0, final `OK` | `low`, no tier field |
| Root default + explicit `-p fastprofile`, with actual `<CODEX_HOME>/fastprofile.config.toml` containing fast/low | exit0, final `OK`; root remains default | `low / priority` |

The installed version's own `exec --help` states that `-p` layers `<CODEX_HOME>/<name>.config.toml`; the live profile check used that current contract rather than assuming an older `[profiles]` implementation. The earlier config-preservation checks still prove that unrelated TOML sections are retained, not that those sections activate this native version's profile behavior.

All actual generation completions reported final `default` from the upstream. Delivered `priority` is not proof of priority entitlement or faster scheduling.

## Confirmed remaining defect / native-client boundary

**Do not close W1's resume precedence requirement.** A thread created with fast continues requesting `priority` on native resume even after:

1. `aih codex effort fast off` saved root default;
2. `codex exec resume <id> … -c service_tier="default"` explicitly requested default;
3. `codex exec -p normal resume <id> …` loaded an explicit default/low profile;
4. `codex exec resume <id> … -c service_tier="flex"` explicitly requested another tier.

Every one of those resumed executions exited0 and returned `OK`, but the transparent relay still observed `priority` in both native warm-up and real-turn frames. The gateway did not turn a default/flex request into priority: it received and forwarded native priority. In contrast, the new-thread and fork paths above applied default/profile selection. This is reproducible native resume session-snapshot precedence in the exercised binary, **not fixed by the earlier WS effort repair**.

No workaround was silently added: the gateway must not overwrite every native tier from a global setting, and AIH must not rewrite private rollout/DB state to make an acceptance check pass. An explicit end-to-end managed resume solution still needs implementation/verification against the user's precedence requirements. Preference command text already limits its promise to new sessions, but text is not a substitute for the remaining protocol fix.

The actual installed binary generated its experimental app-server JSON schema successfully. `ThreadResumeParams`, `ThreadForkParams`, and `TurnStartParams` each contain optional `serviceTier`; `TurnStartParams` describes a per-turn-and-subsequent override. This identifies an official typed control surface for the next step, **not evidence that raw native exec forwards its -c selection to that field**. No existing user's thread settings were changed through that API.

## Usage and transport evidence

The native client sent a `generate:false` prewarm frame before each generating frame, and the latter referenced the actual prewarm response. Each of the four-turn acceptance batches therefore observed8 outbound WS frames but exactly4 new usage rows beyond the private clone's pre-request maximum usage ID. The separate three-turn override investigation observed6 frames /3 usage rows. The gateway deliberately does not count warm-up as a generated turn; this is not duplicate-billing evidence or a claim about provider pricing.

Final generating responses returned5 output tokens each. Input was approximately10.7k per native turn because the real native harness included its own instructions/tool declarations; the short user prompt does not mean only11 input tokens for an actual native client. Token totals matched the recorded generated-turn ledger rows. No model tool calls were emitted (`item.completed` was the final agent message only).

## Commands / low-sensitivity records

```sh
# Actual installed native help/version, in an empty temporary HOME:
codex.aih-original --version
codex.aih-original exec --help
codex.aih-original exec resume --help
codex.aih-original exec fork --help
# Actual business operator scripts (ephemeral):
node /tmp/aih-w1-native-cli-live-20261115.js
node /tmp/aih-w1-native-priority-live-20261115.js
node /tmp/aih-w1-native-resume-overrides-live-20261115.js
```

Low-sensitivity results: `/tmp/aih-w1-native-cli-result-20261115.json`, `/tmp/aih-w1-native-priority-result-20261115.json`, `/tmp/aih-w1-native-resume-overrides-result-20261115.json`. Each final record confirms its private resources removed. All processes were scoped by handles created by that operator; no other native Codex or shared gateway process was stopped.

## Review / completion boundary

This documentation checkpoint is self-reviewed against the three actual result files and installed native help/schema. Independent review capability remains unavailable/no verdict returned as recorded in the previous checkpoint; this is an explicit narrow documentation commit bypass, not independent approval. W1 now has real native new/resume/fork and profile/override observations, but the resume-tier failure remains open. Client cancellation/idle/exhaustive effort/model/account matrices, OAuth, browser acceptance, deployment, and W0–W6 completion remain separate gates.
