# Production Route Catalog Snapshot v1

## 1. 目标

生产路由目录把账号管理写侧维护的本地模型正排、倒排索引编译为 Canonical 推理使用的
不可变快照。它解决两个一致性问题：

- `/v1/models` 展示的模型必须来自已经发布的生产路由快照；
- 推理请求不能在热路径查询 SQLite、请求上游模型目录或重建路由。

本阶段只支持 Codex 和 Claude，不修改 `aih.db` schema，不创建运行态表、目录表、
Node bridge 或 stdio worker。

## 2. 数据流

```text
账号添加 / 导入 / 启停 / 重登 / 模型刷新 / 人工模型策略
                    │
                    ▼
        sqliteaccount routingIndex
        正排：(accountRef -> models)
        倒排：(provider, model -> accounts)
                    │ 写事务提交且索引发布后通知
                    ▼
        RefreshCoordinator（容量一合并队列）
                    │ 单 worker、锁外构建
                    ▼
      Builder + ProviderRouteFactory Registry
          Codex -> Codex Responses
          Claude -> Claude Messages
                    │
                    ▼
      Snapshot(models + immutable RouteCatalog)
                    │ atomic.Pointer 完整替换
          ┌─────────┴──────────┐
          ▼                    ▼
      /v1/models       Canonical Coordinator
                            │
                            ▼
              Recruiter -> Runtime -> Adapter
```

实际征召顺序是 `Runtime eligibility -> Credential Resolver ->
CredentialTransportPolicy -> Adapter`。传输策略由目标 Adapter 声明，不由 Recruiter
根据 Provider 或凭据字符串猜测。

## 3. 快照合同

`Builder` 只接受按 `(modelID, providerID)` 排序的本地模型快照：

- Provider 必须注册唯一 `ProviderRouteFactory`；
- Factory 返回的 Provider 和真实模型必须与输入完全相同；
- 第一阶段只生成 `RouteScopeAll` 的精确模型规则；
- 客户端协议不决定上游 Provider，Responses、Chat Completions 和 Messages 都可以
  请求任意明确模型；
- 同名模型不能自动形成跨 Provider fallback；没有显式策略时整次构建失败；
- alias、prefix、wildcard 和跨 Provider fallback 不根据模型名字猜测。

空模型集合是有效快照：`/v1/models` 返回空数组，推理解析返回 route not found。构建
错误不是空快照，不能覆盖已有目录。

模型快照表达“至少一个启用账号声明支持该模型”，不承诺账号当前没有 quota、policy、
cooldown 或传输限制。快照构建刻意不读取敏感凭据；因此只有 Claude 官方 OAuth 的模型
仍可出现在目录中，但普通 Canonical 请求会在征召阶段跳过这些账号。Native Relay 继续
使用它们。当前不为这一展示差异增加凭据类型缓存、数据库列或第二套模型目录。

## 4. 发布和失败语义

`AtomicCatalog` 同时实现 `RouteResolver` 和 `RoutableModelReader`：

- 首次成功构建后才设置 `ready=true`；
- 请求只执行一次原子指针读取；
- 成功刷新一次性替换模型和路由，并清除 `stale`；
- 首次构建失败时不创建假模型，readiness 返回不可用；
- 后续构建失败时保留 last-known-good，并设置 `stale=true`；
- 状态只公开 ready、stale、模型数、路由数和时间，不公开账号、模型名或内部错误。

目录变化通知是非阻塞的。一个刷新正在执行时，任意数量通知只保留一个待处理信号；
执行期间出现的新变化会触发下一轮，因此不会丢失最终状态，也不会为每次账号写入创建
goroutine。

## 5. 热路径和规模

RouteRule 数量按唯一 Provider/模型组合计算，不按账号数计算。一万个账号共享一百个
模型时，目录仍约为一百条规则；账号选择原子读取模型倒排的不可变候选快照，使用独立
公平票号决定环形起点，只有通过本地运行态筛选的账号才按需读取凭据。

当前 Apple M4 本地基准：

```text
BenchmarkAtomicCatalogResolve-10
342.3 ns/op
0 B/op
0 allocs/op
```

基准只表示本机纯内存解析，不代表网络推理延迟。

## 6. HTTP 和 Claude Relay 路径

Go Host 挂载：

- `POST /v1/responses`
- `POST /v1/chat/completions`
- `POST /v1/messages`
- `GET /v1/models`

`/v1/messages` 同时是 Claude Native Relay 的官方路径。带
`X-AIH-Relay-Token` 的请求必须进入 Relay 自身鉴权；没有该 Header 的请求进入
Canonical Messages。无效 Relay Token 不允许降级为普通客户端鉴权。

Claude 凭据传输矩阵：

| 凭据 | Canonical Messages | Native Relay |
| --- | --- | --- |
| API Key | 支持 | 拒绝 |
| Auth Token | 支持 | 拒绝 |
| 自定义端点 OAuth Token | 支持 | 拒绝 |
| 官方 setup-token | 跳过 | 支持 |
| 官方可刷新 OAuth | 跳过 | 支持 |

Canonical 征召遇到官方 OAuth 时只推进稳定账号游标并继续下一候选，不调用上游，也不
记录 credential、policy、quota 或 cooldown 失败。

标准客户端支持 OpenAI `Authorization: Bearer` 和 Anthropic `x-api-key`，两种 Header
同时出现时失败关闭。Management Key 不能调用推理或模型目录。

## 7. 设计模式

| 模块 | 模式 | 目的 |
| --- | --- | --- |
| `ProviderRouteFactory` | Strategy + Registry | Provider 自己声明协议和经验证能力，Builder 不使用 Provider switch |
| `Builder` | Builder | 集中校验排序、唯一性、歧义和 RouteRule 不变量 |
| `Snapshot` / `AtomicCatalog` | Immutable Snapshot | 模型展示和路由解析一次性发布，读取无锁 |
| `RefreshCoordinator` | Coalescing Worker | 合并刷新风暴并保证最终变化不会丢失 |
| `RoutableModelObserver` | Observer | 写事务成功后从统一索引边界发送目录变化 |
| `CredentialTransportPolicy` | Strategy | Adapter 声明凭据能否由当前线协议承载，征召器不硬编码 Provider |
| `aihserver` | Composition Root | 只在最外层组装 Store、Runtime、Adapter 和 HTTP |

KISS/YAGNI 决定暂不加入持久化目录、通用事件总线、IoC 容器、动态插件或预测式模型
别名。
