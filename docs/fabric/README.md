# AIH Fabric Design Pack

AIH Fabric 是下一阶段远程开发产品线的设计源。这里的文档先于代码实现，用来保证后续开发能被用户理解、被测试复现、被长期追溯。

## 阅读顺序

1. [00-product-brief.md](00-product-brief.md): 产品目标、竞品、范围和成功标准。
2. [01-network-topology.md](01-network-topology.md): 角色叠加、网络拓扑、选路和低带宽策略。
3. [02-user-flows.md](02-user-flows.md): 从添加 server 到进入远程开发会话的标准流程。
4. [03-data-model.md](03-data-model.md): ER 图、数据对象、状态和可追溯要求。
5. [04-protocol.md](04-protocol.md): command/output 层、语义层、传输层和断线恢复。
6. [05-ui-wireframes.md](05-ui-wireframes.md): 客户端信息架构和关键页面线框。
7. [06-implementation-plan.md](06-implementation-plan.md): 里程碑、任务拆分和工程规则。
8. [07-test-plan.md](07-test-plan.md): 真实网络实验、弱网验收和回归矩阵。
9. [08-current-status.md](08-current-status.md): 当前进度、已验证证据和下一步。
10. [09-development-lifecycle.md](09-development-lifecycle.md): 从立项到发布的阶段门、责任分工和追溯规则。
11. [10-legacy-control-plane-migration.md](10-legacy-control-plane-migration.md): 旧 Control Plane/remote node 能力到 Fabric 的迁移映射。
12. [11-competitive-and-transport-research.md](11-competitive-and-transport-research.md): 竞品、WebRTC/WebTransport/MPTCP/OMR 的产品取舍依据。
13. [15-unified-node-product-model.md](15-unified-node-product-model.md): 统一 Node 产品模型、页面映射、AWS 当前能力和后续 P0 计划。

实验记录放在 [evidence/](evidence/)；任何真实网络、远程运行、弱网、relay failover 结论都必须有对应 evidence 文件。

## 当前原则

- 不再把当前 WebUI 入口当作默认产品形态。客户端必须先配置并选择 server。
- 任意 AIH 实例可以同时是 client、server、node、relay node。
- Codex/Claude/AGY/OpenCode runtime 的消息、slash、审批、恢复和诊断能力优先于现有 WebUI chat 体验。
- 用户可见主对象是 Node；server、relay、runtime、SSH、transport 和 health 都是 Node 的能力或观测面。
- WebRTC、QUIC/WebTransport、WSS fallback 都进入本阶段 transport candidates；未过 promotion gate 前不能作为默认连接方式。
- 所有网络和会话能力必须有 evidence，不允许只停留在“理论上可用”。
- `fabric transport probe` 只证明端口或 HTTP 可达；`fabric transport tcp-echo` 证明应用数据能往返；`fabric transport echo` 证明 WebSocket echo/session-level RTT。
