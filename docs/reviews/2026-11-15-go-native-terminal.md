# Native terminal lifecycle migration — 2026-11-15

Status: bounded implementation and isolated real tmux acceptance; full migration remains active. This extends the previous WebUI-PTY slice without removing desktop functions or silently falling back after a Go-owned launch fails.

## Source scope and ownership

- `cmd/aih/main.go`: a thin `__native-terminal` dispatcher before generic signal handling; provider launch still uses the existing `runCLI` flow.
- `internal/runtime/nativeterminal/`: small modules for registry/envelope, identity, multiplexer, process supervision, reconciliation, titles and closing.
- `internal/adapters/hostapps/running.go`: recognize native Go supervisor identity and descendants without changing legacy Node recognition.
- `internal/transport/http/webuiopenappapi/cli_launcher.go`: migrated native combinations use Go lifecycle arguments; close waits for owned pane cleanup before processing old Node windows. Unmigrated external/wider Relay combinations retain their old explicit capability route.

No changes to peer `cmd/aih/run.go`, shell implementation, account credentials or user hooks. The canonical CLI runtime remains responsible for account projection/credential capture.

## Contracts preserved / strengthened

- Parse actual CLI launch intent and verify provider, Relay identity, pinned alias, AccountRef and model; the pane repeats identity verification before launch. It never uses displayed identity to label a different executing account.
- Fresh tmux creation does not use `new-session -A -d`. Existing explicit target/label/resume/mirror behavior is retained; socket and account boundaries are verified before attachment.
- Registry uses Node-compatible camelCase, preserves unknown resource metadata, and stores lifecycle ownership privately. A real Node rewrite that drops unknown fields can still be recognized by the identity-matched owner sidecar. Credentials/environment are not stored in the persistent registry or argv; the private one-shot envelope is consumed.
- Supervisor handles SIGHUP/termination and waits for the existing Go CLI **single capture owner**, then only checks projection/shared-link integrity. It does not perform a second Capture against a newer DB snapshot. Explicit CaptureFailed facts preserve original silent exit codes while retaining registry/sidecar/projection and a stable repair marker.
- Closing validates mux path/signature, exact socket/session and authoritative pane PID; it does not kill by provider name or trust a stale PID alone. Other accounts remain running.
- Titles consume existing bounded read models, cache by file/DB signatures, and avoid all-account session scans or upstream usage probes. Usage queries are account-scoped and rate limited; unchanged frames are not rewritten.
- Windows psmux discovery remains present. This is not proof of Windows runtime acceptance.

## Real isolated acceptance

Final evidence root `/tmp/aih-native-final-qpBPws`, with 19-path allowlist and identical source hashes before/after replay (`SHA256SUMS`). Actual Go CLI, tmux and official Codex CLI; no fake provider protocol, no paid prompt, no AppleScript or desktop window activation.

| Scenario | Observed result |
| --- | --- |
| Official `codex --help` natural exit | Exit0; zero registry, owner sidecar and pending envelope files. |
| Two accounts | Separate account-derived tmux sockets; hostapps identifies correct supervisor/descendant AccountRefs. |
| Reattach then detach | Same session and supervisor PID; pane remains alive; no accidental provider restart. |
| Title rotation | Actual pane titles include project, `codex:1`, and `5h:73% 重置 2h`. |
| Real Node registry rewrite | Node drops unknown owner fields; Go still recognizes identity-matched private sidecar and closes the right pane. |
| Mux-signature negative | `native_terminal_mux_changed`; neither account stopped and closeRequested remains false. |
| Exact and repeated close | First account removed while second remains alive; repeated close Matched0. |
| SIGHUP to second owned inner | Its pane, registry and owner sidecar removed; no remaining active owned records. |
| Mismatched alias/provider/ref/model | Exit1, no registry/envelope created. |
| Actual invalid isolated projection | Cleanup fails; projection unchanged; registry, owner sidecar, unknown resource metadata and stable error retained; pane exits. |
| Provided PATH excludes mux | Does not borrow parent PATH; direct-mode natural help exit cleans registry. |

Files: `lifecycle-final.json`, `identity-negatives-final.json`, `reconcile-failure-final.json`, `source-hashes-before.json`, `source-hashes-frozen.json`.

## Verification boundaries

Full/package builds, focused vet and Linux/Windows cross-builds pass on the checked tree. Runtime acceptance is local isolated PTY/tmux, not a rendered desktop window, Windows psmux real machine, arbitrary provider credential refresh, or paid inference. Existing Node restore compatibility is not proof the entire persistent-session recovery stack has been migrated. Failed-case evidence remains only in the temporary verification directory. No production restart/deploy or branch/worktree created.

Independent review found and the latest implementation fixes duplicate Capture, legacy force-close bypass, and public-only ownership trust. The public registry is display/recovery metadata; destructive actions require an independent identity-matched private sidecar. NativeOwned marks the supervisor and overlapping process families, which are never candidates for the legacy force-close path. The 20-second context still only covers shared-resource checks after RunCLI/title completion, not a global shutdown deadline.

## Final ownership/capture revalidation

Latest evidence root: `/tmp/aih-native-p1-final-ob0shV` (22-source allowlist including `providercli/runner.go`, `capture_error.go`, and `hostapps/scanner.go`). Every source hash matched before/after actual execution. The earlier first negative attempt had an already-exited target and was not counted; the final replay records exact live PID and child identity before every destructive-negative request.

- Public record corrupt/missing and private sidecar missing/corrupt/identity-mismatched: actual NativeLauncher returned a clear failure. Target supervisor **65647**, official child **65652**, other account **65655**, and sentinel **65670** all remained the same live processes; both records unchanged. Restoring trusted records allowed exact graceful cleanup, leaving no active owned records/processes.
- Actual Gemini CLI capture failure: original exit1 remained supervisor exit1 with `SilentExit` and `CaptureFailed` visible; registry/private owner/projection retained under `native_terminal_capture_failed`. This uses the sole existing runtime capture, not a second post-exit adoption.
- Shared-resource integrity checks are read-only; they retain unknown resource evidence on mismatch instead of deleting the projection.

Records: `registry-trust-samepid-final.json`, `capture-marker-final.json`, `final-p1-review-summary.json`, `source-hashes-frozen.json`. Old `qpBPws` positive lifecycle evidence remains separately scoped; it is not presented as proof of the newly added negative guards. Independent final review passed after inspecting the frozen sources and the same-PID negative/capture evidence. Code checkpoint `7da204fad`: all 22 explicit paths matched the final source hashes; pre/post staged/commit scope checks passed, with no peer files included. No new tests or synthetic upstream responses.
