# 需求整理：Server 上下文业务闭环（2026-07-02，与用户对齐）

> 用户原话："mac webui 连接 aws server 后，切换到 aws server，所有的信息应该看到的是 aws server 的数据
> （账号、会话、模型都应该是 aws server 的数据），切换回来亦然。当前 1 没法切换；2 新浏览器打开 :9527/ui
> 没有授权不应该能进来；3 会话应该统一放到 AI 会话层面，节点总览的新会话特性要继承过去。"

## 心智模型（一句话）

**WebUI 是一个客户端壳；「当前 Server」是全局上下文；本机也是一个 Server。**
切到哪个 server，所有页面（账号/AI会话/模型/用量/仪表盘）看到的就是那个 server 的数据。

## 现状诊断（2026-07-02 实测）

- 账号/AI会话/模型/用量页硬连本地 `/v0/webui/*`，无视当前 profile → 切换"无感"。
- 切换控件 `ControlPlaneProfileSelect`（左下角）存在，但只有 Fabric 页和 Settings 消费 active profile。
- **无鉴权**：`/v0/webui/*` 无凭据 HTTP 200；server 监听 0.0.0.0，局域网任意浏览器可直接看到全部数据。
- AWS 侧设备数据接口已可用（Bearer 设备 token）：`/v0/node-rpc/device-accounts`、`device-sessions`、`device-status` 实测 200。模型/用量的 device 接口待确认，缺则需补或页面明示。
- 会话割裂：AI 会话页（本机会话）与节点总览内嵌会话面板（远端 node 会话）是两套。

## 需求（三条，按用户优先级）

### R1 · Server 全局切换，数据全跟随（核心）
- 左下角切换器升级为**全局 server 切换器**：本机 = 默认「Local」profile，与远端 profile 并列。
- 切换后，账号/AI会话/模型/用量/仪表盘的数据源全部指向当前 server：
  - Local → 现有 `/v0/webui/*`（不变）。
  - 远端 → 设备 token 走 `/v0/node-rpc/device-*`。
- 远端缺失的接口（如模型/用量）：页面如实显示「该 server 暂不提供此数据」，不假装、不混本机数据；后续补接口。
- 页面顶部常驻显示当前 server（避免看串数据）。

### R2 · 授权门（安全）
- 未授权的浏览器打开 `:9527/ui` → 只能看到 配对/登录页，任何数据接口 401。
- 复用现有 device pairing：浏览器作为一个 device 完成配对后获得 token，后续请求携带。
- 待用户决策：localhost 是否豁免（见下方问题）。

### R3 · 会话统一到「AI 会话」
- 「AI 会话」页 = 所有会话的唯一 UI：跟随当前 server，列出/发起该 server 上（含其 node）的会话。
- 节点总览的内嵌会话面板**撤下**，改为「发起会话」按钮跳转到 AI 会话页（预选 node+provider）；
  已实现的能力（设备 token start/续话/真实回复，`startControlPlaneDeviceNodeSession` 等）**迁移**到 AI 会话层复用，不重写。
- 节点总览回归定位：看节点、看能力、动作入口。

## 实施顺序建议

1. **R2 授权门**（最小、独立、堵安全洞）
2. **R1 切换语义**（最大，按页面逐个接：账号 → AI 会话 → 状态/仪表盘 → 模型/用量）
3. **R3 会话统一**（依赖 R1 的 server 上下文就位）

每步真实验收（无 mock）：切到 AWS 看到 AWS 的账号列表；新无痕浏览器进 :9527/ui 被挡在配对页；AI 会话页能对 AWS node 发消息拿真实回复。

## 已知技术资产（不重做）

- 设备配对/token：`control-plane-device-pairing`、profile store、`createProfileApiClient`。
- 设备数据面：`device-accounts/device-sessions/device-status/device-node-session-*`。
- 会话能力：`startControlPlaneDeviceNodeSession` / run-events 轮询 / sessionId 续话（已真实验证）。

## 用户已拍板（2026-07-02）

1. **授权门不豁免 localhost**：任何浏览器（含本机）打开 :9527/ui 都必须先配对/授权，数据接口一律 401 挡住。
2. **顺序**：R2 授权门 → R1 切换语义 → R3 会话统一。
3. **远端缺口**：切到远端 server 时缺的数据页如实显示「此 server 暂不提供」，先接已有接口（账号/会话/状态），不假装不混数据。

## R2 授权门：已交付 + 验收（2026-07-02，commit 6784fb4）

真实无头浏览器 + curl 验收（无 mock）：
- 侧门全挡：无 token 时 `/v0/webui/*`、`/v0/node-rpc/device-accounts|sessions|status`、`/v0/fabric/registry` 一律 401（数据无侧门泄漏）。
- 配对闭环：无痕浏览器闯数据页→重定向 gate 页、无数据泄漏、显示授权引导；`aih fabric profile invite`→打开链接配对成功→再访问不再被踢。
- 配对 token 有效：本机 token 读 registry `ok:true`（授权成功；nodes=0 是本机 server 自身 registry 内容，非鉴权失败，归 R1）。
- 流站点全带 token：accounts/watch(WS)、openai-models/watch、projects/watch、sessions/watch 均经 `withWebUiAccessToken` 携 access_token 连接，0 个 401 流；账号页数据正常。
- 配对路径/`/readyz`/`/ui` 静态壳不在门内，仍可达。

**已知缺口（记录）**：`/readyz` 在门外，任何人可读账号数量计数（如 `codex:1/claude:4`）——是计数非数据，暂列已知项，后续可选择性收敛。

**用户须知**：现有只配了 AWS profile 的浏览器标签，刷新后访问本机 :9527/ui 会因无 localhost token 被挡到 gate 页——这是 R2「localhost 不豁免」的预期行为，需一次性配对本机（`aih fabric profile invite` → 打开链接）。

## R1 进度：切片 1 = 账号（已交付，commit 95ff932 + 51e2c47）

架构：server-context.ts 单一真相（激活 profile→endpoint/deviceToken/isLocal）+ 路由级双模。
- 本机(同源)→ 原完整 UI（零改动）；远端→只读摘要（直连远端 endpoint+token，不走本地代理）。
- 拒绝把远端只读摘要塞进本地完整 Account 结构（不造假字段/假管理按钮）。
- 切到远端本地页随组件卸载→SSE/WS watcher 自动拆除；切换瞬间清空到 loading。
真实浏览器验收：切 AWS→13 真实账号(codex1/claude4/agy7/opencode1)+只读横幅；切回本机→完整 UI；**CORS 0 报错**（浏览器验，非 curl）。

**R1 剩余切片（待做，同一套 server-context 模式）**：
- AI 会话（与 R3 合并做，较重）
- 模型目录 / 模型用量：远端 device 接口若无 → 显示「此 server 暂不提供」
- 仪表盘 / 顶部当前 server 常驻横幅
