# 2026-06-28 Fabric Session Control CLI Smoke

## Scope

This evidence records the product CLI controls that continue after `fabric session start`:

- `aih fabric session attach <node-id> --run-id RUN`
- `aih fabric session events <node-id> --run-id RUN`
- `aih fabric session message <node-id> --run-id RUN --text TEXT`
- `aih fabric session slash <node-id> --run-id RUN --command /status`
- `aih fabric session stop <node-id> --run-id RUN`

The client uses the same paired AWS server profile and device token path as `fabric nodes`, `fabric transport readiness`, and `fabric session start`. Reports include `deviceTokenPresent=true` only; raw tokens are not printed.

No mock AWS data was used. No retired `152.*`, `155.*`, or `39.104.*` servers were touched. No new product port was opened.

## Code Surface

| File | Purpose |
|---|---|
| `lib/cli/services/fabric/session-control-client.js` | Shared client for attach/events/message/slash/stop |
| `lib/cli/commands/fabric-router.js` | Routes session control subcommands |
| `test/fabric-session-control-client.test.js` | Parser, protected GET/POST, payload, token redaction, router tests |

## Local Verification

Commands:

```text
node --test test/fabric-session-control-client.test.js test/fabric-session-start-client.test.js
node --test test/fabric-nodes-client.test.js test/fabric-node-inventory.test.js test/fabric-role-registry.test.js
node bin/ai-home.js fabric --help
```

Results:

```text
session control/start focused tests: 9/9 pass
nodes/inventory/role-registry focused tests: 10/10 pass
fabric help lists start/attach/events/message/slash/stop
```

## Real AWS CLI Smoke

Target:

```text
server profile: cp-51hq70
endpoint: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
node: local-mac-remote-node
runtime: codex
account: 1
model: gpt-5.5
project: /Users/model/projects/feature/ai_home
```

Start command:

```text
node bin/ai-home.js fabric session start local-mac-remote-node \
  --provider codex \
  --account-id 1 \
  --model gpt-5.5 \
  --project-path "/Users/model/projects/feature/ai_home" \
  --prompt "Reply with AIH_SESSION_CONTROL_SINGLE_CHECK exactly once." \
  --timeout-ms 120000 \
  --json
```

Start result:

```json
{
  "ok": true,
  "blocked": false,
  "http": {
    "registryAuthorizedStatus": 200,
    "sessionStartStatus": 200
  },
  "result": {
    "accepted": true,
    "mode": "native-session",
    "status": "running",
    "provider": "codex",
    "accountId": "1",
    "runId": "54559278-18bb-4be9-a903-ae426291894e"
  }
}
```

Attach command:

```text
node bin/ai-home.js fabric session attach local-mac-remote-node \
  --run-id 54559278-18bb-4be9-a903-ae426291894e \
  --cursor 0 \
  --limit 5 \
  --json
```

Attach result:

```json
{
  "ok": true,
  "http": { "status": 200 },
  "result": {
    "sessionId": "54559278-18bb-4be9-a903-ae426291894e",
    "runId": "54559278-18bb-4be9-a903-ae426291894e",
    "provider": "codex",
    "status": "running",
    "cursor": 212,
    "allowedCommands": ["attach", "detach", "message", "slash", "approval_response", "stop"]
  }
}
```

Events command:

```text
node bin/ai-home.js fabric session events local-mac-remote-node \
  --run-id 54559278-18bb-4be9-a903-ae426291894e \
  --cursor 0 \
  --limit 5 \
  --json
```

Events result:

```json
{
  "ok": true,
  "http": { "status": 200 },
  "summary": {
    "cursor": 212,
    "completed": false,
    "eventCount": 5,
    "eventTypes": {
      "ready": 1,
      "terminal-output": 4
    }
  }
}
```

Message command:

```text
node bin/ai-home.js fabric session message local-mac-remote-node \
  --run-id 54559278-18bb-4be9-a903-ae426291894e \
  --text "Please print AIH_SESSION_CONTROL_SINGLE_CHECK exactly once." \
  --json
```

Message result:

```json
{
  "ok": true,
  "http": { "status": 200 },
  "result": {
    "accepted": true,
    "type": "message",
    "runId": "54559278-18bb-4be9-a903-ae426291894e",
    "cursor": 212
  }
}
```

Slash command:

```text
node bin/ai-home.js fabric session slash local-mac-remote-node \
  --run-id 54559278-18bb-4be9-a903-ae426291894e \
  --command /status \
  --json
```

Slash result:

```json
{
  "ok": true,
  "http": { "status": 200 },
  "result": {
    "accepted": true,
    "type": "slash",
    "command": "/status",
    "runId": "54559278-18bb-4be9-a903-ae426291894e",
    "cursor": 212
  }
}
```

Stop command:

```text
node bin/ai-home.js fabric session stop local-mac-remote-node \
  --run-id 54559278-18bb-4be9-a903-ae426291894e \
  --json
```

Stop result:

```json
{
  "ok": true,
  "http": { "status": 200 },
  "result": {
    "accepted": true,
    "type": "stop",
    "runId": "54559278-18bb-4be9-a903-ae426291894e",
    "cursor": 217,
    "scope": "run"
  }
}
```

Post-stop events:

```json
{
  "ok": true,
  "http": { "status": 200 },
  "result": {
    "status": "completed",
    "cursor": 218
  },
  "summary": {
    "completed": true,
    "eventCount": 6,
    "eventTypes": {
      "terminal-output": 4,
      "aborted": 1,
      "done": 1
    }
  }
}
```

## Real Finding

During one exploratory run, `message` and `slash` were sent in parallel. The remote TUI accepted both commands but terminal output showed the inputs were concatenated into `/statusPlease...`, which Codex rejected as an unrecognized slash command.

Conclusion:

- The CLI controls are real and protected routes work end to end through AWS default `9527`.
- Command acknowledgement is not the same as semantic TUI completion.
- Higher-level clients must serialize interactive TUI commands when they target the same run. A future native-client layer should wait for prompt readiness or command completion before sending the next command.

This evidence does not claim a model marker response for this run. Marker-producing real conversation evidence remains covered by the earlier M4 AWS/mobile smokes.

## Post-Deploy AWS 9527 Verification

Clean deployment:

```text
commit: b69c7c5 feat(fabric): add session control CLI
source: git archive HEAD into /tmp/aih-fabric-clean-deploy.gvDb1S
target: ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:/home/ubuntu/aih-fabric-current
port: 9527
source artifact sha256: c819cd3b4c7f2c5a1ff804789ee281f3f7112a2661e6ad80593965c9a0476315
remote pid: 259071
accounts: codex=0, gemini=0, claude=0, agy=0, opencode=0
```

Deployment command used `--skip-import --skip-build` and the remote broker token file. No provider credentials were imported and no product port other than `9527` was opened.

Post-deploy read checks:

```text
node scripts/fabric-m3-daemon-preflight.js --json
  ok=true
  verdict=ready_for_confirmed_7_3_execution
  readyzHttp=200
  process=259071 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
  registry counts: nodes=2, relayNodes=2, projects=2, runtimes=4, transports=2, nodeInventory=2
  aws-current-node runtimeHost=false

node bin/ai-home.js fabric nodes aws-current-node --json
  authorizedStatus=200
  aws-current-node relayNode=true projectHost=true runtimeHost=false
  aws-current-node transport=relay online, ws_echo_pass, sampleCount=20, successRate=1
  local-mac-remote-node runtimeHost=true providers=agy,claude,codex,opencode

node bin/ai-home.js fabric transport readiness --json
  authorizedStatus=200
  defaultTransport=relay
  fallbackReady=true
  relayMeasurementPass=true
  blockers still tracked for promoted transports:
    webrtc, webtransport, omr, mptcp
```

Post-deploy session-control checks:

```text
run 1: 8d147b98-93cf-4dac-9ab7-0d6dd1a3636f
start: status=200 accepted=true provider=codex accountId=1
attach: status=200 status=running cursor=211 allowedCommands include message, slash, stop
events: status=200 cursor=211 eventTypes ready=1 terminal-output=59
message: status=200 accepted=true type=message commandId=fabric-message-5spve6
stop: status=200 accepted=true type=stop cursor=524
post-stop events: status=200 cursor=525 eventTypes terminal-output=312 aborted=1 done=1 status=completed

run 2: d32d0fb5-1afa-452f-a56c-12f67a7dd6ce
start: status=200 accepted=true provider=codex accountId=1
slash: status=200 accepted=true type=slash command=/status cursor=280
stop: status=200 accepted=true type=stop cursor=293
post-stop events: status=200 cursor=294 eventTypes terminal-output=12 aborted=1 done=1 status=completed
```

The first post-deploy run did not produce a verified model marker before it was stopped, so it is not counted as marker-producing conversation evidence. It does prove the deployed AWS control plane can start a real local Mac Codex native session, attach to it, read events, send a protected message command, stop it, and observe completion. The second run separately proves the deployed slash command path.

Follow-up finding:

```text
After the second run completed, a later events read returned HTTP 404 because completed native runs were retained in memory for only 60 seconds.
```

Resolution:

```text
lib/server/control-plane-device-session-start.js now defaults completed run retention to 30 minutes.
AIH_NATIVE_RUN_RETENTION_MS or AIH_SESSION_RUN_RETENTION_MS can override it.
Configured values are clamped between 60 seconds and 24 hours.
```

Retention fix deployment and verification:

```text
commit: b8ea19b fix(fabric): retain completed session events longer
AWS source artifact sha256: 8d9309d0732611c0fac9d692bbf13676f9879c86bab2e4c283b17193603307bd
AWS remote pid: 260427
AWS port: 9527
local server pid after restart: 36576
local server port: 9527

node scripts/fabric-m3-daemon-preflight.js --json
  ok=true
  readyzHttp=200
  process=260427 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
  registry counts: nodes=2, runtimes=4, transports=2

node bin/ai-home.js fabric nodes local-mac-remote-node --json
  authorizedStatus=200
  runtimeHost=true
  providers=agy,claude,codex,opencode

retention run: 2d83f79f-9d74-492f-9830-340d6b21fbcf
start: status=200 accepted=true provider=codex accountId=1
stop: status=200 accepted=true type=stop cursor=167
immediate post-stop events:
  status=200 cursor=168 eventTypes terminal-output=165 aborted=1 done=1 status=completed
after sleep 70:
  status=200 cursor=168 eventTypes terminal-output=165 aborted=1 done=1 status=completed
```
