# M4 Remote Development Session Plan

## Purpose

M4 的目标不是新增一个旧式专用入口，而是让任意已授权 client 能从 server profile 进入一个可解释、可恢复、可诊断的远程开发会话。

本阶段先冻结概念和协议边界，再进入实现。没有冻结前，不新增客户端页面入口。

## Non-goals

- 不新增独立的旧式专用菜单或页面。
- 不把“远程启动一个 CLI 进程”当作产品完成。
- 不用 mock 数据证明会话能力。
- 不要求 AWS current 以外的旧服务器参与新测试。
- 不新增产品端口；默认继续使用现有 server listener 和默认 `9527`。

## Current Baseline

已证明的底层能力：

- server profile、broker proxy、device pair、device scoped reads 可用。
- AWS current 默认 `9527` 可作为当前唯一 server/broker 测试目标。
- Role Registry 已能展示本机和 AWS current 两个真实 node/relay-node。
- Relay health 已有 `ws_echo_pass`、p95、successRate 和 networkMeasurements evidence。
- broker link 断开诊断和同 `serverId` 恢复已有 evidence。
- 远程 Codex 会话的数据面 smoke 只能作为协议参考，不再作为产品计划完成项。

未完成的产品能力：

- 用户从 server profile 到 node/project/runtime/session 的路径还没有冻结。
- 会话目录、attach、resume、事件去重、stop、approval、artifact 的职责边界还没有统一协议。
- 移动端只是证明 Fabric Nodes 可浏览，不等于远程开发会话可用。

## Topology

```mermaid
flowchart LR
  Client[Client<br/>Mac / Web / PWA / App Shell]
  Profile[Server Profile<br/>direct or broker proxy]
  Server[AIH Server<br/>identity / registry / routing]
  Broker[Outbound Broker<br/>reachable thin route]
  Node[Remote Node<br/>project / runtime host]
  Relay[Relay Node<br/>WSS fallback and measurements]
  Runtime[Provider Runtime<br/>Codex / Claude / AGY / OpenCode]

  Client --> Profile
  Profile -- direct reachable --> Server
  Profile -- broker proxy --> Broker --> Server
  Server --> Node
  Node --> Relay
  Relay --> Server
  Node --> Runtime
  Runtime --> Node
  Node --> Server
  Server --> Client
```

Routing rules:

- Client 永远先选择 ready server profile。
- Server profile endpoint 可以是 direct server，也可以是 broker proxy base。
- Server 只调度已注册且授权的 node/project/runtime。
- Node 上的 provider account 默认留在 node，本阶段不做跨 node credential 搬运。
- Relay 只转发 allowlist route，不读取 provider credentials。

## Primary User Flows

### Company manages home project

```mermaid
sequenceDiagram
  participant C as Company Client
  participant S as AWS Server Profile
  participant H as Home Node
  participant R as Relay
  participant A as Runtime

  C->>S: select server profile
  C->>S: list nodes/projects/runtimes
  S-->>C: Home node + projects + runtime capabilities
  C->>S: create or attach remote development session
  S->>H: authorize project/runtime
  H->>A: open runtime session in project cwd
  A-->>H: semantic events and artifacts
  H-->>R: session stream
  R-->>S: relay frames with seq/ack
  S-->>C: normalized session events
  C->>S: message / slash / stop / approval response
  S->>H: normalized command
```

### Home manages company project

Same flow, with Home Client selecting Company Node. The server must show which account authority is used:

- node-local provider account;
- explicit account grant;
- denied with a visible reason.

### Mobile controls existing session

```mermaid
sequenceDiagram
  participant M as Mobile Client
  participant S as Server Profile
  participant N as Node

  M->>S: list active sessions
  S-->>M: session summaries with status and last event cursor
  M->>S: attach session
  S-->>M: latest snapshot + event cursor
  M->>S: send message or approval response
  S->>N: command with idempotency key
  N-->>S: ack + events
  S-->>M: updated event stream
```

## Functional Matrix

| Capability | M4 requirement | Source of truth | Acceptance evidence |
|---|---|---|---|
| Session catalog | list active and recent remote development sessions by server/node/project/runtime | server session registry | real paired AWS profile returns non-empty session list after a real session is opened |
| Create session | create session from selected node/project/runtime | server -> node route + node runtime registry | real AWS broker/default `9527` request creates a session with stable `sessionId` |
| Attach session | re-enter an existing session from another client | server event store + node active session handle | close client, reopen, attach, cursor resumes without duplicate events |
| Message input | send normal prompt/message | canonical command envelope | command ack includes idempotency key and event cursor |
| Slash input | send slash command without approval prompt id | canonical command envelope | slash command accepted without `promptId`; approval response uses separate command type |
| Stop/abort | stop current run or session with visible state | session state machine | stop changes state and emits lifecycle/session event; no leaked process |
| Approval | approve/reject high-risk request | approval request table + command envelope | approval request visible with prompt id; approve/reject is idempotent |
| Artifacts | expose diff/log/file snippets without flooding stream | artifact refs | large output stored as artifact ref, stream stays responsive |
| Diagnostics | show server/node/transport/session error layer | diagnostic event | failure includes serverId, nodeId, transportId, sessionId, code |
| Recovery | resume after relay/server link interruption | seq/ack/resume token | kill relay/broker; reconnect and continue from last ack |

## State Model

```mermaid
stateDiagram-v2
  [*] --> Draft: client creates intent
  Draft --> Opening: server validates node/project/runtime
  Opening --> Running: node opens runtime session
  Running --> WaitingApproval: runtime emits approval request
  WaitingApproval --> Running: approve/reject command acked
  Running --> Interrupted: transport/link break
  Interrupted --> Running: resume token accepted
  Running --> Stopping: stop requested
  Stopping --> Completed: runtime exits cleanly
  Running --> Failed: runtime or route error
  Interrupted --> Failed: resume deadline exceeded
  Completed --> [*]
  Failed --> [*]
```

## Data Model Delta

```mermaid
erDiagram
  SERVER_PROFILE ||--o{ REMOTE_DEV_SESSION : owns
  NODE ||--o{ REMOTE_DEV_SESSION : hosts
  PROJECT ||--o{ REMOTE_DEV_SESSION : scopes
  AGENT_RUNTIME ||--o{ REMOTE_DEV_SESSION : runs
  REMOTE_DEV_SESSION ||--o{ SESSION_EVENT : emits
  REMOTE_DEV_SESSION ||--o{ SESSION_COMMAND : receives
  REMOTE_DEV_SESSION ||--o{ APPROVAL_REQUEST : requires
  REMOTE_DEV_SESSION ||--o{ ARTIFACT_REF : produces
  TRANSPORT_SESSION ||--o{ SESSION_EVENT : carries
```

New logical fields:

- `remote_dev_sessions.id`: stable server-visible session id.
- `remote_dev_sessions.nodeId`
- `remote_dev_sessions.projectId`
- `remote_dev_sessions.runtimeProvider`
- `remote_dev_sessions.runtimeAccountRef`
- `remote_dev_sessions.status`
- `remote_dev_sessions.lastCursor`
- `remote_dev_sessions.resumeTokenRef`
- `session_commands.idempotencyKey`
- `session_commands.type`: `message`, `slash`, `approval_response`, `stop`, `attach`, `detach`
- `session_events.seq`
- `session_events.kind`: `message`, `tool`, `approval`, `artifact`, `diagnostic`, `lifecycle`

## Protocol Boundary

Client payloads must target canonical command types instead of runtime-specific raw shapes:

| Command type | Required fields | Notes |
|---|---|---|
| `message` | `sessionId`, `text`, `idempotencyKey` | normal prompt text |
| `slash` | `sessionId`, `command`, `args`, `idempotencyKey` | never carries approval prompt id |
| `approval_response` | `sessionId`, `approvalId`, `decision`, `idempotencyKey` | only valid for active approval |
| `stop` | `sessionId`, `scope`, `idempotencyKey` | `scope=run` or `session` |
| `attach` | `sessionId`, `cursor` | returns snapshot and stream cursor |
| `detach` | `sessionId` | client leaves; runtime may continue |

Server/node adapters can still translate into provider-specific runtime input internally, but the public client protocol stays stable.

## M4 Todo Queue

This queue is authoritative for M4. New requirements must be added here before implementation.

| 顺序 | 状态 | 子项 | 验收 |
|---:|---|---|---|
| 8.0 | done | 删除旧 M4 路线和历史 M4 baseline 证据 | full repo search has no deprecated route identifiers |
| 8.1 | done | M4 远程开发会话设计冻结 | this document exists and is referenced by `08-current-status.md` |
| 8.2 | done | Session catalog + attach contract | server can list active/recent remote development sessions and attach by stable session id; evidence: `2026-06-28-m4-session-catalog-attach-contract.md` |
| 8.3 | done | Canonical command envelope | message/slash/approval/stop are separate command types with idempotency keys; evidence: `2026-06-28-m4-canonical-command-envelope.md` |
| 8.4 | pending | Event store + seq/ack/resume | events can resume from cursor after client reconnect without duplication |
| 8.5 | pending | Approval and artifact lanes | approval request and large output do not block normal message stream |
| 8.6 | pending | Real AWS current smoke | paired AWS profile opens or attaches a real remote development session through default `9527` and records evidence |
| 8.7 | pending | Mobile/PWA smoke | mobile viewport can attach, send message/slash, respond to approval, and recover from reconnect |

## Next Implementation Slice

The next code slice should be 8.4 only:

- Add a session event store with stable `seq`, `ack`, and resume cursor semantics.
- Preserve command envelope output without duplicating accepted commands after reconnect.
- Keep durable approval/artifact lanes out of 8.4; they remain 8.5.
- Do not add UI beyond existing pages until 8.4 is verified by API-level and reconnect tests.

## Verification Gates

Minimum local verification:

- Deprecated route residual search returns no product-route residue outside this plan queue.
- Focused tests for new catalog/attach modules.
- `git diff --check`.

Minimum real verification:

- Use only AWS current default `9527`.
- No mock data.
- No old `152/155/39.104` servers.
- Evidence must include request path, result status, session id, cursor, and process cleanup or detach behavior.
