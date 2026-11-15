# W1 Linux native exec/resume acceptance — 2026-11-16

## Scope

This closes the specific Linux native-client availability gap from the earlier platform checkpoints. It does not declare all W1–W6 complete or install/upgrade the user's global CLI. The authorized AWS Linux x86_64 host initially had no `codex` on PATH and its existing service was inactive/dead/MainPID0.

Used a new private directory and a **pinned official native0.167.2 package**, not an invented client or a mock upstream. No user home/profile, system installation, service state, original credential or existing session was changed. All threads were actually created by the official client within this operation's CODEX_HOME.

## Native package provenance and disk boundary

Fetched official GitHub release metadata for `openai/codex` tag `rust-v0.167.2`, selected `codex-package-x86_64-unknown-linux-musl.tar.gz`, and verified downloaded bytes against the release's SHA-256 digest before extraction:

- Archive SHA-256: `3d77be1748d35a4bb0e7f8752cde3b11890c63338e8c599f01eafa4a59e17b3d`.
- Actual `bin/codex` SHA-256: `a9672d0fa0dd8fcf8cad136fa0d056b914bc046f5ac3d78f4a5cf390655af56b`.
- Actual `--version`: `codex-cli 0.167.2`, exit0.

The first extraction under `/tmp` hit Disk quota exceeded; `/tmp` is a953MiB tmpfs. This was **not** a native compatibility failure. Read-only mount inspection showed `/var/tmp` on the root disk with sufficient space. Only this operation's verified archive was moved into a new private `/var/tmp/aih-linux-native-*`; its incomplete original `/tmp/aih-linux-native-*` directory was removed after identifying that exact archive. No unrelated file was deleted. Extraction checked members for absolute paths, traversal and device entries and used Python's data filter.

The package remained private and temporary. Its official binary/resources were removed at final cleanup; no PATH or global Codex installation was changed.

## Actual transport / credential boundary

- New AIH Linux x86_64 CLI built from current source; SHA-256 `911e90438421a5c43439bd1c5e2c65a46fafde9fffbf777df061c5bea099928c`.
- Remote HOME, CODEX_HOME, working directory and AIH_HOME were under the private root.
- A generated, disposable local-gateway client key reached the remote; the real upstream credential stayed in a permission-restricted DB backup on the Mac.
- An owned SSH reverse forward bound remote127.0.0.1 only and led to a real isolated Go server plus transparent relay. The SSH and server were attached to live tool handles until explicit close, not assumed alive from pid files.
- Prompt was `Reply only OK. Do not run tools.` with read-only native sandbox. The real harness supplied its native instruction/tool declarations; no user history was copied.

## Observed business results

| Operation | CLI/result | Observed real generating request |
|---|---|---|
| AIH effort fast + official new thread | both exit0, final `OK` | `gpt-6.1-sol`, effort low, requested priority |
| AIH effort fast off + Go managed UUID resume | exit0, same thread, final `OK` | effort low, tier absent/default form |
| Go managed `--last` plus stdin `-` | exit0, same thread, final `OK` | effort low, default form |
| Go managed fast profile | exit0, same thread, final `OK` | effort low, requested priority |
| Fast profile + explicit `-c service_tier="default"` | exit0, same thread, final `OK` | effort low, default form |

The native root configuration retained default after the profile/explicit operations. Exactly5 generating frames and5 prewarm frames were observed. The five real generation completions each reported final tier **default**, output5 tokens, and the corresponding5 new usage rows were:

```text
input 10752, output 5, total 10757
input 10772, output 5, total 10777
input 10792, output 5, total 10797
input 10812, output 5, total 10817
input 10832, output 5, total 10837
```

No duplicate generated-turn usage was observed. Native prewarm `generate:false` is not a sixth generation. Requested priority is not priority entitlement, speed, or price evidence.

## Cleanup and independent limits

Final remote cleanup verified private path scope, original official native hash and actual AIH CLI hash, then inspected exact executable paths/argv elements under `/proc` to confirm no private native/AIH/operator processes remained. An initial broad command-text check accidentally matched the cleanup shell's own inline source; it refused cleanup, and no foreign PID was killed. The corrected exact identity check passed, after which only the private directory was removed. This is not a retry of native inference.

The existing service remained **inactive/dead/MainPID0**. The local temporary gateway, transparent relay, DB backup and reverse-SSH handle were closed; disposable connection files containing the generated key were removed. No shared9527 restart or server binary replacement occurred.

Low-sensitivity ephemeral records:
- `/tmp/aih-linux-native-env-20261116.json`
- `/tmp/aih-linux-native-exec-result-20261116.json`
- `/tmp/aih-linux-private-gateway-result-20261116.json`
- `/tmp/aih-linux-native-exec-cleanup-20261116.json`

This proves actual Linux native/API-key exec-resume/profile/stdin behavior rather than cross-compilation alone. It does not prove persistent global installation/upgrade, OAuth/rotation, native Desktop rendering, Edge browser journeys, all model/effort/cancel/reconnect permutations, package release publication or the complete W0–W6 objective. No test cases, fake histories, mock services or production instrumentation were added.

## Evidence review

Original reviewer Hubble checked this document and ledger against the low-sensitivity Linux/native/gateway/cleanup results and reported **no blocking evidence issue**, reconfirmed on2026-11-16. It did not repeat network operations or mutate files. The review preserves all scope limits above and is not a global installation or W0–W6 completion declaration.
