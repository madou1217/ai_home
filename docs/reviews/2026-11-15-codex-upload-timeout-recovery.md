# Codex long-history upload timeout recovery — 2026-11-15

## Finding

The recurring `invalid_request_body` is not a recurrence of the original 16 MiB
limit. The affected remote release already contains the 32 MiB decoder change.
Actual native Codex logs locate the latest occurrence at **2026-11-15 21:19:49
Asia/Shanghai**, after earlier failures at 20:21–20:25. The remote response included
`x-aih-decode-rejected: 1`.

A read-only ephemeral fork of affected thread
`01a1daba-e618-7151-b14c-9be63122f335` produced a **7,285,798-byte valid JSON**
pre-sampling compaction request. The original rollout's size and nanosecond mtime
were unchanged. Normal-speed replay completed successfully, while a real upload
of this body at 128 KiB per 700 ms to the remote production loopback listener
failed after **30.81 s** with the exact reported HTTP 400 body.

Causal chain:

1. `internal/host/aihserver/server.go` applies an absolute 30-second `ReadTimeout`
   to the entire request, including an actively progressing body upload.
2. Native Responses `readBounded` converted the socket timeout into its generic
   invalid-request error.
3. The native handler mislabeled this incomplete upload as a decoder gap and
   emitted `invalid_request_body` with the Node decode-handback marker.
4. Longer session histories are more likely to cross this time boundary even
   when below the byte limit. Retrying on a faster connection can mask the defect.

## Narrow repair

- Add `inferenceapi.ReadRequestBody` in a focused `body_deadline.go` module.
  Authenticated native Responses uploads use a **30-second idle** timeout and a
  fixed **five-minute total** budget, while preserving the 32 MiB wire limit.
- Refresh the socket deadline before each read, bounded by the original total
  deadline. Clear it only after a complete successful read.
- On failure expire the read deadline and close the connection, preventing
  `net/http` cleanup/draining from waiting indefinitely near EOF or on incomplete
  chunked bodies.
- Return the shared **408 `request_timeout`** contract for upload timeouts, before
  account selection/upstream contact and without decode-handback. No blind
  server-side replay was added.
- Existing malformed JSON, unsupported encoding, decompressed byte limits,
  compressed passthrough/sanitization semantics and account selection remain
  unchanged. The host-wide timeout was not globally loosened.

## Real verification

No test cases or synthetic session fixtures were added. Verification used real
saved history, a native Codex ephemeral fork, real sockets, a remote native server
on an independent port and a SQLite online-backup copy of the remote database.
No second writer attached to an original thread or the production database.

| Observation | Result |
| --- | --- |
| Production original, slowly upload real 7,285,798-byte body | 30.81 s, broken pipe, 400 `invalid_request_body`, decode-rejected |
| Isolated repair, same body/pace | 39.22 s upload; 200; `response.completed` at 116.28 s |
| Original affected native Codex thread via `exec fork --ephemeral`, read-only, actual slow upload | 39.54 s first upload; compaction and next request both 200 / `response.completed`; `BODY_RECOVERY_OK`; `turn.completed`; exit 0; original rollout unchanged |
| Stalled upload with large unread tail | 30.00 s, 408 `request_timeout`, connection close, no decode-handback |
| Stalled upload with only final 8 KiB unread | 30.02 s, 408; no cleanup/drain hang |
| Chunked 32 MiB + 1 byte, no terminating chunk | 0.12 s, 413 |
| Declared oversize without sending body | Immediate 413 |
| Malformed JSON | Immediate 400 |
| Unauthorized request without sending body | Immediate 401 |
| Previous 16,862,842-byte captured history, remote identity/gzip/zstd | All 200 / `response.completed` at normal upload speed |

`go build` and `go vet` passed for the affected ingress packages, `gofmt` and
`git diff --check` were clean, and the shared JSON error contract loaded in Node.
Full native Linux builds passed from two immutable source snapshots: committed
main plus only the four-file repair, and remote's declared baseline plus its
committed root-redirect repair plus only this repair. These are **verification
artifacts**, not an assertion of identical production build provenance.

Independent review identified the incomplete-body cleanup/deadline issue before
release; it was corrected before the near-EOF and chunked acceptance above. The
reviewer then approved the four-file repair with no remaining source blocker,
explicitly excluding production rollout approval.

## Delivery boundary — production intentionally unchanged

The running remote package is
`~/.ai_home/pkg/1.0.0-linux-x64-802632cd`, service
`com.meadeo.ai_home.service`. Its actual native binary SHA256 is
`cbc438217c99624c5cd28c3ce6505f3fc61d897d3acc28a6460d05c78f571ad6`;
embedded VCS identifies `d11a5096e33585966c67586506a5b511d299cc7d` **with dirty
sources**. Symbol comparison proves that it contains peer features absent from
that clean baseline, including backup repository v2 and native state paging.
Replacing it with a baseline-only rebuild would silently remove those features.
Current main also contains later unrelated business changes.

Therefore neither production service was restarted/replaced and no database
migration, account disablement, credential/configuration change or package-link
mutation was performed. The fix is source/isolated-runtime accepted, **not yet
production released**. Release needs an approved integrated source/artifact
boundary or a reproducible copy of the deployed dirty sources; do not substitute
an older binary or broadly deploy the shared working tree.

Raw captured bodies, private database snapshots and detailed output remain in
mode-0700 evidence directories outside Git; the repository contains this
sanitized report only. The main Git index has unrelated peer reverse differences;
commit only this repair's explicit paths using a one-use independent index.
