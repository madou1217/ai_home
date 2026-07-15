---
name: aih-codex-implementer
description: Implement approved AIH Fabric tasks in /Users/model/projects/feature/ai_home. Use when asked to execute code changes from docs/fabric designs, especially server profile, node/relay registry, transport, remote session protocol, provider runtime, or test implementation work.
---

# AIH Codex Implementer

This is a project-local skill. If the runner does not auto-discover `docs/fabric/skills/*`, invoke it by passing this folder path explicitly or install it into the configured Codex skills directory.

## Role

Implement narrowly scoped AIH Fabric tasks after the design has been approved or explicitly selected. Do not redesign the product while implementing.

## Required Reading

Before editing code, read these current sources in order:

1. Canonical Server/Client and authentication model: `docs/fabric/20-current-server-client-model.md`.
2. Current product, CLI, Web, and desktop behavior: repository root `README.md`.
3. The current implementation, API contract, and focused tests for the assigned behavior.

Documents `docs/fabric/00-*.md` through `19-*.md` and `docs/fabric/evidence/` are historical design and verification records. Use them only to understand prior decisions or reproduce old evidence. Their client pairing, device-token, per-client scope/revoke, Control Plane, or Node-first requirements must not be implemented or restored.

## Implementation Workflow

1. Restate the selected task in one paragraph.
2. Inspect current code paths before editing.
3. Map the task to the canonical Server/Client model and identify the smallest boundary-preserving change.
4. Implement only the selected behavior.
5. Add focused tests.
6. Run targeted tests first, then broader tests when the blast radius warrants it.
7. Report evidence with commands, outputs, and changed files.

## Boundaries

- Keep Server Profiles, SSH development machines, advanced worker registry, relay transport, session protocol, provider runtime, and Web UI state separate.
- A client uses only `Server URL + Management Key` and sends `Authorization: Bearer <Management Key>`. Do not add client pairing, device tokens, client invites, per-client scopes, paired/revoked states, or per-client revoke behavior.
- Keep the one-time worker join invite inside advanced worker onboarding. It is not a client credential and must not be required by Web, desktop, PWA, or CLI clients.
- Do not require a client machine to run a Server or register as a worker before it can connect to another Server.
- Prefer focused adapters over large rewrites when replacing obsolete internal terminology or contracts.
- Do not hard-code a local server as the client default.
- Do not add provider-specific hacks to generic protocol code.
- Do not treat WSS relay success as proof that remote sessions work.
- Do not expose a Management Key in URLs, ordinary logs, CLI output, diagnostics, tests, or repository files. Do not store real private keys, refresh tokens, or production secrets in repo files.

## Required Evidence

Every implementation report must include:

- Design document section used.
- Lifecycle gate satisfied.
- Files changed.
- Tests run.
- Any real runtime or network evidence, if the task touches transport or sessions.
- Known gaps.

## Stop Conditions

Stop and report before editing when:

- The task conflicts with `docs/fabric/20-current-server-client-model.md` or the root `README.md`.
- The task asks to restore client pairing, device-token, scope, or revoke behavior from a historical document.
- The implementation requires destructive git operations.
- The implementation would expose credentials or production endpoints.
- The requested scope would require redesigning product behavior rather than implementing an approved task.
