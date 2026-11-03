# TUI Harness Agent Session Abstraction Plan

**Status:** planning + phase 0 foundation
**Date:** 2026-11-03
**Scope:** TUI/CLI harnesses only. Desktop sessions (ZCode Desktop, WorkBuddy/WorkBuddyCN, IDE bridges) are out of scope.

## 1. Goal

Give every TUI harness one provider-neutral session/interaction contract, so a consumer
(terminal title, WebUI, peer, audit) can subscribe to "turn started", "needs approval",
"needs an answer", "plan confirmation" without knowing whether the harness speaks ACP,
Codex app-server, Claude stream-json/MCP, OpenCode serve, or only a PTY.

ACP is one transport. It is not the abstraction.

## 2. In-scope harnesses (15)

| Harness | Adapter | Transport | Phase |
| --- | --- | --- | --- |
| codex | codex-app-server | app-server WS JSON-RPC | 2 |
| claude | claude-print-mcp / claude-tui-hook | stream-json + MCP / PTY + hooks | 3 |
| gemini | acp-stdio | gemini --acp | 1 |
| cline | acp-stdio | cline --acp | 1 |
| codebuddy | acp-stdio | --acp | 1 |
| codebuddycn | acp-stdio | --acp (inferred) | 1 |
| qoder | acp-stdio | --acp | 1 |
| qodercn | acp-stdio | --acp (inferred) | 1 |
| kimi | acp-stdio | kimi acp | 5 |
| opencode | acp-stdio (fallback) / opencode-serve (planned) | opencode acp / serve | 4 |
| grok | pty-tui (today) / acp-stdio (account pending) | PTY / grok agent stdio | 5 |
| agy | pty-tui | PTY / --print | 6 |
| kiro | pty-tui | PTY | 6 |
| pi | pty-tui | PTY | 7 |
| dsh-tui | pty-tui | PTY | 7 |

Out of scope: zcode (desktop session), workbuddy, workbuddycn, dsh (web profile), IDE/desktop bridges.

## 3. Layering (mirrors aih peer)

```text
aih agent router (list / capabilities / probe)
        -> lib/agent-session/facade.js
        -> registry.js (provider -> ordered adapter candidates)
        -> adapters/* (ACP / app-server / stream-json+MCP / serve / pty)
        -> event bus + interaction router
        -> listeners (session-state, terminal-title, webui-events, audit)
```

## 4. Canonical contract

Reuse `aih.chat.event.v1` and `canonical-interaction-payload.js`:

- events: session.created/closed, turn.started/completed/failed/interrupted,
  timeline.item.started/delta/updated/completed, interaction.requested/updated/resolved/expired,
  stream.error
- interactions: `approval` | `question` | `plan_confirmation`
- decisions: `{choiceId}` | `{action:'submit',answers}` | `{action:'accept'|'decline'|'cancel'}`
- capabilities: `support('native'|'emulated'|'unsupported', reason)`

## 5. Adapter interface

```js
createAdapter({ sessionId, provider, transport, context }) -> {
  id, provider, transport,
  open({ newSession, cwd, mode, model }) -> { sessionId, models, modes },
  prompt({ text, images, turnId }) -> { stopReason },
  cancel(reason),
  respond(interactionId, decision),
  subscribe(listener) -> unsubscribe,          // 只发契约事件
  onInteractionRequest(handler) -> unsubscribe, // 需要人回答时回调
  dispose(reason),
  setMode?(modeId), setModel?(modelId)
}
```

`subscribe` 与 `onInteractionRequest` 必须分开：交互请求不能走事件通道，否则
router 记一次、bus 再广播一次，就成了两个 requested。

Rules:

- Adapter emits canonical events; facade adds envelope, fans out, owns the interaction router.
- One interaction has exactly one responder; listeners are observers.
- Unsupported interaction fails closed with a coded error; never auto-allow.
- No provider-name dispatch outside the registry.

## 6. Per-harness mapping

| Harness | Native interaction | Canonical kind | Response |
| --- | --- | --- | --- |
| codex | item/tool/requestUserInput | question | answers |
| codex | command/file/permissions requestApproval | approval | choice / decision |
| codex | turn/plan/updated + workflow | plan_confirmation (emulated) | accept/decline |
| claude | MCP approve tool | approval | allow/deny |
| claude | ExitPlanMode | plan_confirmation | accept/decline |
| claude | PermissionRequest / Notification / Elicitation hooks | question/approval | typed choice |
| gemini/cline/codebuddy/qoder/kimi | session/request_permission | approval | optionId |
| opencode | permission.asked | approval | reply |
| agy/kiro/pi/dsh-tui | PTY prompt detector | question/plan_confirmation (emulated) | typed choice |
| grok | ACP pending / PTY | approval (pending) / question (emulated) | pending |

## 7. Phases

- **Phase 0（已完成，865b6243）**: contracts, event bus, interaction router, session shell, facade, registry, matrix tests, `aih agent adapters|capabilities|probe`.
- **Phase 0.5（已完成，931c8872）**: session-state consumer —— interaction.requested 直接驱动终端标题的 `? ...` attention 帧。
- **Phase 1（adapter 已落地，e399b37e）**: acp-stdio + acp-http-sse；gemini/cline/codebuddy/codebuddycn/qoder/qodercn/kimi/opencode 都解析到 acp-stdio。acp-http-sse 仍是 fail-closed（缺端点实证）。
- **Phase 2（已完成，e399b37e）**: codex-app-server adapter。
- **Phase 3（已完成，e399b37e）**: claude-stream-mcp adapter；TUI hook 变体未做（print+桥已覆盖三种交互）。
- Phase 4: opencode-serve adapter（现在 opencode 走 acp-stdio 兜底）。
- Phase 5: grok 的 ACP 入口取证（现在走 pty）。
- **Phase 6（pty 已落地，510f7956）**: pty-tui + 去重/收回；agy/kiro/pi/dsh-tui 已解析到 pty。
- **Phase 7（部分）**: session-state consumer 已完成；WebUI 事件、审计/指标未接。

## 7.1 Known gaps（实测前不要当成已支持）

- **gemini 真机已跑通（2026-11-03，gemini 0.66.0 + 账号 #3）**：ACP 握手 → session/new → 真实模型回合 →
  run_shell_command → 审批 → 标题帧 `? 允许执行「…」吗？` → 应答 → 帧清空 → 文件落盘。
  其余 adapter（codex/claude/pty）仍未跑过真实 harness，测试只证明协议形状自洽。
- **gemini 账号的接入点缺一个变量（已修）**：placeholder（express）账号虽然带 vertex 标记，
  实际走 API-key 分支，只认 `GOOGLE_GEMINI_BASE_URL`；缺它就直打 Google（400 API key not valid，
  网关日志里没有这条请求）。现在 `geminiCliEndpointEnv` 在 placeholder 分支同时下发两个变量；
  真实 project 账号仍然只给 VERTEX（authType=vertex-ai 不读另一个）。守卫见
  `test/gemini-endpoint-env.test.js`。
- gemini 的 `write_file` 在未信任目录里仍然 failed（与 fs/* 实现无关；同一轮 shell 工具成功）。
- acp-http-sse：缺三条实证（POST 路径、SSE 端点与事件名、sessionId 关联方式），open() 直接报 `acp_http_endpoint_unavailable`。
- acp-http-sse：缺三条实证（POST 路径、SSE 端点与事件名、sessionId 关联方式），open() 直接报 `acp_http_endpoint_unavailable`。
- claude：resume（`--resume`）未接；AskUserQuestion 是否真被 permission tool 截获未验；token 需经 0600 临时 launch context 文件（现有 MCP 工具只认 `AIH_LAUNCH_CONTEXT`）。
- codex：`expire` 未实现（plan_confirmation 是通知派生、没有 JSON-RPC id）；APPROVAL_MODE_POLICIES 未导出，选项集合只能从请求的 availableDecisions 投影。
- pty：`prompt()` 只保证「输入已交给终端」（stopReason=`submitted`），没有回合完成信号；plan 提示只有 codex 参数化的 detector 认。

## 8. Acceptance

- `aih agent adapters` lists every in-scope harness with adapter, transport, interaction capabilities, evidence.
- Matrix test: no in-scope harness without a row; no adapter without contract; no capability without evidence.
- Fan-out test: one interaction.requested reaches N listeners; one responder; duplicate response is stale.
- Existing ACP/chat tests stay green.
- Desktop harnesses are not registered.

## 9. Multi-agent ownership

| Agent | Owns |
| --- | --- |
| foundation (main) | contracts.js, event-bus.js, interaction-router.js, session.js, facade.js, registry.js, index.js, matrix/contract/bus/router tests |
| ACP | adapters/acp-stdio.js, adapters/acp-http-sse.js, test/agent-session-acp.test.js |
| Codex | adapters/codex-app-server.js, test/agent-session-codex.test.js |
| Claude | adapters/claude-stream-mcp.js, test/agent-session-claude.test.js |
| PTY | adapters/pty-tui.js, test/agent-session-pty.test.js |

Agents must not edit files outside their ownership. Integration and registry flips are owned by the foundation agent.
