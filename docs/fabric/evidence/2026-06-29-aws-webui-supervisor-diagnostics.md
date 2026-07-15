# AWS WebUI Supervisor Diagnostics Recheck

Date: 2026-06-29

Target:

- AWS current: `ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- Remote dir: `/home/ubuntu/aih-fabric-current`
- Default port: `9527`

## Problem

After the WebRTC promotion persistence fix, the AWS WebUI node test selected the
WebRTC transport, but the embedded `nodeDiagnostics.services` report still showed
relay, registry agent, and WebRTC connector as not running.

Real host checks contradicted that UI diagnostic:

- `node bin/ai-home.js node service status --node-id aws-current-node --json`
  returned `supervisor.ready=true`.
- `systemctl --user status` showed all three user services active:
  - `com.clawdcodex.ai_home.node-relay.aws-current-node.service`
  - `com.clawdcodex.ai_home.fabric-registry-agent.aws-current-node.service`
  - `com.clawdcodex.ai_home.node-webrtc.aws-current-node.service`

Root cause:

- `/v0/node-rpc/status?diagnostics=1` did not receive `spawnSync` from the server
  wiring, so service managers could not call `systemctl`.
- The HTTP server process also may not have `XDG_RUNTIME_DIR` and
  `DBUS_SESSION_BUS_ADDRESS`, while `systemctl --user` requires them outside a
  normal login shell.

## Fix

- `lib/server/server.js` now passes `spawnSync` into node-rpc deps.
- `lib/cli/services/node/doctor.js` wraps Linux `systemctl --user` calls with a
  user systemd runtime env:
  - `XDG_RUNTIME_DIR=/run/user/<uid>`
  - `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus`

The change is scoped to diagnostics/service-status reads. It does not install,
uninstall, restart, or modify systemd units.

## Verification

Local focused verification:

```text
node --check lib/server/server.js
node --check lib/cli/services/node/doctor.js
node --test test/node-doctor.test.js test/node-rpc-router.test.js
```

Result:

- `test/node-doctor.test.js` + `test/node-rpc-router.test.js`: `76/76 pass`

AWS focused verification after syncing the changed files:

```text
node --check lib/server/server.js
node --check lib/cli/services/node/doctor.js
node --test test/node-doctor.test.js test/node-rpc-router.test.js
```

Result:

- AWS current focused tests: `76/76 pass`

AWS default server was restarted on the same default port only:

```text
old_pid=365448
new_pid=365698
```

Post-restart WebUI node test:

```text
POST http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/webui/nodes/aws-current-node/test
```

Result after WebRTC connector reconnect:

```json
{
  "httpStatus": 200,
  "ok": true,
  "selectedTransportKind": "webrtc",
  "fallbackUsed": false,
  "rejectedTransports": [],
  "supervisorReady": true,
  "relayRunning": true,
  "registryAgentRunning": true,
  "webrtcRunning": true,
  "issues": []
}
```

Transport readiness remained promoted:

```text
defaultTransport=webrtc
promotionReady=true
fallbackReady=true
promotedTransports=["webrtc"]
```
