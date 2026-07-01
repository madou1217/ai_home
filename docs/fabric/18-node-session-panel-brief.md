# 设计稿：节点内嵌会话面板（Phase 1 方案1 · 委派 aih claude 4）

> 权威依据：`docs/fabric/16-realignment-2026-07-01.md`（唯一主线）+ `docs/fabric/evidence/2026-07-02-webui-device-session-path-proof.md`（已实测 API 契约）。
> 主控 Opus 已真实验证设备 token 会话路端到端可用（起会话→事件→真实回复）。本刀=前端接线+极简对话 UI。

## 目标（本切唯一验收线）

在节点总览页，用户点某节点详情里的「发起会话（OpenCode）」→ 就地在右详情栏内嵌一个对话面板 → 输入消息 → **看到该 node 上真实 provider 的真实回复**。全程真实、无 mock。

## 用户已选布局：节点页内嵌对话面板（不新开路由、不用全屏页）

```
节点总览 │ aws-current-node · 在线
─────────┼──────────────────────────
 ● aws    │ 能力/我能做/连接质量（保留）
 ● 本机   │ ── 会话（点“发起会话”后就地展开）──
          │ 项目: [aih-fabric-current ▾]  provider: OpenCode
          │ ┌─ 对话 ───────────────────┐
          │ │ 你: 你好                    │
          │ │ AI: 你好，我在。             │  ← 流式
          │ └──────────────────────────┘
          │ [ 输入消息 / slash …        ] [发送]
          │ 状态: 就绪 / 起会话中 / 回复中 / 出错
```

- 面板就地嵌在右详情栏（点「发起会话（provider）」后展开），不跳路由、不用全屏页、不用弹窗。
- 项目选择来自 `node.projects`（默认第一个）；provider = 被点的那个 eligible provider。
- 移动端：面板在详情下方单列，输入框吸底可用。

## API 契约（已实测，见 evidence 2026-07-02）

- 鉴权：`Authorization: Bearer <profile.deviceToken>`（复用现有 `createProfileApiClient`）。
- **起会话（需新增前端方法）**：`POST /v0/node-rpc/device-node-session-start`
  body：`{ nodeId, provider, projectPath, prompt, accountId?, model?, projectDirName? }` → `{ ok, result:{ accepted, status, runId } }`。
- **拉事件**：`GET /v0/node-rpc/device-node-session-run-events?nodeId=<id>&runId=<run>&limit=100`（**nodeId 必填**）→ `result.events[{type:ready|session-created|delta|result|done, delta/content}]`。可轮询或用现成 `streamControlPlaneDeviceNodeSessionEvents`。
- **发后续消息**：复用现有 `sendControlPlaneDeviceNodeSessionInput`（`POST /v0/node-rpc/device-node-session-input`）。
- 展示层：`delta`/`result` 文本拼成 AI 回复；`ready/session-created/done` 作状态；`done` 结束本轮。

## 实现范围（硬边界）

- **可改/新增**：
  - `web/src/services/control-plane-profiles.ts`：新增 `startControlPlaneDeviceNodeSession(profile, {...})` → POST device-node-session-start（照上面契约）。
  - `web/src/pages/FabricNodes.tsx` / `FabricNodes.css`：内嵌会话面板 UI + 把已有「发起会话（provider）」按钮 onClick 接到面板。
  - 可新增 **一个** 组件文件（如 `web/src/pages/FabricNodeSession.tsx` 或 `web/src/components/fabric/NodeSessionPanel.tsx`）承载对话面板。
- **禁止**：改后端 / `lib/**` / 其他页面 / 路由结构 / registry 数据契约；新增依赖；假数据/假回复/假成功。
- 「打开项目」按钮的 `m4_project_action_pending` **保持不动**（那是另一个动作，本刀不处理）。

## 交互状态（必须都在，不许假成功）

就绪 / 起会话中(loading) / 回复流式中 / 本轮完成 / 出错(显示真实 error，不吞) / 节点离线(面板禁用并说明) / 空项目(提示无可打开项目) / 移动端。

## 验收（主控 Opus 亲跑，真实无头浏览器，无 mock）

1. `npm --prefix web run build` = 0 error。
2. 无头浏览器加载 `/ui/fabric/nodes` → 点 aws-current-node → 点「发起会话（OpenCode）」→ 面板展开 → 在输入框发送一条带唯一标记的 prompt → **面板里出现包含该标记的真实 AI 回复** → console 0 error。
3. 报告含：新增/改动文件、build 结果、浏览器验证（视口/路由/动作/观察到的真实回复）、已知缺口。

## 交付物

`control-plane-profiles.ts`(+start 方法) + `FabricNodes.tsx/.css` + 会话面板组件 + worker 报告（标注 `[aih claude 4]`，不 commit）。
