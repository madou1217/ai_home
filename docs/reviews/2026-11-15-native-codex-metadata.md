# Native Codex metadata read closeout — 2026-11-15

## Source and delivery boundary

This session authored the native title/Goal read slice before recovery. On continuation, authoritative HEAD already contained that exact source in `d59271737` (`fix(codex): read thread metadata through native snapshots`, committed at21:03:07 +08:00). All seven metadata implementation/adapter files matched the earlier private verification snapshot byte-for-byte. The implementation was not recreated or recommitted; this checkpoint adds only the session's completed acceptance record.

The title response path now batches requested IDs per vendor state database rather than repeatedly opening a database through the side-effectful general point lookup. The shared native opener uses existing paths only, `mode=ro`, `query_only(1)`, a single connection and explicit read transactions. Title lookup retains first-matching-source priority even when the first row's title is empty; it does not invoke rollout-path repair.

Goal reads distinguish `found`, `absent`, `unsupported` and `unavailable`. The native wire includes blocked and usage/budget limited status mappings. Successful upstream responses remain authoritative; only the explicit JSON-RPC method-not-found code-32601 can attempt local compatibility, and only an actual supported persisted goal can replace that error. Invalid-thread/missing-thread/permission/provider errors and local read failures are not converted to `{goal:null}` success.

## Before evidence

Private snapshot directory: `aih-metadata-real-x42ot8rz` under the OS temporary directory (0700; database/response artifacts0600).

- Real official Codex0.167.2 returned-32600 for an invalid thread ID and for a nonexistent thread. The pre-change patch converted both actual responses into successful null goals.
- A real blocked goal was returned as blocked by official Codex, but the old local reader returned null.
- `aih-metadata-title-readonly-y0zuaj7u`: an actual vendor row and actual rollout were copied to private storage and its cloned path changed to the stale-sidecar form. The old title lookup rewrote that cloned rollout_path; the new native read returned the same title with the path and database hash unchanged. No live history was changed.

## Completed actual acceptance

-43 actual Goal rows read from a private consistent copy:35 previously supported rows exactly match the old projection;8 actual blocked goals are no longer dropped. Four official successful responses match field-for-field, and the two actual official error responses remain unchanged. Goal database bytes remained unchanged.
-516 actual state rows: one native title batch exactly matches stored title/first-user-message semantics; a mixed response containing preexisting and absent titles matches the old wire projection. Missing IDs are not invented. State database hash unchanged.
- `aih-metadata-boundaries-final-_wxfvhw_`, fresh committed helper: corrupt DB exits1 with no result; real SQLite exclusive lock exits1 in1,046 ms with no result; FIFO exits1 without blocking; missing DB returns unavailable without creating it; incompatible schema returns unsupported. All regular-file bytes unchanged. A top-level source row with an empty title wins over a later nonempty copy; deleting only that private row lets the later source supply its actual title.1025 requested IDs and4097-byte ID reject without partial results.
- `aih-metadata-stdio-closeout-9XSqrZ`: actual production Node stdio script + official Codex0.167.2 + freshly built committed native helper, external networking denied by OS. Four persisted Goal states(active, blocked, complete, paused) retain the exact official wire; both invalid/missing-thread errors remain-32600 rather than success. A subsequent config/read succeeds. EOF exit0, no owned child remnants, private state/goals database hashes unchanged. No inference, login or paid request.
- Metadata source was freshly compared to exported commit `0d9468ae1`: identical. That exported snapshot passed `go build -mod=readonly ./...`, focused production-source vet, and Linux/Windows metadata-package cross-builds. JS syntax checks passed. No new test files or mock servers were written.

## Failed probes and evidence limitations

An early lock probe hashed the same inode after acquiring a Python-process POSIX advisory lock; opening/closing that extra descriptor released the lock and invalidated the probe. It was not accepted. The corrected probe hashes before acquiring the lock and never opens another descriptor in the lock-owning process during the native read. An attempted NULL title conflicted with the actual vendor schema; the precedence replay uses empty strings on the private real row instead. Neither failure led to production source changes.

There were no actual usageLimited/budgetLimited rows in this snapshot, so their mapping is source/schema evidence only. No legacy official binary returning-32601 was available; positive legacy-method fallback is not certified as a live upstream scenario. Current official success/error passthrough and native read states are verified. Whole-Desktop UI, Windows/Linux live behavior, broad title/Goal scale benchmarks, and arbitrary cross-database atomic snapshots are not established here.

## Shared workspace, review and remaining scope

The main index contained unrelated inverse changes for another owner's managed service-tier commit. This evidence-only commit uses an isolated one-use index, an explicit single pathspec and before/after scope checks. It does not stage, discard, reset, amend or recommit another session's code. The caller-local service-tier work, backup-account import, terminal recovery, business DB and shared gateway are untouched.

Original reviewer sidecars were context-exhausted; this is documented owner self_review of the bounded read APIs, error preservation, no-write SQL path and actual acceptance. Independent final approval is not claimed. No shared service restart, standard-binary replacement, deployment or push was performed for this closeout. The full Node-to-Go objective still has outstanding stdio orchestration, Desktop/plugin and final delivery/acceptance work; this slice is not project completion.
