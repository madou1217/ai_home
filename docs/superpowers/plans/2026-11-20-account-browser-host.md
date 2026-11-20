# Account browser shared stable host Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development, with the original AWS Neon owner on the disjoint storage module and Planck on independent read-only review. User forbids test cases and branch/worktree creation for this task.

**Goal:** Implement a safe single task-owned stable Edge process lifecycle as a prerequisite, without misrepresenting it as an interactive browser.
**Architecture:** Stable signed identity discovery and platform process ownership remain separate from lifecycle orchestration and private disk locking. No changes to account Open/composition/UI until frame/input exists.
**Tech Stack:** Go standard library, existing golang.org/x/sys/unix, installed macOS stable Edge and codesign/plutil.
**Spec:** docs/superpowers/specs/2026-11-20-account-browser-host.md

## Global Constraints
No Electron, WebView substitution, test cases, debug/automation flags, installs, permissions, daily-profile access, service restarts, automatic crash recovery, broad kill, per-account browser instances, branch/worktree or source copies. Preserve peer index and required dependencies. Only new package and these two documents are writable.

### Task 1: Storage and signed identity
Owner AWS Neon: new storage.go. Coordinator: new types.go, identity_darwin.go, process_darwin.go, family_darwin.go, platform_other.go, doc.go, and mechanical storage_files.go split.
- [x] Define exact internal storage API: acquireStorage(dir) -> *hostStorage, prepare() -> userDataDir, markActive() error, release(clean bool) error. Flock is platform helper lockFile/unlockFile. Private root/file checks; stale marker fails closed.
- [x] Verify stable bundle identity/version and anchored Microsoft code signature with bounded external commands. Return only fixed executable and fixed allowed flags internally.
- [x] Implement dedicated process group, root birth-identity signal checks, group-empty observation; unsupported stub elsewhere.

### Task 2: Lifecycle orchestration
Owner coordinator: new supervisor.go, shutdown.go.
- [x] Serialize state-changing operations with context-cancellable entry; running Start reuses PID. Check cancellation before spawn, own cleanup after the spawn commit point.
- [x] Keep disk lock/active marker until verified shutdown; unexpected exits fail, no auto-respawn. Shutdown can be retried after cancellation or uncertain cleanup.
- [x] Running means process survival only; no attached Host or ready/cookie/login claims.

### Task 3: Real validation, review and scoped delivery
Owner coordinator; reviewer Planck read-only.
- [x] Gofmt, go build/go vet new package and cross-platform unsupported compile; no go test.
- [x] Temporary actual-process runner exercises fixed arguments, concurrent starts/cancellation, same-dir exclusion, dirty marker, stop/restart preserving data, unsafe paths. Read-only daily Edge PID metadata before/after; no capture/input.
- [x] Review implementation, correct material findings, rerun affected actual operations. Record commands, hashes, pass/fail and unverified items; clean task processes/temp artifacts.
- [ ] Audit HEAD/disk/main index; prepare fresh temporary index for only this dependency-complete package plus docs; inspect cached diff/stat; explicit-path commit; verify committed tree and peer index; push main and verify remote contains it. No deploy.

## Dependency audit
Task1 storage exports four methods consumed by Task2, with no shared writable files. Platform types/functions are coordinator-owned and fixed in the worker brief. Task3 consumes the built complete package, not an untracked substitute. All tasks retain the stage boundary in the spec.
