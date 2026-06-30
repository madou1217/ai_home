# 2026-06-29 M6 Promotion Gate CLI

## Scope

This evidence records productizing the aggregate M6 transport promotion gate as:

```text
aih fabric transport promotion-gate
```

The command is a thin product CLI facade over `scripts/fabric-m6-promotion-gate.js`.
It does not duplicate probe logic and it keeps "the gate ran" separate from
"advanced transport can be promoted".

## Local Verification

```text
node --check lib/cli/commands/fabric-router.js
node --check lib/cli/services/fabric/transport-promotion-gate.js
node --test test/fabric-transport-promotion-gate.test.js test/fabric-m6-promotion-gate.test.js
npm test
```

Results:

```text
node --check: pass
focused promotion gate tests: 14/14 pass
npm test: 2690/2690 pass
```

## Real AWS Gate

Command:

```text
node bin/ai-home.js fabric transport promotion-gate \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --sample-count 2 \
  --rpc-sample-count 2 \
  --relay-count 5 \
  --timeout-ms 30000 \
  --browser-channel chrome
```

Result:

```text
AIH Fabric M6 transport promotion gate
  endpoint: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
  promotion_ready: no
  default_transport: relay
  relay: candidate=yes promotion=yes
  webrtc: candidate=yes promotion=no
    - turn_relay_gate_not_ready
  turn: candidate=no promotion=no
    - turn_ice_server_not_configured
  webtransport: candidate=no promotion=no
    - webtransport_connect_failed
  multipath: candidate=yes promotion=no
    - local_mptcp_unavailable
    - openmptcprouter_not_detected
    - default_listener_is_plain_http_not_multipath_transport
```

`--fail-on-blocked --json` returned process status `1` while preserving
`ok=true` and `exitOk=false`.

Important JSON evidence:

```text
relay: successes=5/5, p95=105ms
webrtc: candidateReady=true, promotionReady=false
webrtc.rtt.p95=211ms
webrtc.rpc.ok=true, responses=2, requestsHandled=2, rpc.p95=211.1ms
webrtc.selectedPair=srflx -> srflx
turn.blockers=turn_ice_server_not_configured
webtransport.blockers=webtransport_connect_failed
multipath.blockers=local_mptcp_unavailable,openmptcprouter_not_detected,default_listener_is_plain_http_not_multipath_transport
summary.defaultTransport=relay
summary.fallbackReady=true
summary.promotionReady=false
```

## AWS Source Sync

Commit `e467a1c` was synced with a clean `git archive HEAD` artifact. The dirty
local worktree was not used.

Artifact:

```text
/tmp/aih-fabric-e467a1c.tar.gz
sha256=e5affb7290d4418b9da4660a675ce4e5c3e2c8e8b4cc4fa04cb603b81c214862
remote=/home/ubuntu/aih-fabric-current/source-e467a1c.tar.gz
```

Remote verification:

```text
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/commands/fabric-router.js
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/services/fabric/transport-promotion-gate.js
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-transport-promotion-gate.test.js test/fabric-m6-promotion-gate.test.js
```

Results:

```text
AWS node --check: pass
AWS focused promotion gate tests: 14/14 pass
```

AWS default `9527` remained healthy:

```json
{
  "ok": true,
  "service": "aih-server",
  "ready": false,
  "accounts": {
    "codex": 0,
    "gemini": 0,
    "claude": 0,
    "agy": 0,
    "opencode": 0
  }
}
```

## Conclusion

M6 now has a product CLI entry for the aggregate promotion decision:

- relay fallback is still the default and is healthy;
- WebRTC DataChannel/RPC is a working candidate;
- WebRTC cannot be promoted without a controlled TURN relay candidate;
- WebTransport cannot be promoted until a real HTTPS/H3 endpoint exists;
- multipath cannot be promoted from the current macOS + AWS topology without a
  real OpenMPTCPRouter/Linux underlay;
- default transport must remain `relay`.
