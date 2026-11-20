# Session status hooks by provider/harness

## Scope

This audit covers the session running indicator used by the WebUI project/workbench (the `provider-session-state` hook snapshots), not the account-level activity counters. The reported failure was: a session had stopped long ago, but an attached `aih <provider>` process kept it marked as running.

## Current matrix

| Provider | Session sync mode | Signal source | Current accuracy |
| --- | --- | --- | --- |
| codex | hook + app-server proxy | `json_hooks` events; app-server `turn/started`, `turn/completed`, `thread/status/changed`, `thread/closed` | Fixed in this audit: idle/notLoaded clears; active no longer starts a turn |
| claude | hook | `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Notification`, `Stop`, `StopFailure`, `SessionEnd` | Stop is authoritative; `idle_prompt` still maps to waiting and needs a decision |
| gemini | hook | `SessionStart`, `BeforeAgent`, `AfterAgent`, `SessionEnd` | Turn-scoped; accurate when hooks fire |
| agy | hook | `PreInvocation`, `PostInvocation`, `Stop` | `Stop` with `fullyIdle=false` still maps to working; verify whether that means a live subagent |
| grok | hook | `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `SessionEnd` | Turn-scoped; accurate when hooks fire |
| opencode | plugin bridge | v2 `session.execution.started` / terminal events; v1 `session.idle` / message events | Plugin dedupes per session; needs real v1/v2 acceptance |
| qoder / qodercn | polling | CLI session store/probes | No per-session hook; account activity only. UI should not equate runtime with running |
| kiro | polling | `messages.jsonl` / session store probes | Decisive session records can clear; active-turn probes need acceptance |
| codebuddy family | polling | native JSONL / session activity probes | No per-session hook; account activity only |
| kimi | unavailable | none | Must show unknown/unavailable, never running from an attached process |
| zcode | unavailable | none | Must show unknown/unavailable, never running from an attached process |
| cline | unavailable | none | Must show unknown/unavailable, never running from an attached process |

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

## Optimization plan

1. **Codex**: keep the app-server as the authoritative source; never derive a turn from thread attachment. Retain `turn/started` / `turn/completed` as the only turn boundaries.
2. **Claude**: `idle_prompt` is an idle notification, not a permission question. Decide whether it should clear to idle instead of `waiting`; if the UI needs a separate "needs input" state, expose `waiting` separately from running instead of counting it in `runningSessionKeys`.
3. **AGY**: verify `Stop` with `fullyIdle=false`; if false means "no active subagent", map it to completed rather than working.
4. **Gemini / Grok**: hooks are already turn-scoped; add a bounded stale-working fallback per provider if a terminal hook is lost.
5. **OpenCode**: run a real v2 and v1 session; confirm the plugin's started/terminal pairs cover interrupted/failed turns.
6. **Polling providers (qoder, kiro, codebuddy family)**: do not promote tmux attachment, cursor blink, or a live `aih` process to `sessionTurnActive`. Use only decisive session-store records; otherwise show "estimated/unknown" rather than running.
7. **Unavailable providers (kimi, zcode, cline)**: show "unknown/unavailable"; an attached launcher must never imply a running turn.
