# Codex upload timeout — production acceptance, 2026-11-15

## Approved source and actual deployment

The user explicitly approved a unified deployment of committed `main` after the
isolated repair acceptance. The frozen, approved snapshot is
`f944797c137a8f7f3ba32db09670c941f23ec116`, including the upload fix
`b9e8be87b`. Uncommitted shared work and subsequent peer commits were not
substituted into this release boundary.

Preflight found that a **parallel session had already installed this same source**
at **2026-11-15 23:13:39 Asia/Shanghai (15:13:39 UTC)**. This session therefore
independently verified and accepted that deployment rather than replacing the
package or restarting the service again. Do not attribute the actual switch to
this session or claim an additional rollout occurred.

- Installed package: `~/.ai_home/pkg/1.0.0-linux-x64-f6921c6f`
- User service: `com.meadeo.ai_home.service`
- Acceptance service PID: `218355`; native child: `218678`; `NRestarts=0`
- Native binary SHA256:
  `f6921c6fd6f3fe330913deb624799ab1d2200d067a665c32cb7aa39038759325`
- Deployed full archive SHA256:
  `5103b4b56ddedf2ec957af7c0efc63a5c0ae810f447f8a6d4a56ac4ae1a45836`

The deployed `BUILD_INFO.json` has a blank `source_sha`. This metadata gap was not
hidden by rewriting the installed metadata. Instead:

1. All **5,903 tracked source paths** in the producer's build directory were
   checked against the approved Git tree using actual Git blob hashes: zero
   missing files and zero different files. Extra code was generated Umi output.
2. All **9,078 package files** in the original archive were checked against the
   installed remote package by SHA256, size and executable bit: zero missing,
   extra or differing files; link parity matched.
3. An independent immutable-source native rebuild produced the **same native
   binary SHA256** as the running package.

## Production real-history acceptance

No test cases or synthetic history fixtures were added. Requests used actual
saved Codex history, production sockets and the original official Codex CLI.

| Production observation | Result |
| --- | --- |
| Actual previously captured 7,285,798-byte history, 128 KiB per 700 ms | **39.22 s** upload, HTTP **200**, `response.completed` at **115.64 s** |
| Original failed thread `01a1daba-e618-7151-b14c-9be63122f335`, official `exec fork --ephemeral`, read-only | Actual **7,296,817-byte** request, **39.54 s** upload, HTTP **200**, `response.completed`, final **`BODY_RECOVERY_PRODUCTION_OK`**, `turn.completed`, exit **0** |
| Original thread preservation | Rollout byte size and nanosecond mtime unchanged; no second writer resumed the original thread |
| Near EOF, stop with final 8 KiB unread | **30.02 s**, **408 `request_timeout`**, connection close, no decode-handback |
| Public authenticated `/readyz`, `/v1/models`, `/ui/`, `/` redirect target, CSS and JS assets | All **HTTP 200**; 52 model entries observed |
| Codex actual turn-error audit since production service start | **0** new turn errors in the host Codex logs at the acceptance checkpoint |

The public JavaScript asset required authenticated access in this observation:
an unauthenticated probe received 403, then the authenticated asset returned 200.
No claim is made that public anonymous JS access or desktop visual acceptance
was verified. There were no UI changes specific to this repair.

## Build, backup and review boundaries

A complete Linux x64 release was independently built from an ordinary immutable
Git archive: fresh WebUI production build, production Node dependencies, native
Go server/CLI, portable archive and self-extracting executable. No branch or
worktree was created and shared working-tree/index content was not used.

An initial standby artifact inherited shared Git HEAD metadata after a peer
commit advanced HEAD, despite unchanged frozen files. It was rejected and kept
separate. Rebuilding with a private metadata-only descriptor pinned to the frozen
commit corrected both build stamps. The final verified standby has:

- `source_sha`: `f944797c137a8f7f3ba32db09670c941f23ec116`
- Same native SHA256 as production.
- Full archive SHA256:
  `6cc3714c30421cdbce97028607481ce987cbd39f42b14f977ffb924d60f4df2f`
- Self-extracting artifact SHA256:
  `f6812e260d882b7696b89eccab2a0d07ab3a46470452d33399bee211189d0ce4`

This standby was **not deployed or run as a replacement**. The accepted original
production archive was also retained privately with its checksum.

An **after-deployment** SQLite online snapshot and service/build receipts were
saved under remote `~/.ai_home/run/production-acceptance-f944797c1-20261115`.
`PRAGMA quick_check` returned `ok`; schema remained **31**, with **22** canonical
accounts and **22** credentials. No database rollback or migration was performed.
The prior package `802632cd` was already absent when inspected. Therefore this
session does **not** claim a pre-cutover backup, an immediately available original
release rollback or a rehearsed rollback. The after-deployment snapshot does not
retroactively supply those assurances.

Independent review approved adopting the already-running identical release and
explicitly advised against a redundant rollout/restart. It retained the blank
source-stamp and old-release rollback caveats above. Review relied on this
session's parity and real-runtime evidence; the reviewer did not rerun production.

## Closeout

The original `invalid_request_body` recurrence is **fixed in the running remote
production gateway and verified with the original failed history**. This session
did not restart local or remote shared services, rewrite original sessions,
change credentials/configuration, disable accounts or revert peer code. All
private request bodies/database snapshots/raw evidence remain outside Git in
mode-0700 evidence directories; this report is sanitized.
