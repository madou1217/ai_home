# W1 caller-local managed resume tier intent — 2026-11-15

## Requirement and verified root cause

Continue the original W1 plan; do not replace it with this narrower checkpoint. `2026-11-15-codex-native-tier-precedence.md` demonstrated that raw native `exec resume` can retain historical priority despite current config/CLI overrides. Further actual protocol execution established that the installed native app-server accepts `serviceTier="default"` on `thread/resume` / `turn/start`, resumes the same real thread, and sends the default request form upstream. Thus the official typed field, not a global inference gateway rewrite or vendor-rollout edit, is the correct managed-protocol boundary.

## Scoped implementation

Four production paths only:
- `internal/host/codexlocalappserver/service_tier.go`: resolve the caller's actual effective `service_tier` by launching a private native app-server with the **same command, args, env and cwd**, calling only initialize/initialized and `config/read`. Native code owns TOML/profile/project/CLI precedence. A missing/null config field is unknown, not guessed default.
- `internal/host/codexlocalappserver/handler.go`: after authentication/origin/slot checks but before upgrade, run that bounded probe and attach its result to this caller-local bridge. Probe failure returns explicit502; no fallback to a different account/history.
- `internal/runtime/codexappserverws/service_tier.go`: for actual request IDs, fill a missing `thread/resume` or `thread/fork` typed `serviceTier`. Existing typed values **including null** win; a per-request `config.service_tier` is more specific than the launch snapshot and is promoted to the typed field without deleting the config. Native enum validation remains authoritative.
- `internal/runtime/codexappserverws/rewrite.go`: one options field and one focused adapter call. Shared gateway bridges do not opt into it, so they retain prior behavior. Turn/settings, responses, notifications and non-resume/fork methods are not rewritten.

No config/credential/rollout/state database is rewritten by this feature. No model cache is consulted to downgrade fast. No `priority` response is fabricated.

## Probe lifecycle and privacy

The probe uses the existing detached native process-group owner, a4-second context, and a4MiB maximum JSON line. It consumes one response at a time, discards unrelated notifications, does not confuse server-initiated request IDs with replies, and never logs returned config or native stderr. Closing the request/host closes the probe and reclaims its child group; the separate actual client app-server has its own existing owner. Startup now incurs one extra bounded native config-read process; the observed final handshake was343ms on this Mac, not a cross-platform latency guarantee.

## Actual business acceptance

All operations used actual installed Codex0.167.2, actual full Go gateway/managed helper, temporary CODEX_HOME/cwd, restricted DB clone, short no-tool prompts and a transparent relay to the approved actual upstream. No fake server, fake history or repository test case was used. Shared9527 and original DB/config were not changed.

| Observation | Old helper | New helper |
|---|---|---|
| Create real fast thread, save fast off, resume via actual production Node launcher → Go caller-local bridge, omit request tier | returned `priority`, sent priority | returned **`default`**, upstream omitted tier (native default form) |
| Actual subsequent generating turn | completed | completed; same thread; final actual upstream `default` |
| Two generation rounds including baseline |2 new usage rows |2 new usage rows; prewarm not counted as generated turn |

Final additional actual RPC controls:
- Explicit `thread/fork.serviceTier="fast"` returned `priority` and a new thread; the bridge did not force launch-default over it.
- Omitted fork tier returned `default` from launch intent.
- Explicit null was passed through, native returned default in that fork context. This is not a claim that null always resets every already-loaded native thread.
- Request-level `config.service_tier="fast"` returned `priority` via the typed projection.
- Separate root-fast invocation with explicit launch `-c service_tier="default"` resumed as default while root config remained fast. It did not generate an extra paid turn; only native prewarm was observed after resume.
- Real native PTY TUI connected through the production caller-local helper and resumed the real thread; it emitted explicit default on thread/resume and turn/start, generated `OK`, and retained no duplicate usage. Two Ctrl-C inputs ended only that private TUI. This PTY run used the initial patch artifact; final extra ID/response/request-config guards were subsequently verified by the final-artifact RPC run, not by relabeling the earlier PTY binary.

Lifecycle observations with the final artifact:
- Real native binary reading malformed private TOML produced HTTP502 `local_app_server_effective_config_unavailable` in210ms, with no WebSocket fallback, and helper cleanup completed.
- The controller found only the newly launched native probe under the exact helper PID, SIGSTOPped it, then canceled the pending upgrade and closed the helper. Close completed in103ms; the stopped native PID no longer existed, no operator fallback kill was needed, and the private directory was removed.

## Artifact / command evidence

- Final helper SHA-256: `991c601013c74222438f300d4754aae269610df36e801398e4fb692b5b87b3c3`.
- Before helper SHA-256: `30a214e9ade8e6015cc93fcd137de34c1fc54f63070864563e82a14432432643`.
- Initial successful helper / PTY artifact SHA-256: `02fafa35e985c783c8edc5a9cfcbf28b7c399819ac9da5a99af423f102921c08`.

```sh
go build -o /tmp/aih-w1-managed-tier-server-final-20261115 ./cmd/aih-server
AIH_ACCEPT_LOCAL_BINARY=/tmp/aih-w1-managed-tier-server-final-20261115 node /tmp/aih-w1-managed-resume-live-20261115.js
node /tmp/aih-w1-managed-explicit-live-20261115.js
node /tmp/aih-w1-managed-config-failure-20261115.js
node /tmp/aih-w1-managed-cancel-probe-20261115.js
go build ./...
go vet ./internal/host/codexlocalappserver ./internal/runtime/codexappserverws
```

All builds/vet exited0. Results are in corresponding `/tmp/aih-w1-managed-*-result-20261115.json` (ephemeral). The first PTY operation's report was lost when private cleanup raced an optional Desktop translation compiler triggered by copied settings; that run is **not acceptance evidence**. The controller terminated only the compiler whose executable/argv named that exact private root and removed it; later operators suppressed that unrelated private helper via isolated settings/ownership configuration. No shared Desktop process was stopped and no AppleScript/Apple Events were used.

## Independent review fallback and remaining scope

New reviewer spawn hit the thread limit. Original Helmholtz was resumed but failed with the same tool-protocol400 as the prior review agents. A read-only peer request was delivered/read without a returned verdict. No native review tool was available. Per AGENTS, this scope explicitly uses a documented **self_review commit bypass**: reviewed authentication-before-probe, process-group cancellation, private bounded I/O, effective native parsing, ID namespace/type preservation, typed override precedence, nil opt-in outside local host, no retry/account/usage changes, final real artifact behavior, and scoped staged checks. Independent final review is not claimed.

This closes the caller-local managed-protocol omission path, **not all W1 or the raw native `codex exec resume` limitation**. Profile launches currently bypass the local host by pre-existing design; full raw-exec/picker/profile/resume policy still needs end-to-end reconciliation. No global service-tier force or vendor state rewrite was substituted. Mid-connection config changes, broader account/effort/cancel/reconnect matrices, Windows/Linux runtime of this new probe, OAuth, Edge UI, shared-runtime deployment and W0–W6 remain separate requirements.
