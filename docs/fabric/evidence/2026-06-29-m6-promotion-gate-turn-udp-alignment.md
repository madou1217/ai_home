# 2026-06-29 M6 promotion gate TURN UDP alignment

## Scope

Align the formal aggregate promotion gate with the prerequisite audit for the
same TURN/default-port problem. Both gates now use the shared default UDP
`9527` probe and report the same blocker when local-client to AWS UDP echo is
not reachable.

This does not add a product port, install TURN/QUIC software, import provider
credentials, or touch legacy VPS targets.

## Code paths

- `scripts/fabric-default-udp-probe.js`
- `scripts/fabric-m6-prerequisite-audit.js`
- `scripts/fabric-m6-promotion-gate.js`
- `test/fabric-m6-promotion-gate.test.js`

## Local checks

```bash
node --check scripts/fabric-default-udp-probe.js
node --check scripts/fabric-m6-prerequisite-audit.js
node --check scripts/fabric-m6-promotion-gate.js
node --test \
  test/fabric-m6-prerequisite-audit.test.js \
  test/fabric-m6-promotion-gate.test.js \
  test/fabric-transport-prerequisites.test.js \
  test/fabric-transport-promotion-gate.test.js
```

Result: 28/28 pass.

Full suite:

```bash
npm test
```

Result: 2719/2719 pass.

Coverage:

- `promotion-gate` parser carries AWS current `remoteDir` and default `port`.
- `--skip-turn-udp-probe` remains available for isolated/debug runs.
- missing TURN config includes both `turn_ice_server_not_configured` and the
  real default UDP blocker.
- `runPromotionGate` can inject the UDP probe in tests without shelling out.

## Real AWS promotion gate

Command:

```bash
node bin/ai-home.js fabric transport promotion-gate \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- target:
  - endpoint `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
  - ssh `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
  - remoteDir `/home/ubuntu/aih-fabric-current`
  - port `9527`
- relay fallback: `20/20` echo, p95 `104ms`, blockers `[]`
- WebRTC DataChannel:
  - `candidateReady=true`
  - `promotionReady=false`
  - RTT p95 `218.7ms`
  - selected candidate pair `srflx -> srflx`
  - blocker `turn_relay_gate_not_ready`
- WebRTC RPC adapter:
  - `ok=true`
  - `responses=3`
  - `requestsHandled=3`
  - RPC p95 `221ms`
- TURN:
  - `ran=false`
  - remote UDP echo `ready=true port=9527`
  - local UDP probe `ok=false error=udp_echo_timeout sent=13 durationMs=5001`
  - blockers:
    - `turn_ice_server_not_configured`
    - `turn_default_udp_9527_unreachable`
- WebTransport blocker: `webtransport_connect_failed`
- Multipath blockers:
  - `local_mptcp_unavailable`
  - `openmptcprouter_not_detected`
  - `default_listener_is_plain_http_not_multipath_transport`
- summary:
  - `promotionReady=false`
  - `defaultTransport=relay`
  - `fallbackReady=true`
  - includes `turn:turn_default_udp_9527_unreachable`

## Strict gate

Command:

```bash
node bin/ai-home.js fabric transport promotion-gate \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --fail-on-blocked \
  --json
```

Result:

- process status: `1`
- report `ok`: `true`
- report `exitOk`: `false`
- summary includes:
  - `webrtc:turn_relay_gate_not_ready`
  - `turn:turn_ice_server_not_configured`
  - `turn:turn_default_udp_9527_unreachable`
  - `webtransport:webtransport_connect_failed`
  - `multipath:local_mptcp_unavailable`
  - `multipath:openmptcprouter_not_detected`
  - `multipath:default_listener_is_plain_http_not_multipath_transport`

## AWS current sync and remote verification

Artifact:

```text
8c779807e3678904f0b9559287cae28e75b31228673aa01c349f9b9c402cbb7e  source-promotion-udp-gate.tar.gz
```

Remote target:

```text
ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:/home/ubuntu/aih-fabric-current
```

Remote checks:

```bash
node --check scripts/fabric-default-udp-probe.js
node --check scripts/fabric-m6-prerequisite-audit.js
node --check scripts/fabric-m6-promotion-gate.js
node --test \
  test/fabric-m6-prerequisite-audit.test.js \
  test/fabric-m6-promotion-gate.test.js \
  test/fabric-transport-prerequisites.test.js \
  test/fabric-transport-promotion-gate.test.js
```

Result: 28/28 pass.

## Verdict

The prerequisite audit and aggregate promotion gate now explain the current
TURN blocker with the same data:

- there is no configured controlled TURN server;
- AWS current can temporarily bind UDP `9527`;
- local-client to AWS UDP `9527` echo still times out;
- advanced transport remains blocked, while relay fallback is measured and
  usable as the default.
