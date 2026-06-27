# 2026-06-27 Broker Diagnostics and Recovery

## Scope

验证 Broker link 断开后不再只有模糊离线错误，而是可诊断、可恢复：

- Broker registry 保存最近一次断开快照。
- Broker proxy 离线响应返回 `brokerStatus.lastDisconnected`。
- `aih fabric broker connect` 前台模式支持受控重连参数。
- AWS current 默认 `9527` 上完成真实 broker diagnostics smoke。
- AWS current 默认 `9527` 上再次完成 broker proxy -> relay -> real Codex native session smoke。

## Environment

| item | value |
|---|---|
| Date | 2026-06-27 |
| Local cwd | `/Users/model/projects/feature/ai_home` |
| Active remote | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` |
| Remote dir | `/home/ubuntu/aih-fabric-current` |
| Server port | `9527` |
| Source artifact | `c201183f8de3d7358009e64564146682a1f6f312e3f098932a305b89e77973eb`, `26382060` bytes |
| Retired servers | `152.70.105.41`, `155.248.183.169`, `39.104.59.31` not touched |

## Commands

Local focused checks:

```bash
node --check "lib/server/fabric-broker-session-registry.js"
node --check "lib/server/fabric-broker-router.js"
node --check "lib/cli/services/fabric/broker-connect.js"
node --check "scripts/fabric-real-broker-diagnostics-smoke.js"
node --test "test/fabric-broker-routing.test.js" "test/fabric-real-broker-diagnostics-smoke.test.js" "test/fabric-real-broker-relay-smoke.test.js" "test/fabric-real-outbound-relay-smoke.test.js" "test/server-node-rpc-wiring.test.js"
npm test
```

AWS current deployment:

```bash
node "scripts/fabric-real-vps-deploy.js" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --remote-dir "/home/ubuntu/aih-fabric-current" \
  --node-runtime "tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz" \
  --port 9527 \
  --skip-import \
  --broker-token-file "/home/ubuntu/aih-fabric-current/.broker-token"
```

AWS diagnostics smoke:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   export PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:/home/ubuntu/aih-fabric-current/node_modules/.bin:\$PATH && \
   node scripts/fabric-real-broker-diagnostics-smoke.js \
     --endpoint http://127.0.0.1:9527 \
     --local-url http://127.0.0.1:9527 \
     --server-id aws-current-diagnostics \
     --token-file /home/ubuntu/aih-fabric-current/.broker-token \
     --timeout-ms 10000"
```

AWS broker relay real Codex session:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   export AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home && \
   export PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:/home/ubuntu/aih-fabric-current/node_modules/.bin:\$PATH && \
   node scripts/fabric-real-broker-relay-smoke.js \
     --endpoint http://127.0.0.1:9527 \
     --local-url http://127.0.0.1:9527 \
     --server-id aws-current-diagnostics-relay \
     --node-id aws-current-diagnostics-relay-node \
     --host-home /home/ubuntu/aih-fabric-current/.aih-host-home \
     --token-file /home/ubuntu/aih-fabric-current/.broker-token \
     --timeout-ms 30000 \
     --session-provider codex \
     --session-account 1 \
     --session-model gpt-5.5 \
     --session-project /home/ubuntu/aih-fabric-current \
     --session-prompt 'Return exactly one token by joining these words with underscores and no extra text: AIH BROKER DIAGNOSTICS RECOVERY OK 20260627' \
     --expect-output AIH_BROKER_DIAGNOSTICS_RECOVERY_OK_20260627 \
     --session-timeout-ms 90000"
```

Residual process check:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "ps -eo pid,command | grep -E 'fabric-real-broker-diagnostics|fabric-real-broker-relay|fabric broker connect|node relay connect|aws-current-diagnostics' | grep -v grep || true"
```

## Results

| check | result |
|---|---|
| Broker syntax checks | pass |
| Broker focused regression | 33/33 pass |
| Full local regression | `npm test` 2516/2516 pass, 7 suites, 0 fail |
| Web build during deploy | pass, existing chunk warning only |
| AWS deploy | pass, `listen: http://0.0.0.0:9527` |
| AWS diagnostics smoke | `ok=true` |
| Offline proxy response | HTTP 503, `error=fabric_broker_server_offline` |
| Offline diagnostic | `brokerStatus.online=false`, `lastDisconnected.disconnectReason=broker_server_link_closed` |
| Recovery | same `serverId` reconnect returned `readyz` HTTP 200 |
| AWS broker relay session | `ok=true`, `viaProxy=true`, relay online |
| Real Codex output | `AIH_BROKER_DIAGNOSTICS_RECOVERY_OK_20260627` found in terminal output |
| Cleanup | `/quit` accepted, abort accepted, no residual smoke/relay/broker process |

Diagnostics smoke returned:

```json
{
  "ok": true,
  "mode": "existing-endpoint-broker-diagnostics",
  "endpoint": "http://127.0.0.1:9527",
  "proxyBase": "http://127.0.0.1:9527/v0/fabric/broker/servers/aws-current-diagnostics/proxy",
  "serverId": "aws-current-diagnostics",
  "checks": {
    "beforeDisconnect": { "status": 200, "ok": true, "ready": true },
    "offline": {
      "status": 503,
      "ok": false,
      "error": "fabric_broker_server_offline",
      "brokerStatus": {
        "online": false,
        "lastDisconnected": {
          "disconnectReason": "broker_server_link_closed",
          "closeCode": 1005
        }
      }
    },
    "recovered": { "status": 200, "ok": true, "ready": true }
  }
}
```

Broker relay native session returned:

```json
{
  "ok": true,
  "client": {
    "endpoint": "http://127.0.0.1:9527/v0/fabric/broker/servers/aws-current-diagnostics-relay/proxy",
    "viaProxy": true
  },
  "relay": {
    "online": true,
    "transportKind": "relay"
  },
  "session": {
    "ok": true,
    "provider": "codex",
    "model": "gpt-5.5",
    "expectedOutputFound": true,
    "cleanup": {
      "completed": true
    }
  }
}
```

## Interpretation

- Broker link failure is now diagnosable from the client-facing proxy response without shell access to the broker process.
- The foreground `aih fabric broker connect` command can be run as a long-lived outbound link with bounded or infinite reconnect attempts.
- Recovery with the same `serverId` replaces the previous offline state and restores proxy requests.
- The real AWS native session check proves the diagnostics change did not regress broker proxy -> relay -> TUI runtime routing.

## Verdict

pass

Broker diagnostics and same-server-id recovery are verified on AWS current default `9527` with real broker proxy, real relay, and real Codex output.

## Next Checks

- Add browser-level Server Setup smoke for Broker Profile once it can run on the default serving path without adding a new port.
- Add multi-broker/failover evidence; this pass covers one broker endpoint and same-server recovery, not broker failover.
- Add a reachable public broker endpoint smoke where client and server are on different hosts and both use outbound-only connectivity.
