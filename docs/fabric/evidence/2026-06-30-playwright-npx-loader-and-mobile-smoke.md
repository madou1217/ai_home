# 2026-06-30 Playwright npx Loader and Mobile Smoke Closure

Superseded note: `2026-06-30-mobile-pwa-strict-slash-closure.md` is the current mobile/PWA gate. The old `--allow-unsupported-slash` command is historical only.

## Scope

- Target: AWS current only.
- Endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- Node: `aws-current-node`
- Purpose: remove the temporary `NODE_PATH=/tmp/aih-playwright-smoke/node_modules` requirement from real browser smokes.

## Failure ledger

### 1. npx installed Playwright but Node could not require it

Real reproduction:

```bash
npx --yes --package playwright node -e "console.log(require.resolve('playwright'))"
```

Result:

```text
MODULE_NOT_FOUND Cannot find module 'playwright'
```

Cause:

- `npx --package playwright` prepends `~/.npm/_npx/<id>/node_modules/.bin` to `PATH`.
- Node's CommonJS resolution does not search that temporary `node_modules` root for `require('playwright')`.
- Earlier real smokes worked only by setting `NODE_PATH=/tmp/aih-playwright-smoke/node_modules`, which was a local workaround.

Fix:

- Added `scripts/playwright-require.js`.
- The loader first tries normal `require('playwright')`.
- If that fails, it derives candidate module roots from:
  - `PLAYWRIGHT_REQUIRE_PATH`
  - local repo `node_modules`
  - npx `PATH` entries ending in `node_modules/.bin`
  - known local Playwright CLI/MCP installs
  - npm `_npx` cache entries sorted by mtime
- WebRTC, WebTransport, and mobile/PWA smokes now share the same loader.

### 2. Browser request timeout was too aggressive

After the loader fix, a real npx mobile/PWA smoke produced:

```text
failureStage=start_marker
failureReason=start_marker_events_failed
requestLog error=AbortError
```

Cause:

- The browser request timeout was set to at most 3s.
- AWS `opencode` startup commonly needs around 5-6s before `session-created` and marker events.

Fix:

- Request timeout is now `max(5000, min(15000, phaseTimeout / 2))`.
- Stage ledger remains in place, but normal `opencode` startup is not killed prematurely.

## Verification

### Loader with npx

Command:

```bash
npx --yes --package playwright node -e "const { loadPlaywright, findPlaywrightModulePath } = require('./scripts/playwright-require'); const p = loadPlaywright(); console.log(JSON.stringify({ok:Boolean(p.chromium), path: findPlaywrightModulePath()}));"
```

Result:

```text
{"ok":true,"path":"/Users/model/.npm/_npx/e41f203b7505f1fb/node_modules/playwright"}
```

### Real mobile/PWA smoke without NODE_PATH

Command:

```bash
npx --yes --package playwright node scripts/fabric-real-mobile-pwa-session-smoke.js \
  --existing-node \
  --allow-unsupported-slash \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --client-endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --node-id "aws-current-node" \
  --session-provider "opencode" \
  --session-account "1" \
  --session-model "" \
  --session-project "/home/ubuntu/aih-fabric-current" \
  --timeout-ms 60000 \
  --session-timeout-ms 60000
```

Result:

```text
ok=true
pairStatus=200
parentRunId=9e861e16-0eef-4f8d-92a8-e1ee110db7aa
childRunId=d6a4b449-f254-4834-a894-6209db15b210
sessionRef=ses_0ebae805cffeoN4KCzrY93VDEg
message.resumed=true
markers.start=true
markers.message=true
slash.status=400
slash.error=headless_session_slash_unsupported
stop.status=200
terminalTail contains AIH_MOBILE_PWA_START_OK_20260628 and AIH_MOBILE_PWA_MESSAGE_OK_20260628
```

### Real WebRTC DataChannel smoke without NODE_PATH

Command:

```bash
npx --yes --package playwright node scripts/fabric-real-webrtc-datachannel-smoke.js \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --sample-count 1 \
  --rpc-sample-count 1 \
  --timeout-ms 30000
```

Result:

```text
ok=true
channelOpened=true
connectionState=connected
iceConnectionState=connected
selectedCandidatePair=srflx -> srflx
rtt.p95=298.1ms
rpc.ok=true
rpc.responses=1
rpc.requestsHandled=1
rpc.rtt.p95=298ms
```

### Local tests

```text
node --check scripts/playwright-require.js
node --check scripts/fabric-real-mobile-pwa-session-smoke.js
node --check scripts/fabric-real-webrtc-datachannel-smoke.js
```

All passed.

```text
node --test test/playwright-require.test.js test/fabric-real-mobile-pwa-session-smoke.test.js
tests 9
pass 9
fail 0
```

## Anti-loop rules added

- Do not rely on ad hoc `NODE_PATH` for browser smokes.
- If `npx --package playwright` is used, derive the temporary module root from `PATH`.
- Do not set browser API request timeout below normal provider startup latency.
- Treat `headless_session_slash_unsupported` as a diagnosed provider capability gap, not a browser loader failure.
