# 证据：节点内嵌会话面板落地 + 真实 UI 闭环（Phase 1 方案1）

日期：2026-07-02。设计稿：`docs/fabric/18-node-session-panel-brief.md`。API 契约：`docs/fabric/evidence/2026-07-02-webui-device-session-path-proof.md`。

## 实现者说明（诚实）

原计划委派 `aih claude 4`，但其 **5 小时额度当时耗尽（0%，约 4h42m 后重置）**，worker 启动即因 quota 退出、未产生任何改动。经用户拍板，本刀由**主控 Opus 直接实现**（非 aih claude 4 产出）。设计稿/API 契约已锁定，实现为照契约接线。

## 改动文件

- `web/src/services/control-plane-profiles.ts`：新增 `startControlPlaneDeviceNodeSession`（POST device-node-session-start）+ `fetchControlPlaneDeviceNodeSessionRunEvents`（GET device-node-session-run-events，nodeId 必填），复用现有 `postDeviceJson/fetchDeviceJson`（Bearer deviceToken）。
- `web/src/pages/FabricNodeSession.tsx`（新增）：节点内嵌对话面板。项目选择 + 消息流 + 输入框；走 start(带 sessionId 续话)+轮询 run-events 单一已验证路径；delta/result 拼回复，done 结束；真实状态 idle/starting/streaming/error，超时/离线/空项目/移动端全覆盖，无 mock。
- `web/src/pages/FabricNodes.tsx`：`NodeDetail` 接收 `profile`，把已有「发起会话（provider）」按钮接到面板（点开/收起），节点切换重置。
- `web/src/pages/FabricNodes.css`：会话面板样式（`--app-*` token，移动端堆叠）。
- 未碰后端/`lib/**`/其他页面/路由；「打开项目」的 `m4_project_action_pending` 未动。

## 构建 + 真实 UI 验收（主控 Opus 亲跑，无 mock）

- `npm --prefix web run build` = 0 error。
- 真实无头浏览器（chromium）加载 `/ui/fabric/nodes` → 点 `aws-current-node` → 点「发起会话（OpenCode）」→ 面板展开 → 输入框发送带唯一标记 prompt `AIH_UIMSG_042712` → **面板 AI 消息块出现含该标记的真实回复**（`aiReplyHasMarker=true`），**console 0 error**。
- 截图（自然对话）：`scratchpad/session-panel.png` —— 你问「用一句中文简短介绍你自己」，OpenCode 真实回复「我是 opencode，一个专注于软件工程任务的命令行交互工具…」。

## 结论

主线在 **UI 里**真正闭环：本地浏览器 → 选 AWS node → 发起 OpenCode 会话 → 发消息 → 看真实回复。用户第一次能在界面里用起远端 node 会话。

## 已知缺口 / 下一步

- 多轮续话用 start+sessionId 实现（已具备），但更顺滑的流式（SSE `device-node-session-stream`）与 slash/审批/中断/事件侧栏为后续里程碑。
- 顶部服务器栏偶显「状态未知/0-2 在线」为 profile.nodes 缓存问题（Phase 0 遗留，刷新自愈），非本刀范围。
