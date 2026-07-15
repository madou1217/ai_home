# 证据：WebUI 设备 token 会话路端到端可用（Phase 1 方案1 前置）

日期：2026-07-02。目标：证明「界面里 发起会话→发消息→看回复」将走的**设备 token 路**在后端真通，再决定委派前端。全程无 mock，真实 AWS node。

## API 契约（已实测确认）

- 鉴权：`Authorization: Bearer <deviceToken>`（deviceToken 来自 client 端 `control-plane-profiles.json` 的 profile）。
- **起会话**：`POST {endpoint}/v0/node-rpc/device-node-session-start`
  body 字段（见 `lib/server/node-rpc-router.js:909 buildDeviceNodeSessionStartPayload`）：
  `{ nodeId, provider, accountId?, prompt, projectPath, projectDirName?, model?, sessionId?, artifactThreshold?, cols?, rows? }`
  返回：`{ ok, result:{ accepted, status:'running', runId, ... }, transportDecision }`。
- **拉事件**：`GET {endpoint}/v0/node-rpc/device-node-session-run-events?nodeId=<id>&runId=<run>&limit=100`
  **注意 nodeId 必填**，否则 `400 missing_or_invalid_node_id`。
  返回：`{ ok, result:{ status, events:[{type:ready|session-created|delta|result|done, delta/content}] } }`。
- 其余已存在前端客户端：`device-node-session-messages` / `device-node-session-input` / `device-node-session-stream`。

## 实测（真实 AWS aws-current-node / opencode）

- start：`ok=true`、`accepted=true`、`status=running`、runId `c5822a8a-e818-46f8-82ca-c009feea45a6`、transport 决策自动选路。
- prompt 带唯一标记 `AIH_UIPATH_040255`。
- run-events：`status=completed`，事件序列 `ready→session-created→delta→result→done`，**回复内容 == 标记**（模型真实回复，非回显）。

## 结论 → 方案1 缺口纯前端

后端设备 token 会话路完全可用。缺：
1. 前端 `startControlPlaneDeviceNodeSession`（POST device-node-session-start）—— 现无。
2. 极简会话 UI（选项目→起会话→发消息→流式看回复）。
3. 去掉 `web/src/services/fabric-registry.ts:604` 硬编码的 `m4_project_action_pending`，把「打开项目/发起会话」按钮接到真实路径。

委派对象：`aih claude 4`（复杂前端）；主控 Opus 提供本契约 + UI 设计稿 + 真实无头浏览器验收（起会话看到真实回复）。
