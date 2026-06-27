# 2026-06-27 Outbound Broker Relay AWS Smoke

## Scope

验证 AWS current 默认 `9527` 上的 outbound broker routing 能否接到现有 relay/native session 链路：

- AIH Server 主动 outbound 连接同一 broker endpoint。
- Client/device API 使用 broker proxy base。
- Relay node 仍通过 outbound relay link 连接 Control Plane。
- 通过 broker proxy 触发真实 Codex native TUI 会话，并验证模型输出 marker。

这不是 public ingress 证明；所有命令都在 AWS host 内部访问 `127.0.0.1:9527`。它证明 broker proxy 可以作为 client/server profile endpoint 进入真实 relay/session 控制链路。

## Environment

| item | value |
|---|---|
| Date | 2026-06-27 |
| Host | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` |
| Remote dir | `/home/ubuntu/aih-fabric-current` |
| Server port | `9527` |
| Node runtime | `/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64` |
| Host home | `/home/ubuntu/aih-fabric-current/.aih-host-home` |
| Token handling | broker token read from remote `.broker-token`; token not printed |

## Commands

Deploy current source to the single current directory:

```bash
node scripts/fabric-real-vps-deploy.js \
  --ssh ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  --ssh-key /Users/model/.ssh/aws.pem \
  --remote-dir /home/ubuntu/aih-fabric-current \
  --node-runtime tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz \
  --skip-import \
  --skip-build \
  --broker-token-file /home/ubuntu/aih-fabric-current/.broker-token
```

Base broker relay smoke:

```bash
ssh -i /Users/model/.ssh/aws.pem ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  'cd /home/ubuntu/aih-fabric-current
   export AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
   export PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:/home/ubuntu/aih-fabric-current/node_modules/.bin:$PATH
   node scripts/fabric-real-broker-relay-smoke.js \
     --endpoint http://127.0.0.1:9527 \
     --local-url http://127.0.0.1:9527 \
     --server-id aws-current \
     --node-id aws-current-broker-relay \
     --host-home /home/ubuntu/aih-fabric-current/.aih-host-home \
     --token-file /home/ubuntu/aih-fabric-current/.broker-token \
     --timeout-ms 30000'
```

Native Codex session through broker proxy:

```bash
ssh -i /Users/model/.ssh/aws.pem ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  'cd /home/ubuntu/aih-fabric-current
   export AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
   export PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:/home/ubuntu/aih-fabric-current/node_modules/.bin:$PATH
   node scripts/fabric-real-broker-relay-smoke.js \
     --endpoint http://127.0.0.1:9527 \
     --local-url http://127.0.0.1:9527 \
     --server-id aws-current \
     --node-id aws-current-broker-session \
     --host-home /home/ubuntu/aih-fabric-current/.aih-host-home \
     --token-file /home/ubuntu/aih-fabric-current/.broker-token \
     --timeout-ms 30000 \
     --session-provider codex \
     --session-account 1 \
     --session-model gpt-5.5 \
     --session-project /home/ubuntu/aih-fabric-current \
     --session-prompt "Return one line by joining these words with underscores: AIH REAL BROKER RELAY OK 627A. Do not add any other text." \
     --expect-output AIH_REAL_BROKER_RELAY_OK_627A \
     --session-timeout-ms 120000'
```

Regression and cleanup checks:

```bash
node --test test/fabric-broker-routing.test.js test/fabric-real-broker-relay-smoke.test.js test/fabric-real-outbound-relay-smoke.test.js test/fabric-real-vps-deploy.test.js test/server-node-rpc-wiring.test.js
node --check scripts/fabric-real-broker-smoke.js scripts/fabric-real-broker-relay-smoke.js scripts/fabric-real-outbound-relay-smoke.js scripts/fabric-real-vps-deploy.js
npm test
ps -axo pid,command | rg "[f]abric-real|[f]abric broker connect|[n]ode relay connect|aws-current-broker"
ssh -i /Users/model/.ssh/aws.pem ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  "ps -eo pid,command | grep -E 'fabric-real|fabric broker connect|node relay connect|aws-current-broker' | grep -v grep || true"
```

## Metrics

| metric | value | note |
|---|---:|---|
| deploy source artifact | `e501346455ccb95afe50dc76a0e1e00b2ad1f005c104bcbb43d46f5732d69c0e` | `26368657` bytes |
| remote server startup | pass | `listen: http://0.0.0.0:9527` |
| account pool | `codex=3, gemini=1, claude=4, agy=7, opencode=0` | real imported accounts |
| base broker relay duration | `555ms` | broker + relay + sessions RPC |
| native session duration | `8758ms` | broker + relay + Codex TUI marker |
| broker proxy endpoint | `viaProxy=true` | `/v0/fabric/broker/servers/aws-current/proxy` |
| base relay sessions API | HTTP `200` | `rpc=control_plane.device.node_sessions` |
| native session start | HTTP `200` | runId present |
| native model marker | pass | `expectedOutputFound=true` |
| local focused regression | 49/49 pass | fabric broker/relay/deploy/node-rpc |
| full test suite | 2507/2507 pass | `npm test` |
| static checks | 4/4 pass | broker/relay/deploy smoke scripts |
| process cleanup | pass | no broker/relay/smoke residual process locally or remotely |

## Results

Base broker relay smoke returned:

```json
{
  "ok": true,
  "mode": "existing-endpoint-broker-relay",
  "endpoint": "http://127.0.0.1:9527",
  "proxyBase": "http://127.0.0.1:9527/v0/fabric/broker/servers/aws-current/proxy",
  "serverId": "aws-current",
  "nodeId": "aws-current-broker-relay",
  "broker": {
    "connected": true,
    "sessionId": "ab6d738c-d9d2-4a4b-8b86-6c7c8689bf15"
  },
  "relay": {
    "ok": true,
    "client": {
      "endpoint": "http://127.0.0.1:9527/v0/fabric/broker/servers/aws-current/proxy",
      "viaProxy": true
    },
    "relay": {
      "online": true,
      "status": "online",
      "transportKind": "relay",
      "transportStatuses": ["relay:up"]
    },
    "sessions": {
      "status": 200,
      "ok": true,
      "rpc": "control_plane.device.node_sessions"
    }
  }
}
```

Native Codex session through broker proxy returned:

```json
{
  "ok": true,
  "mode": "existing-endpoint-broker-relay",
  "broker": {
    "connected": true,
    "sessionId": "76f8b97b-3398-4fd4-9886-a98cf759af05"
  },
  "relay": {
    "ok": true,
    "client": {
      "viaProxy": true
    },
    "relay": {
      "online": true,
      "transportKind": "relay"
    },
    "session": {
      "ok": true,
      "enabled": true,
      "provider": "codex",
      "accountId": "1",
      "model": "gpt-5.5",
      "projectPath": "/home/ubuntu/aih-fabric-current",
      "startStatus": 200,
      "runIdPresent": true,
      "expectedOutputFound": true,
      "eventCounts": {
        "ready": 1,
        "terminal-output": 181,
        "aborted": 1
      },
      "quit": {
        "status": 200,
        "accepted": true
      }
    }
  },
  "durationMs": 8758
}
```

The terminal output tail included the model response marker:

```text
AIH_REAL_BROKER_RELAY_OK_627A
```

The prompt did not contain the exact expected marker string; it asked the model to join separate words with underscores.

## Interpretation

- The broker route is no longer only a local protocol slice. On the active AWS current deployment, a device/client can use the broker proxy base as the API endpoint for node/session operations.
- The relay/node leg remains outbound, and the broker/server link is outbound. This is the correct product direction for machines without public ingress.
- This evidence proves the single-host broker + server + relay + native runtime loop on the real VPS default port. The remaining higher-level evidence is a multi-host topology where the broker endpoint is reachable by a separate client and the AIH server itself has no public client ingress.
- The current implementation still deliberately keeps the broker allowlist narrow and does not proxy `/v1/responses` or management account APIs.

## Verdict

pass

For the M2.5 single-broker underlay slice, default-port broker proxy + outbound relay + native Codex session is verified with real AWS runtime and real model output.

## Next Checks

- Promote broker endpoint into Server Profile configuration so WebUI/mobile can select broker proxy endpoints without manual script flags.
- Run the same broker relay smoke with broker and server on separate machines, once a reachable broker endpoint is available.
- Add reconnect/resume evidence for broker link loss.
- Add multi-broker failover and latency measurement before treating broker as production-stable.
