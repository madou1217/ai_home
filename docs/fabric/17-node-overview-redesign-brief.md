# 设计稿：节点总览页重做（Phase 1 · 委派 aih claude 4）

> **历史归档（禁止作为当前实现依据）**：本文保留旧阶段设计；其中客户端 pairing、device token、scope/revoke、Control Plane 或 Node-first 表述仅用于追溯，**不得实现或恢复**。当前客户端只使用 `Server URL + Management Key`；worker join invite 仅用于高级 worker 接入，不是客户端授权。当前规范见 [20-current-server-client-model.md](20-current-server-client-model.md) 和仓库根 [README.md](../../README.md)。

> 权威依据：`docs/fabric/16-realignment-2026-07-01.md`（唯一主线 + 概念收敛）。
> 本 brief 覆盖旧 `05-ui-wireframes.md` 中与本页冲突的部分。主控（Opus）定接口与验收，实现由 aih claude 4 完成。

## 目标（用户原话：看不懂）

让 `web/src/pages/FabricNodes.tsx`（路由 `/fabric/nodes`，"节点总览"）用**大白话**回答每个 Node 四个问题：
1. **这是什么机器**：名字、平台（如"日本 / linux"或"本机 Mac / darwin"）、在线状态。
2. **它能干什么**（能力，大白话）：能跑哪些 AI（如"跑AI(opencode)"）、能否中继、能否 SSH 开发。
3. **我现在能对它做什么**（动作）：可点的按钮（打开项目、发起会话）；不可用的动作要**说清为什么**（如"codex/claude —未授权"，而不是 `provider_account_unavailable:codex`）。
4. **连接质量**：走哪条线路（webrtc / relay）、延迟、健康度。

## 布局（用户已选：左列表 + 右常驻详情栏，工作台式）

```
│ Fabric · 节点(2)                    [刷新] │
├───────────────┬───────────────────────────┤
│ ● aws          │ aws-current-node            │
│   日本 · 在线   │ ● 在线 · webrtc · 12ms       │
│ ● 本机 Mac      │                             │
│   在线          │ 能力:  ✓ 跑AI(opencode)      │
│  (选中高亮)     │        ✓ 中继   ✗ SSH        │
│                │ 我能做: [打开项目] [发起会话]  │
│                │        codex/claude — 未授权  │
│                │ 连接: webrtc 直连 · p95 0ms   │
│                │ 项目/运行时/传输 (折叠区)      │
└───────────────┴───────────────────────────┘
```

- 左：节点列表（名字 + 平台 + 在线点）。点击选中，右侧常驻显示该节点详情。**不用抽屉/弹窗**。
- 右：详情 = 身份行 → 能力 → 我能做（动作）→ 连接质量 → 次要信息（项目/运行时/传输，可折叠，默认收起）。
- 移动端：上下堆叠（列表在上，选中详情在下），单列可读。
- 保留原 Relay Health 数据，但**并入右侧详情的"连接质量"**，不再单独一个让人困惑的区块；如信息多，用折叠。

## 用词（用户已选：大白话中文为主）

| 旧词（看不懂）| 新词（大白话）|
|---|---|
| runtime-host | 能跑 AI |
| relay-node / 中继中枢 | 能中继 |
| ssh capability | 能 SSH 开发 |
| `provider_account_unavailable:codex` | codex — 未授权（这台机器没登录 codex 账号）|
| `Open project: eligible` | 打开项目（可用）|
| capabilities / transports | 能力 / 线路（折叠里可留英文小字对照）|

## 交互状态（必须都在，不许假成功）

loading / 空（无 ready profile 时引导去 Server Setup）/ 出错 / 节点离线（动作置灰并说明）/ 传输 degraded / 移动端布局。**禁止**用假数据或假成功掩盖缺失能力。

## 硬边界

- **只改**：`web/src/pages/FabricNodes.tsx`、`web/src/pages/FabricNodes.css`，以及**仅**为本页所需的展示辅助函数。
- **不碰**：后端协议、API schema、`lib/**`、其他页面、路由结构、`fabric-registry.ts` 的数据契约（只消费，不改）。
- 不新增页面、不新增依赖、不改产品方向/里程碑语义。
- 数据来源沿用现有 `fetchFabricRegistry(profile)` / `buildFabricRegistry*Views`，字段不足就在本页做展示层映射，**不改数据层**。

## 验收（主控 Opus 会亲自跑，无 mock）

1. `npm --prefix web run build` 通过（0 error）。
2. 真实无头浏览器加载 `http://127.0.0.1:9527/ui/fabric/nodes`（重建后重启 server）：
   - 左列表出现 aws-current-node 与本机 Mac；点击 aws 右侧显示其详情。
   - 能力区出现大白话"跑AI(opencode)/中继"；动作区出现"打开项目"可用、codex/claude 显示"未授权"。
   - console 0 error（含老用户脏 localStorage 场景不崩）。
3. 交付报告需含：改了哪些文件、构建结果、浏览器验证（视口/路由/动作/观察结果）、已知缺口。

## 交付物

改好的 `FabricNodes.tsx` / `FabricNodes.css` + 一份简短 worker 报告（标注 `[aih claude 4]`）。
