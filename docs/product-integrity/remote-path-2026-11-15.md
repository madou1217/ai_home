# G04 — remote workspace observed-path containment

Date: 2026-11-15. Continues the original M0–M5 goal. This is a bounded security/data-integrity work package, **not completion of G04 or M0–M5**.

## Confirmed defect

On this work package's own loopback OpenSSH server, a workspace directory link pointing to a sibling `workspace-other` allowed Go/Node file tools to read `OUTSIDE_SENTINEL` and create an outside file. Node list also entered that external directory. No real user files were used; every root/target/key/config was isolated. Go list additionally failed in the user's zsh on unmatched globs, and `wc -c < entry` read link referents solely to obtain size.

The old lexical normalization alone did not implement the documented workspace boundary.

## Shared implementation and preserved behavior

- `contracts/workspacepath/`: one set of POSIX/PowerShell path/search scripts, Go-embedded and Node-read. No upstream-client fork, remote agent installation, Python dependency or silent lexical fallback.
- `internal/adapters/remotepath`: Runner-based adapter, strict NUL framing, stable error codes, remote-dialect path normalization. Used by Go tools **and** Go WebUI remote file readers.
- Node `workspace-path` / `workspace-path-sftp`: common semantic boundary and server-local SFTP namespace. Actual file operations consume checked paths; SFTP I/O reuses the exact resolver session, not a newly opened generation.
- Configured root links are accepted on first binding; internal directory and file links remain usable. External referents are rejected. Relative/absolute link targets are resolved in remote namespace with bounded traversal. Existing broken/loop links are not treated as ordinary missing paths.
- Preserve backend publication semantics: POSIX/SFTP rename replaces a leaf link directory entry; Windows Go direct-write targets its verified referent. This work does **not** silently redefine leaf-link writes. Removing a link unlinks the entry, not its target.
- One canonical root per operation/retry; `edit_file` carries the same binding from read through write via private non-enumerable metadata. Observed canonical-root rebinding is rejected. No long-lived cache of “safe” paths.
- POSIX preserves spaces, quotes, literal `*`, backslashes and newline filename bytes. BSD `readlink -n` avoids losing a true final newline. Missing-entry checks use `find -exec` argv, not newline parsing or unexpanded glob patterns.
- Go list runs explicit `sh`, uses no-follow stat metadata and labels links before directories. Search avoids following symlinks/reparse points, including rg configuration overrides; grep fallback enumerates regular files without following links. Existing caller-specific ignore/per-file limits are retained.
- `run_command`, SSH shell, RemoteMachine and arbitrary Git/command execution are deliberately **not OS sandboxes** and retain their original authority.

## Real acceptance and scope

Evidence: `remote-path-2026-11-15/manifest.json` and the named JSON records. No repository test cases were added.

| Path | Actual observation |
|---|---|
| Go tools → own OpenSSH (`-race`) | external directory/leaf reads, directory listing and new write reject; outside sentinel unchanged/no new file |
| Internal links / root alias | read succeeds; internal leaf edit retains the original POSIX rename semantics; original referent unchanged |
| Literal/whitespace paths | nested create/read succeeds with quotes/newline; tail-newline configured root and link target retained; literal glob names supported |
| Broken/loop links | explicit resolution error, not create permission |
| Observed root rebind | real renamed-root→external-symlink change yields `workspace_root_changed` |
| Go WebUI file service | external read denied; internal read succeeds over actual SSH |
| Node MCP stdio → real service/pool/SSH | external read/write rejected; internal read/new/edit succeeds; final file bytes checked |
| SFTP adapter → actual OpenSSH | external link read/write rejected; nested internal create succeeds; unlink external link retains referent |
| SFTP generation | close resolved session before I/O → `connection_lost`; explicit new session + re-resolve succeeds |
| Edit root binding | read A, repoint config alias to same-content B, write using read binding → A edited, B unchanged |
| Adjacent large-file protection | 524288B still edits; 524289B remains unchanged with file_too_large |
| Platform build | affected Go packages build locally and for windows/amd64; JS syntax checks pass |

## Performance

Thirty interleaved actual loopback reads over the same authenticated pool compared the legacy raw exec adapter with guarded RemoteHost. Before eliminating a redundant root query, guarded p50 was 27.59ms; after, p50 21.26ms / p95 25.13ms / max 26.12ms. The raw adapter in the latter sample was p50 7.14ms / p95 8.96ms. **The guard has a measured security cost; this is not a claim of overall speedup or no regression.** Root-only queries were removed from ordinary reads, but new-file writes retain an initial root binding so ENOENT cannot authorize a different root. WAN performance remains unmeasured.

## Still open — do not overclaim

1. **TOCTOU:** canonical strings and root equality are observed-path checks, not directory-FD/inode/handle-constrained I/O. Changes after checks, mount replacement, hard links and malicious-server responses are not solved. No atomic sandbox/CAS claim.
2. **Windows:** PowerShell handle-based final paths, bounded compressed command transport, UTF-8 framing, broken/reparse checks and no-follow search are implemented/source-reviewed, but actual Windows execution has not been obtained. A peer with an existing Windows acceptance channel was contacted; no credentials were copied and no remote machine was used without coordination.
3. **Conservative compatibility:** unresolvable/damaged links fail closed. New creation under a directory lacking enumeration permission can be refused even if write+execute is granted. Unsupported `readlink -n` / path capabilities fail, not silently bypass.
4. Existing directory/search line-oriented output cannot losslessly represent every newline filename; this work preserves filenames in file I/O and resolver framing, not a claim that all presentation formats are fixed.
5. No shared server rebuild/restart/deploy, DB migration, production account mutation or shell/completion changes. Current acceptance uses source and isolated executables/processes. Full backup/restore consistency, remote CAS and broader M0–M5 gates remain active.
