# 2026-06-29 M6 WebTransport CLI

## Scope

Productize the existing real browser WebTransport smoke as a Fabric command:

```bash
aih fabric transport webtransport
```

The command runs a real Chromium/Chrome `WebTransport` probe against the
configured endpoint and reports candidate/promotion blockers. It does not open a
new port, start a QUIC server, import provider credentials, or touch retired VPS
targets.

Default target behavior is aligned with the M6 promotion gate:

- page URL: `https://example.com/`
- WebTransport URL:
  `https://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo`
- browser channel: `auto` (`bundled` first, then `chrome` only when the
  bundled browser executable is unavailable)

This verifies the real HTTPS/H3/WebTransport prerequisite instead of only
showing the known HTTP insecure-context failure.

## Code paths

- `lib/cli/services/fabric/transport-webtransport.js`
- `lib/cli/commands/fabric-router.js`
- `test/fabric-transport-webtransport.test.js`

## Local code checks

```bash
node --check lib/cli/services/fabric/transport-webtransport.js
node --check lib/cli/commands/fabric-router.js
node --check test/fabric-transport-webtransport.test.js
```

Result: pass.

## Focused local tests

```bash
node --test \
  test/fabric-real-webtransport-smoke.test.js \
  test/fabric-transport-webtransport.test.js
```

Result: 11/11 pass.

Coverage:

- default command target uses HTTPS/H3 WebTransport URL for AWS current.
- product flags and legacy aliases are parsed.
- auto browser fallback keeps both AWS Linux bundled Chromium and local macOS
  system Chrome usable without separate config.
- default diagnostic command reports blockers without failing the process.
- `--fail-on-blocked` exits non-zero while preserving the diagnostic report.
- router emits JSON and routes the command.

## Full local test suite

```bash
npm test
```

Result: 2708/2708 pass.

## Real AWS current WebTransport diagnostic

Command:

```bash
node bin/ai-home.js fabric transport webtransport \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --timeout-ms 15000 \
  --json
```

Result:

```json
{
  "ok": true,
  "mode": "fabric-webtransport-diagnostics",
  "webTransportUrl": "https://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo",
  "pageUrl": "https://example.com/",
  "browserChannel": "chrome",
  "probe": {
    "ok": false,
    "probe": {
      "isSecureContext": true,
      "webTransportType": "function",
      "failureReason": "webtransport_connect_failed",
      "error": {
        "name": "WebTransportError",
        "message": "Opening handshake failed."
      }
    }
  },
  "summary": {
    "candidateReady": false,
    "promotionReady": false,
    "blockers": ["webtransport_connect_failed"]
  },
  "exitOk": true
}
```

Interpretation:

- browser support exists: `webTransportType=function`.
- browser context is secure: `isSecureContext=true`.
- failure is at the AWS default `9527` endpoint handshake.
- current AWS default listener is still not a HTTPS/H3 WebTransport endpoint.

## Fail-on-blocked gate

Command:

```bash
node bin/ai-home.js fabric transport webtransport \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --timeout-ms 15000 \
  --fail-on-blocked \
  --json
```

Result:

- process status: `1`
- report `ok`: `true`
- report `exitOk`: `false`
- blockers: `["webtransport_connect_failed"]`

This gives CI/release gates a strict mode without treating a real negative
transport diagnostic as a crashed command.

## AWS current sync and remote verification

Scoped artifact:

```text
/tmp/aih-fabric-webtransport-cli.tar.gz
```

sha256:

```text
6fe09e6502839767960f998327f81eaf25c13adb163dc38e4dbf54da1693ecc9
```

Uploaded to:

```text
/home/ubuntu/aih-fabric-current/source-webtransport-cli.tar.gz
```

Remote command summary:

```bash
cd /home/ubuntu/aih-fabric-current
tar --no-same-owner -xzf source-webtransport-cli.tar.gz
.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/services/fabric/transport-webtransport.js
.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/commands/fabric-router.js
.node-runtime/node-v22.16.0-linux-x64/bin/node --check test/fabric-transport-webtransport.test.js
.node-runtime/node-v22.16.0-linux-x64/bin/node --test \
  test/fabric-real-webtransport-smoke.test.js \
  test/fabric-transport-webtransport.test.js
.node-runtime/node-v22.16.0-linux-x64/bin/node bin/ai-home.js fabric transport webtransport \
  --endpoint http://127.0.0.1:9527 \
  --timeout-ms 15000 \
  --json
.node-runtime/node-v22.16.0-linux-x64/bin/node bin/ai-home.js fabric transport webtransport \
  --endpoint http://127.0.0.1:9527 \
  --timeout-ms 15000 \
  --fail-on-blocked \
  --json
```

Remote result:

- `node --check`: pass.
- focused tests: 11/11 pass.
- default `auto` browser channel selected bundled Chromium on AWS.
- AWS local default listener diagnostic:
  - endpoint: `http://127.0.0.1:9527`
  - WebTransport URL: `https://127.0.0.1:9527/v0/fabric/webtransport/echo`
  - `isSecureContext=true`
  - `webTransportType=function`
  - `failureReason=webtransport_connect_failed`
  - `summary.candidateReady=false`
  - `summary.promotionReady=false`
  - `summary.blockers=["webtransport_connect_failed"]`
- `--fail-on-blocked` status: `1`, report `ok=true exitOk=false`.

## Verdict

M6 11.4 now has a formal product CLI for real WebTransport/H3 diagnostics.
The current AWS default `9527` server still fails the WebTransport opening
handshake, so WebTransport must remain unpromoted until a real HTTPS/H3 endpoint
exists and this command returns `promotionReady=true`.
