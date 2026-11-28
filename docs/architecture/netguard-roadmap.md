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
- [x] 失败语义：严格模式下 Guard 不可用时 App Desk 在启动前返回 409，不静默降级（API/WebUI 已接）

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
- [x] UDP owner table 命中（真机：目标 UDP 53 请求超时，`blocked=4` 中含 UDP；修复点：UDP 必须调用 `GetExtendedUdpTable`，不能复用 TCP 表函数）
- [x] IPv4 UDP 归因/阻断（真机：目标进程直接 `UdpClient.Send` 到 223.5.5.5:53 无响应；非目标 UDP 正常）
- [x] 子进程继承验收（真机：根 `cmd.exe` 被保护，其 `powershell` 子进程 TCP/UDP 均被阻断，loopback 正常）
- [x] 多根进程树：同一 guard 进程可保护多个实例树（`--root-pid a,b`）。WinDivert 同一过滤器开多个句柄会重复注入，因此每台机器必须由一个 guard 统一持有句柄（WFP 全局 PID 集合同理）
- [x] PID 复用防护：记录每个 PID 的创建时间，watcher 每 250ms 清理已退出/被复用的 PID。真机事故：测试脚本对过期 PID 执行 `taskkill /T` 且 guard 保护了被复用的 PID，导致 sshd 短暂不可达；修复后显式 PID 也会启动 watcher 清理
- [x] 代理 loopback 放行验证（真机：受保护进程连接 127.0.0.1:18080 成功）
- [x] 代理断开 fail closed 验收（guard 阻断外部，进程只能走 loopback；入口断开时请求失败，未直连）
- [ ] IPv6 外部流量归因/阻断（代码已实现 AF_INET6 TCP/UDP owner table 与 IPv6 扩展头解析；该真机无全局 IPv6 地址，未验收）
- [ ] ICMP/raw IP 归因（NETWORK 层无法按 PID 归因，未阻断）
- [ ] 启动 suspended / Job Object：消除初始进程跟踪竞态（当前 250ms watcher）
- [ ] DNS 经 Dnscache 的归因（Windows DNS 客户端在 svchost 中发包，按 PID 阻断无法覆盖；Phase 5 处理）

**WinDivert 结论**：已从“IPv4 TCP 原型”升级为 Windows 的**可用严格后端**（IPv4 TCP+UDP、子进程、loopback 放行、fail closed，真机通过）。仍缺 IPv6 真机验证、ICMP/raw、启动竞态与 DNS/Dnscache；WFP callout（已编译/签名/安装）在内核归因与 IPv6/ICMP 上更完整，待 test signing 重启后加载对比。

### 2.1a WFP 前置条件（构建链已通，加载待重启）

- [ ] WDK 安装：26100/28000 均失败 1714；阻塞包 `SDK ARM64 Additions`（`{7D0E0601-E6CC-870D-0002-C93DD14EDA30}`）无法卸载（msiexec 返回 1612，安装源不可用）；需要修复 VS/SDK 组件或用 EWDK/VS Installer
- [ ] VS Installer `--add Microsoft.VisualStudio.Component.WDK` 未产出 km 头文件，需要进一步修复安装
- [x] 绕过安装器：官方 NuGet `Microsoft.Windows.WDK.x64 10.0.28000.2526` 可解出 `ntddk.h`/`fwpsk.h`/`ntoskrnl.lib`
- [x] 完整编译链：NuGet WDK 缺少基础 `shared` 头，改用 `tpn/winsdk-10` 的 **16299 完整头文件树**（`km`/`shared`/`km\crt`/`ucrt`）+ WDK 28000 导入库；`/DNDIS60=1` 启用 NDIS6 类型，`INITGUID` 自含 WFP 层 GUID。**真机产物 `aih-netguard.sys` 9,728 字节**
- [x] WFP callout 驱动骨架（C）：provider/sublayer/callout V4+V6，ALE_AUTH_CONNECT 按 `FWPS_METADATA_FIELD_PROCESS_ID` 阻断；IOCTL 设置 PID 集合/查询计数
- [x] loopback 豁免：V4 127.0.0.0/8、V6 ::1 与 ::ffff:127.0.0.0/8 放行（实例代理与 AIH 本地入口）
- [x] 测试签名证书：`CN=AIH NetGuard Test` 自签代码签名证书，导入 Root/TrustedPublisher，`Set-AuthenticodeSignature` 签名后 `Get-AuthenticodeSignature = Valid`
- [x] 驱动安装：`System32\drivers\aihnetguard.sys` + `AihNetGuard` kernel 服务已注册（demand start）
- ⛔ test signing：`bcdedit /set testsigning on` + 重启（Secure Boot 已关闭）；当前 `sc start` 返回 **577**。**等待用户授权重启**
- [x] 驱动加载：testsigning 重启后 `AihNetGuard` RUNNING
- [x] WFP 外部阻断真机：受保护进程 TCP/UDP 外联失败，`blocked=3`
- [x] WFP loopback 放行：高权重 `FWP_CONDITION_FLAG_IS_LOOPBACK` permit filter；真机 127.0.0.1:18080 OK
- [x] WFP 真机验收：外部 TCP/UDP 阻断、loopback OK、非目标 TCP OK、blocked 计数递增
- [ ] 驱动签名策略：开发期 test signing；产品期 EV 证书 + Microsoft attestation
- [x] Windows Store/UWP 事实确认：Claude/Codex 均为 AppsFolder/AppContainer；命令行代理参数不可注入、同包多实例受限。Chrome/Edge（独立 profile）可严格启动；UWP 双实例需透明重定向

### 2.2 P1：per-instance 透明 TCP 代理（WinDivert NAT）

设计：`docs/architecture/netguard-transparent-redirect.md`（出站 SYN 改写、回程反向改写、relay CONNECT、MSS/checksum/失败语义与验收）。

- [x] 结论：WinDivert 用户态 NAT 改写后无法投递给本地 relay（4 种路径真机证伪），该路线终止，改由 WFP ALE_CONNECT_REDIRECT
- [ ] NAT 表：原目标 ↔ 本地源端口；回程改写与 checksum 重算
- [ ] relay 支持 HTTP CONNECT / SOCKS5，连该实例代理入口
- [ ] MSS/分片/IPv6/窗口缩放边界处理
- [ ] 外部 UDP/QUIC 默认阻断；必要时 UDP ASSOCIATE
- [ ] 测试：不配置代理的 GUI App 也能被透明接管
- [ ] 测试：两个同 exe 实例分别 JP/SG，出口 IP 不同

### 2.3 P2：WFP callout 产品化（C/C++）

- [x] 安装 WDK / 驱动构建链（NuGet + 16299 头文件树绕过安装器）
- [x] 驱动骨架：PID 集合阻断 + loopback 豁免 + IOCTL 控制面
- [x] 用户态控制：`internal/runtime/netguard/wfp_windows.go`（设备 IOCTL、PID 并集、250ms 进程树、自动后端选择；交叉编译通过）
- [ ] ALE_CONNECT_REDIRECT per-process/实例重定向
- [ ] 内核侧实例上下文，避免 PID 复用竞态
- [ ] 用户态控制服务 IOCTL / 生命周期（当前由 aih-netguard 进程直接持有设备）
- [ ] EV 签名 / attestation / test signing 方案（测试证书已就绪，testsigning 待重启）
- [ ] EDR/杀软兼容测试
- [x] 当前默认决策：WFP 驱动可用时优先，否则 WinDivert；WFP 加载验收后再最终定稿

### 2.4 Windows GUI 验收

- [x] App Desk 严格启动 Windows 端到端（独立测试 Server）：Edge 通过 `--proxy-server` 走 18081，guard PID 写入台账、desk 可见、kill 后 guard 退出
- [x] 双 Chrome 真机（同一 guard 保护两棵进程树）：A 配 `--proxy-server=http://127.0.0.1:18081`，页面正文为百度真实内容；B `--no-proxy-server`，正文为空、标题退化为 `baidu.com`；proxy 日志只出现 A 的 `CONNECT www.baidu.com:443`；`blocked=70`
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
- [x] Codex CLI 真实 API 通过 sandbox：`aih-netguard exec --proxy-url http://127.0.0.1:6152 -- codex exec ... "Reply with exactly OK"` 返回 `OK`
- [x] Claude CLI 真实 API 通过 sandbox（经 AIH 网关：`ANTHROPIC_BASE_URL=http://127.0.0.1:9527` + `ANTHROPIC_AUTH_TOKEN`，返回 `OK`）
- ⛔ Gemini / AGY CLI 真实 API 验收：Gemini CLI 认证配置拒绝 API-key（`Invalid auth method selected`）；AGY 本机未安装。需先修本机认证/安装
- [x] 多实例不同代理验收（真机：6152 AU / 6156 SG，两个 sandbox 实例出口不同；直连均被拒）
- [ ] DNS 严格阻断（当前 DNS 经 mDNSResponder 仍可解析；Phase 5）
- [ ] 与 Provider CLI 启动路径集成（Phase 8）

### 3.2 GUI App 🚧

- [x] Chromium GUI 直接可执行 + sandbox 原型：Chrome 启动、建立到 6152 的连接；外层 sandbox 拒绝直连
- [x] 需要 `--no-sandbox` 才能避免 Chromium 嵌套 sandbox 初始化失败（安全降级，需决策）
- [x] Chromium GUI 沙箱启动（opt-in `AIH_NETGUARD_SANDBOX_GUI=1`）：直接执行 bundle 可执行文件 + sandbox-exec + `--no-sandbox`；真机 Chrome 全部 TCP 只连 127.0.0.1:6152，无外部连接
- [x] Vendor Electron 沙箱启动：ChatGPT.app 直接可执行文件 + sandbox-exec 启动成功，实例无外部 TCP socket；但它不读环境代理，当前只做到 fail-closed
- ⛔ Vendor App 代理可用性：ChatGPT 无外部 socket 但未验证代理请求；VS Code 单实例交接给已运行实例（仍用原 user-data-dir），不结束用户应用无法隔离
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
- [x] 进程树验收：AWS 真机用子进程继承 cgroup，DNS/网络策略生效（GUI 显示未测，无桌面会话）
- [ ] 多实例不同代理验收
- [ ] 与 Docker/Colima/VPN/Tailscale 规则冲突处理
- [ ] 容器/VM 不在宿主进程树范围的文档化

---

## Phase 5 — DNS Guard

- [x] Linux：nftables nat 链把 cgroup 的 UDP/TCP 53 redirect 到 DoH bridge；AWS 真机 `getent example.com` 成功且代理日志出现 `CONNECT 1.1.1.1:443`
- [x] 结论：Windows/macOS 无法用当前按 PID 的 guard 阻断 DNS。真机：受保护进程 `Resolve-DnsName` 成功，DNS 包来自 svchost（pid 5988/10888），不在实例集合；macOS sandbox 连 `(deny mach-lookup)` 也仍能解析。必须用 WFP NRPT/DNS 策略或 Network Extension
- [x] 代理端域名解析验证：DoH over HTTP CONNECT 真机通过（Linux）
- [ ] 本地 DoH/DoT 桥：DNS 流量走代理（兼容档）
- [ ] mDNSResponder / Windows Dnscache 特殊处理
- [ ] 出口 IP/国家与 DNS 落点一致性验证
- [ ] CLI/GUI 的 DNS 泄漏验收

---

## Phase 6 — LaunchProfile 与 preflight

- [x] LaunchProfile 持久化（按 provider/surface/account/instanceSlot）→ `<aiHome>/run/launch-profiles.json`，原子写、0600
- [x] 记忆 ProxySpec（direct/local/selector/URL）+ 最近解析入口与地区，不保存凭据
- [x] App Desk 启动成功后自动写入；`GET /v1/management/webui/apps/profile?id=` 读取
- [x] WebUI 启动弹窗预填上次代理（真机：Calculator 显示“已记住上次：直连”并选中直连）
- [x] 打开前代理 preflight：真实探测入口 host:port；不可用返回 409 `preflight_failed` + 详情
- [x] 失败交互：WebUI 弹窗“仍然启动 / 取消”；API `force:true` 继续并在响应中带 warning
- [ ] 账号凭据与 Guard 可用性 preflight（账号侧/严格模式接入后）
- [ ] selector 候选可出网与入口可绑定 preflight（当前由 Ensure 失败路径覆盖）
- [ ] 节点失效时提示“范围内换节点”，不静默换出口
- [ ] WebUI/CLI 编辑与重置 LaunchProfile（当前仅启动成功自动更新）
- [ ] Provider desktop/CLI 启动路径写入同一 Profile（Phase 7/8）

---

## Phase 7 — 统一实例台账与控制面

- [x] App Desk 启动路径注册 appsessions（Provider desktop/CLI 仍未注册）
- [x] 实例字段：proxy/selector/国家城市、Guard PID/backend/active/error、进程 PID、健康
- [x] 严格模式启动：`networkMode=strict_proxy` 在启动应用前校验 NetGuard 可用；启动后以实例根 PID 拉起 `aih-netguard`，写入台账
- [x] Guard 生命周期：结束实例/自然退出后回收 Guard PID（真机用假 guard 验证：启动 84932、desk 可见、kill 后进程消失）
- [x] WebUI：启动弹窗“严格隔离（实验）”开关；实例行显示 Guard 后端/PID 或“Guard 未启用”
- [x] Provider open-app 路径注册 appsessions（`webuiopenappapi` 成功后写 manual 台账：provider/account/kind、PID、可执行入口；close 标记退出）
- [x] Provider 原生 CLI（`aih <provider>` 经 aihcli.App.Run）注册 appsessions manual 行（PID=当前 aih 进程，退出时 MarkExited）
- [ ] WebUI 看板：换代理、重启、查看 Guard 日志
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
| 严格进程级网络控制（跨平台） | 中 | 30% | 🚧 Phase 1/2/3 |
| Windows per-instance GUI（JP/SG） | WFP 内核阻断/loopback/非目标真机通过；App Desk 严格启动通过 | 60% | 🚧 Phase 2 |
| macOS CLI strict | 机制+Claude/Codex 真实 API 通过 | 50% | 🚧 Phase 3 |
| macOS GUI strict | App Desk 严格启动走 sandbox-exec，台账/进程真机通过 | 45% | 🚧 Phase 3 |
| Linux CLI/GUI strict | cgroup 阻断真机通过 | 25% | 🚧 Phase 4 |
| DNS Guard | Linux redirect→DoH 真机通过 | 30% | 🚧 Phase 5 |
| LaunchProfile / preflight | App Desk 持久化+预填+代理预检真机通过 | 50% | 🚧 Phase 6 |
| 统一实例台账 / 可观测 | App Desk Guard + Provider open-app/原生 CLI 台账 | 65% | 🚧 Phase 7 |
| 统一编排 / Provider 接入 | 未串接 | 10% | ⬜ Phase 8 |
| 跨平台验收 / 文档 | 未开始 | 5% | ⬜ Phase 9 |
| **总目标** | — | **≈50%** | 🚧 |

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

- 当前阶段：**Windows WinDivert 严格后端已真机通过（IPv4 TCP+UDP、子进程、loopback、fail closed）；WFP 驱动待 testsigning 重启加载**
- 已完成：Phase 0；Phase 1 契约代码；WinDivert IPv4 TCP+UDP/子进程阻断；WFP 驱动构建链/驱动骨架/用户态控制；macOS CLI sandbox；Linux cgroup 阻断
- 未开始：Phase 2.2 P1 透明 TCP、Phase 3.2 vendor GUI、Phase 5–9
- 最近更新：2026-11-28
- 证据：Windows 受保护子进程 TCP/UDP 外联 `TIMEOUT`、loopback `OK`、非目标 `NON_TARGET_TCP True`、`blocked=4`；双 Chrome：代理实例正文为百度真实内容、直连实例正文为空且代理日志无其请求、`blocked=70`；`aih-netguard.sys` 9,728 B、签名 `Valid`、`sc start` = 577（testsigning 未开）；macOS 代理 204、`--noproxy '*'` 拒绝、双实例 AU/SG；Linux cgroup 目标 timeout、loopback 200、其他 301