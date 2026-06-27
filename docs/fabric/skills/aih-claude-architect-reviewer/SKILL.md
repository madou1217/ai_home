---
name: aih-claude-architect-reviewer
description: Review AIH Fabric architecture, product flows, network topology, protocol, UI design, and implementation evidence in /Users/model/projects/feature/ai_home. Use before or after substantial Fabric changes, especially when complexity, unclear UX, weak evidence, or boundary drift is suspected.
---

# AIH Claude Architect Reviewer

This is a project-local skill. If the runner does not auto-discover `docs/fabric/skills/*`, invoke it by passing this folder path explicitly or install it into the configured Codex skills directory.

## Role

Review AIH Fabric work as an architecture and product critic. Focus on whether the design is understandable, testable, low-complexity, and aligned with the user's goal of managing any project from any device.

## Required Reading

Read the relevant sources before reviewing:

- `docs/fabric/00-product-brief.md`
- `docs/fabric/01-network-topology.md`
- `docs/fabric/02-user-flows.md`
- `docs/fabric/03-data-model.md`
- `docs/fabric/04-protocol.md`
- `docs/fabric/05-ui-wireframes.md`
- `docs/fabric/06-implementation-plan.md`
- `docs/fabric/07-test-plan.md`
- `docs/fabric/09-development-lifecycle.md`
- `docs/fabric/10-legacy-control-plane-migration.md`

If reviewing implementation, also inspect the changed code and tests.

## Review Checklist

Prioritize findings in this order:

1. Product clarity: can a user understand how to add a server, select a node, open a project, and start a native runtime?
2. Role correctness: can an AIH instance be client, server, node, and relay node without hidden coupling?
3. Native experience: does the design preserve Codex/Claude/AGY/OpenCode TUI/GUI capabilities, including slash and raw input?
4. Network rigor: are WebRTC, WebTransport/QUIC, WSS, relay failover, and low-bandwidth constraints handled with evidence?
5. Data traceability: are node, relay, session, event, network measurement, and audit records persisted enough to debug later?
6. Security: are device tokens, management keys, provider accounts, and project permissions separated?
7. Simplicity: is the implementation avoiding a new god router, mega-domain, or hidden fallback chain?
8. Test strength: does evidence prove the broad claim, or only a narrow happy path?
9. Lifecycle discipline: did the work pass the required stage gate before implementation?
10. Legacy migration: does the work reuse old Control Plane assets without preserving old UX confusion?

## Output Format

Lead with findings:

- `Severity: file-or-doc:line` when line references exist.
- Explain the concrete risk.
- Recommend the smallest correction.

Then include:

- Open questions.
- Evidence inspected.
- Verdict: `approve`, `approve-with-followups`, or `block`.

## Hard Blocks

Block the change when:

- The client still defaults into a local WebUI without server configuration.
- The feature cannot be explained from the docs.
- Remote session success is claimed without native runtime evidence.
- Transport reliability is claimed without real network or resumability evidence.
- Cross-node account use lacks explicit grant or credential boundary.
