# 2026-06-29 M6 post-CLI promotion readiness recheck

## Scope

Re-run the formal transport gates after productizing the M6 CLI entries:

- `aih fabric transport promotion-gate`
- `aih fabric transport prerequisites`
- `aih fabric transport relay-durability`
- `aih fabric transport webtransport`
- `aih fabric transport turn-relay`

This is a real local-client to AWS current recheck. It does not use mock data,
does not touch legacy servers, and does not add ports beyond the default `9527`.

## Target

```text
endpoint: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
aws dir:  /home/ubuntu/aih-fabric-current
```

## Prerequisite audit

Command:

```bash
node bin/ai-home.js fabric transport prerequisites \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- `baseReady=true`
- `promotionReady=false`
- `readyTransports=[]`
- AWS server process: `279373 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527`
- AWS `AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home`
- AWS service supervisor ready: `true`
- registry readback counts: `nodes=2 relayNodes=2 projects=2 runtimes=4 transports=3 nodeInventory=2`
- AWS runtime gaps remain provider-account gaps:
  - `codex:missing_provider_account:codex`
  - `claude:missing_provider_account:claude`
  - `agy:missing_provider_account:agy`
  - `opencode:missing_provider_account:opencode`
- blockers:
  - `turn:turn_ice_server_not_configured`
  - `webtransport:webtransport_connect_failed`
  - `multipath:local_mptcp_unavailable`
  - `multipath:openmptcprouter_not_detected`
  - `multipath:default_listener_is_plain_http_not_multipath_transport`
- `transportConfig.present=false`

## Promotion gate

Command:

```bash
node bin/ai-home.js fabric transport promotion-gate \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- `defaultTransport=relay`
- `fallbackReady=true`
- `promotionReady=false`
- `promotedTransports=[]`
- relay fallback: `20/20` echo, p95 `109ms`, blockers `[]`
- WebRTC DataChannel:
  - `candidateReady=true`
  - `promotionReady=false`
  - RTT p95 `353.3ms`
  - selected candidate pair `srflx -> srflx`
  - blocker `turn_relay_gate_not_ready`
- WebRTC RPC adapter:
  - `ok=true`
  - `responses=3`
  - `requestsHandled=3`
  - RPC p95 `198.8ms`
- TURN:
  - `ran=false`
  - blocker `turn_ice_server_not_configured`
- WebTransport:
  - `ran=true`
  - blocker `webtransport_connect_failed`
- Multipath:
  - `candidateReady=true`
  - `promotionReady=false`
  - blockers `local_mptcp_unavailable`, `openmptcprouter_not_detected`,
    `default_listener_is_plain_http_not_multipath_transport`

## Product diagnostic entries

### TURN relay

Command:

```bash
node bin/ai-home.js fabric transport turn-relay \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- `probe=null`
- `gate.ran=false`
- `candidateReady=false`
- `promotionReady=false`
- blocker `turn_ice_server_not_configured`
- `transportConfig.present=false`

### WebTransport

Command:

```bash
node bin/ai-home.js fabric transport webtransport \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- browser channel: `chrome`
- `isSecureContext=true`
- `webTransportType=function`
- error: `WebTransportError: Opening handshake failed.`
- blocker `webtransport_connect_failed`
- `transportConfig.present=false`

## Verdict

The M6 software surface is now closed for the current AWS-only topology:

- default relay is usable and measured;
- WebRTC DataChannel and its RPC adapter are usable as candidates;
- TURN, WebTransport, and Multipath are blocked by real external topology or
  configuration prerequisites, not by missing product command surfaces;
- advanced transport must not become default until at least one real external
  prerequisite is supplied and the same gates return `promotionReady=true`.
