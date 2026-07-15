[aih claude 4]

# 节点总览页重做 · Worker 报告

## 设计依据
- 权威设计稿：`docs/fabric/17-node-overview-redesign-brief.md`（本次唯一权威）。
- 角色边界：`docs/fabric/skills/aih-claude-frontend-worker/SKILL.md`。
- 数据契约（只消费不改）：`web/src/services/fabric-registry.ts` 的 `readActiveFabricRegistry` / `FabricNodeInventoryItem` / `FabricNodeAction` / `FabricRegistryTransport` 等类型；后端 `GET /v0/fabric/registry`。

## 改了哪些文件
1. `web/src/pages/FabricNodes.tsx` —— 整页重写为「左节点列表 + 右常驻详情栏」工作台布局。
2. `web/src/pages/FabricNodes.css` —— 重写为该布局的样式（栅格、列表项、在线点、能力 chip、连接质量、移动端堆叠），颜色一律走 `--app-*` design token。

未触碰后端 / `lib/**` / 其他页面 / 路由 / `fabric-registry.ts` 数据契约。所有翻译均为本页展示层辅助函数。

## 主要改动点（对照 brief 四问）
- **这是什么机器**：详情身份行 = 名字 + 平台大白话（darwin→Mac / linux→Linux，附技术小字 `platform / arch`）+ 在线徽标（在线/不稳定/离线/状态未知）。左列表每项 = 在线点 + 名字 + 「平台 · 在线」。
- **它能干什么**：能力区大白话 chip，✓/✗：`跑AI(opencode)`（带 provider 列表）、`中继`、`SSH 开发`，hover 有说明。
- **我能做什么**：`打开项目` 按钮（可用性按 `action.eligible` 判定，符合 brief「打开项目（可用）」）；每个 eligible 的 provider 出 `发起会话（X）` 按钮；不可用的 provider 用大白话列原因（`missing_provider_runtime` → `未授权`，明细写「没检测到运行时（可能未安装或未登录）」，不硬断言「没登录」以保精度）。所有真实动作通道为 M4-pending，点击给诚实提示（`动作通道将在后续里程碑（M4）接入`），不伪造成功。节点离线时按钮全禁用并说明。
- **连接质量**：挑主线路（优先有测量→在线→第一条），展示线路类型大白话（WebRTC 直连 / 中继线路 等）+ 健康度 + 延迟 p95 / 成功率；degraded 显式提示；原 Relay Health 数据并入此处（容量/带宽/中继状态），不再单独区块。

## 交互状态（全部保留）
- loading（首次加载左列表 Spin / 详情占位 Spin）
- 空（无 ready profile → 引导去 Server Setup 的 Alert；有 profile 但 0 节点 → Empty 引导）
- 出错（读取失败 Alert，含 message.error toast）
- 节点离线（动作置灰 + 文案说明）
- 传输 degraded（连接质量区显式提示）
- 移动端（`@media (max-width:768px)` 上下堆叠，列表可滚动）
- 空指针防护：`selectedNode` 为 null 时右栏渲染 Empty/占位，不索引 `.node`/`.capabilities`。

## 构建结果
- `npm --prefix web run build` → **0 error**（通过）。
- `npx tsc --noEmit`：本页 `FabricNodes.tsx` **0 error**。仓库其他文件存在先前既有的 tsc 报错（`Chat.tsx` / `Dashboard.tsx` / `FabricServerSetup.tsx` / `FabricWebrtcDiagnostics.tsx`），非本次改动引入，不在本页范围。

## 已知缺口 / 待主控验证
- **浏览器验证未做**：本 worker 仅完成 build-verified；真实无头浏览器加载 `http://127.0.0.1:9527/ui/fabric/nodes`（重建重启 server、点击 aws 看右栏、脏 localStorage 场景 console 0 error）为主控 Opus 的验收步骤，未在此伪造视口/console 结果。
- **动作通道为 M4-pending**：`打开项目` / `发起会话` 按钮当前只展示可用性，点击为诚实的「待接入」提示，不代表远程动作已打通（数据层 `open-project` 恒带 `m4_project_action_pending`，故按可用性而非 enabled 渲染）。
- **平台地理位置（如「日本」）**：brief 中为示意，数据无该字段，未编造；仅按 `platform/arch` 大白话映射。
- **provider「未授权」措辞**：数据真实 blocker 为 `missing_provider_runtime`（无运行时），语义可能是未安装或未登录；headline 保留 brief 要求的 `未授权`，明细如实标注不确定性。

---

## 主控 Opus 验收记录（2026-07-01）

**验收结论：通过（真实无头浏览器，无 mock）。**

- 边界核对：`git status` 仅 `web/src/pages/FabricNodes.tsx` + `FabricNodes.css` 改动，未越界。
- 主控独立 `npm --prefix web run build` = 0 error。
- 真实无头浏览器加载 `http://127.0.0.1:9527/ui/fabric/nodes`：`httpStatus=200`、左列表含 `aws-current-node`+`Local Mac Remote Node`、点击 aws 右栏出详情、大白话能力（跑AI/中继/SSH 开发）齐、动作区“打开项目”可用、console **0 error**。截图存 scratchpad `nodes-page.png`。

**主控修补（1 处，非 worker 复杂范围）**：worker 的 `describeProviderBlocker` 只处理了 `missing_provider_runtime`，但真实数据 blocker 是 `provider_account_unavailable:<provider>`，导致落入 default 分支泄漏原始英文码。主控在验收中补了该 case：`provider_account_unavailable` → headline `未授权` / detail `这台机器没登录 X 账号`。修补后重验：`actionUnauthorized=true`、`leakedJargon=false`，动作区显示“Codex — 未授权 / 这台机器没登录 Codex 账号”。

**遗留（非阻塞，自愈）**：主控在 Phase 0 老用户脏状态回归测试中，误将测试用假 profile 同步进服务端 store（`cp-oldxxx` + 改坏 `cp-51hq70` 的 name），已清理还原（deviceToken 完好）；server 顶部“状态未知/0-2 在线”为 profile.nodes 缓存被清空所致，真实 registry 显示 2 节点在线，点“刷新”或重载自愈。
