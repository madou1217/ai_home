# 2026-06-29 M6 TURN default UDP gate

## Scope

Productize the default-port UDP reachability check inside the existing M6
prerequisite audit:

```bash
aih fabric transport prerequisites
```

The goal is to prove whether AWS current can host a self-managed TURN listener
on the same numeric default port, UDP `9527`, without adding any new product
port. This is a real local-client to AWS current probe.

## Code paths

- `scripts/fabric-m6-prerequisite-audit.js`
- `lib/cli/services/fabric/transport-prerequisites.js`
- `test/fabric-m6-prerequisite-audit.test.js`
- `test/fabric-transport-prerequisites.test.js`

## Local checks

```bash
node --check scripts/fabric-m6-prerequisite-audit.js
node --test \
  test/fabric-m6-prerequisite-audit.test.js \
  test/fabric-transport-prerequisites.test.js
```

Result: 12/12 pass.

Coverage:

- parser defaults keep the UDP gate enabled;
- `--skip-turn-udp-probe` remains available for isolated/debug runs;
- missing TURN config can include the real default UDP blocker;
- a complete external TURN relay candidate is not blocked by AWS default UDP
  failure, because external TURN and self-hosted same-port TURN are separate
  prerequisites.

Full suite:

```bash
npm test
```

Result: 2717/2717 pass.

## Real default UDP 9527 probe

Command:

```bash
node bin/ai-home.js fabric transport prerequisites \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --skip-webtransport \
  --skip-multipath \
  --json
```

Result:

- AWS base preflight: `candidateReady=true`, `promotionReady=true`
- AWS server pid: `279373`
- AWS `AIH_HOST_HOME`: `/home/ubuntu/aih-fabric-current/.aih-host-home`
- registry counts: `nodes=2 relayNodes=2 projects=2 runtimes=4 transports=3 nodeInventory=2`
- remote UDP echo: `ready=true`, `port=9527`
- local UDP probe: `ok=false`, `error=udp_echo_timeout`, `sent=13`, `durationMs=5004`
- TURN blockers:
  - `turn_ice_server_not_configured`
  - `turn_default_udp_9527_unreachable`

Interpretation:

- AWS can bind UDP `9527`.
- The local machine cannot receive an echo from AWS UDP `9527` through the
  current public path.
- A self-managed TURN listener on default UDP `9527` is not currently viable
  for home/company clients.

## Full prerequisite audit

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
- blockers:
  - `turn:turn_ice_server_not_configured`
  - `turn:turn_default_udp_9527_unreachable`
  - `webtransport:webtransport_connect_failed`
  - `multipath:local_mptcp_unavailable`
  - `multipath:openmptcprouter_not_detected`
  - `multipath:default_listener_is_plain_http_not_multipath_transport`

## Strict gate

Command:

```bash
node bin/ai-home.js fabric transport prerequisites \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --skip-webtransport \
  --skip-multipath \
  --fail-on-blocked \
  --json
```

Result:

- process status: `1`
- report `ok`: `true`
- report `exitOk`: `false`
- blockers:
  - `turn:turn_ice_server_not_configured`
  - `turn:turn_default_udp_9527_unreachable`

## AWS current sync and remote verification

Artifact:

```text
ea32c59113222ebdf99ce41d7a604658b91fd4ff09ae5b259263e0a7bb78bf69  source-turn-udp-gate.tar.gz
```

Remote target:

```text
ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:/home/ubuntu/aih-fabric-current
```

Remote checks:

```bash
node --check scripts/fabric-m6-prerequisite-audit.js
node --test \
  test/fabric-m6-prerequisite-audit.test.js \
  test/fabric-transport-prerequisites.test.js
```

Result: 12/12 pass.

## Verdict

M6 11.3 now has a repeatable product gate for default-port self-hosted TURN
feasibility. Under the current AWS-only, default-port-only topology, TURN cannot
be promoted because there is no configured TURN server and AWS UDP `9527` is not
reachable from the local client.
