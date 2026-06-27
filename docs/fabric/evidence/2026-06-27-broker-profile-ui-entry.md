# 2026-06-27 Broker Profile UI Entry

## Scope

验证 Broker Proxy 已从脚本参数推进到 Server Profile 产品入口：

- Server Setup 的配对表单和探测保存表单都能选择 `Broker Proxy`。
- UI 输入 `brokerEndpoint + serverId` 后生成 canonical proxy endpoint。
- 保存和配对都持久化 `connectionMode=broker-proxy` 与 broker metadata。
- 即使用户粘贴 direct pair URL，只要表单选择 broker 模式，配对请求仍走 broker proxy endpoint。
- 真实 AWS current 默认 `9527` broker proxy relay smoke 仍通过。

## Environment

| item | value |
|---|---|
| Date | 2026-06-27 |
| Local cwd | `/Users/model/projects/feature/ai_home` |
| Active remote | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` |
| Remote dir | `/home/ubuntu/aih-fabric-current` |
| Server port | `9527` |
| Retired servers | `152.70.105.41`, `155.248.183.169`, `39.104.59.31` not touched |

## Commands

Focused local regression:

```bash
node --test "test/control-plane-profiles.test.js" "test/fabric-profile-gate.test.js"
npm --prefix web run build
```

AIH Claude frontend worker attempt through AIH Server profile path:

```bash
node "bin/ai-home.js" claude --print --no-session-persistence --permission-mode plan "<frontend review task>"
```

AWS default-port broker proxy relay smoke:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   export AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home && \
   export PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:/home/ubuntu/aih-fabric-current/node_modules/.bin:\$PATH && \
   node scripts/fabric-real-broker-relay-smoke.js \
     --endpoint http://127.0.0.1:9527 \
     --local-url http://127.0.0.1:9527 \
     --server-id aws-current \
     --node-id aws-current-profile-ui \
     --host-home /home/ubuntu/aih-fabric-current/.aih-host-home \
     --token-file /home/ubuntu/aih-fabric-current/.broker-token \
     --timeout-ms 30000"
```

Residual process check:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "ps -eo pid,command | grep -E 'fabric-real|fabric broker connect|node relay connect|aws-current-profile-ui' | grep -v grep || true"
```

## Results

| check | result |
|---|---|
| `control-plane-profiles + fabric-profile-gate` | 33/33 pass |
| Web build | `tsc && vite build` pass, existing chunk warning only |
| Broker form endpoint resolver | direct and broker proxy inputs covered |
| Broker-mode pair override | direct pair URL still posts to proxy endpoint |
| AWS broker proxy smoke | `ok=true`, `viaProxy=true`, relay online |
| AWS sessions RPC | HTTP 200, `rpc=control_plane.device.node_sessions` |
| AWS residual processes | none |
| AIH Claude worker | unavailable; stayed at `Waiting for claude to boot` for more than 60s |

AWS smoke returned:

```json
{
  "ok": true,
  "endpoint": "http://127.0.0.1:9527",
  "proxyBase": "http://127.0.0.1:9527/v0/fabric/broker/servers/aws-current/proxy",
  "serverId": "aws-current",
  "nodeId": "aws-current-profile-ui",
  "broker": {
    "connected": true
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
      "transportKind": "relay"
    },
    "sessions": {
      "status": 200,
      "ok": true,
      "rpc": "control_plane.device.node_sessions"
    }
  }
}
```

## Interpretation

- Broker Proxy is now a selectable Server Profile connection mode, not only a smoke-script flag.
- The product entry stores the proxy endpoint as the client API endpoint and keeps broker metadata for export/import and list display.
- The pair path now explicitly preserves broker routing when a pasted pair URL contains a direct server endpoint.
- The AWS check proves the generated endpoint shape still reaches the real broker -> relay -> sessions control path on default `9527`.
- The Claude worker path was attempted correctly through AIH Server, but it did not produce a review; current validation therefore relies on local tests, build, and real AWS smoke.

## Verdict

pass

Broker Profile UI entry is implemented and verified for local form/profile behavior plus AWS default-port broker proxy relay reachability.

## Next Checks

- Add a browser-level smoke for the Server Setup form once the local/AWS WebUI serving path can be tested without introducing another port.
- Add broker link reconnect/resume evidence.
- Add a reachable public broker endpoint smoke where client and server are on different hosts and both use outbound-only connectivity.
