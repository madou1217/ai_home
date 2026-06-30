# 2026-06-29 M6 WebRTC supervised service closure

## Scope

- Target: AWS current only, `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- Remote dir: `/home/ubuntu/aih-fabric-current`
- Product port: default `9527` only
- Node id: `aws-current-node`
- Clean deployed HEAD: `e3dcad690067`
- Artifact sha256: `b4a62960022de64488ffd79c76be190db1f32231dad1cca947d2c1519d665b50`

## Changes

- `aih node webrtc service install/status/uninstall` added as the WebRTC connector service manager.
- `aih node service install/status/uninstall` now supervises relay, Fabric registry agent, and WebRTC connector.
- `scripts/fabric-m3-daemon-preflight.js` now gates on WebRTC service running and fails duplicate supervised connector processes.
- WebRTC connector now refreshes stale-open DataChannel sessions on the heartbeat window, so a restarted Control Plane does not leave the client stuck on a dead adapter session.

## Local verification

- `npm test`: `2759/2759 pass`
- Focused WebRTC client/service/status tests after stale-session fix:
  - Command: `node --test test/node-webrtc-client.test.js test/webrtc-management-adapter.test.js test/node-webrtc-service.test.js test/fabric-transport-readiness.test.js test/fabric-transport-status.test.js`
  - Result: `18/18 pass`

## AWS deployment verification

- Uploaded and extracted clean artifact from `e3dcad690067` to `/home/ubuntu/aih-fabric-current`.
- Remote focused tests:
  - Command: `node --test test/node-webrtc-client.test.js test/node-webrtc-service.test.js test/webrtc-management-adapter.test.js test/fabric-m3-daemon-preflight.test.js test/fabric-transport-readiness.test.js test/fabric-transport-status.test.js`
  - Result: `35/35 pass`
- Installed real user systemd services through the product command:
  - `node service install http://127.0.0.1:9527 --node-id aws-current-node ... --yes --json`
  - Result: relay, registry agent, and WebRTC connector all `state=running`, supervisor `ready=true`.

## Real runtime evidence

- Local active server profile:
  - API: `GET /v0/webui/control-plane/profiles`
  - Result: `activeProfileId=cp-51hq70`, endpoint `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`, `authState=paired`.
- Fabric nodes readback:
  - Command: `node bin/ai-home.js fabric nodes aws-current-node --json`
  - Result: `aws-current-node` online, project `/home/ubuntu/aih-fabric-current`, transports `relay,webrtc`, local SSH binding `AWS Current Japan`.
- Transport readiness:
  - Command: `node bin/ai-home.js fabric transport readiness --node-id aws-current-node --json`
  - Result: `defaultTransport=webrtc`, `fallbackReady=true`, `relayMeasurementPass=true`, `promotedTransports=["webrtc"]`.
- Transport status:
  - Command: `node bin/ai-home.js fabric transport status --node-id aws-current-node --json`
  - Result: `status=complete`, `remoteDevelopmentReady=true`, `defaultTransport=webrtc`, `advancedPromotionReady=true`, `nextActions=[]`.
- Preflight after server restart:
  - Command: `node scripts/fabric-m3-daemon-preflight.js --json`
  - Result: `ok=true`, `supervisorReady=true`, `remainingGate=[]`, `duplicateSupervisedProcesses=[]`, exactly one server process and one supervised relay/registry/WebRTC connector each.

## Restart recovery

1. Restarted AWS server on the same default port `9527`.
2. Confirmed process became `node bin/ai-home.js server serve --host 0.0.0.0 --port 9527`.
3. Waited one WebRTC refresh window.
4. Re-ran readiness/status/preflight.

Final result:

- `fabric transport readiness`: `defaultTransport=webrtc`
- `fabric transport status`: `status=complete`, `remoteDevelopmentReady=true`
- `fabric-m3-daemon-preflight`: `remainingGate=[]`, `duplicateSupervisedProcesses=[]`

## Remaining blockers

- AWS node is currently a project/relay/WebRTC-capable node, but not a runtime host for provider sessions.
- Runtime gaps remain account-side only:
  - `missing_provider_account:codex`
  - `missing_provider_account:claude`
  - `missing_provider_account:agy`
  - `missing_provider_account:opencode`
- External advanced transport blockers remain outside this closure:
  - controlled TURN credentials/UDP path
  - HTTPS/H3 WebTransport endpoint
  - OpenMPTCPRouter/MPTCP underlay
  - AWS SG/NACL/IAM readback for public UDP diagnosis
