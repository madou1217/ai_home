# W1/W2 standard CLI delivery and Windows native execution — 2026-11-16

## Scope and chronology

This continues the approved `2026-11-14-node-go-next-development-plan.md`; it does not replace W0–W6 with a smaller target. Local standard CLI build/publication began on2026-11-15 Asia/Shanghai; Windows runtime operations and final evidence were completed after midnight on2026-11-16. Existing `...20261115...` private artifact names are historical identifiers, not claims about the final observation date.

No production code changed in this checkpoint. Only this owner's acceptance document and execution ledger are committed. No shared service restart, standard server replacement, branch/worktree creation, original credential/config write, or database merge occurred.

## Standard macOS CLI: published, then actually exercised

The earlier W1 implementation was present in source and a private/companion artifact, while standard `bin/native/darwin-arm64/aih-go` still dated16:43 on November15. This checkpoint publishes the canonical CLI artifact rather than continuing to claim delivery from `/tmp` builds alone.

1. Obtained `buildGoCLIPlan` from `scripts/build-go-cli.js`; used its exact `go build -trimpath -o <same-directory temporary> ./cmd/aih`, `GOOS=darwin`, `GOARCH=arm64`, `CGO_ENABLED=0`.
2. Enumerated the actual Go dependency closure using `go list -deps -json`;769 source/embed/module files all matched the committed HEAD blobs at `e3266101cd5ca44e0ed093c2c9a51fa8390c3fdf` before build. The stale shared index did not serve as content authority.
3. Recorded every dependency digest; after successful build, rechecked all digests and the old target's content hash/inode. Any concurrent change would have aborted publication, retaining the old target.
4. Retained the previous executable privately as a rollback artifact and atomically renamed the new CLI into the standard path. The standard server was never replaced; running processes were not killed.

| Artifact | SHA-256 |
|---|---|
| Previous standard CLI | `c88abf79188dce3e31d0939602b50ea0d2c98cdb61bfa76d626fe60632193fb8` |
| Published standard CLI | `cac088bb126e46453f1212c6a98f7cbfc52d9d36244b8cd1114c35f07e46ed99` |

The standard path itself—not a copied new executable—then ran the real native0.167.2 business matrix in an isolated HOME/CODEX_HOME and restricted account DB backup: fast baseline; fast off → exact-ID resume; fast profile; explicit default overriding profile; `--last` pinned to the same thread. All completed with `OK`, correct outgoing requested tier, same identity, exactly5 generated-turn usage rows, and private resources removed. `node bin/ai-home.js codex version` also reached the installed native CLI successfully. A subsequent peer edit to `internal/runtime/toolkit/apps/open.go` is not in this build; the artifact is tied to the recorded dependency snapshot, not an assertion that all future dirty work is loaded.

Ephemeral manifest/rollback location: `/tmp/aih-standard-cli-delivery-latest-20261115.txt` points to the private directory holding `manifest.json` and `aih-go-before`. Business evidence: `/tmp/aih-standard-cli-business-result-20261115.json`.

## Windows native0.163.0: real business execution

Used the previously authorized Windows host and existing SSH channel, with a new exclusively scoped TEMP directory, protected DACL, isolated HOME/USERPROFILE/CODEX_HOME/AIH_HOME, and a newly cross-built actual Go CLI. The installed official native backup was executed with direct CreateProcess semantics; PowerShell's extension dispatch could not directly execute `.exe.aih-original`, so the initial version probe was corrected to the existing direct-process convention. The native version was **0.163.0**, not assumed equal to macOS0.167.2.

Only a generated disposable gateway client key reached that host. The upstream API key stayed in the local private database clone. An explicitly owned SSH reverse forward bound remote127.0.0.1 only and led to an isolated actual Go gateway; its transparent relay forwarded real upstream bytes. No Windows service/task/install was changed.

| Operation | Actual outcome |
|---|---|
| Windows `aih-go codex effort fast` | exit0 |
| Official native new thread | exit0, final `OK`, outgoing `low/priority` |
| Windows `aih-go codex effort fast off` | exit0 |
| Initial managed resume | same thread identified, generation failed; **not counted as passed** |
| Explicit retry of that same real thread after private forward recovery | exit0, `OK`, outgoing default form |
| Managed `--last` with stdin `-` | exit0, same thread, `OK`, default form |
| Managed resume with fast profile | exit0, same thread, `OK`, priority delivered |
| Same profile plus explicit `-c service_tier="default"` | exit0, same thread, `OK`, default form; root default config retained |

The initial background SSH forward was observed missing after the failed generation; this correlates with that failure but the initial native error was not captured in sufficient detail to claim a unique cause. Its replacement remained attached to a live tool handle, and the exact existing thread was retried. No product retry logic or persisted history was changed to hide the failed run.

Actual local relay/ledger evidence:6 generation attempts were observed,5 completed with real output and5 new generated-turn usage rows. The failed attempt had no final usage; that is unknown final provider accounting, **not proof of zero cost**. Native prewarm frames are recorded separately as `generate:false`. All successful generation completions reported actual tier `default`; delivering requested priority does not establish priority entitlement.

- Windows CLI SHA-256: `abb5abd170de1ab984b793e7019cc89c1d369aa6a414d571b39844c93315bfd9`.
- Windows native binary SHA-256: `2692c8c7bb2cf8b0aefe638741fc90236f4b824c59578ce84994f9de58200993`.
- Private local gateway SHA-256: `73e6cdecf639fc43326b3cdfdfdafa0e3dd3d8f97cca14b46b9e3d46cab578dd`.

## Cleanup and evidence

Windows cleanup revalidated the exact TEMP prefix and CLI hash, checked for no private runtime PIDs, confirmed the protected DACL, removed only that directory, and observed the existing scheduled-task state unchanged at4. The local private server, relay sockets and account backup were shut down/removed. The owned reverse-SSH tool handle was closed; its earlier missing handle was never treated as live. Temporary connection files containing the generated client key were removed. The standard CLI rollback artifact remains intentionally retained.

Low-sensitivity temporary records:
- `/tmp/aih-windows-native-exec-result-20261116.json`
- `/tmp/aih-windows-native-exec-retry-result-20261116.json`
- `/tmp/aih-windows-native-profile-result-20261116.json`
- `/tmp/aih-windows-private-gateway-result-20261116.json`
- `/tmp/aih-windows-native-exec-cleanup-20261116.json`

These are actual native/Go/API/OS operations, not test cases or mock responses. No tests or instrumentation hooks were added to the repository.

## Independent evidence boundaries and remaining plan

The implementation's scoped independent review is documented in `2026-11-15-codex-exec-resume-tier.md`; this new checkpoint requires only evidence/claim consistency review, not reopening completed source review. Standard CLI publication and Windows native exec are now actual delivery/runtime observations, while standard server/companion packaging, Linux official client (previous host lacked it), OAuth rotation, real Desktop effects, Edge visual journeys and all remaining W0–W6 gates remain separate.

A peer reported `/ui`502 while Go `/readyz` stayed200 and owns that Node guard incident. This session did not touch command-handler/instance-lock/nodesupervisor or chat repair files. Later read-only checks observed both `/readyz`200 and `/ui/`200; an HTML200 is **not** a browser journey or proof of all UI/API recovery. No browser restart, replacement browser, AppleScript or UI focus operation was used.

## Evidence review

Original reviewer Hubble independently checked the two-document claims against the referenced low-sensitivity JSON, the769 source digests/committed blobs, current standard CLI and retained rollback hashes. Verdict: **no blocking evidence issue**. It confirmed counts, same-thread retry, final tier truthfulness and cleanup scope; it did not rerun build/publication or Windows business operations. Its clarification that the forward was observed missing **after** the first failed generation is reflected in the ledger; no unique-cause claim is made.
