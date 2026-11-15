# Codex notification cursor checkpoint — 2026-11-15

## Actual failure and corrected boundary

A real event from the existing Codex notification queue was copied, unchanged, to an isolated file in two writes. The old Node reader advanced to offset104 after seeing only the first104 bytes, returned no event, then advanced to208 after the remainder and still returned no event. The event was permanently lost. Existing Go bridge offsets also tracked only byte position/file length, so equal-size file replacement could leave the reader at the end of a new generation.

The new focused cursor binds the offset to file identity, an observed modification boundary and up to64 preceding consumed bytes. It consumes only complete newline-delimited records. Initial start-at-end keeps an unfinished last record pending; a later append can complete it. Rename/replacement, shrink, observed same-size rewrite or anchor mismatch resets to the new file. The anchor is derived from actually consumed bytes, never reread after a possible mutation.

Each poll reads at most256 KiB by default (hard ceiling1 MiB). Malformed or over-budget single lines cannot grow memory or indefinitely block later complete records: skip state is bounded and diagnostics report skipped lines. Only regular files are opened; Unix uses nonblocking open so a path replaced with a FIFO cannot hang. The Go notification bridge now uses this cursor under its existing queue lock rather than an offset-only reader. No queue writes or business database changes are introduced.

## Actual verification

- `aih-notification-before-ExLCYT`: old split-write event loss described above, using a captured real208-byte event.
- `aih-notification-live-ZdrAsv`: actual production JS adapter/native helper. Partial write held, completion delivered once; actual started/completed events preserve active/notLoaded behavior; same-size atomic rename, equal-size in-place rewrite and truncation continue reading. Diagnostics observe resets.
- `aih-notification-boundaries-dnzKK6`: start-at-end with an already-partial event still delivers after completion;331,200-byte malformed line followed by a real event is skipped with a diagnostic and the real event delivered; actual FIFO/no writer is reported without hanging.
- `aih-notification-go-bridge-eIcIts`: actual isolated full race-enabled Go Server → notification bridge → shared session bus → native WebSocket. Partial event held, complete event delivered, same-size queue replacement delivered; shutdown exit0 in1,027 ms, no race warning in server log.
- `aih-notification-final-resources-6M6zU2`: final source,1,000 captured actual events in five batches;6 file descriptors at baseline/every checkpoint, final partial/rename still pass. No claim of constant RSS or all-scale optimality.

Full/native build and production-source vet pass; platform cross-build evidence is recorded with final closeout. No new tests, mock file APIs or fabricated vendor histories were written. Only isolated temporary queue copies changed, not the live queue/service.

## Review and limits

Original reviewer contexts are exhausted; documented owner self_review checked cursor consumption, identity/anchor update order, startup partial handling, skip resynchronization and shared-index scope. Independent final approval is not claimed.

This queue is a best-effort invalidation stream, not durable exactly-once history: replaced generations may replay surviving events and arbitrary simultaneous same-inode rewrites cannot be made transactional by a byte cursor. Those limits are explicit. Legacy stateless exported readers remain compatibility APIs; production native bridge and the next standalone-poller checkpoint use the stateful cursor. The full Node-to-Go objective remains active.
