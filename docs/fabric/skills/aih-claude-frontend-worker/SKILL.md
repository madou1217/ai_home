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

Before editing frontend code, read these current sources in order:

1. Canonical Server/Client and authentication model: `docs/fabric/20-current-server-client-model.md`.
2. Current product and CLI/Web/Desktop usage: repository root `README.md`.
3. The current code, API client, route, types, and focused tests for the assigned surface.

Documents `docs/fabric/00-*.md` through `19-*.md` and `docs/fabric/evidence/` are historical design and verification records. Read them only when background is needed. Their client pairing, device token, per-client scope/revoke, Control Plane, or Node-first instructions must not be implemented or restored.

## Frontend Workflow

1. Restate the selected UI task, target screen, and user outcome.
2. Inspect existing frontend routes, components, state, API clients, and styling before editing.
3. Map the task to the canonical Server/Client model and the exact current API contract.
4. Implement the smallest cohesive UI change.
5. Preserve interaction states: loading, empty, error, unauthorized, degraded/offline Server, degraded transport, and mobile layout.
6. Run focused build, type, unit, and browser verification appropriate to the changed surface.
7. Report evidence with design basis, changed files, browser/build verification, and known gaps.

## Target Surfaces

- Server management and Server Profile selection.
- Add Server, test `Server URL + Management Key`, select the active Server, and show `ready | degraded | offline` states.
- SSH development machines, workspaces, and remote-development actions managed by the selected Server.
- Advanced worker inventory, projects, runtimes, and role/transport status when the task explicitly enters that internal topology.
- Relay Health, benchmark controls, metrics, and evidence export UI.
- WebRTC Lab status levels: signaling, ICE, DataChannel, RTT samples, and failures.
- Remote session UI: message input, slash input, approval actions, stop, detach, event stream, and semantic side rail.
- Mobile shell for Server setup, approvals, sending input, and viewing Server/session state.

## Boundaries

- Do not change product direction, role semantics, or milestone scope.
- Do not modify backend protocol, API schemas, persistence contracts, or transport semantics unless the main thread explicitly assigns that work.
- Do not add client pairing, device tokens, client invites, per-client scopes, paired/revoked states, or per-client revoke UI. A client authenticates with `Authorization: Bearer <Management Key>`.
- Keep the one-time worker join invite inside advanced worker onboarding. It must never become a client identity or a prerequisite for connecting a Web, desktop, or CLI client to a Server.
- Do not require a client machine to run a Server or register as a worker before it can connect to another Server.
- Do not hide missing API support with fake success states or hard-coded demo data.
- Do not treat WebUI rendering as proof that Fabric transport or remote sessions work.
- Do not claim GUI bridge support; use `GUI planned` or `GUI lab` until its contract and evidence exist.
- Keep Server Profiles, SSH development machines, advanced worker registry, transport lab, and remote sessions as separate concerns.
- Never put a Management Key in a URL, ordinary log, CLI output, analytics event, or UI error. Send it only through the Authorization header; follow the canonical document for browser and desktop storage boundaries.

## UI Design Rules

- Build a workbench, not a landing page: no large hero sections.
- Use cards only for list items, dialogs, and tool panels; avoid nested cards.
- Keep the current Server visible wherever users could confuse local and remote data. Show node/worker details only on advanced worker surfaces.
- Prioritize mobile Server setup, approvals, input sending, and status visibility.
- Prioritize desktop remote-session event-stream stability, keyboard flow, slash input, and side-rail diagnostics.
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

- The requested UI contradicts `docs/fabric/20-current-server-client-model.md` or the root `README.md`.
- The task asks to restore client pairing, device-token, scope, or revoke behavior from a historical document.
- The UI requires backend protocol or product-direction changes.
- Required API contract is missing or ambiguous.
- The task would require editing outside the assigned file scope.
- Browser verification cannot be run and the task depends on layout or interaction correctness.
