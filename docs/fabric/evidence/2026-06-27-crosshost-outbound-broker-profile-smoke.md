# 2026-06-27 Cross-host Outbound Broker Profile Smoke

## Scope

验证跨主机 outbound broker 的最小产品链路：

```text
Local client -> AWS public broker endpoint -> local Mac AIH server outbound broker link -> local Mac default 9527
```

本轮验证 Server Profile / device scoped API，不验证 remote node relay 或 native runtime session。

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
| Cleanup | local broker connect stopped; AWS proxy reports `fabric_broker_server_offline` for `local-mac-crosshost`; AWS only has server pid `110864` |

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
- This validates the cross-host Server Profile/control-plane slice.
- This does not yet validate remote node relay or native TUI session through the cross-host broker path.

## Verdict

partial

Cross-host outbound broker works for Server Profile and device scoped control-plane APIs. The remaining gate is node/session traffic through the same cross-host broker profile.

## Next Checks

- Start a node relay against the local server while the local server is exposed only through AWS broker proxy.
- From the client, call `device-node-sessions` and native session start through `http://43.207.102.163:9527/v0/fabric/broker/servers/local-mac-crosshost/proxy`.
- Record cleanup and residual process checks after node/session smoke.
