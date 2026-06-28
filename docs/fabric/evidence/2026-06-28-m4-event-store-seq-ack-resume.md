# M4 8.4 Event Store Seq Ack Resume Evidence

Date: 2026-06-28

## Scope

Implemented M4 item 8.4 only: stable event sequence, ack, and cursor resume semantics for remote development session events.

This does not implement durable approval or artifact lanes. Those remain M4 8.5.

This does not claim full AWS remote development conversation success. The full paired AWS profile open/attach smoke remains M4 8.6.

## Contract

- Session events expose stable `seq` and `cursor`.
- Event reads resume after the supplied cursor and do not replay the already-acknowledged cursor.
- `POST /v0/node-rpc/session-ack` records the highest cursor per `sessionId + consumerId`.
- Older ack cursors are accepted as stale and do not move the stored high-water mark backward.
- `POST /v0/node-rpc/device-node-session-ack` proxies a scoped client ack to the selected remote node.

## Changed Code

- `lib/server/control-plane-device-session-event-store.js`
  - Owns sequence normalization and ack high-water state.
- `lib/server/native-chat-run-store.js`
  - Writes `seq/cursor` on appended native run events.
  - Reads only events newer than the supplied cursor.
- `lib/server/control-plane-device-sessions.js`
  - Normalizes device-safe session events with `seq/cursor`.
- `lib/server/node-rpc-router.js`
  - Adds management `session-ack`.
  - Adds scoped device-node `device-node-session-ack`.
- `lib/server/control-plane-descriptor.js`
  - Advertises `session-ack` and `device-node-session-ack`.
- `lib/server/fabric-broker-router.js`
  - Allows the device-node ack proxy route.
- `lib/server/remote/relay-server.js`
  - Allows relay management forwarding for `session-ack`.
- `lib/cli/services/node/relay-client.js`
  - Allows local relay forwarding for `session-ack`.

## Verification

Focused tests:

```bash
node --test "test/control-plane-device-session-event-store.test.js" "test/node-rpc-router.test.js" "test/node-relay-client.test.js" "test/remote-relay-server.test.js" "test/fabric-broker-routing.test.js" "test/server-node-rpc-wiring.test.js" "test/control-plane-device-session-catalog.test.js" "test/control-plane-device-session-command.test.js"
```

Result:

```text
tests 109
pass 109
fail 0
```

Full repository test:

```bash
npm test
```

Result:

```text
tests 2576
pass 2576
fail 0
```

Scoped diff check:

```bash
git diff --check -- "lib/server/control-plane-device-session-event-store.js" "lib/server/control-plane-device-sessions.js" "lib/server/native-chat-run-store.js" "lib/server/node-rpc-router.js" "lib/server/control-plane-descriptor.js" "lib/server/fabric-broker-router.js" "lib/server/remote/relay-server.js" "lib/cli/services/node/relay-client.js" "test/control-plane-device-session-event-store.test.js" "test/node-rpc-router.test.js" "test/node-relay-client.test.js" "test/remote-relay-server.test.js" "test/fabric-broker-routing.test.js"
```

Result:

```text
pass
```

Local default-port real smoke against `http://127.0.0.1:9527`:

```json
{
  "ok": true,
  "endpoint": "http://127.0.0.1:9527",
  "startStatus": 200,
  "runIdPresent": true,
  "firstCursor": 1,
  "cursor": 36,
  "markerSeen": true,
  "eventCount": 36,
  "resumeStatus": 200,
  "resumeCursor": 36,
  "resumeEventCount": 35,
  "resumeHasFirstCursorDuplicate": false,
  "ackStatus": 200,
  "ackResult": {
    "accepted": true,
    "cursor": 36,
    "consumerId": "m4-8-4-local-smoke",
    "stale": false
  },
  "abortStatus": 200,
  "abortAccepted": true
}
```

AWS pre-deploy check showed the current AWS server was still on old code:

```text
descriptor missing session-ack/device-node-session-ack
POST /v0/node-rpc/device-node-session-ack -> 401 unauthorized_node_rpc
```

AWS post-deploy default-port smoke:

```text
commit deployed: 5c51743
endpoint: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
server pid: 189000
readyz: 200, ready=false, accounts=0
descriptor: 200, legacyControlPlane.nodeRpc includes session-ack and device-node-session-ack
device nodes: 200, local-mac-remote-node online through relay, capabilities include sessions
```

AWS -> local node ack proxy result:

```json
{
  "status": 200,
  "ok": true,
  "payload": {
    "ok": true,
    "rpc": "control_plane.device.node_session_ack",
    "nodeId": "local-mac-remote-node",
    "result": {
      "accepted": true,
      "sessionId": "m4-8-4-aws-proxy-smoke",
      "consumerId": "m4-8-4-aws-smoke",
      "cursor": 44,
      "ackedAt": 1782617847167
    }
  }
}
```

AWS -> local node stale ack high-water result:

```json
{
  "status": 200,
  "ok": true,
  "payload": {
    "ok": true,
    "rpc": "control_plane.device.node_session_ack",
    "nodeId": "local-mac-remote-node",
    "result": {
      "accepted": true,
      "sessionId": "m4-8-4-aws-proxy-smoke",
      "consumerId": "m4-8-4-aws-smoke",
      "cursor": 44,
      "ackedAt": 1782617847167,
      "stale": true
    }
  }
}
```

## Verdict

M4 8.4 is complete at the event contract and routing layer. Cursor resume and ack semantics are covered by focused unit/router/relay tests, full repo tests, and a local default-port real session smoke. The next implementation item is M4 8.5 approval and artifact lanes.
