# M6 Transport Readiness Client Smoke

Date: 2026-06-28

## Objective

Prove the real local client path for AWS transport readiness:

- Read the paired AWS server profile from local `control-plane-profiles.json`.
- Use the stored device token to call AWS current default `9527`.
- Verify unauthenticated access is rejected.
- Verify authorized readiness for `aws-current-node` returns relay fallback readiness.

This smoke does not read the AWS token over SSH, import provider credentials, create mock data, open a new product port, or touch retired VPS targets.

## New Entrypoint

Product CLI:

```bash
aih fabric transport readiness --json
```

Script smoke:

```bash
node scripts/fabric-real-transport-readiness-client-smoke.js --help
```

Default target:

```text
endpoint: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
nodeId: aws-current-node
purpose: runtime
aiHomeDir: resolved host ~/.ai_home
```

## Focused Test

Command:

```bash
node --test test/fabric-real-transport-readiness-client-smoke.test.js
```

Result:

```text
tests 5
pass 5
fail 0
duration_ms 51.082875
```

Covered behavior:

- Parser defaults to AWS current default `9527`.
- Ready server profile selection requires `state=paired`, `authState=paired`, and a present device token.
- The first request is unauthenticated and must return `401`.
- The second request uses `Authorization: Bearer <device token>` and must return `200`.
- Reports include `deviceTokenPresent=true` but never include the raw token.
- `aih fabric transport readiness --json` routes through the same service implementation.

Full regression:

```bash
npm test
```

Result:

```text
tests 2661
pass 2661
fail 0
duration_ms 148782.398125
```

## Clean HEAD AWS Deployment

Command source:

```text
git archive HEAD
```

Deployment command:

```bash
node scripts/fabric-real-vps-deploy.js \
  --ssh ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --remote-dir /home/ubuntu/aih-fabric-current \
  --node-runtime "/Users/model/projects/feature/ai_home/tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz" \
  --skip-import \
  --skip-build \
  --broker-token-file /home/ubuntu/aih-fabric-current/.broker-token
```

Deployment result:

```text
source artifact: 1efb9ce7c57fd2025bd87d895f9ed5defacabbfec5dec32ebe50dc7381735298
server pid: 255015
port: 9527
accounts: codex=0, gemini=0, claude=0, agy=0, opencode=0
```

Post-deploy preflight:

```json
{
  "ok": true,
  "processCount": 1,
  "supervisorReady": true,
  "registryCounts": {
    "nodes": 2,
    "relayNodes": 2,
    "projects": 2,
    "runtimes": 4,
    "transports": 2,
    "nodeInventory": 2
  },
  "targetNode": {
    "id": "aws-current-node",
    "present": true,
    "runtimeHost": false,
    "runtimeGaps": [
      "codex:missing_provider_runtime:codex",
      "claude:missing_provider_runtime:claude",
      "agy:missing_provider_runtime:agy",
      "opencode:missing_provider_runtime:opencode"
    ]
  },
  "residue": [],
  "remainingGate": []
}
```

## Real AWS Client Smoke

Script command:

```bash
node scripts/fabric-real-transport-readiness-client-smoke.js --json
```

Product CLI command:

```bash
node bin/ai-home.js fabric transport readiness --json
```

Result summary:

```json
{
  "ok": true,
  "profile": {
    "id": "cp-51hq70",
    "endpoint": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527",
    "connectionMode": "direct",
    "authState": "paired",
    "deviceTokenPresent": true
  },
  "http": {
    "unauthenticatedStatus": 401,
    "authorizedStatus": 200
  },
  "checks": {
    "unauthRejected": true,
    "authorizedRead": true,
    "rpcOk": true,
    "nodeFound": true,
    "fallbackReady": true,
    "relayMeasurementPass": true
  },
  "summary": {
    "nodes": 1,
    "defaultTransport": "relay",
    "fallbackReady": true,
    "promotionReady": false,
    "promotedTransports": [],
    "blockers": [
      "webrtc:webrtc_transport_candidate_not_registered",
      "webrtc:turn_relay_gate_not_ready",
      "webtransport:webtransport_endpoint_not_configured",
      "webtransport:webtransport_not_promoted",
      "omr:openmptcprouter_not_detected",
      "mptcp:mptcp_data_plane_not_promoted"
    ]
  },
  "node": {
    "nodeId": "aws-current-node",
    "defaultTransport": "relay",
    "fallbackReady": true,
    "relayMeasurementPass": true,
    "relayRttMs": {
      "p95": 1,
      "max": 1,
      "count": 20
    }
  },
  "blockers": []
}
```

## Conclusion

The missing local-client proof is now closed:

- Local paired AWS server profile exists and is usable.
- AWS readiness is protected by the device token gate.
- Local client can read AWS `aws-current-node` transport readiness over default `9527`.
- The current default transport remains `relay`.
- Relay fallback is ready with a passing real measurement.
- Advanced promotion remains false for explicit external blockers.
