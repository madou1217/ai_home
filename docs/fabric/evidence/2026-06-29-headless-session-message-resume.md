# 2026-06-29 Headless Session Message Resume Evidence

## Scope

- Target: AWS current only.
- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- Remote dir: `/home/ubuntu/aih-fabric-current`
- Port: `9527`
- Runtime commit: `4042ad4936572c7948343c8081fa52f7b67f8e26`
- Running server PID after deploy: `382206`

## Code change

- `fabric session message` no longer writes text into a completed or headless `opencode` / `claude` PTY run.
- Completed headless runs now resume through `startNativeDeviceSession()` with the recorded provider/account/project/session metadata.
- Busy headless runs return `headless_session_run_still_running` instead of accepting input that the headless CLI will not consume as a user turn.
- Headless slash commands return `headless_session_slash_unsupported` instead of a generic remote command failure.
- Opencode `step_finish` with reason `tool-calls` is treated as a non-terminal stream event, not as an error.

## Deploy evidence

Local archive:

```text
82649975804571fcba846ea081d0be16ddfe6fbddde139b32bbdfbfa6928e95f  /tmp/aih-fabric-source-4042ad4.tar.gz
```

Remote archive verification:

```text
82649975804571fcba846ea081d0be16ddfe6fbddde139b32bbdfbfa6928e95f  source-4042ad4.tar.gz
DEPLOYED_GIT_HEAD=4042ad4936572c7948343c8081fa52f7b67f8e26
```

AWS `/readyz` after restart:

```json
{
  "ok": true,
  "service": "aih-server",
  "ready": true,
  "accounts": {
    "codex": 1,
    "gemini": 0,
    "claude": 4,
    "agy": 7,
    "opencode": 1
  }
}
```

## Test evidence

Local full test:

```text
npm test
tests 2807
pass 2807
fail 0
duration_ms 149527.755834
```

AWS focused command test:

```text
node --test test/control-plane-device-session-command.test.js
tests 17
pass 17
fail 0
```

Earlier AWS focused bundle on the same change set before the final commit marker cleanup:

```text
node --test test/control-plane-device-session-command.test.js test/native-session-chat.test.js test/node-rpc-router.test.js
tests 106
pass 106
fail 0
```

## Real AWS session evidence

### 1. Base opencode run completed

Command:

```bash
node bin/ai-home.js fabric session start aws-current-node --provider opencode --prompt "请只回复 AIH_HEADLESS_BASE_OK" --timeout-ms 120000 --json
```

Result:

```text
parentRunId=883ad6cd-8cf4-4844-b616-3f8f0db2a80a
sessionId=ses_0ee19adb2ffeRSr033fSXJbXnK
transport=webrtc
completed=true
marker=AIH_HEADLESS_BASE_OK
eventTypes=ready,session-created,delta,result,done
```

### 2. Message on completed parent resumes a new run

Command:

```bash
node bin/ai-home.js fabric session message aws-current-node --run-id 883ad6cd-8cf4-4844-b616-3f8f0db2a80a --text "请只回复 AIH_HEADLESS_RESUME_MESSAGE_OK" --timeout-ms 120000 --json
```

Result:

```text
accepted=true
resumed=true
resumedFromRunId=883ad6cd-8cf4-4844-b616-3f8f0db2a80a
newRunId=c63d4830-b0a2-4134-96b5-23a8e178008e
sessionRef=ses_0ee19adb2ffeRSr033fSXJbXnK
messageTransport=webrtc
eventsCompleted=true
eventsTransport=relay
eventsFallbackFrom=webrtc
eventsFallbackReason=remote_webrtc_session_closed
marker=AIH_HEADLESS_RESUME_MESSAGE_OK
```

The relay fallback on the final event read is expected when the prior WebRTC runtime session has closed; the request remains successful and evidence preserves the fallback decision.

### 3. Message after server restart resumes from persisted run metadata

After deploying and restarting AWS as PID `382206`, the same parent run still resumed from persisted native-run metadata:

```bash
node bin/ai-home.js fabric session message aws-current-node --run-id 883ad6cd-8cf4-4844-b616-3f8f0db2a80a --text "请只回复 AIH_HEADLESS_PERSISTED_RESUME_OK" --timeout-ms 120000 --json
```

Result:

```text
accepted=true
resumed=true
newRunId=de927631-4bc5-40dd-a160-210b7e221a34
sessionRef=ses_0ee19adb2ffeRSr033fSXJbXnK
transport=webrtc
completed=true
marker=AIH_HEADLESS_PERSISTED_RESUME_OK
eventTypes=ready,delta,result,done
```

### 4. Busy headless run rejects message and can be stopped

Busy run:

```text
runId=6de7e8d1-cc58-4188-83c1-bbd907685d1f
startTransport=webrtc
status=running
```

Message while running:

```text
http=409
blocker=headless_session_run_still_running
transport=webrtc
```

Stop:

```text
http=200
accepted=true
cursor=3
transport=webrtc
```

Final events:

```text
completed=true
eventTypes=ready,session-created,aborted,done
content=""
AIH_HEADLESS_BUSY_DONE not emitted
```

### 5. Headless slash command is explicit unsupported

Command:

```bash
node bin/ai-home.js fabric session slash aws-current-node --run-id 883ad6cd-8cf4-4844-b616-3f8f0db2a80a --command /status --timeout-ms 120000 --json
```

Result:

```text
http=400
blocker=headless_session_slash_unsupported
transport=webrtc
```

## Conclusion

AWS opencode remote development now has a truthful command model:

- `start` creates a real remote run.
- `events` and `attach` read real run state.
- `message` on a completed headless run resumes the same native session and returns a new run id.
- `message` on a busy headless run is rejected with a clear 409 instead of fake acceptance.
- `stop` aborts a busy headless run and leaves auditable `aborted` events.
- `slash` is explicitly unsupported for headless opencode until a provider-native command equivalent exists.
