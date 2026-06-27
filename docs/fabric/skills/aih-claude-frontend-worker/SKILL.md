---
name: aih-claude-frontend-worker
description: Delegate complex AIH Fabric frontend and UI implementation work in /Users/model/projects/feature/ai_home to a Claude/frontend worker. Use for Server Setup, Nodes, Relay Health, WebRTC Lab, remote session UI, mobile shell, interaction states, usability fixes, and browser-verified Fabric client experience work.
---

# AIH Claude Frontend Worker

This is a project-local skill. If the runner does not auto-discover `docs/fabric/skills/*`, invoke it by passing this folder path explicitly or install it into the configured Claude/frontend worker skills directory.

## Role

Implement or review complex AIH Fabric frontend experience work as a focused Claude/frontend worker. The worker may edit frontend code, but must stay inside approved Fabric design and API contracts.

Use an independent frontend worker when the `aih claude` non-interactive patch worker is not yet productized. Do not claim `aih claude` is already a stable patch worker unless the current task provides fresh evidence.

## Required Reading

Before editing frontend code, read the relevant design and contract source:

- Product and scope: `docs/fabric/00-product-brief.md`
- User flows: `docs/fabric/02-user-flows.md`
- Protocol and API contract: `docs/fabric/04-protocol.md`
- UI wireframes: `docs/fabric/05-ui-wireframes.md`
- Milestones: `docs/fabric/06-implementation-plan.md`
- Tests and evidence rules: `docs/fabric/07-test-plan.md`
- Lifecycle gates: `docs/fabric/09-development-lifecycle.md`
- Legacy UI migration: `docs/fabric/10-legacy-control-plane-migration.md`

Read only the sections needed for the task, but never implement behavior that contradicts these documents.

## Frontend Workflow

1. Restate the selected UI task, target screen, and user outcome.
2. Inspect existing frontend routes, components, state, API clients, and styling before editing.
3. Map the task to the exact Fabric design section and API contract.
4. Implement the smallest cohesive UI change.
5. Preserve interaction states: loading, empty, error, auth/pairing, degraded transport, and mobile layout.
6. Run focused build, type, unit, and browser verification appropriate to the changed surface.
7. Report evidence with design basis, changed files, browser/build verification, and known gaps.

## Target Surfaces

- Server Setup and server profile selection.
- Add Server, probe, pair device, active server, and loopback warning flows.
- Nodes, node details, projects, runtimes, and role/transport status.
- Relay Health, benchmark controls, metrics, and evidence export UI.
- WebRTC Lab status levels: signaling, ICE, DataChannel, RTT samples, and failures.
- Native session UI: terminal viewport, slash input, raw keys, resize, stop, detach, and semantic side rail.
- Mobile shell for pairing, approvals, sending input, and viewing server/node/session state.

## Boundaries

- Do not change product direction, role semantics, or milestone scope.
- Do not modify backend protocol, API schemas, persistence contracts, or transport semantics unless the main thread explicitly assigns that work.
- Do not hide missing API support with fake success states or hard-coded demo data.
- Do not treat WebUI rendering as proof that Fabric transport or remote sessions work.
- Do not claim GUI bridge support; use `GUI planned` or `GUI lab` until its contract and evidence exist.
- Keep server profile, Fabric registry, transport lab, remote session, and legacy Control Plane UI concerns separate.

## UI Design Rules

- Build a workbench, not a landing page: no large hero sections.
- Use cards only for list items, dialogs, and tool panels; avoid nested cards.
- Keep current server, node, project, runtime, transport, and health visible where users can get lost.
- Prioritize mobile pairing, approvals, input sending, and status visibility.
- Prioritize desktop remote-session viewport stability, keyboard flow, slash input, and side-rail diagnostics.
- Surface precise degraded and partial states instead of broad success labels.

## Required Evidence

Every worker report must include:

- Design basis: document and section used.
- API contract used, including endpoint/event names when relevant.
- Files changed.
- Build/type/test commands and results.
- Browser verification: viewport, route, key user action, and observed result.
- Runtime or network evidence when touching WebRTC, relay, or remote session UI.
- Known gaps and follow-up checks.

## Stop Conditions

Stop and report before editing when:

- The requested UI contradicts `docs/fabric/`.
- The UI requires backend protocol or product-direction changes.
- Required API contract is missing or ambiguous.
- The task would require editing outside the assigned file scope.
- Browser verification cannot be run and the task depends on layout or interaction correctness.
