---
name: aih-codex-implementer
description: Implement approved AIH Fabric tasks in /Users/model/projects/feature/ai_home. Use when asked to execute code changes from docs/fabric designs, especially server profile, node/relay registry, transport, native PTY/TUI, protocol, or test implementation work.
---

# AIH Codex Implementer

This is a project-local skill. If the runner does not auto-discover `docs/fabric/skills/*`, invoke it by passing this folder path explicitly or install it into the configured Codex skills directory.

## Role

Implement narrowly scoped AIH Fabric tasks after the design has been approved or explicitly selected. Do not redesign the product while implementing.

## Required Reading

Before editing code, read the relevant design source:

- Product and scope: `docs/fabric/00-product-brief.md`
- Network and role model: `docs/fabric/01-network-topology.md`
- User flows: `docs/fabric/02-user-flows.md`
- Data model: `docs/fabric/03-data-model.md`
- Protocol: `docs/fabric/04-protocol.md`
- UI wireframes: `docs/fabric/05-ui-wireframes.md`
- Milestones: `docs/fabric/06-implementation-plan.md`
- Tests: `docs/fabric/07-test-plan.md`
- Lifecycle gates: `docs/fabric/09-development-lifecycle.md`
- Legacy migration: `docs/fabric/10-legacy-control-plane-migration.md`

Read only the sections needed for the task, but never implement behavior that contradicts these documents.

## Implementation Workflow

1. Restate the selected task in one paragraph.
2. Inspect current code paths before editing.
3. Identify the smallest boundary-preserving change.
4. Implement only the selected behavior.
5. Add focused tests.
6. Run targeted tests first, then broader tests when the blast radius warrants it.
7. Report evidence with commands, outputs, and changed files.

## Boundaries

- Keep server profile, node registry, relay transport, session protocol, provider runtime, and Web UI state separate.
- Prefer adapters over large rewrites when migrating existing Control Plane code.
- Do not hard-code a local server as the client default.
- Do not add provider-specific hacks to generic protocol code.
- Do not treat WSS relay success as proof that native TUI sessions work.
- Do not store real tokens, private keys, refresh tokens, or production secrets in repo files.

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

- The task conflicts with `docs/fabric/`.
- The implementation requires destructive git operations.
- The implementation would expose credentials or production endpoints.
- The requested scope would require redesigning product behavior rather than implementing an approved task.
