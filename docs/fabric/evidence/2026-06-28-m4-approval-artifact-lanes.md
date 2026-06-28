# M4 8.5 Approval And Artifact Lanes Evidence

Date: 2026-06-28

## Scope

Implemented M4 item 8.5 only: approval events, approval response idempotency, and artifact references for large native session output.

This does not claim the full AWS current remote development session smoke. That remains M4 8.6.

## Contract

- Runtime `interactive-prompt` events are exposed as device-safe `approval_request` events.
- Runtime `interactive-prompt-cleared` events are exposed as `approval_cleared` events.
- Approval response uses command type `approval_response`; slash commands cannot carry an approval id.
- Repeated commands with the same `idempotencyKey` return the original ack; conflicting payload reuse is rejected.
- Large `terminal-output` events can be replaced with `artifact_ref` events.
- Artifact content is read through an explicit artifact lane instead of the normal event stream.
- Per-session `artifactThreshold` is bounded and optional. The default behavior remains unchanged when it is not supplied.

## Changed Code

- `lib/server/control-plane-device-session-artifact-store.js`
  - Owns artifact ids, previews, content storage, pruning, and artifact reads.
- `lib/server/native-chat-run-store.js`
  - Externalizes large terminal output into `artifact_ref` events before appending native run events.
- `lib/server/control-plane-device-session-start.js`
  - Accepts bounded per-session `artifactThreshold` and passes it into native event storage.
- `lib/server/control-plane-device-sessions.js`
  - Normalizes approval and artifact events into device-safe payloads.
- `lib/server/control-plane-device-session-command.js`
  - Adds idempotent command ack handling for approval responses and other session commands.
- `lib/server/node-rpc-router.js`
  - Adds management `session-artifact` and scoped `device-node-session-artifact` routes.
- Relay/broker allowlists
  - Allow only the new artifact read routes needed for session artifact retrieval.
- `scripts/fabric-real-outbound-relay-smoke.js`
  - Can require artifact refs and fetch them through `device-node-session-artifact`.

## Verification

Focused tests:

```bash
node --test test/control-plane-device-session-event-store.test.js test/control-plane-device-session-command.test.js test/control-plane-device-session-start.test.js test/node-rpc-router.test.js test/node-relay-client.test.js test/remote-relay-server.test.js test/fabric-broker-routing.test.js test/server-node-rpc-wiring.test.js test/control-plane-device-session-catalog.test.js test/fabric-real-outbound-relay-smoke.test.js
```

Result:

```text
tests 129
pass 129
fail 0
```

Syntax and diff checks:

```text
node --check passed for control-plane-device-session-start.js and fabric-real-outbound-relay-smoke.js
git diff --check passed for the scoped M4 8.5 files
```

Full repository test:

```bash
npm test
```

Result:

```text
tests 2583
pass 2583
fail 0
```

Local default-port descriptor smoke:

```json
{
  "endpoint": "http://127.0.0.1:9527",
  "descriptor": true,
  "session-artifact": true,
  "device-node-session-artifact": true
}
```

Local default-port real Codex smoke, first run:

```json
{
  "startStatus": 200,
  "runIdPresent": true,
  "eventCounts": {
    "ready": 1,
    "terminal-output": 775
  },
  "markerFound": true,
  "artifacts": {
    "refs": 0,
    "fetched": 0
  },
  "cleanup": {
    "abortStatus": 200,
    "abortAccepted": true
  },
  "ok": false
}
```

Finding: real Codex TUI split the large response into many small PTY chunks, so no single terminal event crossed the default 4096 byte artifact threshold. This is why the bounded per-session threshold was added.

Local default-port real Codex artifact smoke after adding `artifactThreshold=256`:

```json
{
  "startStatus": 200,
  "startOk": true,
  "runIdPresent": true,
  "artifactThreshold": 256,
  "eventCounts": {
    "ready": 1,
    "terminal-output": 774,
    "artifact_ref": 30
  },
  "cursor": 812,
  "latestEventsStatus": 200,
  "markerFound": true,
  "artifacts": {
    "refs": 30,
    "fetched": 30,
    "bytes": 10358
  },
  "cleanup": {
    "abortStatus": 200,
    "abortAccepted": true
  },
  "ok": true
}
```

The smoke used the running local server on default `9527`, real Codex account `1`, model `gpt-5.5`, and real `session-start` / `session-run-events` / `session-artifact` routes. It did not start a second product port.

## Verdict

M4 8.5 is complete at the protocol, store, route, relay/broker allowlist, and local real-session validation layers. The next implementation item is M4 8.6: deploy this slice to AWS current and run a paired AWS profile remote session smoke through default `9527`.
