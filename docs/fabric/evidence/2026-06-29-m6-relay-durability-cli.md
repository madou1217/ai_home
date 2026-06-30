# 2026-06-29 M6 relay durability CLI

## Scope

Productize the existing relay fallback durability gate as a user-facing Fabric command:

```bash
aih fabric transport relay-durability
```

The command is a thin CLI facade over `scripts/fabric-m6-relay-durability-gate.js`.
It runs real WebSocket echo rounds against the current default relay path and
fails the command when the relay durability budget fails. It does not import
provider credentials, open ports, or touch retired VPS targets.

## Code paths

- `lib/cli/services/fabric/transport-relay-durability.js`
- `lib/cli/commands/fabric-router.js`
- `test/fabric-transport-relay-durability.test.js`

## Local code checks

```bash
node --check lib/cli/services/fabric/transport-relay-durability.js
node --check lib/cli/commands/fabric-router.js
node --check test/fabric-transport-relay-durability.test.js
```

Result: pass.

## Focused local tests

```bash
node --test \
  test/fabric-m6-relay-durability-gate.test.js \
  test/fabric-transport-relay-durability.test.js
```

Result: 10/10 pass.

Coverage:

- existing parser/defaults and loopback WebSocket echo gate still pass.
- product service passes CLI options to the durability gate.
- router emits JSON and exits `0` on pass.
- router exits `1` on durability failure.

## Full local test suite

```bash
npm test
```

Result: 2701/2701 pass.

## Real AWS current public relay durability

Command:

```bash
node bin/ai-home.js fabric transport relay-durability \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --rounds 6 \
  --count-per-round 20 \
  --payload-size 64 \
  --timeout-ms 10000 \
  --round-interval-ms 1000 \
  --min-success-rate 100% \
  --json
```

Result:

```json
{
  "ok": true,
  "target": {
    "endpoint": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527",
    "echoUrl": "ws://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/transport/echo"
  },
  "summary": {
    "rounds": 6,
    "passedRounds": 6,
    "totalAttempts": 120,
    "successes": 120,
    "failures": 0,
    "successRate": 1,
    "rttMs": {
      "count": 120,
      "min": 102,
      "max": 116,
      "avg": 107.64,
      "p50": 107,
      "p95": 112,
      "p99": 115
    },
    "blockers": []
  },
  "exitOk": true
}
```

This is a real local -> AWS public endpoint test on the default `9527` listener.

## Pre-commit real AWS recheck

Command:

```bash
node bin/ai-home.js fabric transport relay-durability \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --rounds 6 \
  --count-per-round 20 \
  --payload-size 64 \
  --timeout-ms 10000 \
  --round-interval-ms 1000 \
  --min-success-rate 100% \
  --json
```

Result:

- ok: `true`
- rounds: `6/6`
- echo: `120/120`
- successRate: `1`
- p95: `109ms`
- p99: `198ms`
- blockers: `[]`

## AWS current sync and remote verification

Scoped artifact built from clean `HEAD` plus only this relay-durability CLI
change set:

```text
/tmp/aih-fabric-relay-durability-cli.tar.gz
```

sha256:

```text
69e8f53d4616eeeef7159cffa44e52807aef943c7a806380a8ad2acc6cec52fc
```

Uploaded to:

```text
/home/ubuntu/aih-fabric-current/source-relay-durability-cli.tar.gz
```

Remote command:

```bash
cd /home/ubuntu/aih-fabric-current
tar --no-same-owner -xzf source-relay-durability-cli.tar.gz
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/services/fabric/transport-relay-durability.js
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/commands/fabric-router.js
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --test \
  test/fabric-m6-relay-durability-gate.test.js \
  test/fabric-transport-relay-durability.test.js
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node bin/ai-home.js fabric transport relay-durability \
  --endpoint http://127.0.0.1:9527 \
  --rounds 2 \
  --count-per-round 5 \
  --payload-size 64 \
  --timeout-ms 5000 \
  --round-interval-ms 100 \
  --json
```

Remote result:

- focused tests: 10/10 pass.
- AWS local listener durability: 2/2 rounds, 10/10 echo, successRate `1`, p95 `3ms`, blockers `[]`.

## Verdict

M6 now has a formal product CLI for the current default relay fallback durability
gate. The default transport remains `relay`; advanced transport promotion still
requires a real TURN relay, HTTPS/H3 WebTransport endpoint, or OMR/MPTCP
underlay.
