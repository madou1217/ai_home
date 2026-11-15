# SFTP safe replacement checkpoint

## Real evidence and defect

Local `/usr/libexec/sftp-server` supports ordinary v3 rename and OpenSSH `posix-rename@openssh.com`. Actual protocol exchange: ordinary rename over existing file returned status4; extension succeeded. With native server `-P rename,posix-rename`, the old backup algorithm (rename fails → unlink target → retry rename) deleted the old file and still failed. This was a real protocol/algorithm primitive experiment, not a fake SFTP implementation or complete backup SSH-auth flow.

## Changes

- `lib/runtime/sftp-rename.js` is a focused ssh2 capability adapter shared by Node backup and workspace I/O. Uses OpenSSH atomic extension; fallback to v3 only for explicit unsupported (status8 or ssh2's exact preflight missing-extension error). Other failures propagate, never authorize target deletion.
- `file-ops-sftp.js` retains deadlines/error mapping; temp filenames now use crypto randomness. Cleanup only targets its own temporary file.
- Go minimal SFTP client parses bounded VERSION extension strings, issues type200 posix-rename when advertised, falls back only for unsupported. Backup strategy no longer removes destination after arbitrary rename failure.
- No changes to remote backup identity/manifest format, SSH trust, key storage or user remote directories.

## Actual after

`sftp-replacement-evidence-2026-11-15.json`: product `sftpFileOps.writeFile`, actual ssh2 codec, direct transport to actual OpenSSH subprocess.

| Server | Result |
|---|---|
| normal | OLD→NEW, correct size/mtime, zero owned temp files |
| deny rename/posix-rename | explicit permission_denied; OLD retained; zero owned temp files |

Real Go package build passes, but Go SSH path has not been runtime exercised. Existing unrelated sshd/Colima sftp processes were identified and left untouched; own protocol subprocesses exited.

## Important remaining acceptance

Servers without atomic replacement may now explicitly reject overwrite rather than destroy the old target. This is an immediate data-loss prevention step, **not** the final compatibility goal. A Windows/non-atomic server replacement strategy needs a separate recoverable backup/swap protocol and truthful semantics, plus real server evidence. Timeouts/uncertain ACKs/concurrent external writers require recovery policy; do not turn generic status4 or transport failure into delete permission.

G06 manifest/object consistency and restore checksum/identity verification remain open. G03 expected_version and G04 remote symlink path containment remain open. Independent source review found a remote-status/message collision; numeric status now takes precedence, only code8 may fall back, local exact capability error is accepted only without a code. Other wire/negotiation/no-unlink paths accepted at source level. No remote system configuration, actual backup, restore, credentials or paid inference touched. No tests added.

Reviewer boundaries retained: Go write CLOSE errors and blocked-close mutex; timeout can leave an uncertain delayed rename despite client error; aborted cleanup may be skipped. Therefore only definite permission-denial preservation was proven, not “every failed call leaves OLD”. The initial workspace staging-cleanup gap was separately moved inside try after the reviewer snapshot.
