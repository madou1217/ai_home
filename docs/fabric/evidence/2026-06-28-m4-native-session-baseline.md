# 2026-06-28 M4 Native Session Data Plane Baseline

## Scope

验证 M4 8.0 数据面 smoke：

```text
local browser AWS server profile
-> AWS current server on default 9527
-> local-mac-remote-node over relay
-> real Codex / Claude native CLI process
-> terminal events, slash input, abort
```

本轮只使用本机和 AWS current，不访问旧 `152/155/39.104` 服务器，不新增产品端口。AWS current 继续使用默认 `9527`。

Important boundary: this evidence only proves the remote session data plane can
start a provider CLI process and exchange events/input. It does **not** prove
the product has a native TUI experience. Native TUI experience requires a
client-side shell/viewport that feels like a local TUI: stable terminal surface,
raw key mode, slash input, stop/detach, side rail, resize, and mobile usability.

## Environment

| item | value |
|---|---|
| Date | 2026-06-28 |
| Local cwd | `/Users/model/projects/feature/ai_home` |
| Local browser | Playwright session `aih-76` |
| Control Plane profile | paired AWS profile in browser localStorage |
| AWS endpoint | `http://43.207.102.163:9527` |
| Target node | `local-mac-remote-node` |
| Project path | `/Users/model/projects/feature/ai_home` |

No device token or management key is recorded in this evidence. The browser used the paired profile internally and returned only sanitized status fields.

## Codex Data Plane Prompt Baseline

Real browser API path:

```text
POST http://43.207.102.163:9527/v0/node-rpc/device-node-session-start
GET  http://43.207.102.163:9527/v0/node-rpc/device-node-session-run-events
POST http://43.207.102.163:9527/v0/node-rpc/device-node-session-run-abort
```

Sanitized result:

```json
{
  "ok": true,
  "endpoint": "http://43.207.102.163:9527",
  "nodeId": "local-mac-remote-node",
  "provider": "codex",
  "accountId": "1",
  "model": "gpt-5.5",
  "runIdPresent": true,
  "startStatus": 200,
  "pollCount": 3,
  "cursor": 216,
  "eventTypes": ["ready", "terminal-output"],
  "markerSeen": true,
  "abortStatus": 200,
  "abortAccepted": true,
  "elapsedMs": 8869
}
```

Expected marker:

```text
AIH_M4_REMOTE_CODEX_BASELINE_20260628_OK
```

## Codex Slash Input Baseline

First diagnostic attempt sent `/status` with a `promptId` and correctly failed:

```json
{
  "ok": false,
  "inputStatus": 400,
  "inputPayload": {
    "error": "remote_node_session_run_input_failed"
  },
  "abortStatus": 200,
  "abortAccepted": true
}
```

Direct local diagnosis showed the underlying local error:

```json
{
  "ok": false,
  "phase": "direct_local_input_diagnose",
  "inputStatus": 400,
  "inputError": "native_interactive_prompt_not_active"
}
```

Interpretation: `promptId` is only valid for active approval/interactive prompts. Normal slash/raw input must not attach a `promptId`.

The same AWS relay path passed when `/status` was sent without `promptId`:

```json
{
  "ok": true,
  "endpoint": "http://43.207.102.163:9527",
  "nodeId": "local-mac-remote-node",
  "provider": "codex",
  "startStatus": 200,
  "runIdPresent": true,
  "readySeen": true,
  "inputStatus": 200,
  "inputAccepted": true,
  "inputAppendNewline": true,
  "afterOutputEvents": 2,
  "afterTypes": ["terminal-output"],
  "abortStatus": 200,
  "abortAccepted": true,
  "elapsedMs": 3764
}
```

## Claude Data Plane Prompt Baseline

Real browser API path:

```text
POST http://43.207.102.163:9527/v0/node-rpc/device-node-session-start
GET  http://43.207.102.163:9527/v0/node-rpc/device-node-session-run-events
POST http://43.207.102.163:9527/v0/node-rpc/device-node-session-run-abort
```

Sanitized result:

```json
{
  "ok": true,
  "endpoint": "http://43.207.102.163:9527",
  "nodeId": "local-mac-remote-node",
  "provider": "claude",
  "accountId": "1",
  "runIdPresent": true,
  "startStatus": 200,
  "pollCount": 1,
  "cursor": 25,
  "eventTypes": ["ready", "session-created", "terminal-output"],
  "markerSeen": true,
  "abortStatus": 200,
  "abortAccepted": true,
  "elapsedMs": 3574
}
```

Expected marker:

```text
AIH_M4_REMOTE_CLAUDE_BASELINE_20260628_OK
```

## Discovered Operational Risk

The local server process was observed to be an old argv-started process containing raw `--api-key` and `--management-key` arguments. The AWS current server was already fixed in M3 evidence, but the local server process must be restarted through the secret-store/config path before treating local long-running process hygiene as closed.

This evidence does not print the raw values.

## Verdict

pass for data plane only

M4 8.0 data-plane smoke is complete:

- AWS paired profile can start a real Codex native CLI process on `local-mac-remote-node`;
- AWS paired profile can start a real Claude native CLI process on `local-mac-remote-node`;
- Codex slash/raw input works through the same AWS relay path when no approval `promptId` is attached;
- abort works for all tested native runs.

M4 is not complete yet:

- no native TUI shell/viewport has been validated;
- no dedicated Native Session UI has been validated;
- no mobile viewport slash/approval flow has been validated;
- resize/detach/attach are not proven;
- approval side rail is not proven;
- local server argv secret hygiene still needs a controlled restart and verification.
