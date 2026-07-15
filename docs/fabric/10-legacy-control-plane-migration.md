# AIH Fabric Legacy Control Plane Migration

> **历史归档（禁止作为当前实现依据）**：本文保留旧阶段设计；其中客户端 pairing、device token、scope/revoke、Control Plane 或 Node-first 表述仅用于追溯，**不得实现或恢复**。当前客户端只使用 `Server URL + Management Key`；worker join invite 仅用于高级 worker 接入，不是客户端授权。当前规范见 [20-current-server-client-model.md](20-current-server-client-model.md) 和仓库根 [README.md](../../README.md)。

## 背景

当前仓库已经有 Control Plane、remote node、relay、device pairing、bootstrap、remote audit 等能力，但产品概念和入口不够清晰。Fabric 不应该全部推倒重写，也不能继续在旧 WebUI 上叠功能。

迁移目标是：复用已验证的底层资产，把用户可见模型升级为 server profile first、instance roles、transport candidates、remote session。

## 旧能力现状

| 旧概念/模块 | 当前作用 | Fabric 映射 | 迁移策略 |
|---|---|---|---|
| Control Plane | hub-and-spoke 管理端 | Server role / coordination domain | 保留 server 能力，客户端入口改为 server profile first |
| Device client profile | 手机/PWA/电脑配对 token | `server_profiles` + `device_sessions` | 保留配对思想，补 profile 测试和登录流程 |
| Remote node | 被管理机器 | Node role | 迁移到 roles/capabilities/project grants |
| `aih node relay connect` | node 主动出站到 Control Plane | Relay link / WSS fallback | 作为 WSS baseline 复用，补指标和恢复 |
| `remote-nodes.json` | 本地 remote registry v1 | `nodes`、`transport_endpoints`、`relay_links` | 作为迁移输入，不作为长期模型 |
| Remote audit log | 远程请求审计 | `audit_events` | 保留 append-only 思路，补 trace/session/evidence 关联 |
| WebUI Remote Nodes | 配置和测试远程节点 | Server Dashboard / Nodes / Relay Health | UI 信息架构重建，不继续扩大旧页面 |
| Node bootstrap | 远程安装和 join 脚本 | Node onboarding | 保留为运维工具，补 evidence 写回 |
| Management API proxy | WebUI 代理 management 请求 | Server API facade | 保留代理边界，浏览器不拿 management key |

## 可复用资产

- `lib/cli/commands/node-router.js`: join、doctor、bootstrap、relay connect/service 命令入口。
- `lib/cli/services/node/relay-client.js`: outbound WSS relay client、heartbeat、stream window。
- `lib/server/remote/relay-server.js`: relay upgrade、relay request、relay stream、route allowlist。
- `lib/server/remote/remote-gateway.js`: transport selection、remote management request、audit hook。
- `lib/server/remote/*registry*`: node/transport registry 的 v1 形态。
- `test/node-relay-client.test.js`、`test/remote-node-registry.test.js`、`test/web-ui-router.remote-nodes.test.js`: 旧能力行为边界。

## 停止扩张的旧边界

- 不再把旧 WebUI Chat 当作默认入口。
- 不再把 Control Plane 等同于产品终态 server。
- 不再用 `/test` 返回 200 代表远程开发成功。
- 不再把 `remote-nodes.json` 继续扩成所有 Fabric 状态的总表。
- 不再把 relay 成功连接等同于远程开发会话成功。
- 不再把 OMR/MPTCP 当成 AIH 自己的穿透能力；它们只能是 underlay 优化。

## 迁移路线

### Step 1: Transport Lab 复用旧 relay

使用现有 `aih node relay connect` 和 `relay-server` 建立 WSS baseline，但必须新增：

- RTT p50/p95。
- 重连次数和原因。
- stream ack/window 指标。
- 断线 resume evidence。
- 与 `fabric transport probe` 的同一 evidence schema。

### Step 2: Server Profile First

把客户端启动入口改为：

```text
Open client -> Server Profiles -> Test -> Pair/Login -> Dashboard -> Node -> Project -> Runtime -> Remote Session
```

旧 `/ui/` 可以保留为已登录 server 下的一个页面，但不能在无 profile 时默认展示本机 WebUI。

### Step 3: Role Registry

把旧 remote node 迁移为 instance role：

- `node`: 暴露项目和 runtime。
- `relay-node`: 单独授权、单独限速、单独 health。
- `server`: 身份、目录、路由、审计。
- `client`: 保存 server profile 和 device token。

旧 registry 只做导入来源；新逻辑写入 Fabric registry/data model。

当前第一刀：

- `/v0/fabric/registry` 已成为 Fabric registry read endpoint。
- `/v0/fabric/registry/nodes` 已支持 scoped node snapshot write。
- `fabric-registry.json` 保存 Fabric role/project/runtime/relay metadata。
- 可兼容的 node/relay transport 会双写到旧 remote registry，作为迁移期 `/v0/node-rpc/device-nodes` 的回读来源。

### Step 4: Remote Session

复用现有 session stream 能力时，必须经过 Fabric protocol：

```text
transport -> session frame -> runtime event -> client renderer
```

不允许 provider-specific payload 直接污染通用 frame。Codex/Claude/AGY/OpenCode 的 message、slash、approval 和 stop 必须先归一到 Fabric command envelope。

### Step 5: Evidence and Deprecation

当 Fabric 路径覆盖旧路径后：

- README 旧 Control Plane 文档降级为 legacy/migration 说明。
- WebUI remote node 页面只保留迁移入口或跳转到 Fabric Dashboard。
- 旧 API 保持兼容一段时间，但所有新功能只进 Fabric 边界。

兼容窗口和下线 gate：

- `compat`: 旧 API 继续可用，但只修 bug，不加新产品能力。
- `dual-write`: Fabric registry 和旧 registry 同时写入，evidence 证明两边结果一致。
- `read-from-fabric`: UI 和客户端改读 Fabric，旧 registry 只做回滚来源。
- `deprecated`: 至少一个小版本保留旧 API，并在返回 payload 中暴露迁移提示。
- `removed`: 只有当 30 天内无旧 API 访问，且公司/家里互管、手机审批、remote session、relay failover evidence 全部通过后才能移除。

迁移指标：

- 旧 `/v0/webui/nodes` 访问次数。
- Fabric `nodes`/`relay_links` 写入成功率。
- 旧 registry 到 Fabric registry 的双写差异数。
- remote management `/test` 成功但 remote session 失败的比例。
- 按 server/node/transport/session 聚合的失败错误码。

## 用户可见解释

旧方案一句话：一台 Control Plane 管多台 remote node，node 主动连回 relay。

Fabric 方案一句话：任意 AIH instance 都可以选择 server，并按授权变成 client、node、relay node 或 server；公司和家里通过同一个 server coordination domain 互相发现、授权、选路和恢复。

## 迁移验收

- 用户第一次打开客户端能添加 server，而不是进入本机旧 WebUI。
- 旧 remote node 可以显示为 Fabric Node role。
- 旧 relay connect 可以产生 Fabric `relay_links` 和 `network_measurements`。
- 公司控制家里、家里控制公司都能从同一套流程解释。
- 远程开发会话成功必须有真实 provider runtime evidence，不能只用管理接口测试替代。
