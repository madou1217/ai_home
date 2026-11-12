# Production Route Catalog Snapshot v1

## 1. 目标

> **状态注记（2026-10-18）**：『本阶段只支持 Codex 和 Claude』已过时——Go 侧现有 `internal/adapters/{codex/responses,claude/messages,agy/codeassist}/route_factory.go` 三条 route factory，路由目录已含 agy 等更多 provider。Snapshot 编译合同仍有效。

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
- 同名跨 Provider 模型不能自动形成 fallback；没有显式策略时只隔离该模型，其他
  无歧义模型仍形成可发布快照，避免单个聚合上游拖垮全局目录；
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
| `Builder` | Builder | 集中校验排序、唯一性和 RouteRule 不变量，并线性隔离跨 Provider 歧义模型 |
| `Snapshot` / `AtomicCatalog` | Immutable Snapshot | 模型展示和路由解析一次性发布，读取无锁 |
| `RefreshCoordinator` | Coalescing Worker | 合并刷新风暴并保证最终变化不会丢失 |
| `RoutableModelObserver` | Observer | 写事务成功后从统一索引边界发送目录变化 |
| `CredentialTransportPolicy` | Strategy | Adapter 声明凭据能否由当前线协议承载，征召器不硬编码 Provider |
| `aihserver` | Composition Root | 只在最外层组装 Store、Runtime、Adapter 和 HTTP |

KISS/YAGNI 决定暂不加入持久化目录、通用事件总线、IoC 容器、动态插件或预测式模型
别名。

## 8. 2026-11-06 复核：`gateway.models.list` 的划转条件

结论：**技术上已具备划转条件，只差一次双端实测差集**（需要运行中服务的 client key，
本机当前拿不到）。

已核实的事实：

1. Node 把**完整公共目录投影**推给 Go：Go 就绪后（`lib/server/go-core-host.js:493-495`）、
   目录缓存刷新后（`lib/server/v1-router.js:1490`）；客户端见
   `lib/account/go-bridge/go-management-client.js:77`。
2. Go 优先用投影，投影缺失才回落本地可路由索引：`internal/transport/http/modelsapi/handler.go:59-63`
   （`CatalogReader`），并且 `projection_test.go` 已锁住「投影里的 node-only 模型优先于本地」。
3. `owned_by` 与 Node 同一张厂商表：`internal/transport/http/modelsapi/owner.go`
   （incl. `opencode-go/` 先于 `opencode/` 的分支顺序）。
4. models.dev 元数据快照一致：`npm run models:check` → SDK 0.0.109 / 560 models / 232 providers。
5. canary 通道已可用：`resolveGoOwnedEntryIds(manifest, ['gateway.models.list'])` 无 errors，
   `canaryIds` 含该条目；开关是 `--go-core-routes gateway.models.list`
   （或 `AIH_GO_CORE_ROUTES`，见 `lib/server/go-core-host.js:49`）。
6. manifest 的目录前置守卫（目录必须等全部推理条目）已满足：其余 gateway 条目都是 `go_owned`。

未做的一步（划转判据）：真机差集。

```bash
node scripts/compare-model-catalog.js --node http://127.0.0.1:9527 \
  --node-key <client key> --go <go url> --go-key <client key> --allow-node-only gemini
```

退出码 0 才把 manifest 的 `production_owner`/`migration_state` 改为 `go`/`go_owned`
并删掉 `blockers`；退出码 2 说明还存在未预期的 node-only 模型，必须先查清来源。
