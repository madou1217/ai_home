# 2026-06-28 M6 WebRTC Diagnostics Surface

## Scope

继续推进 M6 Transport Promotion 的产品闭环：

- 把当前 WebRTC DataChannel 页面从 lab 语义收敛为正式的 transport candidate diagnostics。
- Server Setup 不再展示 WebRTC Lab 入口，避免 first-run 配置流程误导用户。
- WebRTC 仍只是 candidate，不提升为默认 transport。
- 真实部署到 AWS current 默认 `9527`，并用真实浏览器和 DataChannel smoke 验证。

## Code Changes

- Route: `/ui/fabric/webrtc-diagnostics`.
- Component: `FabricWebrtcDiagnostics`.
- Removed the old Server Setup link text `打开 WebRTC DataChannel Lab`.
- WebRTC smoke default page path moved to `/ui/fabric/webrtc-diagnostics`.
- Current product code search no longer finds `webrtc-lab`, `WebrtcLab`, `WebRTC DataChannel Lab`, `WebRTC DataChannel 实验`, `AIH Fabric WebRTC Lab`, `webrtc_lab`, `fabric-webrtc-lab`, `LabRole`, or `aih-fabric-lab`.

## Local Validation

```bash
rg -n "webrtc-lab|WebrtcLab|WebRTC DataChannel Lab|WebRTC DataChannel 实验|AIH Fabric WebRTC Lab|webrtc_lab|fabric-webrtc-lab|LabRole|aih-fabric-lab" \
  web/src web/config scripts test

node --check scripts/fabric-real-webrtc-datachannel-smoke.js

node --test \
  test/fabric-profile-gate.test.js \
  test/fabric-real-webrtc-datachannel-smoke.test.js

npm --prefix web run build
```

Result:

- Old lab term search: no matches in current product code, scripts, or tests.
- Script syntax: pass.
- Focused tests: 11/11 pass.
- Local Web build: pass, produced `p__FabricWebrtcDiagnostics.b5221458.async.js`.

## AWS Deployment

Source was deployed from committed `HEAD`, not from the dirty worktree.

```bash
git archive --format=tar.gz -o /tmp/aih-fabric-head-d2f4397.tar.gz HEAD
shasum -a 256 /tmp/aih-fabric-head-d2f4397.tar.gz
```

Archive:

```text
7826575c0652f0c7bad4cbc0af8132f000e222772fdc4718f711c19a49b035e8  /tmp/aih-fabric-head-d2f4397.tar.gz
```

AWS source readback after extract:

```text
7826575c0652f0c7bad4cbc0af8132f000e222772fdc4718f711c19a49b035e8  source-d2f4397.tar.gz
web/config/routes.ts:70:        path: "/fabric/webrtc-diagnostics",
web/src/pages/FabricWebrtcDiagnostics.tsx:126:    ? `${window.location.origin}/ui/fabric/webrtc-diagnostics?room=${encodeURIComponent(roomId)}&role=answerer`
scripts/fabric-real-webrtc-datachannel-smoke.js:9:const DEFAULT_PAGE_PATH = '/ui/fabric/webrtc-diagnostics';
```

Remote Web build initially failed because AWS `web/node_modules/.bin/max` was missing. This was a real remote dependency-cache gap, not a code failure. It was fixed with:

```bash
cd /home/ubuntu/aih-fabric-current/web
npm install --ignore-scripts --cache /home/ubuntu/.aih-npm-cache
```

Then:

```bash
cd /home/ubuntu/aih-fabric-current
npm run web:build
```

Result:

- AWS Web build: pass.
- AWS dist includes:

```text
p__FabricWebrtcDiagnostics.79f00885.chunk.css
p__FabricWebrtcDiagnostics.ba0a9fb1.async.js
```

Server was restarted on the same default port:

```text
pid=220838
listen: http://0.0.0.0:9527
accounts: codex=0, gemini=0, claude=0, agy=0, opencode=0
management_auth: enabled (Bearer key required)
```

`/readyz`:

```json
{
  "ok": true,
  "service": "aih-server",
  "ready": false,
  "accounts": {
    "codex": 0,
    "gemini": 0,
    "claude": 0,
    "agy": 0,
    "opencode": 0
  }
}
```

Interpretation: AWS remains a control/broker/relay-capable node with no provider runtime accounts. That is expected and unrelated to this diagnostics surface.

## Real Browser Page Check

Browser opened:

```text
http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/ui/fabric/webrtc-diagnostics
```

Result:

```json
{
  "ok": true,
  "hasDiagnosticsTitle": true,
  "hasOldLabText": false,
  "url": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/ui/fabric/webrtc-diagnostics"
}
```

One browser console 404 was observed for an ancillary resource. The route itself returned HTTP 200 and rendered the diagnostics title.

## Real WebRTC DataChannel Smoke After Deploy

Command:

```bash
node scripts/fabric-real-webrtc-datachannel-smoke.js \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --timeout-ms 30000 \
  --diagnostics-file /tmp/aih-m6-webrtc-diagnostics-route-smoke-after-deploy.json
```

Result summary:

```json
{
  "ok": true,
  "pageUrl": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/ui/fabric/webrtc-diagnostics",
  "roomId": "rtc_UBC5Ba6xal_zDHVo",
  "rtt": {
    "count": 5,
    "avg": 602.04,
    "p50": 599.6,
    "p95": 848.1,
    "min": 449.6,
    "max": 848.1
  },
  "offerer": {
    "ok": true,
    "channelOpened": true,
    "connectionState": "connected",
    "iceConnectionState": "connected",
    "localCandidateKinds": {
      "host": 2,
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
      "remoteCandidateType": "srflx"
    }
  },
  "answerer": {
    "ok": true,
    "channelOpened": true,
    "connectionState": "connected",
    "iceConnectionState": "connected"
  }
}
```

The report recorded one console error during channel close, with `channel_open` and 5 RTT samples already completed. It is not a connection failure.

## Residue Check

AWS:

```text
220838 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
```

Local:

```text
no fabric-real-webrtc / fabric-real-webtransport smoke process remained
```

## Verdict

done for M6 diagnostics surface productization.

This does not change M6 transport promotion status:

- WebRTC DataChannel remains a candidate, not the default.
- TURN relay remains `diagnostic-pass / relay-fail`.
- WebTransport remains `diagnostic-pass / webtransport-fail`.
- Default remote RPC/session transport remains WSS/broker relay.
