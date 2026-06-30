# 2026-06-28 WebRTC DataChannel AWS Smoke

## Scope

验证 Transport Promotion 的 WebRTC DataChannel 第一段真实 gate：

- 使用 AWS current 默认 `9527` 作为真实 Fabric WebRTC signaling endpoint。
- 使用真实 headed Chromium/Chrome browser，不使用 mock peer。
- 通过 STUN 采集 srflx candidate。
- 两个真实 browser page peer 完成 offer/answer/candidate exchange。
- DataChannel 必须 open，并完成 5 次应用层 ping/pong RTT。

本轮不把 WebRTC 设为默认 transport，不证明手机、跨家庭/公司网络、TURN relay 或 WebTransport/QUIC。

## Environment

| item | value |
|---|---|
| Date | 2026-06-28 |
| Local cwd | `/Users/model/projects/feature/ai_home` |
| AWS endpoint | `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527` |
| Page URL | `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/ui/fabric/webrtc-lab` |
| Browser | Chromium via system Chrome channel |
| Browser mode | headed |
| ICE server | `stun:stun.l.google.com:19302` |
| Diagnostics | `/tmp/aih-webrtc-datachannel-aws.json` |

## Commands

Focused regression:

```bash
node --check scripts/fabric-real-webrtc-datachannel-smoke.js
node --test \
  test/fabric-real-webrtc-datachannel-smoke.test.js \
  test/fabric-webrtc-signaling.test.js \
  test/server-node-rpc-wiring.test.js
```

Real AWS browser smoke:

```bash
npx --yes --package playwright node scripts/fabric-real-webrtc-datachannel-smoke.js \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --sample-count 5 \
  --timeout-ms 30000 \
  --headed \
  --diagnostics-file /tmp/aih-webrtc-datachannel-aws.json
```

## Metrics

| metric | value | note |
|---|---:|---|
| Script syntax | pass | `node --check` |
| Focused regression | 17/17 pass | smoke parser + signaling/server wiring |
| Real browser smoke | pass | `ok=true` |
| Signaling room | `rtc_ersFsxFB9XRkpmZi` | AWS current `9527` |
| Signaling messages | 9 | offer, ready, answer, candidates |
| Offerer channel opened | true | DataChannel opened |
| Answerer channel opened | true | DataChannel opened |
| Offerer ICE state | connected | selected pair succeeded |
| Answerer ICE state | connected | selected pair succeeded |
| Offerer candidates | host=2, srflx=1 | local and remote |
| Answerer candidates | host=2, srflx=1 | local and remote |
| Selected candidate pair | srflx -> srflx | both peers |
| RTT samples | 5 | app-level ping/pong |
| RTT avg | 463.8 ms | headed Chrome |
| RTT p50 | 400.8 ms | headed Chrome |
| RTT p95 | 646.3 ms | headed Chrome |
| Browser console | 0 errors / 0 warnings | pageErrors empty |

## Result Summary

```json
{
  "ok": true,
  "roomId": "rtc_ersFsxFB9XRkpmZi",
  "browser": {
    "engine": "chromium",
    "channel": "chrome",
    "headed": true,
    "durationMs": 8068
  },
  "iceServers": ["stun:stun.l.google.com:19302"],
  "rtt": {
    "count": 5,
    "avg": 463.8,
    "p50": 400.8,
    "p95": 646.3,
    "min": 312.8,
    "max": 646.3
  },
  "offerer": {
    "channelOpened": true,
    "connection": "connected",
    "ice": "connected",
    "selectedCandidatePair": {
      "state": "succeeded",
      "nominated": true,
      "localCandidateType": "srflx",
      "remoteCandidateType": "srflx"
    }
  },
  "answerer": {
    "channelOpened": true,
    "connection": "connected",
    "ice": "connected",
    "selectedCandidatePair": {
      "state": "succeeded",
      "nominated": true,
      "localCandidateType": "srflx",
      "remoteCandidateType": "srflx"
    }
  },
  "console": {
    "errors": 0,
    "warnings": 0,
    "pageErrors": []
  }
}
```

## Interpretation

- WebRTC is no longer only a signaling-room partial. With STUN configured, AWS current signaling plus real browser peers can reach `ICE connected`, open the DataChannel, and produce RTT samples.
- The previous no-STUN headed browser self-check still reproduced the old failure mode: host-only mDNS candidates stayed in `connecting/checking`. STUN is therefore required for this evidence path.
- This is a transport candidate pass for one real browser/AWS-signaling scenario, not a default transport promotion. The full promotion gate still needs phone/cross-machine evidence, TURN diagnosis, failure fallback proof, and WebTransport/QUIC comparison.

## Verdict

partial-pass

WebRTC DataChannel is verified as an explicit transport candidate on AWS current `9527` with real browser RTT evidence. It is still not the default transport.

## Next Checks

1. Run the same script with a phone/PWA as one peer.
2. Run cross-machine home/company browser peers through the same AWS signaling endpoint.
3. Add controlled TURN credentials and verify relay candidate behavior/failure diagnosis.
4. Add WebTransport/QUIC smoke and compare p95 RTT with WSS echo.
5. Prove WebRTC candidate failure falls back to WSS/broker session startup without blocking remote development.
