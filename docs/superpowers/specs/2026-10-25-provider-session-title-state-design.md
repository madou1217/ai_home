# Provider Session State and Title Events Design

## Goal

让 `aih` 的交互式终端标题消费一份按会话隔离、可去重、可处理乱序事件的 provider session state，从官方 session hook、Codex question/approval、重试、错误/中断、路由和 statusline 统一产出轮播帧。

## Invariants

- 会话主键是 `(provider, nativeSessionId, projectPath)`；`correlationId` 只能作为短期别名，不能替代 native session identity。
- 一个会话的事件不能更新另一个会话；事件按 `eventId` 去重，旧 `revision` 或旧时间戳不能覆盖新状态。
- 官方 hook 优先；没有官方 hook 时才使用 native event 或 PTY fallback，并在状态中记录来源。
- 标题来源只返回完整字符串数组；标题 Facade 负责轮播、去重、错误 TTL 和终端写入，不判断 provider 名。
- 所有持久化写入使用临时文件加 rename；不写凭据，不把 prompt 内容无限写入日志。
- hook 安装只使用已有显式安装入口，不在 server 启动时覆盖用户配置。

## Event model

归一化事件包含：

- `session-opened`, `session-closed`
- `turn-started`, `turn-updated`, `turn-completed`, `turn-failed`, `turn-interrupted`
- `question-opened`, `question-cleared`
- `retry-updated`
- `statusline-updated`
- `route-updated`

每个事件包含 `eventId`, `provider`, `sessionId`, `projectPath`, `correlationId`, `source`, `at`, `revision` 和受限的 payload。状态 store 只保留当前快照与有限的最近事件摘要。

## State and title flow

```text
official hook / native adapter / PTY fallback
        -> normalizeProviderSessionEvent
        -> ProviderSessionStateStore.apply
        -> session state change notification
        -> title source registry
        -> terminal-title facade rotation
```

Codex interactive observer 与 provider hook receiver 都写入同一个 store；WebUI session event bus 继续接收同一归一化事件。标题来源通过 `getSessionState()` 读取当前会话快照，不直接读 hook 文件或解析 provider 输出。

## Provider adapters

- Claude / Codex / JSON hook providers：继续使用 `provider-session-hook-config` 与 `provider-hook-event-normalizer`，增加 question/error/interrupted/statusline 字段归一化。
- Codex：把 `codex-interaction-observer` 的 prompt open/clear 写入 state store；Codex app-server hook wrapper 负责在 remote/WS 侧维持同一 correlation alias。
- OpenCode：继续使用插件桥，把 execution failure/interrupted/permission events 写入 state store。
- 无官方能力的 provider：PTY 错误识别和 retry observer 作为明确标注的 fallback。

## Verification

- 临时 `node --test` RED/GREEN checks for state isolation, deduplication, ordering, question/error/retry transitions and title frame production.
- Real hook sender/receiver probe for Claude and Codex.
- Real Codex PTY prompt and interrupted/error observation.
- Two simultaneous tmux sessions with the same provider to prove state isolation.
- JS syntax checks, Go build where touched, changed-file lint, and real pane title sampling.
