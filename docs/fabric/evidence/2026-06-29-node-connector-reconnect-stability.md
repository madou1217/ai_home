# 2026-06-29 Node connector reconnect stability

## Scope

This evidence closes the connector stability gap found after the WebRTC
promotion and runtime guard work. The AWS current node was usable, but the
supervised connector services had high systemd restart counters:

- `node-webrtc` restart counter: 39
- `node-relay` restart counter: 67

The goal of this change is to keep transient reconnects inside the connector
process instead of bouncing through systemd.

Target:

```text
AWS current: ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com
remote dir: /home/ubuntu/aih-fabric-current
port: 9527
node id: aws-current-node
```

## Root cause

`runRelayLoop()` and `runWebrtcLoop()` already reconnected after an established
connection closed. They did not handle a failure during the next `connectOnce`
attempt. If the control server was restarting during that window, the connector
process exited and systemd restarted it.

Relay had one additional issue: its reconnect `sleep()` used an unref'd timer.
When the reconnect delay was the only remaining handle, Node could exit before
the awaited timer resolved.

## Code change

Commit:

```text
11e51db0b07809559ac1bcbd1eac82e5ec75a3a6
fix(fabric): Keep node connectors alive during reconnect
```

Changed modules:

- `lib/cli/services/node/relay-client.js`
- `lib/cli/services/node/webrtc-client.js`
- `test/node-relay-client.test.js`
- `test/node-webrtc-client.test.js`

Behavior:

- retry transient connect failures such as `ECONNREFUSED`;
- keep `--once` behavior unchanged;
- fail fast for non-retryable config/auth errors such as `401`;
- remove the relay reconnect timer `unref()` so an awaited reconnect delay keeps
  the process alive.

## Local verification

```bash
node --check lib/cli/services/node/relay-client.js
node --check lib/cli/services/node/webrtc-client.js
node --test test/node-relay-client.test.js test/node-webrtc-client.test.js
node --test test/node-relay-service.test.js test/node-webrtc-service.test.js test/node-doctor.test.js test/fabric-m3-daemon-preflight.test.js
npm test
```

Results:

```text
connector focused tests: 21/21 pass
service/doctor focused tests: 51/51 pass
full npm test: 2818/2818 pass
```

## AWS clean deployment

Deployment used a clean git archive from `HEAD`, not the dirty local worktree.

```bash
git archive --format=tar.gz -o /tmp/aih-fabric-head-11e51db.tar.gz HEAD
shasum -a 256 /tmp/aih-fabric-head-11e51db.tar.gz
scp -i /Users/model/.ssh/aws.pem /tmp/aih-fabric-head-11e51db.tar.gz \
  ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:/home/ubuntu/aih-fabric-current/source-11e51db.tar.gz
```

Artifact:

```text
sha256=330ae6a6a07cfeb75687bb3b3285861a9135e87783de4275fb7dd1e06181ad1e
remote=/home/ubuntu/aih-fabric-current/source-11e51db.tar.gz
DEPLOYED_GIT_HEAD=11e51db0b07809559ac1bcbd1eac82e5ec75a3a6
```

Remote verification:

```bash
node --check lib/cli/services/node/relay-client.js
node --check lib/cli/services/node/webrtc-client.js
node --test test/node-relay-client.test.js test/node-webrtc-client.test.js
```

Result:

```text
remote connector focused tests: 21/21 pass
```

## AWS service restart and controlled server restart

The connector services were restarted once to load the new code:

```text
node-relay MainPID=401181
node-webrtc MainPID=401182
```

Then the default `9527` server was restarted in place:

```text
old server pid=398002
new server pid=401374
```

Post-restart process state:

```text
401181 node /home/ubuntu/aih-fabric-current/bin/ai-home.js node relay connect http://127.0.0.1:9527 --node-id aws-current-node
401182 node /home/ubuntu/aih-fabric-current/bin/ai-home.js node webrtc connect http://127.0.0.1:9527 --node-id aws-current-node
401374 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
```

After a 3 minute observation window:

```text
node-relay MainPID=401181, active since 08:08:34 UTC
node-webrtc MainPID=401182, active since 08:08:34 UTC
```

`journalctl --user --since '2026-06-29 08:08:30 UTC'` showed only the explicit
service restart and no new `Failed with result` entries.

## Post-restart readiness and live session

Readiness:

```json
{
  "defaultTransport": "webrtc",
  "fallbackReady": true,
  "promotionReady": true,
  "promotedTransports": ["webrtc"],
  "relayMeasurementPass": true
}
```

Transport status:

```json
{
  "status": "complete",
  "remoteDevelopmentReady": true,
  "defaultTransport": "webrtc",
  "advancedPromotionReady": true,
  "fallbackReady": true
}
```

Real OpenCode session after the restart:

```bash
node bin/ai-home.js fabric session start aws-current-node \
  --provider opencode \
  --prompt "Do not use tools. Output exactly: AIH_CONNECTOR_RECONNECT_STABILITY_OK_20260629_1611" \
  --timeout-ms 120000 \
  --json
```

Result:

```json
{
  "runId": "6f12595e-371e-4975-8347-fe2796032083",
  "selectedTransportKind": "webrtc",
  "fallbackUsed": false,
  "accountId": "1"
}
```

Events:

```json
{
  "status": "completed",
  "selectedTransportKind": "webrtc",
  "fallbackUsed": false,
  "eventTypes": {
    "ready": 1,
    "session-created": 1,
    "delta": 1,
    "result": 1,
    "done": 1
  },
  "content": "AIH_CONNECTOR_RECONNECT_STABILITY_OK_20260629_1611"
}
```

## Verdict

The connector stability fix is deployed and verified on the real AWS current
node. A default-port server restart no longer forced relay/WebRTC connector
process replacement; both connector PIDs survived and a real post-restart
OpenCode session completed over WebRTC.

Remaining blockers are outside this connector loop:

- Codex/Claude/AGY AWS provider account runtime auth state;
- TURN UDP public path / AWS SG-NACL or external TURN;
- WebTransport HTTPS/H3 endpoint;
- Multipath/OMR underlay.
