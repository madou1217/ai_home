# Remote write-version contract — recovered closeout, 2026-11-15

This continues the existing M0–M5 SSH/tools work package. The Go fix and its real evidence preceded the latest `aih ls` priority; they were not reimplemented. Node MCP/connection-pool acceptance was the remaining breakpoint.

## Defect and retained contract

`write_file` declared `expected_version` in the tool schema but execution could accept a missing/wrong-typed version. Tool schemas are descriptive, not an execution guard. The guarded contract is a **required string**: read_file version for modification, empty string for new-only. Null, missing, number, bool, array and object are rejected before workspace/auth resolution and before MCP HTTP forwarding. Path/content must also be strings. Existing-file new-only conflicts even when content is identical. Retry checks the current version again; edit writes using its initially read version.

This is read/check/replace conflict prevention, **not atomic CAS against arbitrary external writers**. A modification between check and rename remains a separate open G03 race. G04 remote symlink/root containment is also open. Non-atomic SFTP v3 recovery is not described as guaranteed atomic replacement.

## Real evidence

- `remote-tools-go-live-2026-11-15.json`: recovered prior actual `CallRemoteTool` → own OpenSSH → POSIX files evidence, isolated Go appstate and temporary key under isolated `.ssh`. Missing/wrong version rejected, original preserved, read/write/new/edit successful, new-only same-content conflict. Not rerun just to manufacture a new timestamp.
- `remote-tools-node-live-2026-11-15.json`: new actual Node MCP stdio process → launch-context → isolated `aih.db` → `RemoteWorkspaceService`/connection pool → own OpenSSH → POSIX commands. No mock server or fake RemoteHost. Invalid values all rejected and USER ORIGINAL retained; valid read/write, stale-version rejection, new-only same-content rejection, new empty-version file and versioned edit observed. Disk verification: `EDITED WRITE\n` and `NEW\n`.
- This validates direct MCP transport and real pool execution, **not** the separate HTTP forwarding/auth route. The forwarding guard has source review only.
- The Go/Node tool descriptions now agree with the required string contract and avoid claiming every backend is atomic. Syntax/package build are static evidence, not substitutes for SSH acceptance.

Shared-state boundary: the temporary OpenSSH listener belongs to this work package (loopback 64935, config under the recorded aih-product-sshd root). All account/workspace config writes for acceptance used isolated directories; no singleDB migration, rollback or shared service restart. No test cases added.

## Additional confirmed data-loss defect: truncated versions

Real Go/OpenSSH reproduction used a 524,317-byte file with a retained-tail marker. `read_file` returned a version of only the first 524,288 bytes; `edit_file` then reported success while replacing the file with that prefix, losing the tail. A write with the prefix version also succeeded. This was isolated acceptance data, not a user file.

`completeRemoteFile` now supplies a version only for a complete read. POSIX checks both the bounded +1-byte read and transport truncation; PowerShell reads at most limit+1 bytes using a disposed FileStream rather than unbounded ReadAllBytes and rejects truncated base64 transport. Oversize results are explicit `file_too_large`, shared by read/edit/prewrite conflict checking. The 512 KiB tool read ceiling is unchanged and matches the existing Node error behavior; silent loss is not replaced with a fake successful partial edit.

Real post-fix `-race` execution: 524,317-byte file remains byte-for-byte unchanged after rejected read/edit/prefix-version write; exactly 524,288 bytes still edits successfully without length change; 524,289 bytes is rejected and preserved. Normal read/write/new-only/edit journeys were repeated successfully. See `remote-tools-large-file-2026-11-15.json`. Windows package cross-build passed; actual PowerShell execution remains unverified. No gateway restart or production service binary update was performed for this server-side change.
