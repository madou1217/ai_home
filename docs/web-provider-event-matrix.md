# Web Provider Event Matrix

更新时间：2026-04-12

这份说明只记录当前仓库源码里已经确认的能力，不包含主观推测。

## 已确认事件来源

### Codex

- Web API Key / 代理流：
  - 在 [webui-chat-routes.js](/Users/model/projects/feature/ai_home/lib/server/webui-chat-routes.js) 的 OpenAI chunk adapter 中，会把 `choice.delta.reasoning_content` 转成 `thinking` 事件。
  - 同一处会把 `choice.delta.content` 转成 `delta` 事件。
- Native / Session Snapshot：
  - 在 [session-reader.js](/Users/model/projects/feature/ai_home/lib/sessions/session-reader.js) 中，`function_call` 会被转成 `assistant_tool_call`。
  - `exec_command_end` 会被转成 `assistant_tool_result`。
  - 单独的 `function_call_output` 由于结构不足，会要求 `requiresSnapshot = true`，前端应回退重读 snapshot，而不是强行增量拼接。
- Native / Run Stream：
  - 在 [native-session-chat.js](/Users/model/projects/feature/ai_home/lib/server/native-session-chat.js) 中，当前稳定暴露的是 `delta` 和 `terminal-output`。

### Claude

- Web API Key / 代理流：
  - 在 [webui-chat-routes.js](/Users/model/projects/feature/ai_home/lib/server/webui-chat-routes.js) 的 Anthropic SSE 处理里，当前只确认 `content_block_delta.delta.text -> delta`。
  - 当前源码里没有看到与 Codex 等价的 `thinking` 增量事件映射。
- Native / Run Stream：
  - 走 [native-session-chat.js](/Users/model/projects/feature/ai_home/lib/server/native-session-chat.js) 的统一 native stream 解析，当前稳定暴露 `delta` / `terminal-output`。

### Gemini

- Web API Key / 代理流：
  - 通过统一 OpenAI chunk adapter 读取 `choice.delta.content -> delta`。
  - 当前源码里没有确认 Gemini 会稳定提供与 Codex 同等级的 `reasoning_content -> thinking` 事件。
- Native / Run Stream：
  - 走 [native-session-chat.js](/Users/model/projects/feature/ai_home/lib/server/native-session-chat.js) 的统一 native stream 解析，当前稳定暴露 `delta` / `terminal-output`。

## 已确认前端策略

- `after_tool_call` 只对 Codex OAuth 开启。
- `externalPending / watchPending` 只对 Codex 开启。
- `assistant_tool_call` 边界目前只对 Codex 用来触发队列注入。

## 当前不应假设的能力

- 不能假设 Claude 存在与 Codex 等价的 reasoning 增量事件。
- 不能假设 Gemini 存在与 Codex 等价的 tool-call 边界事件。
- 不能把 `function_call_output` 直接当成稳定增量消息拼接到现有 assistant 文本里。
