# 2026-06-27 M3 Relay Health Strong Metrics Smoke

## Scope

验证 M3 7.4：

```text
AWS current default 9527
-> server-side WS echo endpoint on the existing listener
-> registry agent WS echo probe
-> latest transport measurement
-> append-only networkMeasurements trace
-> Fabric Nodes UI shows p95 / success rate / ws_echo status
```

本轮只使用 AWS current 和本机浏览器，不访问旧 `152/155/39.104` 服务器，不新增产品端口。AWS current 继续使用默认 `9527`。

## Environment

| item | value |
|---|---|
| Date | 2026-06-27 |
| Local cwd | `/Users/model/projects/feature/ai_home` |
| AWS host | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` |
| AWS dir | `/home/ubuntu/aih-fabric-current` |
| AWS server pid | `121002` |
| Default endpoint | `http://127.0.0.1:9527` |
| Public UI endpoint | `http://43.207.102.163:9527/ui/fabric/nodes` |
| Echo endpoint | `ws://127.0.0.1:9527/v0/fabric/transport/echo` |
| Node id | `aws-current-node` |
| Screenshot | `/tmp/aih-m3-relay-health-strong-metrics.png` |

## Commands

Direct WS echo on the existing server listener:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:\$PATH \
   node bin/ai-home.js fabric transport echo \
     ws://127.0.0.1:9527/v0/fabric/transport/echo \
     --count 20 \
     --payload-size 64 \
     --timeout-ms 10000 \
     --json"
```

Registry agent probe, using the persisted node token file without printing the token:

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
     --probe-transport relay=ws://127.0.0.1:9527/v0/fabric/transport/echo \
     --probe-count 20 \
     --probe-payload-size 64 \
     --probe-timeout-ms 10000 \
     --count 1 \
     --json"
```

Independent readback from the persisted registry file:

```text
Read /home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric-registry.json
Summarize counts, aws-current-node-relay latest measurement and latest networkMeasurements entry.
```

Browser smoke:

```text
Chrome headless opened http://43.207.102.163:9527/ui/fabric/nodes.
A real device pair was created through AWS current and stored as a browser profile.
The page loaded the real /v0/fabric/registry data with that token.
Screenshot saved to /tmp/aih-m3-relay-health-strong-metrics.png.
```

## Results

| check | result |
|---|---|
| AWS server process | `121002 ... server serve --host 0.0.0.0 --port 9527` |
| Descriptor | `transportLab` includes `ws-echo`; `transports` includes `ws-echo` |
| Direct WS echo | `ok=true`, `successes=20`, `failures=[]`, `rttMs.count=20`, `p95=1ms` |
| Registry agent | `ok=true`, `attempts=1`, `failures=0` |
| Agent probe | `status=ws_echo_pass`, `successes=20`, `failures=0`, `sampleCount=20`, `successRate=1`, `p95=2ms` |
| Registry counts | `nodes=2`, `relayNodes=2`, `transports=2`, `projects=2`, `runtimes=4`, `networkMeasurements=2` |
| Latest transport measurement | `aws-current-node-relay` has `status=ws_echo_pass`, `sampleCount=20`, `successRate=1`, `rttMs.count=20`, `rttMs.p95=2` |
| Latest network measurement | appended for `aws-current-node-relay` with the same WS echo summary |
| Browser UI | title, both nodes, `p95`, `100% ok (20)`, `ws_echo_pass` visible |
| Browser console | 0 errors, 0 exceptions |
| AWS residue | no `fabric registry agent`, `node relay connect`, `fabric transport echo`, or browser smoke process after run |
| Local focused tests | 36/36 pass |
| AWS focused tests | 36/36 pass |
| Web build | pass; only existing Vite chunk-size warning |

Sanitized direct echo result:

```json
{
  "ok": true,
  "target": "ws://127.0.0.1:9527/v0/fabric/transport/echo",
  "count": 20,
  "payloadSize": 64,
  "durationMs": 33,
  "successes": 20,
  "failures": [],
  "rttMs": {
    "count": 20,
    "min": 0,
    "max": 4,
    "avg": 0.4,
    "p50": 0,
    "p95": 1
  }
}
```

Sanitized registry readback:

```json
{
  "counts": {
    "nodes": 2,
    "relayNodes": 2,
    "transports": 2,
    "projects": 2,
    "runtimes": 4,
    "networkMeasurements": 2
  },
  "transport": {
    "id": "aws-current-node-relay",
    "health": "online",
    "measurement": {
      "status": "ws_echo_pass",
      "durationMs": 23,
      "successes": 20,
      "failures": 0,
      "sampleCount": 20,
      "successRate": 1,
      "rttMs": {
        "min": 0,
        "p50": 0,
        "p95": 2,
        "max": 4,
        "avg": 0,
        "count": 20
      }
    }
  },
  "latestNetworkMeasurement": {
    "nodeId": "aws-current-node",
    "transportId": "aws-current-node-relay",
    "transportKind": "relay",
    "status": "ws_echo_pass",
    "durationMs": 23,
    "successes": 20,
    "failures": 0,
    "sampleCount": 20,
    "successRate": 1,
    "rttMs": {
      "min": 0,
      "p50": 0,
      "p95": 2,
      "max": 4,
      "avg": 0,
      "count": 20
    }
  }
}
```

Browser smoke result:

```json
{
  "hasFabricTitle": true,
  "hasAwsNode": true,
  "hasLocalNode": true,
  "hasP95": true,
  "hasSuccessRate": true,
  "hasWsEcho": true,
  "consoleErrorCount": 0,
  "exceptionCount": 0,
  "screenshotPath": "/tmp/aih-m3-relay-health-strong-metrics.png"
}
```

## Interpretation

- 7.4 uses the existing AIH server listener and default port; it does not start a separate echo product port.
- `transport.measurement` keeps the latest relay health summary for fast UI rendering.
- `networkMeasurements` appends capped historical measurement entries for traceability.
- Fabric Nodes UI now exposes the strong metrics users need to judge a relay: RTT p95, echo success rate, status and failure reason when present.

## Verdict

pass

M3 subtask 7.4 is complete. The remaining M3 gates are 7.3 real supervised daemon install/start and 7.5 mobile multi-node UI regression.
