# M4 8.7 Mobile PWA Session Smoke Evidence

Date: 2026-06-28

## Scope

Verified M4 item 8.7 against AWS current only:

- AWS endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- Product port: default `9527`
- Mobile client: real Chromium mobile viewport `390x844`
- Runtime: real local Codex account `1`, model `gpt-5.5`
- Remote node under test: `m4-8-7-mobile-node`

No mock data and no old VPS targets were used.

## Finding And Fixes

Two real gaps were found before the final pass.

1. Codex TUI did not submit message input reliably when text and Enter were written as one PTY burst. The prompt stayed in the input field and the message marker never appeared.

   Fix:

   - `lib/server/native-session-chat.js` now writes prompt text and submit key as separate PTY chunks.
   - Submit key is delayed by `160ms`, avoiding Codex's paste-burst Enter suppression window.
   - `test/native-session-chat.test.js` covers chunk construction.

2. `device-node-session-attach` returned HTTP 404 while the same `runId` was readable through `session-run-events`.

   Root cause: the session catalog default reader used `native-chat-run-store.readNativeChatRunEvents(runId, options)`, but attach called it with the node RPC reader shape `{ runId, cursor, limit }`. Injected tests hid the mismatch.

   Fix:

   - `lib/server/control-plane-device-session-catalog.js` adapts the default native run reader to the `{ runId, cursor, limit }` shape.
   - Attach now treats the run-events reader as the active-run truth and uses `getNativeChatRun` only as metadata.
   - `test/control-plane-device-session-catalog.test.js` now covers default native run store attach.

## Local Attach Diagnostic

Before rerunning AWS, the local default `9527` server was restarted and a direct local node RPC smoke was run:

```json
{"phase":"start","status":200,"ok":true,"runIdPresent":true}
{"phase":"events","status":200,"ok":true,"cursor":34,"events":2,"error":""}
{"phase":"attach","status":200,"ok":true,"rpc":"node.session_attach","error":"","cursor":34,"events":2}
{"phase":"abort","status":200,"ok":true,"error":""}
```

## Real AWS Smoke Command

```bash
env NODE_PATH="/tmp/aih-playwright-smoke/node_modules" \
  node scripts/fabric-real-mobile-pwa-session-smoke.js \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --client-endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --host-home /Users/model \
  --node-id m4-8-7-mobile-node \
  --session-provider codex \
  --session-account 1 \
  --session-model gpt-5.5 \
  --session-project /Users/model/projects/feature/ai_home \
  --session-timeout-ms 180000
```

## Final Result

```json
{
  "ok": true,
  "mode": "mobile-pwa-browser",
  "endpoint": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527",
  "nodeId": "m4-8-7-mobile-node",
  "managementKeySource": "server-config",
  "preparation": {
    "mode": "api",
    "joinStatus": 200,
    "pairStatus": 200,
    "nodeInviteId": "invite-stez53wnuyc",
    "deviceInviteId": "device-invite-pof7jb7b0hw"
  },
  "relay": {
    "online": true,
    "status": "online",
    "transportKind": "relay",
    "transportId": "m4-8-7-mobile-node-relay"
  },
  "device": {
    "paired": true,
    "scopes": [
      "control-plane:read",
      "nodes:read",
      "sessions:read",
      "sessions:write",
      "status:read"
    ]
  },
  "mobile": {
    "ok": true,
    "viewport": {
      "width": 390,
      "height": 844,
      "devicePixelRatio": 3,
      "maxTouchPoints": 1
    },
    "runIdPresent": true,
    "startStatus": 200,
    "attachStatus": 200,
    "attach": {
      "status": 200,
      "ok": true,
      "rpc": "control_plane.device.node_session_attach",
      "error": ""
    },
    "disconnectedCursor": 260,
    "resumedCursor": 440,
    "reconnect": {
      "resumedFromCursor": 260,
      "duplicateEvents": 0,
      "markerFoundAfterResume": true
    },
    "markers": {
      "start": true,
      "message": true
    },
    "commands": {
      "message": { "status": 200, "accepted": true, "type": "message" },
      "slash": { "status": 200, "accepted": true, "type": "slash", "command": "/status" },
      "approval": {
        "status": 0,
        "accepted": false,
        "type": "approval_response",
        "skipped": true,
        "reason": "no_approval_request"
      },
      "stop": { "status": 200, "accepted": true, "type": "stop", "scope": "run" }
    },
    "final": {
      "completed": true,
      "cursor": 460,
      "eventCounts": {
        "ready": 1,
        "terminal-output": 407,
        "artifact_ref": 20,
        "aborted": 1,
        "done": 1
      }
    },
    "artifacts": {
      "refs": 20,
      "fetched": 20,
      "bytes": 10566
    },
    "browser": {
      "engine": "chromium",
      "mobileViewport": "390x844",
      "consoleErrors": 0,
      "pageErrors": []
    }
  }
}
```

The approval response was not faked. The real Codex run did not emit an `approval_request`, so the smoke recorded `skipped: true` with `reason: no_approval_request`. The canonical approval command path remains covered by focused command tests from M4 8.5 and this M4 8.7 test sends a response only when a real approval request exists.

## Cleanup And Runtime State

Process residue check after the smoke:

```text
No fabric-real-mobile-pwa-session-smoke, m4-8-7-mobile-node, node relay connect, relay-client, or AIH_LOCAL_ATTACH_DIAG process remained.
```

AWS listener check:

```text
LISTEN 0 511 0.0.0.0:9527 0.0.0.0:* users:(("node",pid=194865,fd=27))
```

Readiness:

```json
{
  "local": {
    "ready": true,
    "accounts": {
      "codex": 1,
      "gemini": 1,
      "claude": 5,
      "agy": 7,
      "opencode": 1
    }
  },
  "aws": {
    "ready": false,
    "accounts": {
      "codex": 0,
      "gemini": 0,
      "claude": 0,
      "agy": 0,
      "opencode": 0
    }
  }
}
```

AWS is currently the control plane / broker / relay-capable node. It is not a provider runtime host because it has no provider accounts imported. In this smoke the provider runtime was the paired local node.

## Verification

Focused tests:

```bash
node --test \
  test/control-plane-device-session-catalog.test.js \
  test/node-rpc-router.test.js \
  test/fabric-real-mobile-pwa-session-smoke.test.js \
  test/native-session-chat.test.js \
  test/control-plane-device-session-start.test.js \
  test/control-plane-device-session-command.test.js
```

Result:

```text
tests 100
pass 100
fail 0
```

## Verdict

M4 8.7 is complete for the real mobile/PWA path: the mobile browser can pair through AWS, see the relay node online, start a real Codex session, attach to the active run, send message and slash commands, recover from a cursor reconnect without duplicate events, fetch artifact refs, and stop the run without leaked smoke processes.
