# 2026-06-28 Current AWS Node Model Readback

## Scope

This is a real readback against the current local AIH server and AWS current server. It was run to clarify what the local WebUI can actually do with the AWS Fabric node today.

No mock data was used. No old servers were touched.

## Targets

| Target | Endpoint / host |
|---|---|
| Local server | `http://127.0.0.1:9527` |
| AWS current | `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527` |
| AWS SSH | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` |
| AWS dir | `/home/ubuntu/aih-fabric-current` |

## Checks

### Local shared profile store

Command summary:

```text
GET http://127.0.0.1:9527/v0/webui/control-plane/profiles
```

Sanitized result:

```json
{
  "status": 200,
  "count": 1,
  "ready": [
    {
      "name": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527",
      "endpoint": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527",
      "state": "paired",
      "authState": "paired",
      "connectionMode": "direct"
    }
  ]
}
```

The local browser/client has a paired AWS server profile available through the shared local server profile store.

### Unauthenticated registry gate

Command summary:

```text
GET http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/registry
```

Result:

```json
{
  "status": 401
}
```

This is expected. Registry read requires an authorized device token with `nodes:read`.

### Authorized registry read

Command summary:

```text
GET {awsProfile.endpoint}/v0/fabric/registry
Authorization: Bearer [redacted local paired device token]
```

Sanitized result:

```json
{
  "status": 200,
  "ok": true,
  "rpc": "fabric.registry.read",
  "counts": {
    "nodes": 2,
    "relayNodes": 2,
    "transports": 2,
    "projects": 2,
    "runtimes": 4
  },
  "nodes": [
    {
      "id": "aws-current-node",
      "name": "AWS Current Node",
      "roles": ["node", "relay-node"],
      "status": "online"
    },
    {
      "id": "local-mac-remote-node",
      "name": "Local Mac Remote Node",
      "roles": ["node", "relay-node"],
      "status": "online"
    }
  ],
  "relayNodes": [
    {
      "id": "local-mac-remote-node-relay",
      "nodeId": "local-mac-remote-node",
      "status": "online",
      "capacityClass": "tiny"
    },
    {
      "id": "aws-current-node-relay",
      "nodeId": "aws-current-node",
      "status": "online",
      "capacityClass": "tiny"
    }
  ]
}
```

Top-level registry items:

```json
{
  "projects": [
    {
      "id": "local-mac-remote-node-p-0ce3abedda4d5a7b",
      "nodeId": "local-mac-remote-node",
      "name": "ai_home",
      "displayPath": "/Users/model/projects/feature/ai_home"
    },
    {
      "id": "aws-current-node-p-44fd5246a00228b4",
      "nodeId": "aws-current-node",
      "name": "aih-fabric-current",
      "displayPath": "/home/ubuntu/aih-fabric-current"
    }
  ],
  "runtimes": [
    {
      "id": "local-mac-remote-node-codex-tui",
      "nodeId": "local-mac-remote-node",
      "provider": "codex",
      "mode": "tui",
      "status": "available"
    },
    {
      "id": "local-mac-remote-node-claude-tui",
      "nodeId": "local-mac-remote-node",
      "provider": "claude",
      "mode": "tui",
      "status": "available"
    },
    {
      "id": "local-mac-remote-node-agy-tui",
      "nodeId": "local-mac-remote-node",
      "provider": "agy",
      "mode": "tui",
      "status": "available"
    },
    {
      "id": "local-mac-remote-node-opencode-tui",
      "nodeId": "local-mac-remote-node",
      "provider": "opencode",
      "mode": "tui",
      "status": "available"
    }
  ],
  "transports": [
    {
      "id": "aws-current-node-relay",
      "nodeId": "aws-current-node",
      "kind": "relay",
      "health": "online",
      "measurement": {
        "status": "ws_echo_pass",
        "successRate": 1,
        "rttMs": {
          "p95": 0,
          "max": 1,
          "count": 20
        }
      }
    },
    {
      "id": "local-mac-remote-node-relay",
      "nodeId": "local-mac-remote-node",
      "kind": "relay",
      "health": "online",
      "measurement": {
        "status": "reachable"
      }
    }
  ]
}
```

### Ready state

Command summary:

```text
GET http://127.0.0.1:9527/readyz
GET http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/readyz
```

Sanitized result:

```json
[
  {
    "url": "http://127.0.0.1:9527/readyz",
    "status": 200,
    "ready": true,
    "accounts": {
      "codex": 1,
      "gemini": 1,
      "claude": 5,
      "agy": 7,
      "opencode": 1
    }
  },
  {
    "url": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/readyz",
    "status": 200,
    "ready": false,
    "accounts": {
      "codex": 0,
      "gemini": 0,
      "claude": 0,
      "agy": 0,
      "opencode": 0
    }
  }
]
```

AWS current is online as a server endpoint, but it has no provider accounts loaded in the current state.

### AWS process and persisted registry

SSH process summary:

```text
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node /home/ubuntu/aih-fabric-current/lib/cli/app.js server serve --host 0.0.0.0 --port 9527
node /home/ubuntu/aih-fabric-current/bin/ai-home.js node relay connect http://127.0.0.1:9527 --node-id aws-current-node
node /home/ubuntu/aih-fabric-current/bin/ai-home.js fabric registry agent http://127.0.0.1:9527 --node-id aws-current-node --token-file ... --interval-ms 30000
```

Server environment summary:

```text
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
PWD=/home/ubuntu/aih-fabric-current
HOME=/home/ubuntu
```

Persisted registry summary:

```json
{
  "path": "/home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric-registry.json",
  "nodes": ["aws-current-node", "local-mac-remote-node"],
  "relayNodes": ["local-mac-remote-node-relay", "aws-current-node-relay"],
  "projects": 2,
  "runtimes": 4,
  "transports": 2,
  "networkMeasurements": 397
}
```

## Conclusion

Current AWS visibility is real and authorized:

- local client can restore the AWS server profile;
- local client can read AWS Fabric registry with its paired device token;
- AWS current and local Mac are visible as online Fabric nodes;
- AWS current has relay health and an AWS project entry.

Current AWS remote development session is not product-complete:

- AWS current has no provider accounts loaded;
- AWS current has no provider runtime records in this readback;
- the product still lacks a node detail action that gates `start session` by runtime/account availability;
- M4 event store, approval/artifact lanes, attach/resume, and real AWS current M4 smoke remain pending.
