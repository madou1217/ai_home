# 2026-06-28 M6 WebRTC Cross-Machine Smoke

## Scope

验证 M6 11.2：至少一端为第二台真实机器参与同一 AWS signaling room。

- AWS current 默认 `9527` 只作为 Fabric WebRTC signaling endpoint。
- 本机 macOS Chrome 作为 offerer。
- AWS EC2 Ubuntu headless Chromium 作为 answerer。
- 两端通过同一个 AWS signaling room 交换 offer/answer/candidates。
- DataChannel 必须 open，并由本机 offerer 完成 5 次应用层 ping/pong RTT。

本轮不使用 mock peer，不新增产品端口，不触碰旧 `152/155/39.104` 服务器。本轮仍不把 WebRTC 设为默认 transport；TURN 和 WebTransport/QUIC 仍是后续 gate。

## Environment

| item | value |
|---|---|
| Date | 2026-06-28 |
| Local cwd | `/Users/model/projects/feature/ai_home` |
| AWS host | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` |
| AWS project | `/home/ubuntu/aih-fabric-current` |
| AWS endpoint | `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527` |
| Page URL | `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/ui/fabric/webrtc-lab` |
| Local browser | Chromium via system Chrome channel |
| AWS browser | Playwright bundled Chromium headless shell |
| ICE server | `stun:stun.l.google.com:19302` |
| Room diagnostics | `/tmp/aih-m6-cross-room.json` |
| Local offerer diagnostics | `/tmp/aih-m6-cross-local-offerer.json` |
| AWS answerer diagnostics | `/tmp/aih-m6-cross-aws-answerer.json` |

## AWS Runtime Preparation

Initial real run failed before WebRTC negotiation because AWS could not launch Chromium:

```text
error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file
```

AWS already had project-local Node:

```bash
export PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:/home/ubuntu/aih-fabric-current/node_modules/.bin:$PATH
node -v
npm -v
```

Result:

```text
node=v22.16.0
npm=10.9.2
```

Playwright browser/runtime was installed on AWS for this real browser gate:

```bash
npx --yes playwright --version
npx --yes playwright install chromium
npx --yes playwright install-deps chromium --dry-run
npx --yes playwright install-deps chromium
```

Observed install scope:

- Playwright version: `1.61.1`.
- Chromium downloaded to `/home/ubuntu/.cache/ms-playwright/chromium-1228`.
- Chromium headless shell downloaded to `/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-1228`.
- `install-deps chromium --dry-run` reported 73 missing system dependencies.
- Actual dependency install added 73 packages, downloaded `50.8 MB`, and used about `160 MB` additional disk.

## Commands

Focused regression:

```bash
node --check scripts/fabric-real-webrtc-datachannel-smoke.js
node --test test/fabric-real-webrtc-datachannel-smoke.test.js
```

Copy current smoke script to AWS test path:

```bash
scp -i "$HOME/.ssh/aws.pem" \
  scripts/fabric-real-webrtc-datachannel-smoke.js \
  ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:/tmp/fabric-real-webrtc-datachannel-smoke.js
```

Create a real AWS signaling room:

```bash
node scripts/fabric-real-webrtc-datachannel-smoke.js \
  --create-room-only \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --diagnostics-file /tmp/aih-m6-cross-room.json
```

Start AWS answerer:

```bash
ssh -i "$HOME/.ssh/aws.pem" ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com '
  export PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:/home/ubuntu/aih-fabric-current/node_modules/.bin:$PATH
  cd /home/ubuntu/aih-fabric-current
  node /tmp/fabric-real-webrtc-datachannel-smoke.js \
    --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
    --page-url "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/ui/fabric/webrtc-lab" \
    --room-id "rtc_zdGfUBArAYBmN0b0" \
    --peer-role answerer \
    --peer-id "aws-answerer-m6-112" \
    --browser-channel bundled \
    --timeout-ms 70000 \
    --sample-count 5 \
    --diagnostics-file "/tmp/aih-m6-cross-aws-answerer.json"
'
```

Start local offerer:

```bash
node scripts/fabric-real-webrtc-datachannel-smoke.js \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --page-url "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/ui/fabric/webrtc-lab" \
  --room-id "rtc_zdGfUBArAYBmN0b0" \
  --peer-role offerer \
  --peer-id "local-offerer-m6-112" \
  --timeout-ms 70000 \
  --sample-count 5 \
  --diagnostics-file "/tmp/aih-m6-cross-local-offerer.json"
```

## Metrics

| metric | value | note |
|---|---:|---|
| Script syntax | pass | `node --check` |
| Focused regression | 8/8 pass | single-peer parser/report coverage |
| Signaling room | `rtc_zdGfUBArAYBmN0b0` | AWS current `9527` |
| Signaling messages | 8 | ready, offer, answer, candidates |
| Local offerer result | pass | `ok=true` |
| AWS answerer result | pass | `ok=true` |
| Local offerer channel opened | true | DataChannel opened |
| AWS answerer channel opened | true | DataChannel opened |
| Local offerer ICE state | connected | selected pair succeeded |
| AWS answerer ICE state | connected | selected pair succeeded |
| Local candidates | host=2, srflx=1 | local side |
| AWS candidates | host=1, srflx=1 | remote machine side |
| Selected candidate pair | srflx -> srflx | both peers |
| RTT samples | 5 | app-level ping/pong |
| RTT avg | 129.06 ms | local offerer measured |
| RTT p50 | 103.6 ms | local offerer measured |
| RTT p95 | 232.1 ms | local offerer measured |
| Browser console | 0 errors / 0 warnings | both sides pageErrors empty |

## Result Summary

```json
{
  "ok": true,
  "roomId": "rtc_zdGfUBArAYBmN0b0",
  "offerer": {
    "role": "offerer",
    "browser": {
      "engine": "chromium",
      "channel": "chrome",
      "headed": false,
      "durationMs": 5056
    },
    "channelOpened": true,
    "connectionState": "connected",
    "iceConnectionState": "connected",
    "localCandidateKinds": {
      "host": 2,
      "srflx": 1
    },
    "remoteCandidateKinds": {
      "host": 1,
      "srflx": 1
    },
    "selectedCandidatePair": {
      "state": "succeeded",
      "nominated": true,
      "localCandidateType": "srflx",
      "remoteCandidateType": "srflx",
      "currentRoundTripTime": 0.109
    },
    "rtt": {
      "count": 5,
      "avg": 129.06,
      "p50": 103.6,
      "p95": 232.1,
      "min": 101.6,
      "max": 232.1
    }
  },
  "answerer": {
    "role": "answerer",
    "browser": {
      "engine": "chromium",
      "channel": "bundled",
      "headed": false,
      "durationMs": 15128
    },
    "channelOpened": true,
    "connectionState": "connected",
    "iceConnectionState": "connected",
    "localCandidateKinds": {
      "host": 1,
      "srflx": 1
    },
    "remoteCandidateKinds": {
      "host": 2,
      "srflx": 1
    },
    "selectedCandidatePair": {
      "state": "succeeded",
      "nominated": true,
      "localCandidateType": "srflx",
      "remoteCandidateType": "srflx",
      "currentRoundTripTime": 0.105
    },
    "pingsHandled": 5
  }
}
```

## Interpretation

- WebRTC 现在不仅通过了同机双 browser page gate，也通过了本机 macOS 与 AWS Ubuntu 两台真实机器之间的 DataChannel gate。
- 本轮证明 AWS `9527` signaling room 可以协调跨机器 offer/answer/candidate exchange，且 STUN 下可形成 `srflx -> srflx` selected pair。
- 初始失败暴露了 AWS runtime 缺少浏览器系统依赖；完成依赖安装后同一 smoke 通过，说明失败根因不是 signaling API 或脚本逻辑。
- 这仍不是默认 transport promotion：TURN relay candidate、受控失败诊断和 WebTransport/QUIC 尚未完成；fallback decision gate 仍保护默认远程开发路径。

## Verdict

pass

M6 11.2 cross-machine WebRTC DataChannel gate completed with real local + AWS browser peers.

## Next Checks

1. M6 11.3: 配置受控 TURN，证明 relay candidate 可用或给出明确失败原因。
2. M6 11.4: WebTransport/QUIC smoke，记录 connect time、stream RTT 和 fallback reason。
3. Promotion 前复跑 fallback gate，确认 WebRTC/WebTransport 失败不会阻塞 WSS/broker remote development。
