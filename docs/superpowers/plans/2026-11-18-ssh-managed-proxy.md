# SSH Managed Proxy Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development / executing-plans, disjoint write ownership; user prohibits new test cases, use real runtime acceptance.

**Goal:** Complete SSH host -> managed proxy pool -> provider install/update/completion, and switch-only automatic reverse forwarding.
**Architecture:** Native Go SSH forwarding supervised by the existing server, canonical managed-source projection, authenticated task leases with execution-host-local ingress. No remote proxy software.
**Tech Stack:** Go net/http + x/crypto/ssh, CommonJS CLI completion, React/Ant Design desktop.
**Spec:** docs/superpowers/specs/2026-11-18-ssh-managed-proxy.md

## Global Constraints
- Do not revert parallel-session work; no worktrees/branches, no new test files.
- Loopback only, no global proxy changes, no credential export. Failure closes explicitly, never silently direct.
- UI compact inline state, no Alert main content or decorative left bars; desktop only.

### Task 1: Reverse forwarding and SSH host settings
- [x] Implement atomic remote port0 and actual-port status, safe reconnect/probe.
- [x] Persist/validate enabled switch and proxyEnabled boolean, preserve old records.
- [x] Desktop switches/status, API model serialization. Real reverse SSH checks.

### Task 2: Managed SSH proxy runtime and canonical pool
- [x] Add SSH direct-tcpip capability and reusable HTTP proxy transport.
- [x] Add supervised SSH outlet readiness/retry/cleanup with stable IDs.
- [x] Synchronize managed source and nodes under existing pool store locks; runtime provenance checks.
- [x] Wire startup, record edits and shutdown; expose candidate and task-lease APIs.

### Task 3: CLI lifecycle and completion
- [x] Add optional proxy selector grammar, shared API lease + local HTTP ingress.
- [x] Expose install alongside update via existing provider install plans.
- [x] Complete available selectors via fast bounded snapshot; keep URL and native escape.

### Task 4: Runtime acceptance and review
- [x] Build Go CLI/server and WebUI, cross-build supported adapters.
- [x] Real AWS managed proxy, reverse ports and lifecycle cleanup; actual completion and install/update.
- [x] Independent review of credentials/provenance/port lifetime/scope; fix issues.
- [x] Background Edge visual inspection; state exact acceptance boundary.
- [x] Recheck shared staged scope and retained evidence before completion.

## Verified delivery evidence (2026-11-18)
- Native macOS CLI/server and Web production build passed; Linux/Windows adapters cross-built.
- Real AWS automatic reverse listeners distinct; reconnect changed port and removed old listener; 30s probe preserved port.
- Real native Go managed SSH proxy performs trusted DoH over selected outlet, rejects metadata/private/special addresses; no remote script/install.
- Stable SSH source/node automatically added/removed on switch; available candidates complete in shell.
- Actual Codex auto update0.170.0 and formal9527 auto install0.170.0; AGY named install1.5.10 and name-based update passed.
- Formal local service activated through canonical restart, `/readyz` ready=true and user tmux sessions retained; AWS proxy switch enabled, existing22022 reverse record preserved.
- 64 lease cap, release and switch cleanup, authentication, stable node identity, cancellation evidence retained under `~/.ai_home/run/ssh-managed-proxy-20261118-140515`.
- Independent runtime/CLI/reverse reviewers; no unresolved P1/P2. No new test cases, staging/commits/push, or AWS service deployment.
- Edge background actual SSH card/status and advanced2switch DOM inspected. Screenshot proof retained. Expanded desktop modal constrained to viewport; no mobile scope.
- Non-HTTP pool protocol sidecar builds and fails closed without a preinstalled mihomo; no local core was available for real-core execution.
