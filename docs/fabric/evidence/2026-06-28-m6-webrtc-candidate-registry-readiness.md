# 2026-06-28 M6 WebRTC Candidate Registry Readiness

## Scope

This evidence records the M6 product-state alignment after the transport
promotion gate proved WebRTC DataChannel/RPC was usable but the server-side
readiness endpoint still reported `webrtc_transport_candidate_not_registered`.

No mock AWS data was used. No retired `152.*`, `155.*`, or `39.104.*` servers
were touched. No product port other than default `9527` was opened. No provider
credentials were imported to AWS.

This evidence does **not** promote WebRTC to the default transport. It only
keeps the registry/readiness model aligned with the real transport candidate:

- default transport remains `relay`;
- WebRTC is registered as a candidate transport on `aws-current-node`;
- WebRTC promotion remains blocked by `turn_relay_gate_not_ready`;
- TURN/WebTransport/Multipath blockers remain explicit.

## Before

Real M6 gate with system Chrome:

```text
node scripts/fabric-m6-promotion-gate.js \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --ssh ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  --ssh-key /Users/model/.ssh/aws.pem \
  --sample-count 1 \
  --rpc-sample-count 1 \
  --relay-count 5 \
  --timeout-ms 25000 \
  --browser-channel chrome \
  --json
```

Result:

```text
relay: promotionReady=true, 5/5 echo, p95=105ms
webrtc: candidateReady=true, RPC ok=true, selected pair srflx -> srflx
webrtc blocker: turn_relay_gate_not_ready
turn blocker: turn_ice_server_not_configured
webtransport blocker: webtransport_connect_failed
multipath blockers: local_mptcp_unavailable, openmptcprouter_not_detected, default_listener_is_plain_http_not_multipath_transport
summary: promotionReady=false, defaultTransport=relay, fallbackReady=true
```

But the product readiness endpoint still returned:

```text
webrtc:webrtc_transport_candidate_not_registered
webrtc:turn_relay_gate_not_ready
```

That was misleading because WebRTC signaling/DataChannel/RPC was already a
verified candidate; what remained missing was the TURN relay promotion gate.

## AWS Registry Agent Update

The existing registry agent service already supports persistent `--transport`
arguments. The AWS current user-level registry agent was reinstalled with the
same relay probe plus an explicit WebRTC candidate:

```text
target: ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com
service: com.clawdcodex.ai_home.fabric-registry-agent.aws-current-node.service
node: aws-current-node
server endpoint: http://127.0.0.1:9527
added argument: --transport webrtc=online
preserved argument: --transport relay=online
preserved probe: --probe-transport relay=ws://127.0.0.1:9527/v0/fabric/transport/echo
```

During the first remote install attempt, `node` was not on the non-login SSH
PATH, so no unit was written. During the first successful write, the environment
missed the embedded Node runtime path and the corrected `AIH_HOST_HOME`, which
made the service briefly fail with:

```text
env: 'node': No such file or directory
```

The final unit was immediately corrected and restarted with the real deployed
runtime and host-home isolation.

Final service proof:

```text
MainPID: 265669
ExecStart:
  /home/ubuntu/aih-fabric-current/bin/ai-home.js fabric registry agent
  http://127.0.0.1:9527
  --node-id aws-current-node
  --token-file /home/ubuntu/aih-fabric-current/.aih-host-home/.ai_home/fabric/aws-current-node.token
  --status online
  --relay-status online
  --transport relay=online
  --transport webrtc=online
  --probe-transport relay=ws://127.0.0.1:9527/v0/fabric/transport/echo
  --probe-timeout-ms 10000
  --probe-method HEAD
  --probe-count 20
  --probe-payload-size 64
  --interval-ms 30000

PATH:
  /home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:...

AIH_HOST_HOME:
  /home/ubuntu/aih-fabric-current/.aih-host-home

status:
  active
```

Successful heartbeat after correction:

```text
[aih fabric agent] heartbeat #1 node=aws-current-node status=online relay=online transports=2 probes=relay:online nodes=2 relayNodes=2 transports=3 projects=2 runtimes=4
```

## Real Readback

Registry readback through the local paired profile:

```text
node bin/ai-home.js fabric nodes aws-current-node \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --json
```

Result:

```text
unauthenticatedStatus=401
authorizedStatus=200
registry counts: nodes=2, relayNodes=2, transports=3, projects=2, runtimes=4
aws-current-node transportKinds: relay,webrtc
aws-current-node transports:
  relay: health=online, measurement ws_echo_pass, sampleCount=20, p95=2ms
  webrtc: health=online, measurement=null
```

Transport readiness readback:

```text
node bin/ai-home.js fabric transport readiness \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --node-id aws-current-node \
  --timeout-ms 20000 \
  --json
```

Result:

```text
unauthenticatedStatus=401
authorizedStatus=200
nodeFound=true
fallbackReady=true
relayMeasurementPass=true
defaultTransport=relay
promotionReady=false
blockers:
  webrtc:webrtc_not_promoted
  webrtc:turn_relay_gate_not_ready
  webtransport:webtransport_endpoint_not_configured
  webtransport:webtransport_not_promoted
  omr:openmptcprouter_not_detected
  mptcp:mptcp_data_plane_not_promoted
```

The stale blocker is gone:

```text
webrtc_transport_candidate_not_registered: absent
```

## Post-Update Gate

Real promotion gate after registry alignment:

```text
relay: promotionReady=true, 5/5 echo, p95=112ms
webrtc: candidateReady=true, RPC ok=true, selected pair srflx -> srflx
webrtc blocker: turn_relay_gate_not_ready
turn blocker: turn_ice_server_not_configured
webtransport blocker: webtransport_connect_failed
multipath blockers: local_mptcp_unavailable, openmptcprouter_not_detected, default_listener_is_plain_http_not_multipath_transport
summary: promotionReady=false, defaultTransport=relay, fallbackReady=true
```

## Conclusion

M6 remains partial because the external promotion gates are still missing:

- no controlled TURN relay `iceServers`/credentials;
- no HTTPS/H3 WebTransport endpoint on the default target;
- no OpenMPTCPRouter/Linux MPTCP underlay for both ends.

The product state is now more accurate: AWS current exposes WebRTC as a real
candidate transport, while relay remains the only promoted/default transport.
