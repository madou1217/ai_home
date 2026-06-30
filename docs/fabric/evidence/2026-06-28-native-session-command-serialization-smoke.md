# 2026-06-28 Native Session Command Serialization Smoke

## Scope

This evidence records the fix for the real TUI input race found during
`fabric session control` verification:

- concurrent `message` and `slash` commands for the same native run must not be
  written into the PTY input window at the same time;
- idempotent retries must reuse the in-flight command instead of writing again;
- independent runs must remain independent and must not block each other;
- failed commands must still let the same-run queue continue after the settle
  window.

No mock AWS data was used. No retired `152.*`, `155.*`, or `39.104.*` servers
were touched. No product port other than default `9527` was opened. No provider
credentials were imported to AWS.

## Code Surface

| File | Purpose |
|---|---|
| `lib/server/control-plane-device-session-command.js` | Adds per-session command queue, in-flight idempotency reuse, and a settle delay before the next same-run command can write to the native PTY |
| `test/control-plane-device-session-command.test.js` | Covers same-session serialization, different-session independence, in-flight idempotency, and failed-command queue continuation |

## Clean Code Commit

```text
commit: 975badd fix(fabric): serialize native session commands
staged files:
  lib/server/control-plane-device-session-command.js
  test/control-plane-device-session-command.test.js
```

Design notes:

- queue key is `sessionId`, so the lock is scoped to one native run;
- cached command key remains `sessionId + idempotencyKey`, so retries preserve
  the existing command semantics;
- `message`, `slash`, `approval_response`, and `stop` share the same queue,
  because they all target the same interactive native session;
- default settle delay is `240ms`, which is intentionally longer than the
  existing native submit delay (`PTY_SUBMIT_DELAY_MS=160ms`) so the PTY has time
  to flush the previous submit before the next command writes.

## Local Verification

Commands:

```text
node --test test/control-plane-device-session-command.test.js test/fabric-session-control-client.test.js test/server-node-rpc-wiring.test.js
node --test test/control-plane-device-session-start.test.js test/control-plane-device-session-catalog.test.js test/server-node-rpc-wiring.test.js test/node-rpc-router.test.js
npm test
```

Results:

```text
session command/control/router focused tests: 29/29 pass
session start/catalog/router focused tests: 73/73 pass
full npm test: 2680/2680 pass
```

The focused tests prove:

- a second same-run command waits until the first command and settle gate finish;
- a different run can continue while the first run is waiting;
- a duplicate in-flight idempotency key does not write to the PTY twice;
- after a failed command, the queue still settles and accepts the next command.

## Deployment

Local default `9527` was restarted from the current repository code:

```text
local pid: 39699
local readyz: ready=true
accounts: codex=1, gemini=1, claude=5, agy=7, opencode=1
```

AWS current was deployed from clean source:

```text
target: ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:/home/ubuntu/aih-fabric-current
port: 9527
source artifact sha256: 298301c5a5ac4cb41afd4778336a3dbcd2545f536ed475209c535d63b23083e2
remote pid: 263117
deploy flags: --skip-import --skip-build
```

AWS `/readyz` after deployment:

```text
http://127.0.0.1:9527/readyz
http.status=200
ready=false
accounts: codex=0, gemini=0, claude=0, agy=0, opencode=0
```

`ready=false` is expected for AWS because provider credentials were not
imported. In this topology AWS is the control plane/broker/relay-capable node;
the real Codex runtime remains on `local-mac-remote-node`.

The local long-running node services were also checked after reinstalling them
to the repository CLI path:

```text
relay plist: ~/Library/LaunchAgents/com.clawdcodex.ai_home.node-relay.local-mac-remote-node.plist
registry plist: ~/Library/LaunchAgents/com.clawdcodex.ai_home.fabric-registry-agent.local-mac-remote-node.plist
ProgramArguments[0]: /Users/model/projects/feature/ai_home/bin/ai-home.js
registry agent flags include --relay-status online and --transport relay=online
```

This matters because the first failed readback was caused by launchd still
running the old global `/opt/homebrew/bin/aih` service, not by AWS.

## Real AWS -> Local Native Session

Target:

```text
endpoint: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
node: local-mac-remote-node
provider: codex
accountId: 4
projectPath: /Users/model/projects/feature/ai_home
runId: 1d46a3d3-95d4-4ab0-b8da-fec4eb5a0efe
```

Concurrent commands were sent through AWS to the same local native Codex run:

```text
message: SERIALIZATION_SMOKE_MESSAGE_20260628 keep this separate from slash command.
slash: /status
```

Results:

```text
message command: HTTP 200, accepted=true, cursor=11
slash command: HTTP 200, accepted=true, cursor=12
events after cursor 10: message text appeared separately from /status
concatenationHits: []
```

The negative check looked for the previous failure pattern:

```text
/statusSERIALIZATION...
SERIALIZATION.../status
```

No concatenated terminal input was found.

Stop and cleanup:

```text
stop: HTTP 200, accepted=true
final events cursor=21
final status=completed
terminal event type includes aborted
```

## Runtime Note

The real Codex TUI still emitted provider-runtime token warnings in this test
environment. That is an account/provider runtime issue and not a Fabric command
serialization blocker. The serialization smoke only claims that AWS -> relay ->
local native session command delivery no longer concatenates concurrent same-run
inputs.
