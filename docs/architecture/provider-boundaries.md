# Provider 领域分层与语言决策

状态：已采纳（第一阶段）

范围：Provider 静态定义、跨语言合同和现有消费层收敛；不包含网关主链重写。

## 1. 问题定义

旧实现把 Provider 身份、展示字段、认证方式、CLI 配置、原生能力和会话同步清单分散在 Node 与 Web 文件中。新增 Provider 即使还没有进入运行链，也要修改多份联合类型、对象和列表，容易出现字段漏配、顺序漂移和 Client 崩溃。

本阶段建立以下约束：

- Provider 静态定义只有一个人工维护源。
- Server、Client 和兼容层只能消费生成合同，不能再复制完整 Provider 清单。
- Provider 只声明身份、认证方式、能力和适配器选择，不执行认证刷新、协议转换、会话读取或配置写入。
- 现有 Node 网关继续运行，不引入新的进程、RPC 或微服务边界。

## 2. 正确的分层名称

`server / client / core` 是部署或运行位置，不能完整表达依赖方向。项目后续统一使用下面的逻辑分层：

| 逻辑层 | 当前路径 | 职责 | 允许依赖 |
|---|---|---|---|
| Domain Core（领域核心） | `core/providers/` | Provider 身份、值类型、能力声明、合同校验、只读目录 | Go 标准库；不依赖 Server、Web、数据库和 I/O |
| Contract Boundary（合同边界） | `contracts/providers/` | 跨语言、可版本化的生成合同 | 只包含数据，不包含行为 |
| Application（应用编排） | 当前主要在 `lib/server/`、`lib/cli/services/` | 账号选择、请求路由、用例编排 | Domain Core 的生成合同与 Integration Port |
| Integration Adapters（集成适配器） | `lib/server/`、`lib/cli/services/`、`lib/account/` 中的 Provider 专属模块 | OAuth、API Key、CLI、Hook、上游协议、会话存储等外部系统细节 | Application 定义的稳定输入；不能反向定义 Provider 身份 |
| Delivery（交付入口） | `bin/`、HTTP/SSE/WebSocket 路由 | CLI 和网络请求接入、参数校验、响应渲染 | Application；不放 Provider 业务规则 |
| Client（客户端） | `web/src/providers/`、React 页面 | 消费最小 TypeScript 投影并展示 | 只依赖生成的 Client 合同，不导入 Node Server 模块 |
| Native Platform（原生平台） | `src-tauri/`、PTY/runtime 边界 | 进程、终端、桌面系统能力 | Rust 适配器；不成为 Provider 定义源 |
| Compatibility Adapter（兼容适配） | `lib/provider-catalog.js`、`lib/provider-catalog-data.json` | 为现有 CommonJS 调用方维持旧 API 和旧数据形状 | 只读生成合同；迁移完成后可删除 |

这里的 `Server` 应理解为一个部署容器，内部仍要区分 Delivery、Application 和 Integration Adapter；不能继续把所有后端代码统称为 Server 层。

## 3. 依赖方向

```text
core/providers (Go 单一人工定义源)
          |
          v
cmd/provider-manifest (校验 + 生成)
          |
          +--> contracts/providers/manifest.json
          |             |
          |             +--> Node Compatibility Adapter
          |                         |
          |                         +--> Application / Integration Adapters
          |
          +--> web/src/providers/provider-contract.generated.ts
                                |
                                +--> TypeScript Client Catalog --> React UI
```

运行时不会调用 Go 进程。Go 只在开发和构建阶段生成合同，因此不存在新增的进程生命周期、网络故障或 IPC 成本。

## 4. 语言决策（ADR-001）

### 决策

- Go：Provider 领域核心、合同校验和跨语言生成器，优先级 1。
- Rust：Tauri、PTY、进程控制等原生平台边界，优先级 2。
- TypeScript：Web Client 与浏览器交互。
- Node.js：保留现有 Server 兼容适配和主链，按后续里程碑逐步收缩。

### 方案比较

| 方案 | 优点 | 代价 | 结论 |
|---|---|---|---|
| 全部继续 Node/TypeScript | 改动最少 | 运行时与 UI 容易继续共享可变对象，难建立强合同 | 不选作新核心 |
| Go 核心 + 生成合同 | 编译快、部署简单、适合数据校验和工具链；不影响现有运行时 | 引入 Go 工具链 | 本阶段选择 |
| Rust Provider 核心 | 类型与内存安全强，适合原生运行时 | 与现有 Node/Web 连接需要绑定、WASM、IPC 或第二套生成链 | 暂不选择 |
| Go Provider 微服务 | 可独立部署 | 当前没有独立扩缩容需求，增加 RPC、监控和故障面 | KISS/YAGNI 拒绝 |

### 取舍

本阶段接受 Node 主链仍存在的事实，优先消除多份静态定义。只有性能剖析证明请求主链是瓶颈，并且边界合同稳定后，才评估把 Application 或协议适配器迁到 Go。Rust 不与 Go 同时维护 Provider 静态真相，避免“双核心”。

重新评估条件：

- Node 网关在可复现压测中成为主要 CPU 或内存瓶颈。
- Native Runtime 需要共享强类型 Provider 能力，并且生成合同不能满足要求。
- 团队需要把某个模块独立部署或独立扩缩容。

## 5. Provider 合同边界

Provider 定义可以包含：

- 稳定 ID 和展示元数据。
- 网关生命周期状态。
- 声明式能力。
- 支持的认证选项。
- 可选 CLI 投影。
- 可选原生能力边界。
- 会话同步模式和适配器选择。

Provider 定义不能包含：

- Token、API Key、账号状态或额度运行态。
- OAuth 刷新、HTTP 请求、SSE 解析、错误分类等执行逻辑。
- 数据库、文件系统、终端或 React 依赖。
- 为未来功能预留的空方法或胖接口。

## 6. 新增 Provider 的标准流程

1. 在 `core/providers/builtins.go` 添加定义；如原生能力已确认，再在 `native.go` 添加对应声明。
2. 仅在真实功能需要时实现相应 Integration Adapter。API-only Provider 不必伪造 CLI 配置。
3. 执行 `npm run providers:generate`，生成规范 JSON、旧 Node 投影和 TypeScript Client 投影。
4. 执行 `npm run test:providers`，验证两个自有 Go 包、生成投影、兼容 API 和消费注册表一致；不要用根目录 `go test ./...` 扫描 `web/node_modules` 中的第三方 Go 源码。
5. 执行 Web 构建与全量测试，确认旧运行链没有行为回归。

新增静态定义时不再手工修改：

- Web `Provider` 联合类型。
- Accounts 认证选项对象。
- Node Provider 展示目录。
- CLI Provider 总表。
- Native capability 总表。
- Session sync 三态总表。

品牌 SVG、真正的认证实现、上游协议实现和模型路由仍是独立能力，不应伪装成“加一条定义就自动实现”。没有专用品牌图标时 Client 使用统一回退图标。

## 7. `clawdcodex` 复用结论

可复用的是设计原则，不直接复制实现：

- `crates/providers/src/lib.rs` 的轻量 Provider 思路：只回答身份、描述和能力。
- `capability.rs` 的能力枚举，以及 `registry.rs` 的 Registry 边界。
- `docs/planning/provider-manager-domain.md` 对账号真相、认证、Runtime 与 Relay 的职责拆分。

不直接复制的原因：

- 其内置定义当前主要覆盖 OpenAI 与 Claude，AI Home 已有十个 Provider。
- 其 `ProviderKind` 与 Rust accounts 领域直接耦合，不能作为 AI Home 的跨语言唯一真相。
- 直接引入会让 Go 与 Rust 同时维护 Provider 核心，产生本次重构正要消除的双定义。

因此本阶段只采用 Thin Provider、Capability Registry 和 Adapter 分离思想；`clawdcodex` 不成为编译依赖或代码来源。

## 8. 使用的设计模式

| 模块 | 模式 | 目的 |
|---|---|---|
| `core/providers/catalog.go` | Registry | 集中查询 Provider 身份和能力，返回防御性副本 |
| `cmd/provider-manifest` | Code Generation / Projection | 从一个定义源生成不同语言所需的最小投影 |
| `lib/provider-catalog.js` | Anti-Corruption Layer / Adapter | 把新合同转换成现有 Node API，限制迁移影响面 |
| `web/src/providers/catalog.ts` | Client Facade | 隐藏生成文件细节，为 React 提供稳定只读入口 |

未引入 IoC 容器、动态插件系统、微服务、CQRS 或事件溯源；当前问题不需要这些复杂度。
