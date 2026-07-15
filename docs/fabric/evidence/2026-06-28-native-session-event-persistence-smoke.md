# 2026-06-28 Native Session Event Persistence Smoke

## Scope

This evidence records the hardening after the session-control CLI smoke:

- completed native session run events are persisted under the node server's `AIH_HOST_HOME`/`aiHomeDir`;
- terminal-output artifacts are persisted beside run events;
- `fabric session events` can still read a completed run after the node server process restarts.

No mock AWS data was used. No retired `152.*`, `155.*`, or `39.104.*` servers were touched. No product port other than default `9527` was opened. No provider credentials were imported to AWS.

## Code Surface

| File | Purpose |
|---|---|
| `lib/server/native-chat-run-persistence.js` | Append-only JSONL run event store and run meta reader |
| `lib/server/native-chat-run-store.js` | Persist every appended native run event; active runs still read from memory first |
| `lib/server/control-plane-device-session-artifact-store.js` | Persist large terminal artifacts under `fabric/session-artifacts` |
| `lib/server/control-plane-device-session-start.js` | Pass `aiHomeDir` into event/artifact persistence and run-event reads |
| `lib/server/control-plane-device-session-command.js` | Preserve `aiHomeDir` through message/slash/stop cursor reads |
| `lib/server/node-rpc-router.js` | Preserve `aiHomeDir` through node-rpc default session routes |

## Local Verification

Commands:

```text
node --test test/control-plane-device-session-start.test.js test/control-plane-device-session-command.test.js test/control-plane-device-session-catalog.test.js test/server-node-rpc-wiring.test.js
node --test test/fabric-session-control-client.test.js test/fabric-session-start-client.test.js
npm test
```

Results:

```text
session start/command/catalog/router focused tests: 31/31 pass
fabric session-control/start CLI tests: 9/9 pass
full npm test: 2676/2676 pass
```

The new focused test starts a native run, writes terminal output large enough to create an artifact, aborts the run, removes in-memory run/artifact state, and then reads both run events and artifact content back from disk.

## Clean Code Commit

```text
commit: a8d5e5d fix(fabric): persist native session run events
staged files:
  lib/server/control-plane-device-session-artifact-store.js
  lib/server/control-plane-device-session-command.js
  lib/server/control-plane-device-session-start.js
  lib/server/native-chat-run-persistence.js
  lib/server/native-chat-run-store.js
  lib/server/node-rpc-router.js
  test/control-plane-device-session-command.test.js
  test/control-plane-device-session-start.test.js
git diff --cached --check: pass
```

## AWS Deployment

Clean deployment source:

```text
source: git archive HEAD into /tmp/aih-fabric-clean-deploy.H0Dkf3/src
target: ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:/home/ubuntu/aih-fabric-current
command: scripts/fabric-real-vps-deploy.js with --skip-import --skip-build
port: 9527
source artifact sha256: 4f77e9c7415c3941c59e7d31fdaf4f8340751480106b3bab96df638ce63c36ba
remote pid: 262206
```

AWS `/readyz` after deployment:

```text
http://127.0.0.1:9527/readyz
ok=true
ready=false
accounts: codex=0, gemini=0, claude=0, agy=0, opencode=0
```

`ready=false` is expected for AWS because this deployment used `--skip-import`; AWS is still the control plane/broker/relay-capable node, not a provider runtime host.

Local node server was restarted on the same default port:

```text
old local pid: 51672
new local pid after restart: 55595
local readyz: ok=true, ready=true
local accounts: codex=1, gemini=1, claude=5, agy=7, opencode=1
```

`/opt/homebrew/bin/aih` resolves to this repository through `/opt/homebrew/lib/node_modules/ai_home -> /Users/model/projects/feature/ai_home`, so the local server process used current source.

## Real AWS -> Local Node Session

Registry readback:

```text
node bin/ai-home.js fabric nodes --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json

profile: cp-51hq70
authorizedStatus=200
registry counts: nodes=2, relayNodes=2, projects=2, runtimes=4, transports=2
aws-current-node: relayNode=true, projectHost=true, runtimeHost=false
local-mac-remote-node: runtimeHost=true, providers=agy,claude,codex,opencode
```

First start attempt without an account id returned HTTP 400 with `remote_node_session_start_failed`; this is correct because native start requires an explicit local account id. The real run used local Codex OAuth account `4`.

Start command:

```text
node bin/ai-home.js fabric session start local-mac-remote-node \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --provider codex \
  --account-id 4 \
  --project-path "/Users/model/projects/feature/ai_home" \
  --prompt "AIH persistence smoke: please reply exactly AIH_PERSISTENCE_SMOKE_OK and do not modify files." \
  --json
```

Start result:

```text
status=200
accepted=true
provider=codex
accountId=4
runId=9a8ffe98-58f1-4bc3-9f3c-40454ccfe401
initial cursor=1
```

Event read through AWS showed real terminal output:

```text
OpenAI Codex v0.142.3
model=gpt-5.5
directory=~/projects/feature/ai_home
prompt text visible in TUI
cursor advanced to 75
event types: ready + terminal-output
```

The Codex TUI also reported `codex_apps` MCP `token_expired` and later `Your access token could not be refreshed`; this is a real provider/account runtime condition. It did not block Fabric session-control verification.

Real controls:

```text
message:
  status=200
  accepted=true
  commandId=fabric-message-17ni266
  cursor=191

slash /status:
  status=200
  accepted=true
  commandId=fabric-slash-dn4iyk
  cursor=316
  status panel showed Account rich8gems@gmail.com (Pro), model gpt-5.5, session 019f0eb9-e050-7510-8301-f861e937d09f

stop:
  status=200
  accepted=true
  commandId=fabric-stop-1re1npr
  cursor=326
```

Immediate post-stop events:

```text
runId=9a8ffe98-58f1-4bc3-9f3c-40454ccfe401
status=completed
cursor=327
events after cursor 300: terminal-output=25, aborted=1, done=1
completed=true
```

Disk evidence before restart:

```text
/Users/model/.ai_home/fabric/native-runs/9a8ffe98-58f1-4bc3-9f3c-40454ccfe401.events.jsonl
  size=157291 bytes
  tail includes cursor 326 type=aborted and cursor 327 type=done

/Users/model/.ai_home/fabric/native-runs/9a8ffe98-58f1-4bc3-9f3c-40454ccfe401.json
  completed=true
  eventCursor=327
  provider=codex
  accountId=4
  projectPath=/Users/model/projects/feature/ai_home
```

Local node server restart:

```text
kill old local server pid 51672
restart default 9527
new listener pid: 55595
readyz: ok=true, ready=true
relay connect and registry agent remained running
```

Post-restart read through AWS:

```text
node bin/ai-home.js fabric session events local-mac-remote-node \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --run-id 9a8ffe98-58f1-4bc3-9f3c-40454ccfe401 \
  --cursor 320 \
  --limit 20 \
  --json

http.status=200
result.status=completed
result.cursor=327
result.completed=true
result.persisted=true
events: terminal-output=5, aborted=1, done=1
```

Conclusion:

- Completed native run events now survive local node server restart.
- The control plane can still read the completed run through AWS `9527` and the existing relay path.
- Active runs still read memory first; persisted reads are used after memory cleanup/restart.
- AWS remains credentials-free in this test; all provider runtime execution happened on `local-mac-remote-node`.
