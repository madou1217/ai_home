# 2026-06-29 M6 UDP packet arrival diagnosis

## Scope

Deepen the TURN/default-port blocker from a plain UDP echo timeout into packet
arrival evidence at the AWS instance boundary.

This is a real local-client to AWS current test. It does not add ports, does
not modify AWS security groups, does not install TURN/QUIC software, and does
not touch legacy VPS targets.

## Code paths

- `scripts/fabric-default-udp-probe.js`
- `scripts/fabric-m6-prerequisite-audit.js`
- `scripts/fabric-m6-promotion-gate.js`
- `test/fabric-default-udp-probe.test.js`

## Manual packet capture check

AWS target:

```text
ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com
remote dir: /home/ubuntu/aih-fabric-current
public IPv4: 43.207.102.163
private interface: enp39s0 / 172.31.47.163
```

AWS capture command:

```bash
sudo timeout 15 tcpdump -U -i enp39s0 -nn -w /tmp/aih-udp9527.pcap "udp and port 9527"
```

Local sender:

```bash
node -e "const d=require('node:dgram');const s=d.createSocket('udp4');let n=0;const host='43.207.102.163';const port=9527;const t=setInterval(()=>{n+=1;s.send(Buffer.from('aih-udp-pcap-'+n),port,host);if(n>=20){clearInterval(t);setTimeout(()=>s.close(),1000)}},200);"
```

Result:

```text
0 packets captured
0 packets received by filter
0 packets dropped by kernel
```

Interpretation: local UDP datagrams to AWS public UDP `9527` did not arrive at
the instance network interface.

## Productized probe output

The shared default UDP probe now starts a best-effort remote packet capture
while the existing local UDP echo probe is running. Both `prerequisites` and
`promotion-gate` inherit this evidence because they use the same probe module.

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
- remote UDP echo: `ready=true`, `port=9527`
- local UDP echo: `ok=false`, `error=udp_echo_timeout`, `sent=13`, `durationMs=5003`
- packet capture:
  - `ready=true`
  - `available=true`
  - `captured=false`
  - `interface=enp39s0`
  - `status=124`
  - `packets=[]`
  - stderr includes:

```text
listening on enp39s0, link-type EN10MB (Ethernet), snapshot length 262144 bytes
0 packets captured
0 packets received by filter
0 packets dropped by kernel
```

Summary remains:

```text
baseReady=true
promotionReady=false
readyTransports=[]
blockers=turn:turn_ice_server_not_configured,turn:turn_default_udp_9527_unreachable
```

Promotion gate check:

```bash
node bin/ai-home.js fabric transport promotion-gate \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --skip-webtransport \
  --skip-multipath \
  --skip-webrtc \
  --json
```

Result:

- relay fallback: `20/20` echo, p95 `105ms`, blockers `[]`
- packet capture also reports `captured=false` on `enp39s0`
- summary keeps `defaultTransport=relay`, `fallbackReady=true`,
  `promotionReady=false`

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

Result: 30/30 pass.

Full suite:

```bash
npm test
```

Result: 2721/2721 pass.

AWS current sync artifact:

```text
81ba89030e92d41d298ec7d92717b30a7b7eb3ba29d35890b33c2f0899146eb0  source-udp-packet-capture.tar.gz
```

AWS remote focused checks:

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

Result: 30/30 pass.

## Verdict

The UDP blocker is now more precise:

- AWS current can start a temporary UDP echo listener on port `9527`.
- AWS current can run tcpdump on the real private interface `enp39s0`.
- Local datagrams to public UDP `9527` do not arrive at the instance interface.
- The current TURN/default UDP blocker is therefore outside the AIH Node.js
  process and inside the public cloud/network edge path, such as security group,
  NACL, provider firewall, or upstream UDP filtering.

M6 remains partial. Relay remains the measured default transport until the
external network path for TURN/WebTransport/Multipath is supplied and the same
gates return `promotionReady=true`.
