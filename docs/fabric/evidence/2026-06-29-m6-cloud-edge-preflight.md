# 2026-06-29 M6 cloud edge preflight

## Scope

Add a formal product CLI for the remaining cloud-edge part of the TURN/default
UDP blocker:

```bash
aih fabric transport cloud-edge
```

The command is read-only. It runs the real default UDP `9527` probe, captures
AWS host/packet evidence, and checks whether the AWS instance itself can use AWS
API credentials to inspect cloud edge policy. It does not add ports, does not
modify security groups or NACLs, does not install TURN/QUIC software, and does
not touch legacy VPS targets.

## Code paths

- `scripts/fabric-cloud-edge-preflight.js`
- `lib/cli/services/fabric/transport-cloud-edge.js`
- `lib/cli/commands/fabric-router.js`
- `test/fabric-cloud-edge-preflight.test.js`
- `test/fabric-transport-cloud-edge.test.js`

## Real AWS cloud-edge run

Command:

```bash
node bin/ai-home.js fabric transport cloud-edge \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --json
```

Result:

- diagnostic command status: `0`
- report: `ok=true`, `exitOk=true`
- `cloudEdgeReady=false`
- UDP:
  - remote echo: `ready=true`, `port=9527`
  - local echo: `ok=false`, `error=udp_echo_timeout`, `sent=13`
  - packet capture: `available=true`, `captured=false`, `interface=enp39s0`
  - tcpdump evidence: `0 packets captured`, `0 packets received by filter`
- edge:
  - interface: `enp39s0`
  - private address: `172.31.47.163`
  - public IPv4: `43.207.102.163`
  - `ufw=inactive`
  - `iptables INPUT ACCEPT`
  - `hostFirewallBlocksUdp=false`
  - security groups: `launch-wizard-1`, `default`
  - security group IDs: `sg-01e33f3412fabfded`, `sg-01e7f50a205d7b308`
- AWS API credential readiness:
  - `awsCli.available=false`
  - `imds.tokenAvailable=true`
  - `imds.iamRoleAvailable=false`
  - `imds.iamRoleProbeHttpStatus=404`
  - `awsApiCredentialsReady=false`
- blockers:
  - `turn_default_udp_9527_unreachable`
  - `aws_public_udp_path_blocked`
  - `aws_cli_missing`
  - `aws_iam_role_missing`

Strict command:

```bash
node bin/ai-home.js fabric transport cloud-edge \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --fail-on-blocked \
  --json
```

Result:

- process status: `1`
- report remains `ok=true`
- `exitOk=false`
- same real blockers as above

## Verification

Local syntax and focused tests:

```bash
node --check scripts/fabric-cloud-edge-preflight.js
node --check lib/cli/services/fabric/transport-cloud-edge.js
node --check lib/cli/commands/fabric-router.js
node --test \
  test/fabric-cloud-edge-preflight.test.js \
  test/fabric-transport-cloud-edge.test.js \
  test/fabric-default-udp-probe.test.js \
  test/fabric-transport-prerequisites.test.js \
  test/fabric-transport-promotion-gate.test.js
```

Result: 18/18 pass.

Full local suite:

```bash
npm test
```

Result: 2731/2731 pass.

AWS current sync artifact:

```text
c5b216d5445160e611c28f3a344ab3cac0a10fa805fd047de91c6d9b7a581f4e  source-cloud-edge-preflight.tar.gz
```

AWS remote focused checks:

```bash
node --check scripts/fabric-cloud-edge-preflight.js
node --check lib/cli/services/fabric/transport-cloud-edge.js
node --check lib/cli/commands/fabric-router.js
node --test \
  test/fabric-cloud-edge-preflight.test.js \
  test/fabric-transport-cloud-edge.test.js \
  test/fabric-default-udp-probe.test.js \
  test/fabric-transport-prerequisites.test.js \
  test/fabric-transport-promotion-gate.test.js
```

Result: 18/18 pass.

## Verdict

The remaining default UDP blocker is now a formal product diagnostic rather than
a manual interpretation:

- The instance-local host firewall does not appear to block UDP `9527`.
- Public UDP `9527` packets still do not arrive at `enp39s0`.
- The AWS instance cannot inspect or mutate its own cloud edge policy because
  it has no AWS CLI and no EC2 IAM role (`iam/security-credentials/` is HTTP
  `404`).
- The next required external action is cloud-edge policy work: verify or change
  Security Group/NACL/provider UDP path for `sg-01e33f3412fabfded` and
  `sg-01e7f50a205d7b308`, or provide a controlled TURN endpoint with reachable
  relay ports.

M6 remains partial until one real advanced transport path returns
`promotionReady=true`. Relay remains the measured default transport.
