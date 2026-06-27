# AIH Fabric Product Brief

## 背景

用户需要在公司、家里、手机、服务器之间随时接管任意电脑上的项目开发。两端通常都没有公网 IP，现有 SSH 能用但不够产品化；当前 WebUI 和 server 绑定过紧，远程节点功能缺少清晰配置入口、真实网络验收和可解释的产品流程。

AIH Fabric 的目标是把 AIH 从本机多账号工具扩展成一个远程 AI coding fabric：任意设备可以进入任意授权机器上的原生 AI coding runtime，并尽量保留 Codex、Claude、AGY、OpenCode 的 TUI/GUI 能力。

## 目标

- 公司电脑可以管理家里电脑项目，家里电脑也可以管理公司电脑项目。
- 手机 App/PWA/桌面端可以配置多个 AIH server，登录后选择 node、project、provider，再进入会话。
- 任意 AIH 实例可以同时扮演 client、server、node、relay node。
- 2M-3M 小水管 VPS 也能支撑稳定控制流和 agent 会话流。
- 远程体验优先复刻原生 TUI/GUI，包括输入消息、slash、审批、resize、键盘控制、工具调用提示。
- 每个功能从设计、实现、测试到真实运行证据都可追溯。

## 非目标

- 不做通用 VPN 产品，Tailscale、WireGuard、ZeroTier 只能作为 underlay。
- 不做云 IDE 或远程桌面，不持续传输整套 UI 像素。
- 不要求把项目搬到云服务器；项目默认留在真实开发电脑。
- 不把现有 Control Plane 页面继续扩成产品终态，必须先重构入口和概念模型。

## 竞品参照

| 竞品 | 可借鉴点 | AIH 不照搬的点 |
|---|---|---|
| VS Code Remote Tunnels | 远端主动出站建隧道，客户端无需公网 IP | 不以完整 IDE remote 为核心 |
| Tailscale | NAT traversal、直连优先、中继兜底 | 不把网络账号/VPN 作为产品主依赖 |
| Cloudflare Tunnel | 低门槛暴露无公网服务 | 不把流量完全锁在第三方网络 |
| Cursor Cloud Agents | 远端 agent + 客户端控制/审阅 | 不强制使用云工作区 |
| OpenAI Codex mobile | 手机端控制远程 coding agent | AIH 允许自托管、多 provider、多 node |
| Coder | 自托管开发环境治理 | AIH 重点是本机项目和 agent runtime 接管 |

## 核心差异化

AIH Fabric 是 AI coding agent 的远程控制层：

- 代码留在开发电脑。
- 账号和权限可治理。
- 多设备进入同一会话。
- 弱网下优先保证输入、审批、语义事件和恢复。
- 原生 TUI/GUI 不被当前 WebUI chat 简化掉。

## 功能矩阵

| 能力 | MVP | Phase 2 | Phase 3 |
|---|---|---|---|
| Server profile | 添加、测试、登录、切换、删除 | 多 server 聚合视图 | server federation |
| Node | 注册、项目发现、provider 摘要、会话启动 | 权限模板、分组、标签 | remote lifecycle 管理 |
| Relay node | 注册、测速、转发、故障切换 | 多 relay 调度 | relay 计费和配额 |
| Transport | WSS、WebRTC lab、WebTransport lab | 自动选路 | multipath QUIC 实验 |
| 原生 TUI | PTY 镜像、输入、slash、resize | 鼠标、图片、文件引用 | provider GUI bridge |
| 语义事件 | 消息、工具、审批、diff、runtime status | session snapshot | 回放和审计搜索 |
| 账号治理 | node-local 默认、account grant 设计 | 短期 credential lease | 多 server vault |
| 手机端 | PWA/壳 App server 选择和会话控制 | 推送通知 | 离线审批队列 |

## 成功标准

- 用户第一次打开客户端时知道先添加 AIH server，而不是直接看到绑定本机的 WebUI。
- 家里电脑连接 server1 后可以被公司电脑控制，也可以作为 relay node 被调度。
- 公司电脑连接 server1 后可以被家里电脑控制，反之亦然。
- 手机可以进入同一会话，发送 prompt、输入 slash、审批工具调用、查看 diff。
- 任意一个 relay 断开后，会话能按 resume token 恢复。
- 真实网络测试覆盖 3 台小 VPS、家里电脑、公司电脑和手机网络。
- 每次失败能定位到 server、node、transport、session、错误码和最近 evidence。
