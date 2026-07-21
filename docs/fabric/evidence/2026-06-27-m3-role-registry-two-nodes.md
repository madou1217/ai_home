# 2026-06-27 M3 Role Registry Two Nodes Smoke

## Scope

验证 M3 Role Registry 的第二个真实节点 gate：

```text
local Mac node + relay-node
AWS current node + relay-node
-> one AWS current registry
-> Fabric Nodes UI shows both nodes
```

本轮只使用 AWS current 和本机，不访问旧 `152/155/39.104` 服务器，不新增产品端口。AWS current 继续使用默认 `9527`。

## Environment

| item | value |
|---|---|
| Date | 2026-06-27 |
| Local cwd | `/Users/model/projects/feature/ai_home` |
| AWS endpoint | `http://43.207.102.163:9527` |
| AWS dir | `/home/ubuntu/aih-fabric-current` |
| AWS server pid | `113275` |
| Existing node | `local-mac-remote-node` |
| New node | `aws-current-node` |
| AWS token storage | `/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home` |
| UI screenshot | `/tmp/aih-m3-fabric-two-nodes.png` |

## Commands

Register AWS current itself as a second real node:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
   .node-runtime/node-v22.16.0-linux-x64/bin/node \
   scripts/fabric-real-vps-registry-publish.js \
   --port 9527 \
   --node-id aws-current-node \
   --name 'AWS Current Node' \
   --project /home/ubuntu/aih-fabric-current \
   --bandwidth-kbps 3072 \
   --agent-count 1 \
   --agent-interval-ms 1000 \
   --agent-probe-transport relay=http://127.0.0.1:9527/readyz"
```

Read the registry back from the real AWS endpoint:

```bash
TOKEN="$(tr -d '\n' < "/Users/model/.ai_home/fabric/local-mac-remote-node.token")"
curl --noproxy "*" --max-time 10 -s -S \
  -H "Authorization: Bearer ${TOKEN}" \
  "http://43.207.102.163:9527/v0/fabric/registry"
```

Browser smoke:

```text
Playwright Chromium opened http://43.207.102.163:9527/ui/fabric/nodes
Injected a paired server profile for the real AWS endpoint.
Waited for local-mac-remote-node, aws-current-node and Relay Health.
Screenshot: /tmp/aih-m3-fabric-two-nodes.png
```

## Results

| check | result |
|---|---|
| AWS current self registration | `ok=true` |
| AWS node publish | `roles=["node","relay-node"]`, `projects=1`, `transports=1` |
| AWS node heartbeat | `ok=true`, `relayStatus=online` |
| AWS node agent | `ok=true`, `attempts=1`, `failures=0`, probe `status=reachable`, `durationMs=33` |
| Registry counts | `nodes=2`, `relayNodes=2`, `projects=2`, `transports=2`, `runtimes=4` |
| Registry node ids | `aws-current-node`, `local-mac-remote-node` |
| Registry relay ids | `aws-current-node-relay`, `local-mac-remote-node-relay` |
| Transport health | both relay transports `online` |
| Browser UI smoke | HTTP 200, both node names visible, counts show two nodes and two relay nodes |
| Browser console | 0 errors, 0 warnings |
| AWS server process | `113275 ... server serve --host 0.0.0.0 --port 9527` |

Sanitized registry readback:

```json
{
  "ok": true,
  "counts": {
    "nodes": 2,
    "relayNodes": 2,
    "transports": 2,
    "projects": 2,
    "runtimes": 4
  },
  "nodeIds": [
    "aws-current-node",
    "local-mac-remote-node"
  ],
  "relayNodeIds": [
    "local-mac-remote-node-relay",
    "aws-current-node-relay"
  ],
  "transports": [
    {
      "nodeId": "aws-current-node",
      "kind": "relay",
      "health": "online",
      "measurement": {
        "status": "reachable",
        "durationMs": 33
      }
    },
    {
      "nodeId": "local-mac-remote-node",
      "kind": "relay",
      "health": "online",
      "measurement": {
        "status": "reachable",
        "durationMs": 238
      }
    }
  ]
}
```

Browser smoke result:

```json
{
  "ok": true,
  "status": 200,
  "url": "http://43.207.102.163:9527/ui/fabric/nodes",
  "hasLocalNode": true,
  "hasAwsNode": true,
  "hasTwoNodeCount": true,
  "hasTwoRelayCount": true,
  "hasRelayHealth": true,
  "hasReachable": true,
  "hasOnline": true,
  "consoleErrors": 0,
  "consoleWarnings": 0
}
```

## Interpretation

- M3 now has two real machines represented in the same AWS current registry: local Mac and AWS current.
- Both nodes declare `node + relay-node`, both relay transports are online, and Fabric Nodes UI can show them together.
- AWS current remains on default `9527`; no old VPS targets were touched.
- This does not complete the long-running daemon/service gate. AWS self registration used a finite foreground agent smoke.

## Verdict

pass

M3 subtask 7.2 is complete. The next M3 gate is supervised long-running registry agent + relay service evidence.

## Next Checks

- M3 7.3: verify service install/start or equivalent supervised long-running mode without leaking token in argv.
- M3 7.4: replace HTTP reachability measurement with stronger TCP/WS echo or session-derived p95 metrics.
- M3 7.5: run mobile viewport Fabric Nodes smoke with two nodes.
