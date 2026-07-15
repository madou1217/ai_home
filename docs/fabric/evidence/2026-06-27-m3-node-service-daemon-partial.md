# 2026-06-27 M3 Node Service Daemon Partial Smoke

## Scope

验证 M3 7.3 的长期在线前置条件：

```text
AWS current default 9527
-> persistent token file
-> registry agent long-running heartbeat
-> node service dry-run plan
-> systemd status/readiness diagnosis
```

本轮只使用 AWS current，不访问旧 `152/155/39.104` 服务器，不新增产品端口。AWS current 继续使用默认 `9527`。

## Environment

| item | value |
|---|---|
| Date | 2026-06-27 |
| Local cwd | `/Users/model/projects/feature/ai_home` |
| AWS host | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` |
| AWS dir | `/home/ubuntu/aih-fabric-current` |
| AWS server pid | `113275` |
| Default endpoint | `http://127.0.0.1:9527` |
| Node id | `aws-current-node` |
| Token file | `/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token` |

## Commands

Create a real Fabric device token file without printing the token. The remote Node script used the existing pairing primitives directly:

```text
createControlPlaneDeviceInvite({
  id: "invite-fabric-agent-aws-current-node",
  name: "AWS Current Fabric Agent",
  controlEndpoint: "http://127.0.0.1:9527"
})

consumeControlPlaneDeviceInvite({
  device.id: "fabric-agent-aws-current-node"
})

write /home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token
chmod 0600
print only file path, mode, byte length, device id/state, tokenPrinted=false
```

Read-only current service status:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:\$PATH \
   AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
   AIH_CLI_PATH=/home/ubuntu/aih-fabric-current/bin/ai-home.js \
   node bin/ai-home.js node service status \
     --control-url http://127.0.0.1:9527 \
     --node-id aws-current-node \
     --json"
```

Current service install dry-run:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:\$PATH \
   AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
   AIH_CLI_PATH=/home/ubuntu/aih-fabric-current/bin/ai-home.js \
   node bin/ai-home.js node service install \
     http://127.0.0.1:9527 \
     --node-id aws-current-node \
     --token-file /home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token \
     --dry-run \
     --json"
```

Re-register `aws-current-node` through the real registry HTTP route so the persisted token owns the node:

```text
POST http://127.0.0.1:9527/v0/fabric/registry/nodes
Authorization: Bearer <token read from aws-current-node.token>
Payload is copied from current fabric-registry.json for aws-current-node,
including roles, relayNode, transports, projects and runtimes.
The token is not printed and is not passed in argv.
```

Run a finite long-running registry agent loop:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:\$PATH \
   AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
   AIH_CLI_PATH=/home/ubuntu/aih-fabric-current/bin/ai-home.js \
   node bin/ai-home.js fabric registry agent \
     http://127.0.0.1:9527 \
     --node-id aws-current-node \
     --token-file /home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token \
     --status online \
     --relay-status online \
     --transport relay=online \
     --probe-transport relay=http://127.0.0.1:9527/readyz \
     --probe-method GET \
     --probe-timeout-ms 10000 \
     --interval-ms 10000 \
     --count 5 \
     --json"
```

Post-run independent readback and residue check:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "ps -axo pid,command | grep -E 'fabric registry agent|node relay connect' | grep -v grep || true"

ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "systemctl --user status com.clawdcodex.ai_home.node-relay.aws-current-node.service --no-pager || true; \
   systemctl --user status com.clawdcodex.ai_home.fabric-registry-agent.aws-current-node.service --no-pager || true"
```

Focused local tests:

```bash
node --test \
  test/fabric-registry-agent.test.js \
  test/fabric-registry-heartbeat.test.js \
  test/fabric-role-registry.test.js \
  test/fabric-registry-client.test.js \
  test/fabric-registry-agent-service.test.js \
  test/node-doctor.test.js \
  test/node-relay-service.test.js
```

## Results

| check | result |
|---|---|
| AWS server process | `113275 ... server serve --host 0.0.0.0 --port 9527` |
| Token file | created, `44 bytes`, mode `600`, token not printed |
| Initial service status | relay service `missing`, registry agent service `missing` |
| Initial blocker | `management_key_missing`; current AWS host home has no `server-config.json` management key |
| Service install dry-run | `ok=true`, `writes=false`, services `relay`, `registryAgent` |
| First long-run attempt | failed `5/5` with `forbidden_fabric_node_owner` |
| Cause | previous 7.2 self-registration used an in-memory token and did not persist the owner token |
| Owner repair | real `POST /v0/fabric/registry/nodes` rebound `aws-current-node` to `fabric-agent-aws-current-node` |
| Second long-run agent | `ok=true`, `attempts=5`, `failures=0`, interval `10000ms` |
| Probe | `status=reachable`, `durationMs=4` |
| Registry readback | `nodes=2`, `relayNodes=2`, `transports=2`, `projects=2`, `runtimes=4` |
| AWS residue | no `fabric registry agent` or `node relay connect` process after finite run |
| Systemd units | both expected user units are still missing; no install was performed |
| Focused local tests | 53/53 pass |

Sanitized long-run result:

```json
{
  "ok": true,
  "nodeId": "aws-current-node",
  "intervalMs": 10000,
  "count": 5,
  "attempts": 5,
  "failures": 0,
  "probes": [
    {
      "kind": "relay",
      "health": "online",
      "durationMs": 4,
      "status": "reachable"
    }
  ],
  "lastResult": {
    "node": {
      "id": "aws-current-node",
      "ownerDeviceId": "fabric-agent-aws-current-node",
      "status": "online"
    },
    "relayNode": {
      "id": "aws-current-node-relay",
      "status": "online"
    },
    "transports": [
      {
        "id": "aws-current-node-relay",
        "kind": "relay",
        "health": "online",
        "measurement": {
          "status": "reachable",
          "durationMs": 4
        }
      }
    ]
  }
}
```

Independent registry readback:

```json
{
  "ok": true,
  "nodes": [
    {
      "id": "aws-current-node",
      "status": "online",
      "ownerDeviceId": "fabric-agent-aws-current-node",
      "roles": ["node", "relay-node"]
    },
    {
      "id": "local-mac-remote-node",
      "status": "online",
      "ownerDeviceId": "local-mac-aws-final",
      "roles": ["node", "relay-node"]
    }
  ],
  "transports": [
    {
      "id": "aws-current-node-relay",
      "nodeId": "aws-current-node",
      "kind": "relay",
      "health": "online",
      "measurement": {
        "status": "reachable",
        "durationMs": 4
      }
    },
    {
      "id": "local-mac-remote-node-relay",
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

## Interpretation

- A durable token file is now available for `aws-current-node`; it is not exposed in argv, service files, or evidence output.
- The registry agent can run for multiple heartbeat intervals against AWS current default `9527`, update relay measurement, and exit cleanly.
- This is not final 7.3 completion. No systemd unit was installed and no relay daemon was started.
- Full 7.3 requires a confirmed mutation of AWS current server config and user systemd state:
  - write/generate a server `managementKey` for AWS current,
  - join or repair `aws-current-node` remote-node secret with the same key,
  - run `node service install ... --yes`,
  - verify `relay.running=true`, `registryAgent.running=true`, and heartbeat after service restart.

## Verdict

partial

M3 7.3 has real current-node token persistence and long-running registry agent evidence. The supervised relay + registry agent systemd install remains blocked by required confirmation for AWS config and user service writes.

## Next Checks

- After confirmation, configure AWS current management key and install the two supervised user services on default `9527`.
- Verify `node service status --json` reports `supervisor.ready=true`.
- Confirm service files do not contain raw token or management key.
- Restart the service or user manager and verify heartbeat still updates.
