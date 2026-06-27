# AIH Fabric Competitive and Transport Research

## 目的

本文回答两个问题：

1. 这个需求是否已有竞品或相邻产品验证。
2. WebRTC、WebTransport/QUIC、MPTCP、OpenMPTCPRouter 应该放在 AIH Fabric 的哪一层。

结论：需求不是凭空想象，已有产品分别验证了远端主动出站、P2P/relay fallback、云端 agent、远程 IDE、自托管开发环境和移动端控制本机 coding agent。但 AIH 的组合目标不同：项目和 provider 账号默认留在真实开发电脑，客户端只是进入被授权 node 的 provider runtime session。

来源核查时间：2026-06-26。后续如果竞品能力变化，先刷新本节再调整产品判断。

## 竞品和相邻产品

| 产品 | 官方资料 | 可借鉴点 | AIH 不照搬的点 |
|---|---|---|---|
| VS Code Remote Tunnels | https://code.visualstudio.com/docs/remote/tunnels | 远端机器主动建立隧道，客户端不需要远端有公网 IP | 不把完整 IDE remote 作为核心体验；AIH 优先多 provider runtime session |
| Tailscale | https://tailscale.com/kb/1232/derp-servers | 直连优先，无法直连时使用 DERP relay | 不要求用户先接受一个全局 VPN 身份体系；可作为 underlay |
| Cloudflare Tunnel | https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/ | 无公网 origin 通过出站连接暴露服务 | 不把 relay 路径锁死到第三方网络；AIH server/relay 要能自托管 |
| Claude Code Remote Control | https://code.claude.com/docs/en/remote-control | 移动端/网页控制本机 Claude Code，会话仍在原机器运行 | 只覆盖 Claude Code；AIH 要多 provider、多 server、多 node、relay 调度和审计 |
| GitHub Codespaces | https://docs.github.com/en/codespaces | 云端开发环境、浏览器/IDE 接入、生命周期治理 | 项目会迁移到云工作区；AIH MVP 要管理已经存在的家里/公司电脑项目 |
| Coder | https://coder.com/docs | 自托管开发环境治理、模板、访问控制 | 偏云工作区/CDE；AIH 的 MVP 是接管已有电脑上的项目 |
| JetBrains Gateway | https://www.jetbrains.com/help/idea/remote-development-starting-page.html | 本地轻客户端 + 远端 IDE backend 的体验拆分 | AIH 不绑定某个 IDE backend；核心是 agent runtime session |
| Gitpod / Ona | https://www.gitpod.io/docs | 远程 workspace 和自动化开发环境 | 仍是 workspace 平台路线；AIH 更像远程 agent runtime fabric |
| Teleport | https://goteleport.com/docs/enroll-resources/server-access/openssh/openssh-agentless/ | SSH 访问代理、审计、身份边界 | 更偏安全访问平台；AIH 的核心不是 shell 登录，而是 provider runtime 会话 |
| Cursor Cloud Agent | https://cursor.com/docs/cloud-agent | 后台 agent、远程执行、客户端审阅 | 偏 Cursor 产品闭环；AIH 要多 provider、自托管、多 node |
| OpenAI Codex | https://developers.openai.com/codex/ | 云端 coding agent、任务审阅、移动/网页入口的产品方向 | AIH 要允许本机项目、本机账号和自托管 relay，不只依赖单一 vendor cloud |

## 对 AIH 的产品约束

- Client 启动必须先选择 server profile。VS Code/Tunnel/Cloudflare/Tailscale 都证明“先有连接域/身份域，再进入资源”更可理解。
- Node 必须主动出站连接 server/relay。两端无公网 IP 时，要求 client 直接打 node 是不现实的默认路径。
- Relay 是产品内概念，不只是网络技巧。Relay node 会消耗带宽、影响稳定性，必须有授权、限速、health 和 evidence。
- 远程开发会话是第一体验。竞品远程 IDE 的价值在交互完整性；AIH 对应的是输入、slash、approval、状态恢复和诊断，而不是现有 WebUI chat。
- 诊断必须分层。`tcp connect`、`tcp echo`、`ws echo`、`runtime session` 是不同层级，任何一层失败都不能向上宣称成功。
- 直接竞品已经证明“手机/网页控制本机 agent”有用户价值；AIH 不能只做 WebUI 聊天，必须优先补远程会话桥接和 session recovery。

## Transport 取舍

协议/项目资料：

| 技术 | 官方资料 |
|---|---|
| WebRTC | https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API |
| RTCDataChannel | https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel |
| WebTransport | https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API |
| Multipath QUIC | https://datatracker.ietf.org/doc/draft-ietf-quic-multipath/ |
| MPTCP | https://www.rfc-editor.org/rfc/rfc8684 |
| OpenMPTCPRouter | https://www.openmptcprouter.com/ |

| 技术 | 放置层级 | 现阶段策略 | 原因 |
|---|---|---|---|
| WSS relay | 默认 fallback | MVP 必须可用 | 部署和企业网络兼容最好，适合小 VPS 控制流 |
| WebRTC DataChannel | Transport lab，争取进 MVP candidate | 本阶段必须做 signaling/data channel 实验 | 浏览器、手机、桌面壳都可用；适合 P2P，失败时可回 WSS |
| WebTransport/QUIC | Transport lab | 本阶段必须做 prototype，不默认启用 | 多流/低延迟有价值，但 HTTP/3/TLS/浏览器兼容要实测 |
| Multipath QUIC | 高级实验 | 不进默认路径 | IETF 工作仍需要跟进，浏览器和服务器栈部署复杂；先证明单路径可靠性 |
| MPTCP | Underlay | 只在多路径网络环境做专项实验 | RFC 8684 定义的是 TCP 多路径能力，不解决 AIH 身份、节点发现、会话恢复 |
| OpenMPTCPRouter | Underlay appliance | 可用于多 WAN VPS/家宽聚合实验 | 需要路由器/VPS/多线路部署；单 2M-3M VPS 本身不能靠它变大带宽 |

## MPTCP / OpenMPTCPRouter 判断

MPTCP 和 OpenMPTCPRouter 可以用，但不能作为 AIH Fabric 的主设计。

适用场景：

- 家里或公司有多条 WAN，需要聚合或故障切换。
- 有一台 VPS 做 aggregation endpoint。
- 目标是改善 underlay 稳定性，而不是代替 server/node/relay/session 协议。

不适用场景：

- 只有一条家宽或单个 2M-3M VPS。
- 期望它自动解决 NAT traversal、设备配对、审计、provider runtime 启动。
- 期望浏览器/PWA 直接获得 MPTCP 能力。

因此 AIH 的默认路线是：

```text
WSS fallback first
-> tcp/ws/runtime evidence
-> WebRTC direct candidate
-> WebTransport/QUIC candidate
-> multi-relay failover
-> optional MPTCP/OMR underlay optimization
```

## 研发阶段要求

- M1 必须同时覆盖 `probe`、`tcp-echo`、`ws echo`，再进入 WebRTC/WebTransport。
- WebRTC 实验必须记录 ICE candidate 类型、是否 direct、是否 relay/TURN、连接时间、RTT、失败原因。
- WebTransport 实验必须记录浏览器/Node/runtime 版本、HTTP/3/TLS 配置、connect time、stream RTT、fallback 原因。
- OMR/MPTCP 实验必须记录是否多 WAN、单链路基线、聚合后吞吐/抖动/丢包改善；没有改善就不进入产品默认配置。

## 当前结论

AIH Fabric 应该做，但不能做成“又一个 VPN”或“旧 WebUI 加 remote node 页面”。它应该是 AI coding agent 的远程控制面：

- server profile first；
- node/relay/runtime roles 显式可见；
- 远程开发会话优先；
- transport lab 用 evidence 晋级；
- 数据落到 audit、network measurements、evidence runs，能复盘。
