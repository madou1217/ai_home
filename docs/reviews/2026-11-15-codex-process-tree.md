# Caller-owned Codex process lifecycle — 2026-11-15

This checkpoint extends the existing native app-server process port rather than creating a second process supervisor.

- Startup receives an explicit working directory, preserving the caller's project instead of inheriting the gateway/host cwd.
- Windows verbatim command-line intent can be preserved after the existing Node adapter resolves a batch/npm shim. Windows tree termination uses bounded taskkill /T plus direct fallback; source/cross-build only, not Windows live acceptance.
- POSIX process groups are created exclusively for the child and terminated exactly once. Leader Wait triggers immediate group cleanup; a leader having exited no longer proves its descendants exited. Later Close reuses the completed cleanup instead of signaling that old PID again.
- Close retains bounded graceful termination/forced kill and pipe cleanup. Current CODEX_HOME transaction readiness checks and all peer-owned environment/account changes remain in the committed source.

Actual evidence: `aih-local-final-pipes-l6roNN` uses real sh/cat/sleep. The shell leader exited with a live30-second descendant; the descendant was gone in168 ms and the final stdout frame was preserved. An actual blocked stdin writer closed in15,049 ms. `aih-local-official-churn-P7Y4yd` ran ten actual official Codex initialize/config/read/disconnect cycles:7 FDs/0 child processes at every checkpoint, active shutdown exit0 in1,029 ms. No paid inference, shared gateway restart, test cases or fake process protocol were used.

Native/full isolated snapshot build, production-source vet and Linux/Windows package cross-builds passed. A single cleanup primitive still cannot guarantee a malicious process that intentionally escapes its group; no such broad claim is made. Windows runtime remains unverified.

The original shared index includes an unrelated staged reversal of CODEX_HOME readiness logic from the AWS snapshot incident. This session commits current HEAD plus only its process delta using a one-use independent index; an independently prepared temporary main-index projection applies only that same delta to the old staged blob, preserving the peer's existing staged reversal exactly. No reset/revert/amend or peer-code deletion.

Review fallback is documented self_review because original reviewer contexts are exhausted. Scope, process-group ownership, once/order semantics, exact staged diff and actual exit evidence were inspected. The overall migration goal is not complete.
