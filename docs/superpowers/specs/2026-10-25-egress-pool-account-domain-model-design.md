# 出口池与账号状态领域模型设计

## 背景

当前出口池已经包含节点账本、账号绑定、上游地区策略、节点拦截策略、账号 lane 和会话独占等能力，但这些能力没有共享一套稳定的领域边界。结果是资源状态、账号状态、provider 状态、上游证据和运行时分配在接口和界面中互相混用。

用户会遇到以下问题：

- 账号出口设置只显示“使用 AIH 出口池”，必须跳到全局出口池页面才能知道实际节点和出口 IP。
- 全局节点表把不同账号、不同 provider、不同上游的拒绝结果聚合成一个“出口 IP 被拉黑”状态。
- 同一个节点实体、运行时节点编号、lane、账号绑定和账号使用记录没有明确区分。
- `shared`、`sticky`、`session` 既像账号配置，又像运行时 lane 策略，边界不清楚。
- 账号的全局状态没有被所有页面、调度器和出口视图作为唯一实体引用，存在串号和状态覆盖风险。

当前实现中已有可复用的局部能力：

- `lib/account/zcode-egress-binding-store.js` 已保存账号级出口绑定、节点范围和轮换策略。
- `lib/server/egress-pool-planner.js` 已按账号、上游、节点范围和策略生成 lane。
- `lib/runtime/egress-pool-node-health.js` 已按出口身份保存节点账本，并记录账号使用关系。
- `lib/runtime/egress-pool-node-policy.js` 已将延迟、不可达和手动关闭做成节点拦截策略。
- `lib/server/egress-region-policy.js` 已提供上游与出口之间的规则和证据判定。
- `web/src/features/egress-pool/` 和 `web/src/features/egress-upstream/` 已提供节点资源和上游判定的基础 UI。

这些模块需要被重新组织到一个完整的领域模型中，而不是继续在现有字段上追加特判。

## 目标

1. 建立稳定的 `ProxyPoolGroup → ProxyPool → NodeMembership → NodeEntity` 资源层级。
2. 建立唯一的 `AccountEntity` 和 `AccountGlobalState`，所有页面和调度流程只引用同一个账号实例。
3. 将账号出口绑定建模为 `AccountEgressAssignment`，清楚表达账号允许使用哪个池、哪些节点和哪种调度策略。
4. 将 `RuntimeLane`、`SessionAssignment` 和 `NodeRuntime` 定义为可重建的临时运行对象，不把它们当成实体状态。
5. 将节点基础健康、provider/upstream 证据、账号/upstream 证据和账号调度状态分开保存。
6. 默认将“自选节点”定义为“允许节点集合 + 自动选择”；固定节点必须使用单独的 `pinned` 选择模式。
7. 账号出口弹窗直接展示当前池、当前 lane、活动节点、实际出口 IP 和作用域化证据，不要求用户跳到全局池页面排查账号。
8. 全局出口池页面只承担资源管理和诊断，不把账号级拒绝渲染成节点全局黑名单。
9. 保留旧数据兼容读取，迁移时不能把无作用域的历史 `ip_blocked` 直接提升为全局黑名单。

## 非目标

- 本次设计不改变代理协议本身，也不新增 `AIH_*` 环境变量。
- 本次设计不把外部 TUN 或系统代理纳入 AIH 节点实体；它们是外部出口来源，只通过统一的 `EgressSource` 适配到账号视图。
- 本次设计不要求一次性删除现有 `/v0/webui/egress-pool` 和 `zcode-egress` API；旧接口可以保留兼容读取，新的写入和 UI 使用新领域接口。
- 本次设计不把一次 provider 失败自动升级为全局节点禁用。

## 核心概念

### 资源层

```text
ProxyPoolGroup
  └── ProxyPool
        └── NodeMembership
              └── NodeEntity
```

#### NodeEntity

`NodeEntity` 是稳定的代理节点实体。持久身份由稳定指纹产生，不使用本次启动的 `node-1`、`node-2` 运行编号。

```text
nodeId
protocol
server
port
credentialRef
exitIdentity
location
source
lifecycle
```

`nodeId` 必须在节点重排、订阅更新和池重启后保持稳定。节点实体只表达节点自身的资源事实，不保存某个账号的认证失败或某个 provider 的上游拒绝。

#### NodeMembership

`NodeMembership` 是池与节点的关系：

```text
poolId
nodeId
enabled
priority
weight
tags
```

一个节点可以属于多个池；池内优先级和权重不能写回节点实体。

#### ProxyPool

`ProxyPool` 是可被账号绑定的业务池：

```text
poolId
poolGroupId
name
selectionModeDefault
rotationPolicy
healthPolicy
upstreamCompatibilityPolicy
```

它不是运行时 lane，也不是账号列表。

#### ProxyPoolGroup

`ProxyPoolGroup` 组织多个业务池，例如 Claude 亚洲低延迟、Codex 主池、AGY 备用池。订阅导入产生的来源分组必须使用独立的 `NodeSourceGroup` 概念，不能直接当作业务池组。

### 账号层

#### AccountEntity

账号的唯一身份是 `accountRef`：

```text
accountRef = 唯一实体身份
provider + cliAccountId = 展示身份
index = provider 作用域内的展示编号
```

一个索引账号实例只能指向一个 `AccountEntity`。账号列表、模型调度、出口绑定、运行态和诊断证据都必须通过 `accountRef` 访问同一个实体。

#### AccountGlobalState

账号全局状态只由账号状态服务维护：

```text
authStatus
runtimeStatus
schedulingStatus
cooldown
disabled
reauthRequired
lastSuccess
lastFailure
modelCapabilities
```

出口池不复制这些字段；出口池只保存 `accountRef` 引用和运行时分配结果。

#### AccountEgressAssignment

账号出口绑定表达“允许这个账号从哪个池出网”：

```text
accountRef
poolGroupId
poolId
selectionMode: auto | pinned
strategy: shared | sticky | session
scope: all | groups | nodes
fallbackPolicy
updatedAt
```

已确认的默认语义是：

```text
selectionMode = auto
scope = allowlist
```

当 `scope.kind = groups` 或 `scope.kind = nodes` 时，它表示允许集合，而不是当前实际节点。固定节点必须使用：

```text
selectionMode = pinned
pinnedNodeId = node_xxx
```

不能继续让“自选节点”同时表示 allowlist 和 pinned。

### 运行层

#### RuntimeLane

`RuntimeLane` 是运行时为一个池、账号或会话准备的临时出站通道。它可以在进程重启或规划变化后重建，不是持久业务实体。

#### SessionAssignment

`SessionAssignment` 表示某个本地 CLI 会话当前认领的 lane：

```text
sessionId
accountRef
poolId
laneId
nodeId
assignedAt
releasedAt
```

#### NodeRuntime

`NodeRuntime` 是 NodeEntity 在本次进程中的运行实例。`node-1` 等名称只属于这一层。

## 状态与证据作用域

必须使用独立的状态类型，不能用单个 `EgressPoolNodeHealth` 表示所有结论。

| 状态 | 唯一作用域 | 允许表达的事实 |
| --- | --- | --- |
| `NodeHealth` | `nodeId / exitIdentity` | 网络连通、延迟、DNS、基础探测、节点运行状态 |
| `NodePolicy` | `nodeId / exitIdentity` | 管理员手动关闭、延迟阈值、不可达拦截 |
| `ProviderExitEvidence` | `provider + upstreamId + nodeId/exitIp + modelFamily` | provider 级别的地区、权限或出口拒绝证据 |
| `AccountUpstreamEvidence` | `accountRef + provider + upstreamId + nodeId/exitIp + credentialGeneration` | 具体账号使用具体出口访问具体上游的结果 |
| `AccountGlobalState` | `accountRef` | 认证、运行和全局调度状态 |
| `AccountSchedulingState` | `accountRef` | 账号冷却、禁用、连续失败和恢复状态 |

“出口 IP 被拉黑”只能作为有作用域的证据，例如：

```json
{
  "scope": "account_upstream_exit",
  "accountRef": "acct_xxx",
  "provider": "claude",
  "upstreamId": "anthropic",
  "nodeId": "node_hk_03",
  "exitIp": "203.0.113.10",
  "modelFamily": "claude",
  "reason": "abusive_traffic",
  "source": "real_upstream_response",
  "confidence": "account_specific",
  "at": 0
}
```

作用域提升规则：

1. 一次账号失败只能写 `AccountUpstreamEvidence`。
2. 多个账号、同一 provider、同一上游、同一出口得到一致证据后，才能形成 `ProviderExitEvidence`。
3. 只有明确的 NodeHealth 或 NodePolicy 证据才能影响全局节点轮换。
4. `AccountUpstreamEvidence` 不能直接修改另一个账号的状态。
5. `ProviderExitEvidence` 也不能直接把节点标成所有 provider 都不可用。
6. 每条证据必须保留来源、时间、作用域和置信度。

## 调度数据流

```text
AccountEntity
  ↓
AccountGlobalState
  ↓
AccountEgressAssignment
  ↓
ProxyPoolGroup / ProxyPool
  ↓
NodeMembership
  ↓
NodeHealth + NodePolicy
  ↓
ProviderExitEvidence
  ↓
AccountUpstreamEvidence
  ↓
RuntimeLane
  ↓
SessionAssignment
  ↓
NodeRuntime
```

请求失败后的写回规则：

```text
网络连接失败        → NodeHealth
provider 地区拒绝   → ProviderExitEvidence
账号认证失败        → AccountGlobalState
账号+上游+出口拒绝  → AccountUpstreamEvidence
账号连续失败        → AccountSchedulingState
管理员手动关闭节点  → NodePolicy
```

## API 设计

旧接口保留兼容读取；新写入使用领域接口。

```text
GET  /v0/webui/egress-pool-groups
GET  /v0/webui/egress-pools
GET  /v0/webui/egress-pools/:poolId
GET  /v0/webui/egress-nodes/:nodeId

GET  /v0/webui/accounts/:provider/:accountRef/egress
PUT  /v0/webui/accounts/:provider/:accountRef/egress-assignment
GET  /v0/webui/accounts/:provider/:accountRef/egress-runtime

GET  /v0/webui/egress-evidence
POST /v0/webui/egress-evidence/:id/reset
```

账号视角接口必须直接返回：

```json
{
  "account": {
    "accountRef": "acct_xxx",
    "provider": "claude",
    "index": 2
  },
  "assignment": {
    "poolGroupId": "claude-asia",
    "poolId": "asia-low-latency",
    "selectionMode": "auto",
    "strategy": "session",
    "scope": {
      "kind": "groups",
      "groups": ["asia"],
      "nodes": []
    }
  },
  "runtime": {
    "lanes": [
      {
        "sessionId": "session-a",
        "nodeId": "node-hk-03",
        "exitIp": "203.0.113.10"
      }
    ]
  },
  "verdict": {
    "scope": "account_upstream_exit",
    "status": "allowed",
    "provider": "claude",
    "upstreamId": "anthropic",
    "nodeId": "node-hk-03",
    "source": "real_traffic",
    "at": 0
  }
}
```

## UI 设计

### 账号出口设置

账号弹窗必须直接显示：

```text
账号 / provider / 上游
代理池组 / 代理池
选择模式：自动选择 / 固定节点
允许节点范围
轮换策略：共享轮换 / 账号独占 / 会话独占
当前 lane
当前节点实体
当前运行节点
实际出口 IP
节点基础健康
当前账号和上游的作用域化结论
证据来源与时间
```

账号弹窗不应要求用户跳转到全局出口池才能查看当前生效节点。全局池页面只作为资源管理入口。

### 全局出口池

全局页面改为资源管理视角：

```text
代理池组
  └── 代理池
        └── 节点实体
              ├── 基础健康
              ├── 运行状态
              ├── 成员关系
              └── 引用账号 / 会话数量
```

全局节点表不能直接显示无作用域的“出口 IP 被拉黑”。它应显示：

```text
基础网络：可用
Claude / acct_2 / api.anthropic.com：被拒
Codex / acct_5 / api.openai.com：未知
AGY / acct_1 / generativelanguage.googleapis.com：可用
```

“全部节点”代表 NodeEntity 资源列表；“自建分组”代表 NodeSourceGroup；“自选节点”代表账号 allowlist。

## 迁移规则

1. `account:egress:*` 迁移为 `AccountEgressAssignment`。
2. 旧 `scope` 迁移为 allowlist，不推导当前节点。
3. `shared / sticky / session` 保留为 RuntimeLane strategy。
4. `node-health.json` 只迁移基础节点健康、网络冷却和 NodePolicy 相关字段。
5. 无 provider/account/upstream 作用域的历史 `ip_blocked` 标记为 `legacy_unscoped_evidence`，不能直接变成全局黑名单。
6. 旧 `egress:upstream-evidence:*` 如果缺少作用域，只能作为低置信度提示，不得直接阻断账号。
7. 订阅 catalog group 不能自动等同于业务 ProxyPoolGroup；需要明确的 NodeSourceGroup 到 ProxyPool 的映射。
8. 旧 API 保留兼容读取；新写入全部经过新的领域服务。
9. 迁移必须可回滚，旧记录在新模型完成验证前不能删除。

## 分阶段实施

### Phase 1：契约和唯一身份

- 新增 NodeEntity、ProxyPool、ProxyPoolGroup、AccountEgressAssignment、EgressObservation 契约。
- 固化 `accountRef` 和稳定 `nodeId` 的唯一键规则。
- 加入 Entity/Identity Map，禁止同一账号和节点在不同服务中复制状态。
- 不改变 UI 和现有运行逻辑。

### Phase 2：状态和证据拆分

- 将 NodeHealth、NodePolicy、ProviderExitEvidence、AccountUpstreamEvidence、AccountSchedulingState 分离。
- 历史无作用域 `ip_blocked` 降级为 legacy evidence。
- 所有失败写回使用作用域化事件。
- 增加跨账号、跨 provider、跨 upstream 隔离测试。

### Phase 3：调度重构

- planner 只消费 AccountEgressAssignment、NodeHealth、NodePolicy、ProviderExitEvidence、AccountUpstreamEvidence。
- 输出 RuntimeLane 和 SessionAssignment。
- 明确 `auto + allowlist` 和 `pinned + nodeId` 的两种选择模式。
- 保留 shared/sticky/session 的现有意图，但不让 lane 反向成为账号状态源。

### Phase 4：账号视角 API/UI

- 先改账号出口弹窗，直接回显 pool group、pool、策略、allowlist、活动 lane、节点和出口 IP。
- 增加账号/上游/节点作用域化诊断。
- 保存后显示生效结果和失败原因。

### Phase 5：全局资源管理 UI

- 出口池页面改成 PoolGroup → Pool → NodeEntity 层级。
- 增加资源视角和账号诊断视角。
- 从节点全局状态中移除账号专属“IP 被拉黑”语义。

### Phase 6：迁移、兼容和清理

- 迁移旧绑定、旧健康账本和旧证据。
- 保留兼容读取和回滚路径。
- 删除会造成歧义的旧字段和无作用域 UI 文案。

## 验收矩阵

1. 两个相同 provider 的账号使用同一个 NodeEntity，其中一个被上游拒绝，另一个仍为未知或可用。
2. 两个不同 provider 使用同一个出口 IP，provider A 的拒绝不修改 provider B 的状态。
3. 同一个账号访问两个上游，A 被拒不影响 B。
4. 账号弹窗直接显示当前 PoolGroup、Pool、策略、活动节点、出口 IP 和证据作用域。
5. `session` 策略下，同一账号的两个 CLI 会话显示不同 RuntimeLane/NodeEntity。
6. 全局池页面不把账号级拒绝显示成节点全局红色状态。
7. NodeEntity 在重启、重排和订阅更新后身份稳定。
8. 一个 AccountEntity 只有一份全局状态，所有列表、调度和出口视图引用它。
9. 历史无作用域 `ip_blocked` 不会成为全局黑名单。
10. NodePolicy、Evidence、AccountGlobalState 在 API 和 UI 中可区分。
11. “允许集合 + 自动选择”是默认账号出口语义。
12. 固定节点必须使用独立 `pinned` 模式。
13. 旧 API 兼容读取，新写入使用新领域服务。
14. 迁移可以回滚，不丢失原有账号绑定、节点身份和证据记录。

## 设计模式

- `Entity + Identity Map`：AccountEntity、NodeEntity 唯一维护。
- `Aggregate`：ProxyPoolGroup → ProxyPool → NodeMembership。
- `Strategy`：shared、sticky、session、pinned。
- `Specification`：NodeHealth、ProviderExitEvidence、AccountUpstreamEvidence 独立判定。
- `Projection / Read Model`：账号视角和资源视角分别生成。
- `Registry`：PoolGroup、Pool、NodeEntity、AccountEntity 索引。
- `Observer / Event Ledger`：请求和探测结果写入作用域化观察记录。
- `Single Source of Truth`：AccountGlobalState 由 AccountStateService 统一维护。

## 设计决策记录

- “自选节点”默认语义已确认：允许节点集合 + 自动选择。
- 固定节点不复用“自选节点”语义，使用单独的 pinned 模式。
- 无作用域的旧 `ip_blocked` 不能自动升级为全局节点黑名单。
- 账号弹窗必须直接显示账号视角运行态，不依赖跳转到全局资源页面。
