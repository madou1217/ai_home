# NetGuard 严格网络控制路线图

> 目标：Claude / Codex / Gemini / AGY 的 CLI 与桌面 App，在 macOS / Linux / Windows 上都能按**启动实例的进程树**精确控制网络：指定代理可用时全部走代理，代理断开时全部失败，绝不直连；并能在 WebUI/CLI 中看到、修改、重连、结束。
>
> 状态图例：✅ 已完成 · 🚧 进行中 · ⬜ 未开始 · ⛔ 需要决策/受阻
>
> 每次完成一个阶段或子项：更新本文件的状态、证据和“进度汇总”，并在当次回复中按固定模板汇报。

## 验收总标准

1. 同一 exe 的两个实例可分别使用不同代理（如 JP / SG），互不影响。
2. 实例进程树内除白名单 loopback 外，禁止外部 IPv4/IPv6/TCP/UDP/QUIC。
3. 代理入口断开、不可达或无可用候选时，实例所有外联失败；不得回落直连。
4. DNS 默认由代理端解析；本地 DNS 直出需被禁止，或经走代理的 DoH 桥。
5. WebUI/CLI 能看到：实例、账号、代理规格、实际出口节点/国家/城市/出口 IP、Guard 状态、DNS 模式、进程树、健康与错误。
6. 所有 Provider CLI/桌面 App 启动都注册到统一实例台账；不再存在“启动了但看台看不到”的路径。
7. 启动前 preflight：代理可用、账号凭据可用、平台 Guard 可用；失败时提示“更换代理 / 继续但不隔离 / 取消”。
8. 每个阶段有真机证据；不以“代码写完”代替验收。

---

## Phase 0 — 现状盘点与可行性验证 ✅

- [x] 现有代理资产盘点：selector/地区、临时入口、稳定端口、fail-closed、健康、自动恢复
- [x] 现有进程资产盘点：进程归属、进程家族结束、自然退出回收、App 看台
- [x] 现有 Provider 启动链路盘点：desktop/CLI 代理注入、账号出口、启动未注册到 appsessions
- [x] macOS sandbox 机制验证：代理 204、直连 IP 被拒、CLI 可启动
- [x] Windows 主机能力盘点：Win11 26300、管理员、VS/SDK、无 WDK/test signing、可访问网络
- [x] WinDivert 2.2.2 下载与 `processId` 过滤能力确认
- [x] DNS/Claude 风控影响分析
- [x] 需求风险分析：绝对化承诺、Windows per-instance、GUI helper、DNS、ToS

**证据**：本会话中的 macOS sandbox/curl 测试、Windows PowerShell 主机审计、WinDivert 包与头文件检查。

---

## Phase 1 — NetGuard 契约与实例身份（基础）🚧

- [x] 定义 `LaunchTarget`：provider + surface(cli|desktop) + accountRef + instanceSlot
- [x] 定义 `ProxySpec`：direct / local / selector(国家/城市/池/节点) / custom URL
- [x] 定义 `NetworkPolicy`：direct / cooperative / strict_proxy
- [x] 定义 `LaunchProfile`：ProxySpec + NetworkPolicy + DNSMode + 最近成功状态
- [x] 定义 `NetworkGuard` 接口：Start / SetProcessTree / Stop / Status / Audit
- [x] 平台构造函数：Windows strict → WinDivert P0；其他平台 strict 明确返回 unsupported
- [ ] 实例身份与进程树抽象完全落到 Orchestrator（当前由 guard 自己跟踪 root PID）
- [ ] Guard 审计模型：非 loopback socket、出口 IP、DNS 状态、错误（当前只有 blocked/PIDs）
- [ ] 失败语义：Guard 准备失败时拒绝启动，或用户显式选择 non-strict（接口已有，Orchestrator 未接）

**完成标准**：接口与数据模型落地，能用一个假 Guard 跑通 preflight→launch→stop 的状态机。

**代码**：`internal/runtime/netguard`、`cmd/aih-netguard`。

---

## Phase 2 — Windows per-instance Guard（最高优先级）

### 2.1 P0：per-process / per-instance 阻断（WinDivert）🚧

- [x] 主机工具链确认（管理员、VS/SDK、WinDivert 可用）
- [x] WinDivert 2.2.2 下载、签名驱动
- [x] 关键发现：**WinDivert NETWORK 层不支持 `processId` 字段**（官方文档明确），不能直接按 PID 过滤
- [x] 改为 5-tuple → Windows TCP/UDP owner table → PID 的桥接方案
- [x] 目标进程 IPv4 TCP 直连阻断（真机：目标 `DIRECT_ERROR`，`blocked=3`）
- [x] 非目标进程不受影响（真机：另一个进程 `DIRECT_OK 200`）
- [ ] UDP owner table 命中（真机：owner-table 重注入会让目标 UDP 超时但 blocked=0，系统 UDP 也可能被误伤；当前 P0 过滤器明确只采集 TCP，UDP 不声称已控制）
- [ ] IPv6 外部流量归因/阻断（P0 未实现）
- [ ] 启动 suspended / Job Object：消除初始进程跟踪竞态
- [ ] 代理 loopback 放行验证（过滤器排除 loopback，但未做正向请求验收）
- [ ] 代理断开 fail closed 验收（当前 guard 只阻断；与入口 fail closed 联调未做）
- [ ] 子进程验收（当前有 250ms 轮询 watcher，测试客户端未跑通）

**WinDivert 结论**：它是 P0 的**可运行原型**，但 WinDivert 无法提供内核级 processId 归因；UDP/IPv6/竞态无法达到“精确 per-instance”验收。长期必须用 WFP callout。

### 2.1a WFP 前置条件（当前阻塞）

- [ ] WDK 安装：26100/28000 均失败 1714；阻塞包 `SDK ARM64 Additions`（`{7D0E0601-E6CC-870D-0002-C93DD14EDA30}`）无法卸载（msiexec 返回 1612，安装源不可用）；需要修复 VS/SDK 组件或用 EWDK/VS Installer
- [ ] VS Installer `--add Microsoft.VisualStudio.Component.WDK` 未产出 km 头文件，需要进一步修复安装
- [ ] test signing：Secure Boot 已关闭，可开启；需要重启
- [ ] 驱动签名策略：开发期 test signing；产品期 EV 证书 + Microsoft attestation
- [ ] WFP callout 驱动骨架（C/C++）待在 WDK 可用后开始

### 2.2 P1：per-instance 透明 TCP 代理（WinDivert NAT）

- [ ] 出站 SYN 改写目标到实例专属本地 relay
- [ ] NAT 表：原目标 ↔ 本地源端口；回程改写与 checksum 重算
- [ ] relay 支持 HTTP CONNECT / SOCKS5，连该实例代理入口
- [ ] MSS/分片/IPv6/窗口缩放边界处理
- [ ] 外部 UDP/QUIC 默认阻断；必要时 UDP ASSOCIATE
- [ ] 测试：不配置代理的 GUI App 也能被透明接管
- [ ] 测试：两个同 exe 实例分别 JP/SG，出口 IP 不同

### 2.3 P2：WFP callout 产品化（C/C++）

- [ ] 安装 WDK / 驱动构建链
- [ ] ALE_CONNECT_REDIRECT per-process/实例重定向
- [ ] 内核侧实例上下文，避免 PID 复用竞态
- [ ] 用户态控制服务 IOCTL / 生命周期
- [ ] EV 签名 / attestation / test signing 方案
- [ ] EDR/杀软兼容测试
- [ ] 决策 WinDivert vs WFP 作为长期默认

### 2.4 Windows GUI 验收

- [ ] Claude/Codex/Gemini/AGY 桌面 App 各启动两个实例（不同账号/JP+SG）
- [ ] App 内所有 TCP 请求走各自代理
- [ ] 代理断开全部失败，不直连
- [ ] helper/更新器/系统代劳行为记录并明确边界
- [ ] WebUI 可看到两个实例的 Guard/出口/IP

---

## Phase 3 — macOS Guard

### 3.1 CLI strict 🚧

- [x] sandbox-exec profile 生成器（per launch）
- [x] 禁止外部 IP，允许 loopback（代理/AIH 网关/MCP）
- [x] 注入 `HTTP(S)_PROXY` + `NODE_USE_ENV_PROXY=1`
- [x] 真机：代理请求 204；`curl --noproxy '*'` 直连 IP/域名均被拒
- [x] 真机：代理端口不存在时请求直接失败（fail closed）
- [x] 真机：Claude 2.1.332 / Codex 0.172.0 / Gemini 0.70.0 均可在 sandbox 内启动
- [x] CLI 工具：`aih-netguard exec --proxy-url ... -- <command>`
- [ ] 四个 CLI 真实 API 请求验收（含 AGY；当前只验证启动）
- [x] 多实例不同代理验收（真机：6152 AU / 6156 SG，两个 sandbox 实例出口不同；直连均被拒）
- [ ] DNS 严格阻断（当前 DNS 经 mDNSResponder 仍可解析；Phase 5）
- [ ] 与 Provider CLI 启动路径集成（Phase 8）

### 3.2 GUI App 🚧

- [x] Chromium GUI 直接可执行 + sandbox 原型：Chrome 启动、建立到 6152 的连接；外层 sandbox 拒绝直连
- [x] 需要 `--no-sandbox` 才能避免 Chromium 嵌套 sandbox 初始化失败（安全降级，需决策）
- [ ] Vendor Electron App / AGY `open -a` 路径改造
- [ ] 窗口/TCC/单实例/OAuth 深链/更新器验证
- [ ] 无法满足时决策 Network Extension（签名扩展）
- [ ] 系统 XPC/nsurlsessiond/更新器边界文档化

---

## Phase 4 — Linux Guard 🚧

- [x] cgroup v2 + nftables 方案选型与真机验证
- [x] 特权 helper（sudo -n mkdir/tee/nft）与清理路径
- [x] Linux Guard 代码：cgroupv2 level 2 匹配，loopback 放行、外部 drop
- [x] 真机：目标进程外网 timeout、loopback 200、其他进程 301
- [ ] per-instance 透明 TCP 重定向（当前为阻断；App 需使用代理）
- [ ] 外部 UDP/QUIC/DNS 策略（cgroup 规则会 drop；系统 resolver 旁路待验证）
- [ ] CLI strict 四家真实 API 验收
- [ ] GUI App 进程树验收（cgroup 继承，理论上覆盖子进程）
- [ ] 多实例不同代理验收
- [ ] 与 Docker/Colima/VPN/Tailscale 规则冲突处理
- [ ] 容器/VM 不在宿主进程树范围的文档化

---

## Phase 5 — DNS Guard

- [ ] 严格默认：禁止本地 DNS 直出
- [ ] 代理端域名解析验证（HTTP CONNECT / socks5h）
- [ ] 本地 DoH/DoT 桥：DNS 流量走代理（兼容档）
- [ ] mDNSResponder / Windows Dnscache 特殊处理
- [ ] 出口 IP/国家与 DNS 落点一致性验证
- [ ] CLI/GUI 的 DNS 泄漏验收

---

## Phase 6 — LaunchProfile 与 preflight

- [ ] LaunchProfile 持久化（按 provider/surface/account/instanceSlot）
- [ ] 记忆 ProxySpec（国家/城市/池/节点/URL），不保存凭据
- [ ] 打开前 preflight：selector 有效、候选可出网、入口可绑定、账号凭据有效、Guard 可用
- [ ] 失败交互：更换代理 / 继续但不隔离 / 取消
- [ ] 节点失效时提示“范围内换节点”，不静默换出口
- [ ] WebUI/CLI 编辑与重置 LaunchProfile

---

## Phase 7 — 统一实例台账与控制面

- [ ] 所有启动路径注册 appsessions（Provider desktop/CLI 当前未注册）
- [ ] 实例字段：launchId、profile、账号、proxySpec、实际节点/国家/城市/IP、Guard、DNS、进程树、健康
- [ ] WebUI 看板：启动、重连、换代理、重启、结束进程树、日志
- [ ] CLI 等价命令：`aih app` / Provider 查看与管理
- [ ] 历史/孤儿清理与断链状态
- [ ] 审计日志与证据导出

---

## Phase 8 — 接入现有 AIH 编排

- [ ] Provider desktop/CLI 启动统一经 Orchestrator
- [ ] App 看台通用应用启动统一经 Orchestrator
- [ ] 统一 `NetworkGuard` 平台适配器（win/mac/linux）
- [ ] 账号 Egress 与实例代理的优先级/冲突规则
- [ ] strict_proxy 默认策略与 cooperative/direct 显式降级
- [ ] 多实例、不同代理、热替换关闭恢复语义统一

---

## Phase 9 — 验收、文档与发布

- [ ] 跨平台 CLI 验收矩阵
- [ ] 跨平台 GUI 验收矩阵（含 Windows JP/SG 双实例）
- [ ] 代理断开 / DNS / QUIC / IPv6 / 更新器测试
- [ ] 性能、资源、EDR/杀软兼容测试
- [ ] 用户文档、限制说明、安装/卸载/签名说明
- [ ] 分阶段发布与回滚

---

## 进度汇总（按需求）

> 计算口径：以“完整严格网络控制 + 统一编排 + 可观测管理”的最终目标为 100%；已有代理设施只计入可复用基础，不把“合作式代理注入”算作严格控制。

| 需求 | 现有可复用 | 完成度 | 状态 |
| --- | --- | --- | --- |
| 代理选择 / 临时入口 / 稳定端口 / 健康 | 高 | 90% | ✅ 基础完成 |
| 代理断链 fail closed | 高 | 85% | ✅ 基础完成 |
| 进程归属 / 结束家族 / 孤儿回收 | 高 | 85% | ✅ 基础完成 |
| 严格进程级网络控制（跨平台） | 中 | 15% | 🚧 Phase 1/2/3 |
| Windows per-instance GUI（JP/SG） | P0 TCP 原型可运行 | 8% | 🚧 Phase 2 |
| macOS CLI strict | 机制+三 CLI 启动已验证 | 40% | 🚧 Phase 3 |
| macOS GUI strict | Chromium 原型可用 | 20% | 🚧 Phase 3 |
| Linux CLI/GUI strict | cgroup 阻断真机通过 | 25% | 🚧 Phase 4 |
| DNS Guard | 分析完成 | 10% | ⬜ Phase 5 |
| LaunchProfile / preflight | 组件部分有 | 15% | ⬜ Phase 6 |
| 统一实例台账 / 可观测 | App 看台部分有 | 30% | ⬜ Phase 7 |
| 统一编排 / Provider 接入 | 未串接 | 10% | ⬜ Phase 8 |
| 跨平台验收 / 文档 | 未开始 | 5% | ⬜ Phase 9 |
| **总目标** | — | **≈22%** | 🚧 |

---

## 汇报模板（每次必须使用）

```
本次完成：
- [Phase X / 子项] ...（✅/🚧）
证据：
- 命令 / 日志 / 截图 / 测试结果
总进度：
- 严格控制：X%
- 平台：Windows X% / macOS X% / Linux X%
- 需求总完成度：X%
阻塞/风险：
- ...
下一步：
- ...
```

## 当前状态

- 当前阶段：**Windows WFP 被 WDK 阻塞；macOS CLI/Chromium GUI 原型、Linux cgroup 阻断均已真机通过**
- 已完成：Phase 0；Phase 1 契约代码；P0 IPv4 TCP；macOS CLI sandbox；Linux cgroup 阻断
- 未开始：Phase 2.2 P1 透明 TCP、Phase 2.3 WFP、Phase 3.2 vendor GUI、Phase 5–9
- 最近更新：2026-11-28
- 证据：Windows 目标 `DIRECT_ERROR`/`blocked=3`、非目标 `DIRECT_OK 200`；macOS 代理 204、`--noproxy '*'` 拒绝、双实例 AU/SG；Linux cgroup 目标 timeout、loopback 200、其他 301