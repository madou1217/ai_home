# 2026-06-30 Mobile PWA Existing Node Closure

Superseded note: `2026-06-30-mobile-pwa-strict-slash-closure.md` is the current product gate. `headless_session_slash_unsupported` is no longer an acceptable ok=true result.

## Scope

- Target: AWS current only.
- Endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- Node: `aws-current-node`
- Provider: `opencode`
- Account: `1`
- Project: `/home/ubuntu/aih-fabric-current`
- Mode: existing Fabric node, real mobile browser viewport, real paired device token, no mock data.

## Why the previous loop happened

The mobile/PWA smoke was still validating an older flow:

- It created or assumed temporary legacy relay-node semantics instead of targeting the current registered Fabric node.
- It read only old `terminal-output` style events, while current native runs emit canonical `delta/result/done`.
- It waited through multiple stages even after a marker was already impossible, so the outside browser timeout hid the real cause.
- It sent `message` to a completed headless run, but kept reading the parent run id. Current server semantics resume completed headless runs into a new child `runId`.

This made a simple product question look like a transport timeout.

## Code closure

- `scripts/fabric-real-mobile-pwa-session-smoke.js`
  - Added `--existing-node` so the smoke pairs a real device and targets `aws-current-node` directly.
  - Added canonical stream parsing for `delta`, `result.content`, and `done.content`.
  - Added request-stage ledger: `failureStage`, `failureReason`, `requestLog`, `consoleTail`, and `networkTail`.
  - Added browser-side request timeout so hung fetch calls return a diagnostic instead of consuming the whole run.
  - Added early failure when a run is `completed` without the expected marker.
  - Added headless slash unsupported as an explicit diagnosed capability gap when `--allow-unsupported-slash` is set.
  - Added completed-run resume following: when `message` returns `resumed=true` and a child `runId`, subsequent events, slash, and stop use that child run.
- `test/fabric-real-mobile-pwa-session-smoke.test.js`
  - Covers existing-node options.
  - Covers canonical event parsing.
  - Covers unsupported slash reporting.
  - Covers stop-on-missing-marker.
  - Covers following the resumed child run id.

## Failure ledger from real testing

### 1. Browser evaluate timeout

First current-node run:

```text
mode=mobile-pwa-existing-node
pairStatus=200
failureStage=browser_evaluate
failureReason=mobile_browser_evaluate_timeout
```

Cause:

- The smoke did not have per-request timeout or browser-side request ledger.
- The outer timeout erased which API stage was stuck.

Fix:

- Added browser request timeout and stage ledger.

### 2. Message marker missing

After adding stage ledger, the real failure became visible:

```text
failureStage=message_marker
failureReason=message_marker_not_found
startStatus=200
attachStatus=200
message.status=200
stop.status=200
eventCounts=ready:1,session-created:1,delta:1,result:1,done:1,aborted:1
terminalTail=AIH_MOBILE_PWA_START_OK_20260628...
```

Remote event readback for parent run `600e4c7d-29a7-47d9-8caf-3021cfb50a90` confirmed the parent run completed after the first prompt and only contained the start marker. The message command was accepted, but the smoke was still reading the parent run id.

Cause:

- Current headless command semantics resume completed runs into a new child run.
- The mobile smoke ignored `message.result.runId`.

Fix:

- Follow `message.result.runId` when `message.result.resumed=true`.

### 3. Browser `/readyz` CORS probe was not the root cause

A browser-side diagnostic from a `data:` page showed:

```text
fetch /readyz -> blocked by CORS policy, origin=null
fetch /v0/node-rpc/device-node-session-start with bad token -> HTTP 401
```

Conclusion:

- `/readyz` is not a valid browser API preflight signal for this smoke because it does not expose CORS headers to a `data:` origin.
- The protected `/v0/node-rpc/*` path did return real HTTP responses from Chromium.
- Do not classify this smoke as failed only because `/readyz` is CORS-blocked in a synthetic browser probe.

## Successful real AWS smoke

Command:

```bash
env NODE_PATH="/tmp/aih-playwright-smoke/node_modules" node scripts/fabric-real-mobile-pwa-session-smoke.js \
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
mode=mobile-pwa-existing-node
pairStatus=200
deviceInviteId=device-invite-yt0c0uggefg
parentRunId=5df26324-7edf-40a1-820d-9459de06885c
childRunId=65f6c750-5515-414f-a5f1-f1478d4b32a1
sessionRef=ses_0ebba4cdcffe6h2gIqUiUS1k5o
message.resumed=true
markers.start=true
markers.message=true
slash.status=400
slash.error=headless_session_slash_unsupported
slash.unsupported=true
approval.skipped=true
stop.status=200
final.completed=true
final.cursor=4
eventCounts=ready:1,session-created:1,delta:2,result:2,done:1,aborted:1
terminalTail contains AIH_MOBILE_PWA_START_OK_20260628 and AIH_MOBILE_PWA_MESSAGE_OK_20260628
```

Transport and runtime notes:

- This smoke used the real AWS endpoint on default port `9527`.
- It used the registered `aws-current-node`.
- It did not create a temporary legacy relay node.
- It did not touch old VPS targets.
- Headless slash remains an explicit provider capability gap, not a transport failure.

## Local verification

```text
node --check scripts/fabric-real-mobile-pwa-session-smoke.js
pass
```

```text
node --test test/fabric-real-mobile-pwa-session-smoke.test.js
tests 7
pass 7
fail 0
```

## Anti-loop rules added

- Do not treat browser total timeout as a root cause; inspect `failureStage`, `failureReason`, and `requestLog`.
- Do not keep polling a completed run when the expected marker is absent.
- Do not continue reading the parent run after `message.resumed=true`.
- Do not fail mobile/PWA smoke only because headless slash is unsupported when `--allow-unsupported-slash` is explicitly set.
- Do not use legacy temporary relay-node smoke to validate the current AWS Fabric node path.
