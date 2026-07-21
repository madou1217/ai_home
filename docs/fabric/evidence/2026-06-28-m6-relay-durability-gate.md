# M6 Relay Durability Gate

Date: 2026-06-28

## Objective

Add a repeatable, low-impact durability gate for the current default relay fallback path:

- AWS current default `9527` only.
- WebSocket echo path `/v0/fabric/transport/echo`.
- Multiple rounds, aggregate success rate, RTT p50/p95/p99, and failure reason counts.
- No provider credential import.
- No new product port.
- No retired VPS target.

This gate does not promote WebRTC, WebTransport, Multipath QUIC, MPTCP, or OpenMPTCPRouter. It only proves the existing relay fallback is stable enough to remain the default while advanced transports are externally blocked.

## New Entrypoint

```bash
node scripts/fabric-m6-relay-durability-gate.js --help
```

Default budget:

```text
endpoint: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
target: ws://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/transport/echo
rounds: 6
countPerRound: 20
payloadSize: 64
timeoutMs: 10000
roundIntervalMs: 1000
echoIntervalMs: 0
minSuccessRate: 1
```

## Focused Test

Command:

```bash
node --test test/fabric-m6-relay-durability-gate.test.js
```

Result:

```text
tests 6
pass 6
fail 0
duration_ms 69.009791
```

The final focused test starts a real local WebSocket echo server and measures two real echo rounds. Static reports are only used for pure parser/aggregation behavior.

Full regression command:

```bash
npm test
```

Result:

```text
tests 2653
pass 2653
fail 0
duration_ms 147898.574083
```

## Real AWS Gate Before Deployment

Command:

```bash
node scripts/fabric-m6-relay-durability-gate.js \
  --diagnostics-file tmp/fabric-m6-relay-durability-gate-20260628.json
```

Result:

```text
AIH Fabric M6 relay durability gate
  endpoint: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
  target: ws://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/transport/echo
  rounds: 6/6
  attempts: 120/120 success_rate=100%
  rtt: min=98ms p50=105ms p95=113ms p99=114ms max=114ms avg=105.2ms
  result: pass
```

Diagnostics summary:

```json
{
  "ok": true,
  "durationMs": 18951,
  "summary": {
    "ok": true,
    "rounds": 6,
    "passedRounds": 6,
    "failedRounds": 0,
    "totalAttempts": 120,
    "successes": 120,
    "failures": 0,
    "successRate": 1,
    "requiredSuccessRate": 1,
    "rttMs": {
      "count": 120,
      "min": 98,
      "max": 114,
      "avg": 105.2,
      "p50": 105,
      "p95": 113,
      "p99": 114
    },
    "failureReasons": [],
    "blockers": []
  }
}
```

## Conclusion

Relay fallback durability is currently pass on AWS current default `9527`:

- `6/6` rounds passed.
- `120/120` echo frames succeeded.
- Required success rate `100%` was met.
- RTT p95 `113ms`, p99 `114ms`.
- No failure reasons and no blockers.

M6 advanced transport promotion remains blocked by the external prerequisites recorded in `2026-06-28-m6-prerequisite-audit.md`: controlled TURN relay credentials, HTTPS/H3 WebTransport endpoint, or a real OpenMPTCPRouter/Linux underlay.

## Clean HEAD AWS Deployment

Command source:

```text
git archive HEAD
```

Deployment command:

```bash
node scripts/fabric-real-vps-deploy.js \
  --ssh ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --remote-dir /home/ubuntu/aih-fabric-current \
  --node-runtime "/Users/model/projects/feature/ai_home/tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz" \
  --skip-import \
  --skip-build \
  --broker-token-file /home/ubuntu/aih-fabric-current/.broker-token
```

Deployment result:

```text
source artifact: 3ad0b4eecbfff1005a4ed14c3cc847d3ea8e0cb78e5e525456e6ecef03f0493c
server pid: 250901
accounts: codex=0, gemini=0, claude=0, agy=0, opencode=0
```

Post-deploy preflight:

```json
{
  "ok": true,
  "processCount": 1,
  "supervisorReady": true,
  "registryCounts": {
    "nodes": 2,
    "relayNodes": 2,
    "projects": 2,
    "runtimes": 4,
    "transports": 2,
    "nodeInventory": 2
  },
  "targetNode": {
    "id": "aws-current-node",
    "present": true,
    "runtimeHost": false,
    "runtimeGaps": [
      "codex:missing_provider_runtime:codex",
      "claude:missing_provider_runtime:claude",
      "agy:missing_provider_runtime:agy",
      "opencode:missing_provider_runtime:opencode"
    ]
  },
  "residue": [],
  "remainingGate": []
}
```

## Real AWS Gate After Deployment

Command:

```bash
node scripts/fabric-m6-relay-durability-gate.js \
  --diagnostics-file tmp/fabric-m6-relay-durability-gate-20260628-postdeploy.json
```

Result:

```text
AIH Fabric M6 relay durability gate
  endpoint: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
  target: ws://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/transport/echo
  rounds: 6/6
  attempts: 120/120 success_rate=100%
  rtt: min=97ms p50=104ms p95=116ms p99=117ms max=118ms avg=105.67ms
  result: pass
```

Post-deploy diagnostics summary:

```json
{
  "ok": true,
  "durationMs": 19004,
  "summary": {
    "ok": true,
    "rounds": 6,
    "passedRounds": 6,
    "failedRounds": 0,
    "totalAttempts": 120,
    "successes": 120,
    "failures": 0,
    "successRate": 1,
    "requiredSuccessRate": 1,
    "rttMs": {
      "count": 120,
      "min": 97,
      "max": 118,
      "avg": 105.67,
      "p50": 104,
      "p95": 116,
      "p99": 117
    },
    "failureReasons": [],
    "blockers": []
  }
}
```

Latest conclusion remains:

- `6/6` rounds passed after clean HEAD deployment.
- `120/120` echo frames succeeded after clean HEAD deployment.
- Required success rate `100%` was met.
- RTT p95 `116ms`, p99 `117ms`.
- No failure reasons and no blockers.
- AWS current node still has no provider runtime host because provider accounts were intentionally not imported.
