# M4 8.6 AWS Real Remote Session Smoke Evidence

Date: 2026-06-28

## Scope

Verified M4 item 8.6 against AWS current only:

- AWS endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- AWS deploy dir: `/home/ubuntu/aih-fabric-current`
- Product port: default `9527`
- Runtime: real local Codex account `1`, model `gpt-5.5`

No old VPS targets were used.

## Finding And Fix

The first AWS real smoke reached Codex and found the expected marker, but failed the artifact requirement:

```json
{
  "ok": false,
  "preparation": {
    "mode": "api",
    "joinStatus": 200,
    "pairStatus": 200
  },
  "relay": {
    "online": true,
    "transportKind": "relay"
  },
  "session": {
    "startStatus": 200,
    "runIdPresent": true,
    "expectedOutputFound": true,
    "eventCounts": {
      "ready": 1,
      "terminal-output": 1238,
      "aborted": 1,
      "done": 1
    },
    "artifacts": {
      "required": true,
      "refs": 0,
      "fetched": 0,
      "bytes": 0,
      "ok": false
    }
  }
}
```

Root cause: `device-node-session-start` accepted `artifactThreshold`, but `buildDeviceNodeSessionStartPayload()` dropped it before forwarding the request to the remote node. The node therefore started the Codex runtime without the low-bandwidth artifact policy.

Fix:

- `lib/server/node-rpc-router.js` now preserves `artifactThreshold` / `artifact_threshold` when forwarding a device-scoped remote session start to `/v0/node-rpc/session-start`.
- `test/node-rpc-router.test.js` now covers that the forwarded remote-node start payload still includes `artifactThreshold: 256`.

Focused verification:

```bash
node --test test/node-rpc-router.test.js test/control-plane-device-session-start.test.js
```

Result:

```text
tests 56
pass 56
fail 0
```

Final scoped/full verification after evidence docs were updated:

```bash
node --test test/node-rpc-router.test.js test/control-plane-device-session-start.test.js test/fabric-real-outbound-relay-smoke.test.js
npm test
```

Result:

```text
focused tests 66
focused pass 66
full tests 2584
full pass 2584
fail 0
```

## AWS Runtime State

The scoped fix was copied to AWS current and syntax-checked on the remote host:

```bash
cd /home/ubuntu/aih-fabric-current
./.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/server/node-rpc-router.js
./.node-runtime/node-v22.16.0-linux-x64/bin/node --check test/node-rpc-router.test.js
```

Result: pass.

AWS server was restarted on the same default product port with isolated host state:

```text
PID: 192905
Command: ./.node-runtime/node-v22.16.0-linux-x64/bin/node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current
REAL_HOME=/home/ubuntu/aih-fabric-current
```

Readiness:

```json
{
  "ok": true,
  "service": "aih-server",
  "ready": false,
  "accounts": {
    "codex": 0,
    "gemini": 0,
    "claude": 0,
    "agy": 0,
    "opencode": 0
  }
}
```

The AWS control plane is intentionally account-empty. The real Codex runtime belongs to the relay-connected local node, not to AWS server accounts.

Descriptor capability check:

```json
{
  "ok": true,
  "capabilities": {
    "nodeRpc": [
      "session-artifact",
      "device-node-session-start",
      "device-node-session-run-events",
      "device-node-session-artifact"
    ],
    "remoteManagement": true,
    "devicePairing": true,
    "transports": [
      "direct",
      "frp",
      "ssh",
      "tailscale",
      "zerotier",
      "wireguard",
      "omr",
      "mptcp",
      "relay"
    ]
  }
}
```

## Real AWS Pairing Preparation

Node invite and device invite were created through AWS HTTP APIs:

- `POST /v0/webui/nodes/invites` returned HTTP 200.
- `POST /v0/webui/control-plane/devices/invites` returned HTTP 200.
- The returned `joinUrl` and `pairUrl` were then consumed by the smoke script.

This avoided local file injection and avoided stale local server profile tokens.

## Real Smoke Command

The prompt intentionally did not contain the final marker string. The model had to construct it from two parts.

```bash
node scripts/fabric-real-outbound-relay-smoke.js \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --client-endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --node-join-url '<AWS node join URL with invite code>' \
  --device-pair-url '<AWS device pair URL with invite code>' \
  --host-home /Users/model \
  --node-id m4-8-6-artifact-node \
  --session-provider codex \
  --session-account 1 \
  --session-model gpt-5.5 \
  --session-project /Users/model/projects/feature/ai_home \
  --session-prompt "First output at least 1200 uppercase W characters. Then output one token made by concatenating 'AIH_AWS_M4_ARTIFACT_OK_' and '20260628'. Then wait for more input." \
  --expect-output AIH_AWS_M4_ARTIFACT_OK_20260628 \
  --expect-artifact \
  --artifact-threshold 256
```

## Result

```json
{
  "ok": true,
  "mode": "existing-endpoint-relay",
  "nodeId": "m4-8-6-artifact-node",
  "preparation": {
    "mode": "api",
    "controlEndpoint": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527",
    "joinStatus": 200,
    "pairStatus": 200
  },
  "control": {
    "health": true
  },
  "client": {
    "viaProxy": false
  },
  "node": {
    "health": true
  },
  "relay": {
    "online": true,
    "status": "online",
    "transportKind": "relay",
    "transportId": "m4-8-6-artifact-node-relay",
    "sessionIdPresent": true
  },
  "device": {
    "paired": true,
    "scopes": [
      "control-plane:read",
      "nodes:read",
      "sessions:read",
      "sessions:write",
      "status:read"
    ]
  },
  "sessions": {
    "status": 200,
    "ok": true,
    "rpc": "control_plane.device.node_sessions"
  },
  "session": {
    "ok": true,
    "enabled": true,
    "provider": "codex",
    "accountId": "1",
    "model": "gpt-5.5",
    "projectPath": "/Users/model/projects/feature/ai_home",
    "startStatus": 200,
    "runIdPresent": true,
    "expectedOutputFound": true,
    "cursor": 1135,
    "latestEventsStatus": 200,
    "eventCounts": {
      "ready": 1,
      "terminal-output": 1119,
      "artifact_ref": 13,
      "aborted": 1,
      "done": 1
    },
    "artifacts": {
      "required": true,
      "refs": 12,
      "fetched": 12,
      "bytes": 5805,
      "ok": true
    },
    "quit": {
      "status": 200,
      "ok": true,
      "accepted": true
    },
    "cleanup": {
      "completed": true,
      "abort": {
        "status": 200,
        "ok": true,
        "accepted": true
      }
    }
  }
}
```

The terminal tail contained the real model output marker:

```text
AIH_AWS_M4_ARTIFACT_OK_20260628
```

## Residue Check

Local process checks after the smoke:

```bash
ps -p 56391 -o pid,args
ps -axo pid,args | rg "node .*bin/ai-home.js node relay|fabric-real-outbound-relay-smoke|m4-8-6-artifact-node"
```

Result:

- relay child PID `56391` was gone.
- no local `node relay connect`, smoke, or `m4-8-6-artifact-node` process remained.

AWS registry readback after the smoke:

```json
{
  "ok": true,
  "nodes": [
    {
      "id": "m4-8-6-artifact-node",
      "connection": {
        "status": "offline",
        "transportKind": "relay"
      },
      "transports": [
        {
          "id": "m4-8-6-artifact-node-relay",
          "kind": "relay",
          "status": "degraded",
          "lastError": "relay_disconnected"
        }
      ]
    }
  ]
}
```

This is expected after the smoke process exits: the node was really registered in AWS, then the relay disconnected during cleanup.

## Verdict

M4 8.6 is complete:

- AWS current was the only remote server used.
- The product server stayed on default `9527`.
- Node invite, device invite, join, pair, relay, session start, event polling, artifact read, `/quit`, and abort cleanup all used real HTTP/RPC paths.
- A real Codex session produced the marker and generated artifact references over the AWS relay path.
