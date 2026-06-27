# 2026-06-27 Cross-host Outbound Broker Profile and Native Session Smoke

## Scope

验证跨主机 outbound broker 的完整 M2.5 产品链路：

```text
Local client -> AWS public broker endpoint -> local Mac AIH server outbound broker link -> local Mac default 9527 -> local node relay -> Codex native session
```

本轮覆盖 Server Profile / device scoped API、node relay sessions RPC，以及真实 Codex native TUI 对话。

## Environment

| item | value |
|---|---|
| Date | 2026-06-27 |
| Local cwd | `/Users/model/projects/feature/ai_home` |
| Broker endpoint | `http://43.207.102.163:9527` |
| Broker host | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` |
| Broker server process | `110864 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527` |
| Local server endpoint | `http://127.0.0.1:9527` |
| Broker server id | `local-mac-crosshost` |
| Native runtime | `codex account 1`, `model=gpt-5.5` |
| Session project | `/Users/model/projects/feature/ai_home` |

## Commands

Public broker reachability:

```bash
curl --noproxy "*" --max-time 10 -s -S "http://43.207.102.163:9527/readyz"
```

Local server health:

```bash
curl --noproxy "*" --max-time 5 -s -S "http://127.0.0.1:9527/readyz"
curl --noproxy "*" --max-time 5 -s -S "http://127.0.0.1:9527/v0/fabric/descriptor"
```

Outbound broker link from local Mac to AWS broker:

```bash
AIH_FABRIC_BROKER_TOKEN="$(ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cat /home/ubuntu/aih-fabric-current/.broker-token")" \
node "bin/ai-home.js" fabric broker connect \
  "http://43.207.102.163:9527" \
  --server-id local-mac-crosshost \
  --local-url "http://127.0.0.1:9527"
```

Client requests through AWS public broker proxy:

```bash
curl --noproxy "*" --max-time 10 -s -S \
  "http://43.207.102.163:9527/v0/fabric/broker/servers/local-mac-crosshost/proxy/readyz"

curl --noproxy "*" --max-time 10 -s -S \
  "http://43.207.102.163:9527/v0/fabric/broker/servers/local-mac-crosshost/proxy/v0/fabric/descriptor"
```

Device scoped smoke:

1. Create a real local device invite via `POST /v0/webui/control-plane/devices/invites`.
2. Consume that code through AWS broker proxy `POST /v0/fabric/device-pair`.
3. Use returned device token through AWS broker proxy to read descriptor/profile/nodes/status/accounts/sessions.
4. Revoke the smoke device.

Node relay sessions RPC through the same AWS broker proxy:

```bash
node "scripts/fabric-real-outbound-relay-smoke.js" \
  --endpoint "http://127.0.0.1:9527" \
  --client-endpoint "http://43.207.102.163:9527/v0/fabric/broker/servers/local-mac-crosshost/proxy" \
  --host-home "$HOME" \
  --node-id "local-mac-crosshost-node-verify" \
  --timeout-ms 30000
```

Native Codex session through the same AWS broker proxy:

```bash
node "scripts/fabric-real-outbound-relay-smoke.js" \
  --endpoint "http://127.0.0.1:9527" \
  --client-endpoint "http://43.207.102.163:9527/v0/fabric/broker/servers/local-mac-crosshost/proxy" \
  --host-home "$HOME" \
  --node-id "local-mac-crosshost-native-verify" \
  --timeout-ms 30000 \
  --session-provider codex \
  --session-account 1 \
  --session-model gpt-5.5 \
  --session-project "/Users/model/projects/feature/ai_home" \
  --session-prompt "Reply with exactly these underscore-joined parts: AIH CROSSHOST BROKER NATIVE SESSION VERIFY OK 20260627. Use underscores between words and no extra text." \
  --expect-output "AIH_CROSSHOST_BROKER_NATIVE_SESSION_VERIFY_OK_20260627" \
  --session-timeout-ms 90000
```

Cleanup checks:

```bash
curl --noproxy "*" --max-time 10 -s -S \
  "http://43.207.102.163:9527/v0/fabric/broker/servers/local-mac-crosshost/proxy/readyz"

ps -axo pid,command | rg "(local-mac-crosshost|local-mac-crosshost-node-verify|local-mac-crosshost-native-verify|fabric-real-outbound-relay-smoke|fabric broker connect)"

ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "ps -axo pid,command | grep -E 'fabric-real-outbound-relay-smoke|local-mac-crosshost|fabric broker connect|node relay connect' | grep -v grep || true; ps -axo pid,command | grep 'node bin/ai-home.js server serve --host 0.0.0.0 --port 9527' | grep -v grep || true"
```

## Results

| check | result |
|---|---|
| AWS public `readyz` | HTTP 200 |
| Local default `readyz` | HTTP 200, ready true, accounts `codex=1, gemini=1, claude=3, agy=7, opencode=1` |
| Broker proxy `readyz` | HTTP 200, returned local server health |
| Broker proxy descriptor | HTTP 200, returned local `aih-fabric` descriptor |
| Pair through broker proxy | HTTP 200, token returned |
| Device profile through broker proxy | HTTP 200 |
| Device nodes through broker proxy | HTTP 200 |
| Device status through broker proxy | HTTP 200 |
| Device accounts through broker proxy | HTTP 200 |
| Device sessions through broker proxy | HTTP 200 |
| Node relay sessions RPC through broker proxy | `ok=true`, `viaProxy=true`, `relay.online=true`, sessions HTTP 200 |
| Native Codex session through broker proxy | `ok=true`, runId present, expected marker found |
| Native session cleanup | `/quit` accepted; abort cleanup accepted |
| Cleanup | local broker connect stopped; AWS proxy reports `fabric_broker_server_offline` for `local-mac-crosshost`; AWS only has server pid `110864`; local residual check only matched the check command itself |

Device scoped result:

```json
{
  "ok": true,
  "pair": { "status": 200, "ok": true, "hasToken": true },
  "results": [
    { "route": "/v0/fabric/descriptor", "status": 200, "ok": true },
    { "route": "/v0/node-rpc/device-profile", "status": 200, "ok": true },
    { "route": "/v0/node-rpc/device-nodes", "status": 200, "ok": true },
    { "route": "/v0/node-rpc/device-status", "status": 200, "ok": true },
    { "route": "/v0/node-rpc/device-accounts", "status": 200, "ok": true },
    { "route": "/v0/node-rpc/device-sessions", "status": 200, "ok": true }
  ]
}
```

Node relay sessions RPC result:

```json
{
  "ok": true,
  "client": {
    "endpoint": "http://43.207.102.163:9527/v0/fabric/broker/servers/local-mac-crosshost/proxy",
    "viaProxy": true
  },
  "relay": {
    "online": true,
    "status": "online",
    "transportKind": "relay"
  },
  "sessions": {
    "status": 200,
    "ok": true,
    "rpc": "control_plane.device.node_sessions",
    "total": 1147,
    "returned": 5
  }
}
```

Native Codex session result:

```json
{
  "ok": true,
  "client": {
    "endpoint": "http://43.207.102.163:9527/v0/fabric/broker/servers/local-mac-crosshost/proxy",
    "viaProxy": true
  },
  "relay": {
    "online": true,
    "status": "online",
    "transportKind": "relay"
  },
  "sessions": {
    "status": 200,
    "ok": true,
    "rpc": "control_plane.device.node_sessions",
    "total": 1148,
    "returned": 5
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
    "eventCounts": {
      "ready": 1,
      "terminal-output": 426,
      "aborted": 1,
      "done": 1
    },
    "terminalOutputMarker": "AIH_CROSSHOST_BROKER_NATIVE_SESSION_VERIFY_OK_20260627",
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

Post-cleanup broker proxy status:

```json
{
  "ok": false,
  "error": "fabric_broker_server_offline",
  "serverId": "local-mac-crosshost",
  "brokerStatus": {
    "online": false,
    "lastDisconnected": {
      "disconnectReason": "broker_server_link_closed"
    }
  }
}
```

## Interpretation

- AWS current is now a real reachable broker endpoint from the local client.
- The local Mac AIH server does not need public ingress; it connects outbound to AWS broker.
- The client can pair and read device scoped Server Profile APIs through AWS public broker proxy.
- The client can read node sessions through the same AWS broker proxy while the node relay dials the local server outbound.
- The client can start a real Codex native TUI session through the same AWS broker proxy and observe model output.
- This validates the cross-host M2.5 broker profile path for Server Profile, node relay and native session.

## Verdict

pass

Cross-host outbound broker works for Server Profile, device scoped control-plane APIs, node relay sessions RPC and real Codex native session through the same AWS broker profile.

## Next Checks

- Move to M3 Role Registry product closure: home/company node roles, relay-node roles, daemon heartbeat, UI node page and relay health measurement.
- Keep this evidence as the M2.5 regression gate before adding WebRTC/WebTransport/Multipath QUIC promotion paths.
