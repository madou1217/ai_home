# M6 Prerequisite Audit

Date: 2026-06-28

## Objective

Make the remaining M6 external prerequisites repeatable and auditable:

- AWS current default `9527` base readiness.
- Controlled TURN relay readiness.
- HTTPS/H3 WebTransport endpoint readiness.
- Multipath/MPTCP/OpenMPTCPRouter topology readiness.

This audit is read-only. It does not import provider credentials, open product ports, install TURN/QUIC software, or touch retired VPS targets.

## Scope

- AWS only: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`.
- Endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`.
- Remote dir: `/home/ubuntu/aih-fabric-current`.
- Node id: `aws-current-node`.
- SSH key: `/Users/model/.ssh/aws.pem`.

## New Audit Entrypoint

```bash
node scripts/fabric-m6-prerequisite-audit.js --help
```

The script composes existing real probes:

- `fabric-m3-daemon-preflight.js` for AWS daemon/registry readiness.
- `fabric-real-webrtc-datachannel-smoke.js` for relay-only TURN when controlled credentials exist.
- `fabric-real-webtransport-smoke.js` for browser WebTransport handshake.
- `fabric-multipath-diagnosis.js` for MPTCP/OpenMPTCPRouter/default listener diagnosis.

Optional environment defaults are read only when present:

- `AIH_TURN_ICE_SERVER` / `AIH_TURN_ICE_SERVERS`
- `AIH_TURN_USERNAME`
- `AIH_TURN_CREDENTIAL`
- `AIH_WEBTRANSPORT_URL` / `AIH_M6_WEBTRANSPORT_URL`
- `AIH_WEBTRANSPORT_PAGE_URL` / `AIH_M6_WEBTRANSPORT_PAGE_URL`

## Focused Tests

```bash
node --check scripts/fabric-m6-prerequisite-audit.js
node --test test/fabric-m6-prerequisite-audit.test.js
node --test \
  test/fabric-m6-prerequisite-audit.test.js \
  test/fabric-m6-promotion-gate.test.js \
  test/fabric-real-webrtc-datachannel-smoke.test.js \
  test/fabric-real-webtransport-smoke.test.js \
  test/fabric-multipath-diagnosis.test.js \
  test/fabric-m3-daemon-preflight.test.js
```

Result:

```text
M6 focused transport/preflight tests: 52/52 pass
```

## Real AWS Audit

Command:

```bash
node scripts/fabric-m6-prerequisite-audit.js \
  --json \
  --diagnostics-dir /tmp/aih-m6-prereq-audit-20260628-postdeploy \
  --diagnostics-file /tmp/aih-m6-prereq-audit-20260628-postdeploy/report.json
```

Post-commit deployment used a clean `git archive HEAD` source tree, `--skip-import`, `--skip-build`, and the existing default `9527` remote dir.

Deployment result:

```text
source artifact: bbc723fcb0e44cb6b651459c66aaf26e992d9582d7822ce52dd7e9043aa799de
server pid: 247633
accounts: codex=0, gemini=0, claude=0, agy=0, opencode=0
```

Result generated at `2026-06-28T11:54:00.597Z`, duration `12739ms`.

### AWS Base Readiness

```json
{
  "candidateReady": true,
  "promotionReady": true,
  "server": {
    "readyzHttp": 200,
    "processCount": 1,
    "processes": [
      "247633 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527"
    ],
    "expectedHostHome": "/home/ubuntu/aih-fabric-current/.aih-host-home",
    "hostHomes": [
      {
        "pid": 247633,
        "hostHome": "/home/ubuntu/aih-fabric-current/.aih-host-home",
        "ok": true
      }
    ]
  },
  "serviceStatus": {
    "supervisorReady": true,
    "relay": {
      "state": "running",
      "running": true
    },
    "registryAgent": {
      "state": "running",
      "running": true
    },
    "issues": []
  },
  "registry": {
    "ok": true,
    "http": 200,
    "counts": {
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
      "runtimeProviders": [],
      "runtimeGaps": [
        "codex:missing_provider_runtime:codex",
        "claude:missing_provider_runtime:claude",
        "agy:missing_provider_runtime:agy",
        "opencode:missing_provider_runtime:opencode"
      ]
    }
  },
  "residue": [],
  "blockers": []
}
```

### TURN

```json
{
  "ran": false,
  "candidateReady": false,
  "promotionReady": false,
  "configuration": {
    "iceServers": [],
    "turnServers": [],
    "ignoredIceServers": [],
    "username": "",
    "credential": ""
  },
  "blockers": [
    "turn_ice_server_not_configured"
  ]
}
```

No controlled TURN `iceServers`/credentials were configured, so the audit did not run a fake relay-only smoke.

### WebTransport

```json
{
  "ran": true,
  "candidateReady": false,
  "promotionReady": false,
  "webTransportUrl": "https://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo",
  "failureReason": "webtransport_connect_failed",
  "blockers": [
    "webtransport_connect_failed"
  ],
  "pageUrl": "https://example.com"
}
```

The browser secure context exists, but AWS default `9527` is not a working HTTPS/H3 WebTransport endpoint.

### Multipath

```json
{
  "ran": true,
  "candidateReady": true,
  "promotionReady": false,
  "verdict": "diagnostic_pass_promotion_blocked",
  "blockers": [
    "local_mptcp_unavailable",
    "openmptcprouter_not_detected",
    "default_listener_is_plain_http_not_multipath_transport"
  ],
  "local": {
    "platform": "Darwin",
    "arch": "arm64",
    "kernelMptcp": false,
    "pythonMptcpSocket": false
  },
  "remote": {
    "platform": "Linux",
    "arch": "x86_64",
    "kernelMptcp": true,
    "pythonMptcpSocket": true,
    "listener9527": "tcp   LISTEN 0      511                  0.0.0.0:9527      0.0.0.0:*    users:((\"node\",pid=247633,fd=27))"
  },
  "openMptcpRouterDetected": false
}
```

AWS Linux has MPTCP capability, but the local macOS side does not expose a generic MPTCP socket, OpenMPTCPRouter was not detected, and default `9527` is still the plain AIH HTTP listener.

## Aggregate Result

```json
{
  "baseReady": true,
  "promotionReady": false,
  "readyTransports": [],
  "blockers": [
    "turn:turn_ice_server_not_configured",
    "webtransport:webtransport_connect_failed",
    "multipath:local_mptcp_unavailable",
    "multipath:openmptcprouter_not_detected",
    "multipath:default_listener_is_plain_http_not_multipath_transport"
  ]
}
```

## Conclusion

M6 software-side WebRTC RPC adapter readiness is already proven by `2026-06-28-m6-webrtc-rpc-adapter-gate.md`.

This audit proves the remaining blocker set is external topology/configuration, not missing local classification:

- WebRTC promotion still needs controlled TURN relay `iceServers` and credentials, then relay-only DataChannel smoke must produce relay candidates.
- WebTransport promotion still needs a real HTTPS/H3 WebTransport endpoint on the approved topology.
- Multipath promotion still needs a real dual-side Linux/OpenMPTCPRouter underlay while preserving externally stable default `9527`.

No advanced transport is promoted by this audit; current default remains relay fallback.
