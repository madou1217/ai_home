# 2026-06-29 M6 UDP edge snapshot

## Scope

Add host/network edge context to the existing default UDP `9527` gate. The goal
is to make the blocker actionable: not only "UDP echo timeout", but also which
AWS interface, private/public addresses, host firewall state, and security
group identifiers were observed during the same real probe.

This test uses only AWS current:

```text
ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com
remote dir: /home/ubuntu/aih-fabric-current
default port: 9527
```

It does not add ports, does not modify AWS security groups or firewall rules,
does not install TURN/QUIC software, and does not touch legacy VPS targets.

## Code paths

- `scripts/fabric-default-udp-probe.js`
- `test/fabric-default-udp-probe.test.js`
- `test/fabric-m6-prerequisite-audit.test.js`
- `test/fabric-m6-promotion-gate.test.js`

## Real AWS prerequisite audit

Command:

```bash
node bin/ai-home.js fabric transport prerequisites \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --skip-webtransport \
  --skip-multipath \
  --json
```

Result:

- AWS base gate: `candidateReady=true`, `promotionReady=true`
- server process: `279373 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527`
- registry counts: `nodes=2`, `relayNodes=2`, `projects=2`, `runtimes=4`, `transports=3`, `nodeInventory=2`
- remote UDP echo: `ready=true`, `port=9527`
- local UDP echo: `ok=false`, `error=udp_echo_timeout`, `sent=13`, `durationMs=5002`
- packet capture: `ready=true`, `available=true`, `captured=false`, `interface=enp39s0`, `status=124`
- summary: `baseReady=true`, `promotionReady=false`, `readyTransports=[]`
- blockers: `turn:turn_ice_server_not_configured`, `turn:turn_default_udp_9527_unreachable`

Edge snapshot:

```text
route=1.1.1.1 via 172.31.32.1 dev enp39s0 src 172.31.47.163 uid 1000
interface=enp39s0
privateAddress=172.31.47.163
publicIpv4=43.207.102.163
ufw=Status: inactive
iptablesInput=-P INPUT ACCEPT
iptablesUdp=
nft=
inputPolicyAccept=true
ufwInactive=true
hostFirewallBlocksUdp=false
imdsInstanceId=i-001b344ddf61dc168
imdsSecurityGroups=launch-wizard-1,default
imdsSecurityGroupIds=sg-01e33f3412fabfded,sg-01e7f50a205d7b308
vpcId=vpc-015359c5a785e16cd
subnetId=subnet-0f7fce79d31c05449
```

## Real AWS promotion gate

Command:

```bash
node bin/ai-home.js fabric transport promotion-gate \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --skip-webtransport \
  --skip-multipath \
  --skip-webrtc \
  --json
```

Result:

- relay fallback: `20/20` echo, p95 `108ms`, blockers `[]`
- default transport: `relay`
- fallbackReady: `true`
- promotionReady: `false`
- TURN default UDP blocker: `turn_default_udp_9527_unreachable`
- edge snapshot matches prerequisite audit:
  - `interface=enp39s0`
  - `privateAddress=172.31.47.163`
  - `publicIpv4=43.207.102.163`
  - `securityGroupIds=sg-01e33f3412fabfded,sg-01e7f50a205d7b308`
  - `hostFirewallBlocksUdp=false`

## Verification

Local syntax and focused tests:

```bash
node --check scripts/fabric-default-udp-probe.js
node --check scripts/fabric-m6-prerequisite-audit.js
node --check scripts/fabric-m6-promotion-gate.js
node --test \
  test/fabric-default-udp-probe.test.js \
  test/fabric-m6-prerequisite-audit.test.js \
  test/fabric-m6-promotion-gate.test.js \
  test/fabric-transport-prerequisites.test.js \
  test/fabric-transport-promotion-gate.test.js
```

Result: 33/33 pass.

Full suite:

```bash
npm test
```

Result: 2724/2724 pass.

AWS current sync artifact:

```text
1f2042e976672cb551c60d9aadff6ad27b76272af2d1536fbdcd6e03c2761511  source-udp-edge-snapshot.tar.gz
```

AWS remote focused checks:

```bash
node --check scripts/fabric-default-udp-probe.js
node --test \
  test/fabric-default-udp-probe.test.js \
  test/fabric-m6-prerequisite-audit.test.js \
  test/fabric-m6-promotion-gate.test.js \
  test/fabric-transport-prerequisites.test.js \
  test/fabric-transport-promotion-gate.test.js
```

Result: 33/33 pass.

## Verdict

The product gate now records enough edge context to distinguish host-level
blocking from cloud-edge/public-path blocking:

- AWS host firewall does not show a UDP `9527` block.
- AWS instance route/interface/public IP/security-group IDs are captured in the
  same probe report.
- Packet capture still shows zero UDP packets arriving at `enp39s0`.
- Therefore the current self-hosted TURN/default UDP blocker remains outside
  the AIH Node.js process and outside the instance-local firewall. The next
  actionable layer is AWS security group/NACL/provider UDP path, or a separate
  controlled TURN endpoint with reachable UDP/TCP/TLS relay ports.
