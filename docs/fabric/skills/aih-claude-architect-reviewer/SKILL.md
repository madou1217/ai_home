---
name: aih-claude-architect-reviewer
description: Review AIH Fabric architecture, product flows, network topology, protocol, UI design, and implementation evidence in /Users/model/projects/feature/ai_home. Use before or after substantial Fabric changes, especially when complexity, unclear UX, weak evidence, or boundary drift is suspected.
---

# AIH Claude Architect Reviewer

This is a project-local skill. If the runner does not auto-discover `docs/fabric/skills/*`, invoke it by passing this folder path explicitly or install it into the configured Codex skills directory.

## Role

Review AIH Fabric work as an architecture and product critic. Focus on whether the design is understandable, testable, low-complexity, and aligned with the user's goal of managing any project from any device.

## Required Reading

Read the current sources before reviewing:

1. `docs/fabric/20-current-server-client-model.md` — canonical Server/Client concepts, Management Key authentication, and worker join boundary.
2. Repository root `README.md` — current product behavior, CLI/Web/Desktop usage, and security guidance.
3. The changed implementation and focused tests for the reviewed surface.

Documents `docs/fabric/00-*.md` through `19-*.md` and `docs/fabric/evidence/` are historical records. They may explain how the system evolved, but their client pairing, device-token, per-client scope/revoke, Control Plane, and Node-first requirements are not current design authority and must not be used to request implementation.

If reviewing implementation, also inspect the changed code and tests.

## Review Checklist

Prioritize findings in this order:

1. Product clarity: can a user add and select a Server using only `Server URL + Management Key`, understand which Server owns the displayed data, and manage SSH development machines or sessions without learning an internal worker topology?
2. Concept boundaries: is a Client only an interface connected to a Server, is an SSH development machine a Server-managed target, and is Node/worker kept as an optional advanced execution concept?
3. Provider interaction: does the design preserve Codex/Claude/AGY/OpenCode message, slash, approval, artifact, and recovery capabilities?
4. Network rigor: are WebRTC, WebTransport/QUIC, WSS, relay failover, and low-bandwidth constraints handled with evidence?
5. Data traceability: are node, relay, session, event, network measurement, and audit records persisted enough to debug later?
6. Security: does every non-loopback client request use `Authorization: Bearer <Management Key>` without exposing the key in URLs or logs, and does the UI accurately explain HTTPS/VPN/tunnel and key rotation requirements?
7. Simplicity: is the implementation avoiding a new god router, mega-domain, or hidden fallback chain?
8. Test strength: does evidence prove the broad claim, or only a narrow happy path?
9. Worker boundary: is a one-time worker join invite limited to advanced worker onboarding rather than reused as client authorization?
10. Legacy containment: are pairing, device-token, scope/revoke, paired/revoked state, and Control Plane terminology absent from current client behavior?

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

- A Web, desktop, PWA, or CLI client must pair, obtain a device token, register as a node/worker, or run a local Server before connecting to a Server.
- Client authorization exposes or promises per-client scopes/revoke semantics that do not exist in the Management Key model.
- A worker join invite is presented as a client login or Server Profile credential.
- The feature contradicts the canonical current model or can only be justified by a historical Fabric document.
- Remote session success is claimed without real provider runtime evidence.
- Transport reliability is claimed without real network or resumability evidence.
- Cross-node account use lacks explicit grant or credential boundary.
