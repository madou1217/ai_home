# Phase 0 现状实况诊断（2026-07-01）

目标：真实验证「本地 WebUI → 把 AWS 加成 Node → 开项目 → 真实消息真实回复」这条主线今天走到哪断。
机器：本机 Mac + AWS（`ubuntu@ec2-43-207-102-163...:9527`，`~/.ssh/aws.pem`）。全程无 mock。

## 实测结果（逐层）

1. **AWS 侧运行中**：SSH 通；`/home/ubuntu/aih-fabric-current` 满配运行——9527 server(pid 578118)、registry agent、webrtc/relay connect、2 个 opencode 会话。
2. **网络路径通**：本机直连 `http://ec2-43-207-102-163...:9527/v0/fabric/descriptor` = HTTP 200 / 0.44s；`/readyz` = `ready:true`，accounts=codex1/claude4/agy7/opencode1。security group 放行 9527。
3. **后端闭环通（CLI 验证）**：本机 `aih fabric nodes --json` 全绿——`unauthRejected/authorizedRead/rpcOk/nodeFound` 全 true，registry=2 nodes / 2 relay / 3 transports / 2 projects / 8 runtimes。
4. **已配对 profile 存在**：`~/.ai_home/control-plane-profiles.json` 有 `cp-51hq70`→AWS，`authState:paired`、`deviceToken` 有效、含 `aws-current-node`。**但 `activeProfileId:""`（无激活选择）**。
5. **共享接口能返回**：`GET /v0/webui/control-plane/profiles` = 200，返回 cp-51hq70（连旧 server 都能返回）。

## 根因（用户看到「no ready server profile / 看不到 AWS」的真实原因）

- **不是网络问题，也不是后端没数据。** 病在客户端/WebUI 这一层。
- 本机 WebUI server（pid 32726）是 **2 天前从全局安装 `/opt/homebrew/bin/aih` 起的旧进程**（ELAPSED 02-03:39:10），不是当前仓库代码。用户这两天盯着的一直是它。
- `/fabric/nodes` 不在重定向保护名单里，所以那条提示是 **FabricNodes 页面自己的空态**：`active.profile` 解析不出来 → `ready=false`。
- 当前仓库代码里 `resolveControlPlaneProfile` **已有回退**：storedProfileId 为空时用 `findPreferredProfile` 自动选中 paired profile → 理论上 ready 应为 true。所以症状要么来自 **浏览器 localStorage 被清空(6/27 reset)后前端未把服务端共享 profile 合并进列表**，要么来自 **旧 server 提供的旧前端逻辑**。

## 结论

主线的「网络 + 后端」这两段其实是通的；断点集中在**客户端 profile 激活/合并**与**用户实际在跑一个陈旧 server**。

## 下一步

重新构建前端 + 用当前代码重启本机 9527 server → 真去 `http://127.0.0.1:9527/ui` 加载，确认 AWS node 是否出现、能否开项目发消息。若仍空态，则定位「localStorage 空时未合并共享 profile」这个具体前端 bug 并修复。

## 修复验证（重建前端 + 重启 server 后）

- `max build` 重建 web/dist 成功（含 FabricNodes/FabricServerSetup 新包）。
- 旧进程 32726 被 launchd 服务 `com.clawdcodex.ai_home` 自动以最新代码(软链 repo)重启为 pid 72288；`/readyz ready=true`。
- **真实无头浏览器验证**（空 localStorage 新 context，chromium headless，加载 `http://127.0.0.1:9527/ui/fabric/nodes`）：
  - HTTP 200；`hasNoReadyProfile=false`（空态消失）；`hasAwsNode=true`；**console 0 error**。
  - 渲染出节点表：`aws-current-node`(online, linux/x64, 1 projects, 4 runtimes) + `Local Mac Remote Node`，2/2 在线。
  - aws-current-node 动作：Open project=eligible、Start opencode=eligible；codex/claude/agy=provider_account_unavailable（AWS 侧仅授权 opencode）。
  - 前端自动把服务端共享 profile 合并进 localStorage（cp-51hq70，2 节点）。
- **结论**：用户「看不到 AWS node / no ready server profile」根因 = 跑了 2 天的旧 server 进程。重建+重启即修复，无需改代码。

## 完整闭环验证（真实会话，无 mock）

对 `aws-current-node` 真实起 opencode 会话（本机 CLI，全程真实网络）：
- session start：`accepted=true`、`blocked=false`、`blockers=[]`、status=running、runId `d822c66d-2b8f-489e-90c4-7207733d1d98`、projectPath `/home/ubuntu/aih-fabric-current`；传输 `webrtc`、`fallbackUsed=false`。
- 发送带唯一标记的 prompt：`AIH_LOOP_20260701_204206`。
- 真实事件序列：`ready → session-created(ses_0e24c8169ffech0dxIlvjF2X3y) → delta:"AIH_LOOP_20260701_204206" → result:"AIH_LOOP_20260701_204206" → done`，status=`completed`。
- **模型真实回复内容 == 发出的唯一标记**（在 delta/result 事件中，非 prompt 回显）→ 端到端闭环成立。
- 主线闭环：本地 → AWS node(webrtc) → opencode 会话 → 真实 prompt → 真实回复，**零代码改动**（仅重建+重启旧 server）。

## 老用户脏 localStorage 回归（避免「对我却看不到」）

真实无头浏览器，导航前 seed localStorage 模拟返回用户四种脏状态，加载 `/ui/fabric/nodes`：
1. 旧 profile 列表不含 AWS（配对前缓存）→ `hasAwsNode=true`（共享同步补齐；有幽灵旧 server 的 CORS console 报错，节点仍显示，属 Phase 1 清理项）。
2. `activeProfileId` 指向已删除 id → `hasAwsNode=true`、0 error（回退生效）。
3. AWS profile `state=degraded` → `hasAwsNode=true`、0 error（共享同步自愈）。
4. AWS profile `authState≠paired` → `hasAwsNode=true`、0 error（自愈）。
- 结论：服务端共享 profile 同步覆盖本地脏状态，四种场景都恢复到显示 AWS 节点；「重启后对返回用户同样可见」成立。

## 精确边界（避免过度声称）
- 会话闭环仅对 **opencode** 证明；AWS 节点上 codex/claude/agy = `provider_account_unavailable`（未授权账号）。
- 节点**可见性**经真实 UI 证明；**会话**经 CLI 证明。UI 内「开项目→输入→看回复」点击路径尚未端到端验证。
- 假说（非定论）：本机 server 连续跑 2 天未随重建更新，codex session 期间每次「本地 WebUI 检查」都在对旧代码看——可能是「你说闭环了我却看不到」的一大主因；也暴露 DX 缺陷：重建/更新后无任何提示告知用户运行中的 server 已过时。
