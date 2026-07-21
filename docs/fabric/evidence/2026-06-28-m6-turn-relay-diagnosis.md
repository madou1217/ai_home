# 2026-06-28 M6 TURN Relay Diagnosis

## Scope

验证 M6 11.3：WebRTC TURN relay candidate 和失败诊断。

本轮目标不是把 WebRTC 设为默认 transport，而是确认当前环境是否已经具备可用 TURN relay：

- 不新增 AIH 产品端口；AIH server 仍只使用默认 TCP `9527`。
- 不触碰旧 `152/155/39.104` 服务器。
- 优先检查 AWS current 是否能在默认端口约束下承载自有 TURN。
- 追加 public TURN relay-only smoke，用真实浏览器 `icecandidateerror` 记录失败原因。

## Environment

| item | value |
|---|---|
| Date | 2026-06-28 |
| Local cwd | `/Users/model/projects/feature/ai_home` |
| AWS host | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` |
| AWS endpoint | `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527` |
| Signaling room | `rtc_Q6OwwrTCkW0OvGci` for domain test, `rtc_c11QtxdZNA7qOFSp` for IP test |
| Local browser | Chromium via system Chrome channel |
| AWS browser | Playwright bundled Chromium headless shell |
| Public TURN reference | `https://www.metered.ca/tools/openrelay/` |
| Public TURN tested | `turn:openrelay.metered.ca:80`, `turn:openrelay.metered.ca:443`, `turn:openrelay.metered.ca:443?transport=tcp` |
| Public TURN IP tested | `turn:15.235.47.158:80`, `turn:15.235.47.158:443`, `turn:15.235.47.158:443?transport=tcp` |

## Script Changes

`scripts/fabric-real-webrtc-datachannel-smoke.js` was extended with:

- `--ice-username` / `--ice-credential` for TURN credentials.
- `--ice-transport-policy all|relay` to force relay-only gathering.
- `icecandidateerror` collection inside browser diagnostics.
- Redacted `iceServerAuth` in reports so credentials do not leak into evidence.

Existing default STUN and two-peer smoke behavior is unchanged.

## Controlled TURN Constraint Check

The current product constraint is no new product port. AIH uses TCP `9527`; a TURN server cannot share that same TCP listener with the current Node HTTP server. UDP `9527` was tested separately because it has the same port number and does not conflict with TCP `9527`.

AWS UDP echo was started on UDP `9527`:

```bash
ssh -i "$HOME/.ssh/aws.pem" ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com '
  export PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:$PATH
  node -e "const d=require(\"node:dgram\");const s=d.createSocket(\"udp4\");s.on(\"message\",(m,r)=>s.send(Buffer.from(\"aih-udp-9527-ok\"),r.port,r.address));s.bind(9527,\"0.0.0.0\",()=>console.log(\"udp-9527-ready\"));setTimeout(()=>process.exit(0),20000);"
'
```

Local UDP probe:

```bash
node -e "const d=require('node:dgram');const s=d.createSocket('udp4');const host='ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com';s.on('message',(m)=>{console.log('udp-reply', String(m)); s.close();});s.send(Buffer.from('aih-udp-9527-probe'),9527,host);setTimeout(()=>{console.log('udp-timeout');s.close();process.exitCode=1;},5000);"
```

Result:

```text
remote: udp-9527-ready
local: udp-timeout
```

Interpretation:

- AWS process can bind UDP `9527`.
- Local -> AWS UDP `9527` does not return traffic in the current network/security-group path.
- A controlled TURN server on AWS cannot be accepted under the current no-new-port constraint without opening a reachable UDP/TCP TURN listener and relay range, or introducing an explicit TURN-over-TLS/TCP service endpoint.

## Public TURN Relay-Only Smoke

Public TURN is not a controlled AIH TURN service. It was tested only to prove the smoke harness and browser diagnostics can force relay-only mode and report failures.

Metered OpenRelay currently documents that Open Relay runs on ports 80 and 443 and that current TURN usage should fetch `iceServers` from their REST API after account signup. Static-auth documentation is for services that support shared-secret auth; it is not equivalent to a browser `username`/`credential` pair.

### Domain-Based TURN URLs

Create signaling room:

```bash
node scripts/fabric-real-webrtc-datachannel-smoke.js \
  --create-room-only \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --diagnostics-file /tmp/aih-m6-turn-room.json
```

Run both peers with:

```bash
--no-default-stun \
--ice-server "turn:openrelay.metered.ca:80" \
--ice-server "turn:openrelay.metered.ca:443" \
--ice-server "turn:openrelay.metered.ca:443?transport=tcp" \
--ice-username "openrelayproject" \
--ice-credential "openrelayproject" \
--ice-transport-policy relay
```

Local DNS probe:

```bash
node -e "const dns=require('node:dns').promises; dns.lookup('openrelay.metered.ca',{all:true}).then(r=>console.log(JSON.stringify(r)))"
```

Result:

```json
[{"address":"198.18.0.4","family":4}]
```

AWS DNS probe:

```json
[{"address":"15.235.47.158","family":4},{"address":"2607:5300:205:300::a1","family":6}]
```

Result summary:

| peer | ok | local candidates | remote candidates | channel | key errors |
|---|---:|---:|---:|---|---|
| local offerer | false | 0 | 0 | not opened | host lookup errors, TURN allocate timeout, TCP failed |
| AWS answerer | false | 0 | 0 | not opened | TURN allocate timeout, TCP failed |

The local DNS result `198.18.0.4` is not a public TURN endpoint; it is a reserved benchmark/private-use range. This makes the domain-based public TURN test unsuitable from the current local network.

### Direct Public IP TURN URLs

To exclude local DNS distortion, the same relay-only smoke was repeated against AWS-resolved IPv4 `15.235.47.158`.

Run both peers with:

```bash
--no-default-stun \
--ice-server "turn:15.235.47.158:80" \
--ice-server "turn:15.235.47.158:443" \
--ice-server "turn:15.235.47.158:443?transport=tcp" \
--ice-username "openrelayproject" \
--ice-credential "openrelayproject" \
--ice-transport-policy relay
```

Result summary:

| peer | ok | local candidates | remote candidates | channel | key errors |
|---|---:|---:|---:|---|---|
| local offerer | false | 0 | 0 | not opened | STUN binding timeout, TURN allocate timeout, TCP failed |
| AWS answerer | false | 0 | 0 | not opened | STUN binding timeout, TURN allocate timeout, TCP failed |

Representative browser errors:

```json
[
  {
    "url": "turn:15.235.47.158:443?transport=tcp",
    "errorCode": 701,
    "errorText": "Failed to establish connection"
  },
  {
    "url": "turn:15.235.47.158:80?transport=udp",
    "errorCode": 701,
    "errorText": "TURN allocate request timed out."
  },
  {
    "url": "turn:15.235.47.158:443?transport=udp",
    "errorCode": 701,
    "errorText": "TURN allocate request timed out."
  }
]
```

## Metrics

| metric | value |
|---|---:|
| Script syntax | pass |
| Focused regression | 8/8 pass |
| AWS UDP `9527` process bind | pass |
| Local -> AWS UDP `9527` echo | fail, timeout |
| Domain public TURN relay candidates | 0 |
| Direct IP public TURN relay candidates | 0 |
| Relay-only DataChannel open | false |
| Browser console errors | 0 |
| Browser ICE candidate errors | captured |

## Interpretation

- The code path now supports TURN credentials, relay-only policy, and browser-level ICE error evidence.
- Current AWS cannot host a controlled TURN service within the existing default TCP `9527` product listener; UDP `9527` is not reachable from local, and TURN normally also needs relay allocation ports.
- Public OpenRelay did not produce relay candidates from this environment. The domain path is additionally invalidated by local DNS resolving to `198.18.0.4`; the direct-IP path still times out or fails TCP establishment.
- Therefore M6 11.3 has a real diagnosis but not a relay candidate pass.

## Verdict

diagnostic-pass / relay-fail

Do not promote WebRTC to default transport. Keep WSS/broker relay as the default path.

## Next Checks

1. Provision a controlled TURN service with a reachable UDP/TCP listener and relay range, or explicitly approve a TURN endpoint/port exception.
2. If using Metered/OpenRelay, fetch current REST API `iceServers` with a real API key instead of assuming static browser username/password credentials.
3. Rerun relay-only smoke and require at least one `relay` candidate plus DataChannel open before marking TURN gate as pass.
