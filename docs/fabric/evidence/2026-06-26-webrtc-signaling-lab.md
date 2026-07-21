# 2026-06-26 WebRTC Signaling Lab

## Scope

验证 M1 Transport Lab 的 WebRTC 第一刀：

- Fabric server 提供短期 signaling room。
- Web UI 提供 `/ui/fabric/webrtc-lab`。
- Offerer 可以创建 room、发送 offer/candidate。
- Answerer 通过分享 URL 自动启动并发送 ready/answer/candidate。
- 页面展示 connection、ICE、ICE gathering、signaling、candidate、signal 和 RTT 诊断字段。

本轮不把 WebRTC DataChannel 设为生产默认 transport，不证明 NAT 穿透、跨机器、手机或 TURN 场景成功。

## Environment

- Date: 2026-06-26
- Server: isolated smoke server
- Endpoint: `http://127.0.0.1:52060`
- Browser automation: Playwright CLI Chromium session `fabric-webrtc-smoke`
- Build artifact: `web/dist/assets/FabricWebrtcLab-_U10LEZ_.js`

## Commands

Focused tests:

```bash
node --test test/fabric-webrtc-signaling.test.js test/server-node-rpc-wiring.test.js
node --test test/control-plane-device-pairing.test.js test/control-plane-profiles.test.js test/fabric-profile-gate.test.js
npm run web:build
```

Temporary smoke server:

```bash
node scripts/fabric-browser-pairing-smoke-server.js
```

Playwright browser flow:

```text
Open SMOKE_WEB_PAIR_URL.
Confirm Server Setup shows 1 ready / 1 profiles / 0 sessions.
Open /ui/fabric/webrtc-lab.
Click create room as offerer.
Open share URL in a second tab as answerer.
Wait for offer/answer/candidate exchange.
Check browser console warnings/errors.
Run same-page RTCPeerConnection self-check.
```

API signaling smoke:

```text
POST /v0/fabric/webrtc/signaling/rooms
POST /v0/fabric/webrtc/signaling/rooms/<room>/messages offer
POST /v0/fabric/webrtc/signaling/rooms/<room>/messages answer
POST /v0/fabric/webrtc/signaling/rooms/<room>/messages candidate
GET  /v0/fabric/webrtc/signaling/rooms/<room>/messages?since=0&limit=100
GET  /v0/fabric/webrtc/signaling/rooms/<room>/messages?since=1&limit=100
```

## Metrics

| metric | value | note |
|---|---:|---|
| WebRTC signaling store tests | pass | 2/2 pass |
| Server wiring tests | pass | total focused run 7/7 pass |
| Profile gate tests | pass | 31/31 pass |
| Web build | pass | existing Vite chunk warning only |
| Browser Server Setup pairing | pass | `1 ready`, `1 profiles`, `0 会话` |
| API signaling room | pass | room `rtc_IQy52xU-I-I3MlVr` |
| API message seq | pass | seq `1,2,3` |
| API incremental fetch | pass | `since=1` returned `answer,candidate` |
| Browser lab room | partial | room `rtc_JJe2HhTzMmi3Lpo-` |
| Browser room messages | pass | `offer,candidate,candidate,ready,answer,candidate,candidate` |
| Offerer signals observed | pass | 4 remote signals |
| Answerer signals observed | pass | 3 remote signals |
| Browser console warnings/errors | pass | 0 |
| DataChannel open | fail in this environment | channel did not open |
| Same-page RTCPeerConnection self-check | fail in this environment | stayed `connecting/checking` |

## Browser Result Shape

Offerer after answerer joined:

```json
{
  "channel": "connecting",
  "connection": "failed",
  "ice": "disconnected",
  "gathering": "complete",
  "signaling": "stable",
  "localCandidates": 2,
  "remoteCandidates": 2,
  "signals": 4,
  "rttSamples": 0
}
```

Answerer after auto-start from share URL:

```json
{
  "channel": "closed",
  "connection": "failed",
  "ice": "disconnected",
  "gathering": "complete",
  "signaling": "stable",
  "localCandidates": 2,
  "remoteCandidates": 2,
  "signals": 3,
  "events": ["offer received", "answer sent"]
}
```

Room messages:

```json
[
  { "seq": 1, "type": "offer" },
  { "seq": 2, "type": "candidate" },
  { "seq": 3, "type": "candidate" },
  { "seq": 4, "type": "ready" },
  { "seq": 5, "type": "answer" },
  { "seq": 6, "type": "candidate" },
  { "seq": 7, "type": "candidate" }
]
```

Same-page browser self-check:

```json
{
  "opened": false,
  "aConnection": "connecting",
  "bConnection": "connecting",
  "aIce": "checking",
  "bIce": "checking",
  "aGathering": "complete",
  "bGathering": "complete"
}
```

## Implementation Notes

- Frontend worker fixed polling re-entry with single-flight.
- Signal consumption is idempotent by `seq`.
- Answerer share URL with `room&role=answerer` now auto-starts the answerer side.
- Offer/answer handling checks `signalingState` before SDP mutation.
- Main thread added per-signal error logging and exposed `signalingState` in the lab UI.

## Interpretation

The Fabric signaling API and browser lab state machine are usable as a lab candidate. The room exchange proves offer/answer/candidate delivery and the UI no longer hits the duplicate `setLocalDescription(answer)` state error seen before the frontend worker patch.

This does not prove WebRTC DataChannel transport is viable yet. In this automated Chromium environment, even a same-page minimal `RTCPeerConnection` self-check did not open a DataChannel and stayed in `connecting/checking`. Treat DataChannel as unpromoted until a headed browser, phone, cross-machine, STUN/TURN, or real NAT test produces RTT samples.

## Verdict

partial

## Next Checks

1. Run the same lab in headed Chrome/Safari, not only the Playwright automation browser.
2. Test phone <-> local server over LAN with a non-loopback endpoint.
3. Test home <-> company with at least one STUN server and one controlled TURN candidate.
4. Record 5 RTT samples only after `channelState=open`; otherwise keep verdict `partial` or `fail`.
5. Add fallback decision logic: WebRTC candidate failure must fall back to WSS without blocking remote session startup.
