# AIH Fabric Design Pack

> **当前设计入口：** [20-current-server-client-model.md](20-current-server-client-model.md) 与仓库根 `README.md`。`00`-`19` 和 `evidence/` 保留为历史设计、实验和迁移证据，其中包含已经删除的旧客户端授权模型；它们不得再作为当前实现依据。

AIH Fabric 文档包用于长期追溯远程开发产品线的设计演进。新实现必须先遵循当前 Server/Client 模型，再按需查阅历史记录理解背景。

## 阅读顺序

1. [20-current-server-client-model.md](20-current-server-client-model.md): 当前唯一 Server/Client、Management Key 和 worker join 边界。
2. 根目录 [README.md](../../README.md): 当前 CLI、WebUI、Server 与跨平台客户端使用说明。
3. `00`-`19`: 只作为历史设计与迁移记录阅读。
4. [08-current-status.md](08-current-status.md) 与 [evidence/](evidence/): append-only 历史验证证据。

实验记录放在 [evidence/](evidence/)；任何真实网络、远程运行、弱网、relay failover 结论都必须有对应 evidence 文件。

## 当前原则

- 用户主概念只有 Server、Client 和 SSH 开发机；Node/worker 仅属于高级内部执行拓扑。
- 客户端授权只有 Server URL + Management Key。
- Web、桌面和 CLI 复用同一 Server API 契约；Web 只是客户端形态之一。
- Management Key 不进入 URL、普通日志或普通 CLI 输出；跨不可信网络必须使用 HTTPS/VPN/受控隧道。
- Codex/Claude/AGY/OpenCode runtime 的消息、slash、审批、恢复和诊断能力优先于现有 WebUI chat 体验。
- WebRTC、QUIC/WebTransport、WSS fallback 都进入本阶段 transport candidates；未过 promotion gate 前不能作为默认连接方式。
- 所有网络和会话能力必须有 evidence，不允许只停留在“理论上可用”。
- `fabric transport probe` 只证明端口或 HTTP 可达；`fabric transport tcp-echo` 证明应用数据能往返；`fabric transport echo` 证明 WebSocket echo/session-level RTT。
