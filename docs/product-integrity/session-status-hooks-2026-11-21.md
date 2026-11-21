# Session status hooks by provider/harness

## Scope

This audit covers the session running indicator used by the WebUI project/workbench (the `provider-session-state` hook snapshots), not the account-level activity counters. The reported failure was: a session had stopped long ago, but an attached `aih <provider>` process kept it marked as running.

## Current matrix

| Provider | Session sync mode | Signal source | Current accuracy |
| --- | --- | --- | --- |
| codex | hook + app-server proxy | `json_hooks` events; app-server `turn/started`, `turn/completed`, `thread/status/changed`, `thread/closed` | Fixed in this audit: idle/notLoaded clears; active no longer starts a turn |
| claude | hook | `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Notification`, `Stop`, `StopFailure`, `SessionEnd` | Fixed in this audit: `idle_prompt` completes the turn; `permission_prompt` still opens a question |
| gemini | hook | `SessionStart`, `BeforeAgent`, `AfterAgent`, `SessionEnd` | Turn-scoped; accurate when hooks fire |
| agy | hook | `PreInvocation`, `PostInvocation`, `Stop` | Fixed in this audit: `Stop` completes the turn; `continuationActive=true` keeps it working; `fullyIdle` only reports background tasks |
| grok | hook | `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `SessionEnd` | Turn-scoped; accurate when hooks fire |
| opencode | plugin bridge | v2 `session.execution.started` / terminal events; v1 `session.idle` / message events | Plugin dedupes per session; needs real v1/v2 acceptance |
| qoder / qodercn | polling | CLI session store/probes | No per-session hook and no store-backed turn probe: unknown unless traffic says otherwise. tmux pane activity is no longer turn evidence |
| kiro | polling | `messages.jsonl` / session store probes | Store records can prove activity/end; tmux pane activity is no longer turn evidence |
| codebuddy family | polling | native JSONL / session activity probes | No per-session hook and no store-backed turn probe: unknown. tmux pane activity is no longer turn evidence |
| kimi | unavailable | none | Must show unknown/unavailable, never running from an attached process |
| zcode | unavailable | none | Must show unknown/unavailable, never running from an attached process |
| cline | polling | session store (`started_at` / `ended_at` / `status` / pid) | Decisive terminal records can clear; unknown when no store record |

## Confirmed Codex bug

The app-server proxy mapped `thread/status/changed` as:

```js
type = statusType === 'active' ? 'session:turn-started' : 'session:turn-updated';
```

`session:turn-updated` transitions to `working`. Therefore an `idle` thread status from a still-attached Codex app-server wrote `working` and never cleared. The state only cleared if a later `turn/completed` happened to arrive.

### Fix

- `lib/server/codex-app-server-stdio-proxy-resume.js` now treats `thread/status/changed` as a **status observation**, not a turn start:
  - `idle` / `notLoaded` → `session:turn-completed`
  - `systemError` → `session:turn-failed`
  - `active` / other → `session:updated` (does not create a working turn)
  - the status string is included in the payload for diagnosis.
- `webuisessionhookapi/normalizer.go` maps `AppServerThreadStatusChanged` from the payload status with the same rules, and no longer falls back to `turn-updated`.
- Only `turn/started` starts a Codex turn.

### Real verification

Against the local hook endpoint:

1. `AppServerTurnStarted` → state file `turnState=working`.
2. `AppServerThreadStatusChanged` with `status=idle` → state file `turnState=completed`; last event `turn-completed`.
3. The test state file was removed afterwards.

Commit: `e547acd0 fix(session): treat Codex idle thread status as completed`.

## Confirmed Claude bug

Claude Code's `Notification` hook with `notification_type=idle_prompt` was classified as a question:

```go
var waitingNotificationTypes = map[string]bool{
    "permission_prompt":        true,
    "worker_permission_prompt": true,
    "idle_prompt":              true,
    ...
}
```

That produced `question-opened`, which sets `turnState=waiting` and stores a question whose text is the idle message ("Claude is waiting for your input"). `waiting` counts as running (`isRuntimeActiveTurn`), so an attached but idle `aih claude` process appeared to be running indefinitely; every idle notification also refreshed `lastEventAt`, so the 10-minute stale guard never applied.

### Fix

- `idle_prompt` moved out of `waitingNotificationTypes` into `idleNotificationTypes`.
- It now resolves to `session:turn-completed`: the turn is over and the CLI is waiting for the next prompt.
- Its `message` is no longer copied into the event payload's `question`/`notice` fields, so the UI does not render an idle notice as a pending question.
- `permission_prompt`, `worker_permission_prompt`, `agent_needs_input` and `elicitation_dialog` still open a question and remain `waiting`.

### Real verification

Against the local hook endpoint with a fresh session:

1. `SessionStart` → `session-opened`.
2. `UserPromptSubmit` → `turnState=working`.
3. `Notification(idle_prompt)` → `turnState=completed`, `lastEvent=turn-completed`, no question.
4. `Notification(permission_prompt)` → `turnState=waiting` with the permission text as the question, confirming no collateral change.

The test session state file was removed afterwards.

Commit: `7fc288a7 fix(session): treat Claude idle_prompt as turn completion`.

## Confirmed AGY bug

AGY 1.5.6's own hook documentation (embedded in the installed `agy` binary) defines the `Stop` contract as:

```json
{
  "executionNum": 1,
  "terminationReason": "NO_TOOL_CALL",
  "error": "",
  "fullyIdle": true,        // true if all background tasks are done
  "continuationActive": true // true after a Stop hook kept the agent going this turn
}
```

`Stop` fires "when the execution loop terminates". Therefore:

- `fullyIdle=false` means background tasks are still running, **not** that a turn is running.
- `continuationActive=true` means a Stop hook asked the agent to continue in this turn, which is the only Stop payload that represents live work.
- Only a `decision: "continue"` output re-enters the loop.

The previous mapping treated `fullyIdle=false` as `session:turn-updated`, so every normal AGY stop with pending background tasks left the session `working` forever.

### Fix

- The provider hook sender now forwards `continuationActive` alongside `fullyIdle` (both are plain booleans, no content fields).
- AGY `Stop` maps to:
  - `ERROR` / non-empty error → `session:turn-failed`
  - `continuationActive=true` → `session:turn-updated`
  - otherwise → `session:turn-completed`, regardless of `fullyIdle`

### Real verification

The Go sender (`aih-server __provider-hook`) posted real payloads to the local receiver:

| Event | Payload | Result |
| --- | --- | --- |
| `PreInvocation` | invocation 1 | `working` |
| `Stop` | `fullyIdle=false`, `continuationActive=false` | `completed` |
| `PreInvocation` | invocation 1 | `working` |
| `Stop` | `fullyIdle=true`, `continuationActive=false` | `completed` |
| `PreInvocation` | invocation 1 | `working` |
| `Stop` | `fullyIdle=false`, `continuationActive=true` | `working` |
| `Stop` | `terminationReason=ERROR`, `error=boom` | `failed` |

The `continuationActive=true` row also proves the sender forwards the flag; without it the receiver would have produced `completed`.

Commit: `c8798c4c fix(session): treat AGY Stop as completion unless continuing`.

## Confirmed tmux false-positive (polling providers)

`BuiltinHarnessProbes` registered a `tmux-pane` probe for every harness. It used tmux's `window_activity` / `session_activity` as "last turn activity" and, for non-hook providers, gave it `AuthorityTurn`. Those timestamps advance on any pane output, including a TUI clock, statusline refresh, spinner or prompting redraw. An unattached, long-idle `aih <provider>` terminal therefore looked like a running turn on every poll, and `MarkSessionTurn` kept `sessionTurnActive` true.

### Real reproduction and fix verification

A real tmux server was started on an existing enabled codebuddycn account's socket, with a registry entry and a 1s redraw loop. It was never attached.

| Phase | inFlight | sessionTurnActive | runtimeSessions | runtimeAttached |
| --- | ---: | --- | ---: | ---: |
| before fix | 1 | true | 1 | 0 |
| after fix | 0 | false | 1 | 0 |

After the verification the temporary tmux server was killed. `runtimeSessions` still reports the open terminal; it just no longer claims a running turn.

### Fix

- Removed `tmux-pane` from `BuiltinHarnessProbes`.
- Turn signals now come only from store-backed probes (`cline-session-store`, `kiro-session-store`) or from provider hooks.
- Providers without store evidence stay unknown: no `sessionTurnActive`, no inflated `inFlight`.
- Terminal presence continues to be reported separately through `runtimeSessions` / `runtimeAttached`.

Commit: `f8adec80 fix(session): stop treating tmux pane activity as a running turn`.

## Optimization plan

1. **Codex**: keep the app-server as the authoritative source; never derive a turn from thread attachment. Retain `turn/started` / `turn/completed` as the only turn boundaries.
2. **Claude**: done — `idle_prompt` no longer opens a question and completes the turn. Remaining optional work: if the UI wants a "needs attention" hint for idle sessions, expose it as a separate flag instead of reusing `waiting`/running.
3. **AGY**: done — `Stop` completes the turn; `continuationActive=true` is the only Stop payload treated as working.
4. **Gemini / Grok**: hooks are already turn-scoped; add a bounded stale-working fallback per provider if a terminal hook is lost.
5. **OpenCode**: run a real v2 and v1 session; confirm the plugin's started/terminal pairs cover interrupted/failed turns.
6. **Polling providers (qoder, kiro, codebuddy family)**: done — tmux pane activity was removed as turn evidence. Only store-backed probes can produce a turn; everything else stays unknown.
7. **Unavailable providers (kimi, zcode, cline)**: show "unknown/unavailable"; an attached launcher must never imply a running turn.
