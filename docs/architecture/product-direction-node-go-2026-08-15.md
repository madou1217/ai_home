# AIH 产品转向与 Node/Go 目标架构（2026-08-15）

## 1. 状态

- 产品方向：**已确认**。停止开发 `ccx`，后续产品能力统一进入 AIH。
- 本文架构：**Proposed**。用于收口当前 Node/Go 迁移，不代表现有运行链已经完成切流。
- 适用范围：本阶段账号管理、推理 Relay、WebUI、CLI/原生 Runtime 和发布验收。
- 证据基线：2026-08-15 的 AIH dirty working tree。该工作树仍有其他并行修改，本文只记录
  目标、边界和验收条件，不把未提交实现描述成稳定版本。

`ccx` 从本日起只保留为历史研究来源，不再作为产品、编译依赖、运行依赖、代码迁移底座
或未来 Rust Core 的默认候选。仍有价值的官方 CLI、协议和参考项目研究应按来源迁入 AIH，
不得继续以“复用 ccx 代码”为交付路径。

## 2. 决策摘要

本阶段不建设两个功能对等、各自持久化、各自路由的 Node/Go 版本。目标是：

> **一套业务核心、两个宿主角色、一个账号真相源。**

- **Go Core** 唯一拥有账号身份、凭据、账号模型、额度快照、运行资格、账号征召、
  Relay、失败归因和请求 attempt 历史。
- **Node Host** 保留公开产品入口、Web/Fabric BFF、原生 CLI、PTY、tmux、Session、文件、
  Git、SSH 和平台编排；不再维护第二套账号或 Relay 决策。
- **WebUI** 只消费稳定 Read Contract，不根据接口来自 Node 或 Go 自行推断业务事实。
- **Tauri** 只负责桌面传输、系统能力和安全凭据注入，不成为第三套业务核心。
- **`aih.db`** 是账号领域唯一持久化真相；`app-state.db` 只保留非账号的 UI、Native 和
  本地宿主状态。

两个进程是部署边界，不是两个业务真相。Node 可以代理 Go，但不得重新解释 Go 的账号、
路由、重试、cooldown 或错误结果。

## 3. 当前事实与直接风险

| 当前事实 | 证据 | 风险 |
| --- | --- | --- |
| npm 正式入口仍全部进入 Node；Go CLI/Server 被刻意隔离为显式 preview | `bin/ai-home.js`、`scripts/go-accounts-preview.js`、`test/go-preview-isolation.test.js` | 当前不是两个完整版本，也不能把 preview 当成已上线能力 |
| Go Server 尚未进入 npm 的正式构建、安装、启动和升级链；Node 已有默认关闭的私有 Go supervisor wiring | `package.json` 仍无 Go Host 构建/安装入口；`lib/cli/services/server/go-core-supervisor.js`、`lib/cli/bootstrap/server-wiring.js`、`test/go-core-supervisor.test.js` | supervisor 只接受显式 opt-in，尚未校验安装构件/版本/manifest，也不自动改变 9527 所有者 |
| Go 使用 `aih.db`，Node 仍维护 `app-state.db` 中的账号引用和凭据 | `internal/adapters/accounts/sqliteaccount/database.go`、`lib/server/account-ref-store.js`、`lib/server/account-credential-store.js` | 同一用户可能看到两套账号世界 |
| Node 与 Go 的 OAuth/API Key 身份种子不同 | `lib/account/account-identity.js`、`core/accounts/{codex,claude}` | 不能直接复制、双写或用邮箱盲目合并 |
| 隔离的 Go Accounts preview 已调用 `/v1/management`，正式 `/accounts` 仍使用 Node `/webui/accounts` | `web/config/routes.ts`、`web/src/services/account-management/client.ts`、`web/src/services/api.ts` | preview 合同存在不等于正式账号页已经切流 |
| Go Relay 已有请求快照、有界 attempt 和失败作用域；当前完整 Go 套件已在非缓存执行中通过 | `go test -count=1 ./...`；`test/go-core-supervisor.test.js` 验证私有 ready/stop/失败关闭 | 测试证明内部装配和局部监督合同，不证明 npm 正式安装、公开入口或真实上游验收已经完成 |
| Go 管理 DTO 已有持久化 usage 多窗口，但没有派生的 runtime eligibility、quota status 和 schedulability | `internal/transport/http/accountsapi/contracts.go`、`web/src/services/account-management/projection.ts` | 页面若把缺失派生事实当阻塞，会产生错误运维结论 |
| Accounts、Chat、Models 仍消费不同账号/模型目录 | `web/src/services/account-management/`、`web/src/services/legacy-chat-account-catalog-core.ts`、`web/src/features/chat-runtime/use-account-model-catalog.ts` | 同一账号可在三个页面呈现不同模型和状态 |

这些事实只描述迁移基线，不构成目标架构。

## 4. 被本文替代的目标态声明

现有文档继续作为实现历史和下位领域规范保留。发生下列目标态冲突时，以本文为新的
Proposed 决策；正式接受本文后，再在原文标注 superseded，不能静默改写历史。

| 现有文档 | 被替代的声明 | 保留内容 |
| --- | --- | --- |
| [`provider-boundaries.md`](./provider-boundaries.md) | “不引入新进程”“运行时不会调用 Go”“Go 只生成合同”“Node 主链只在性能瓶颈后迁移” | Thin Provider、生成合同、依赖内向、静态 Provider Registry |
| [`go-server-host-v1.md`](./go-server-host-v1.md) | “不创建 Node bridge”以及把 Go 默认 `9527` 启动方式当成生产公开入口 | Go 内部分层、HTTP 安全、账号与推理 Host 合同；直接启动只可用于隔离开发/测试 |
| [`account-management-http-v1.md`](./account-management-http-v1.md) | 浏览器持 Management Key 跨端口直连 Go 作为生产路径 | 管理 API 的输入校验、错误码和领域写合同 |
| [`go-node-parity-matrix.md`](./go-node-parity-matrix.md) | “Go 取代整个 Node 9527”以及 TypeScript 必须直连 Go | Provider 契约高于 Node 行为、协议语义和 shadow 方法 |
| [`aih-cli-v1.md`](./aih-cli-v1.md) | Node 长期拥有 Gateway Relay | 当前迁移基线、Node CLI/native runtime 语义 |
| [`account-persistence-v1.md`](./account-persistence-v1.md) | 长期“不迁移旧账号数据”且允许 Node 账号表继续存在 | `aih.db` 分层、凭据安全、CAS 和模型 LKG |
| [`functional-matrix.md`](../functional-matrix.md) 第 15 节 | `clawdcodex` 仍是可运行 Rust workspace、Rust 核心候选底座或代码来源 | 该节只保留为历史判断；后续应改为研究来源索引 |

`account-runtime-v1.md` 的失败作用域、`route-catalog-snapshot-v1.md` 的不可变快照、
`cross-protocol-semantics-matrix.md` 的协议语义仍是有效下位规范。

## 5. 方案比较

| 方案 | 优点 | 代价与风险 | 结论 |
| --- | --- | --- | --- |
| Node/Go 两套完整实现 | 表面上可独立回退 | 双 DB、双身份、双状态机、双重测试矩阵；行为必然漂移 | 拒绝 |
| 立即 Go-only 重写 | 最终部署形态简单 | 会同时重写 Web BFF、tmux、Session、Fabric 和平台能力，风险不可控 | 拒绝 |
| 单 Go 业务核心 + Node 产品宿主 | 保留成熟 Native/Web 能力，同时消除账号和 Relay 双真相 | 需要明确内部合同、进程监督和单向迁移 | 采用 |
| 微服务/动态插件微内核 | 理论扩展性高 | 当前没有独立扩缩容或多人服务自治需求 | KISS/YAGNI 拒绝 |

采用的结构是 **Strangler Fig + Ports and Adapters + Strategy/Registry**：先让新账号和
Relay 能力进入 Go Core，再由 Node 的透明 BFF 替换旧路径；Provider 差异留在 Adapter，
共享流程依赖窄合同。当前不引入 IoC 容器、消息队列、CQRS 或完整事件溯源。

## 6. 目标运行拓扑

```text
Browser / Tauri / CLI / Provider Client
                    |
                    v
          Node Public Host :9527
        +-------------------------+
        | Web assets + Web BFF    |
        | Native CLI/tmux/session |
        | Fabric/files/git/ssh    |
        | Transparent Go gateway  |
        +------------+------------+
                     |
           supervised private contract
           request-id / cancel / readiness
                     |
                     v
              Go Application Host
        +----------------------------+
        | account authority          |
        | model/usage snapshots      |
        | runtime eligibility        |
        | routing/retry/failover     |
        | protocol/native relay      |
        | low-sensitive attempts     |
        +-------------+--------------+
                      |
             +--------+---------+
             |                  |
          aih.db          Provider upstreams
```

### 6.1 监督合同

- Node 启动、监控并关闭与自身版本匹配的 Go Host；安装包必须同时包含并校验两个构件。
- Go 使用由 supervisor 明确提供的私有 endpoint，不与公开 `9527` 竞争。
- Node 的组合 readiness 必须区分 `node_ready`、`go_ready`、`catalog_stale` 和具体能力；
  manifest 中已 `go_owned` 的能力缺少 Go Core 时失败关闭，不能回退旧账号库；仍为
  `node_owned` 的能力继续由 Node 现行路径服务。
- Node 向 Go 传播 `request_id`、取消和 deadline；Response Header 或任何 Body/SSE 字节
  已向客户端 commit 后，任何一层都不得静默换账号或重放请求。
- Browser 不持有内部 Management Key。迁移期只有 Node daemon 持有并注入私有 Go 鉴权；
  Tauri、CLI 和 Browser 均只连接 Node 公开合同。DOM、URL、argv、日志和错误中不得出现
  内部密钥。
- BFF 只做认证、同源、传输和必要的 Client DTO 适配；不得重新选号、重试、协议重编码、
  cooldown 或错误分类。

Browser 到 Node 使用 HttpOnly、SameSite 的 WebUI 会话或等价桌面会话合同；写请求必须
校验 Origin/Host 与 CSRF。Node 丢弃外部请求携带的所有内部身份 Header，再注入可信
principal。Node 到 Go 使用彼此隔离的 boot-scoped `management` / `inference` capability，
通过继承 pipe 或 `0600` 文件交付，不进入 renderer 或命令参数。

每个 `AIH_HOME` 只有一个 Node supervisor owner，由原子 owner lock 和进程身份共同证明。
Go readiness 返回 `boot_id`、`contract_version`、`build_sha`、`manifest_hash`；Node 全部核对
成功后才发布组合 ready。Go 崩溃可以由 Node 重启进程，但任何结果不明的在途推理都不得
由 Node 重放。

私有 endpoint 的最终载体由跨平台 spike 决定；Unix socket、named pipe 或 loopback port
都必须满足显式所有权、权限、重启清理和唯一实例检测，不能靠“找一个空闲端口”猜测当前
Core。

### 6.2 Go 上线前的公开端口禁令

- Go 上线门禁完成前，生产公开 `127.0.0.1:9527` 必须继续由 Node Host 持有。
- Go 只能绑定 supervisor 分配并登记的私有 endpoint。开发或测试可以显式直接启动 Go，
  但必须使用隔离端口/临时目录，不能占用或冒充当前正式 AIH Server。
- Web、Tauri、CLI 和 Provider Client 在迁移期仍只连接 Node 公开入口，不得各自探测或
  绕过 Node 直连某个 Go 端口。
- “Go 上线”至少要求：正式安装包包含并校验 Go 构件；Node 能监督启动/停止/升级；
  账号只写 `aih.db`；目标协议通过真实 Composition Root、shadow 和真实 Provider 验收；
  Web 管理链、取消、流式终态、attempt 审计、readiness 与回滚均有证据。
- 上述门禁通过只证明 Go Core 可以承载生产业务，不自动授权它接管公开 `9527`。是否改变
  公开端口所有者必须另写 ADR、提供兼容与回滚证据，并经显式切流确认。

### 6.3 能力级单所有者切流

公开端口保持不变，不代表内部能力可以双写。账号管理、模型目录和每种 Relay 协议使用
`(provider, auth_kind, capability)` 作为迁移键，分别遵循同一状态机：

```text
node_owned -> write_frozen -> migrated_and_verified -> go_owned
```

- `node_owned`：正式流量仍由 Node 现行路径处理；Go 只使用临时 `AIH_HOME`、fixture、
  mock upstream 或 shadow 输入验证，不写生产账号事实。
- `write_frozen`：对该能力短暂冻结新写入，导出带校验和的稳定快照；不得边迁移边双写。
- `migrated_and_verified`：导入 `aih.db`，逐账号核对映射、凭据 generation、模型 LKG、
  默认值和数量，再用正式 Composition Root 验证。
- `go_owned`：Node 原子切换为透明转发并退役旧写路径。此后 Go 故障必须显式失败关闭，
  不能偷偷回读 `app-state.db` 或恢复 Node 选号。

每项能力任一时刻只能有一个生产写者。首次 Go 生产写入发生前，可以原子恢复切流前的
完整 Node 所有权状态；首次 Go 写入后只允许冻结写入并 roll-forward。任何反向迁移都必须
另有完整 delta 导出/验证合同和显式授权，不能恢复旧快照或形成“Node 写一半、Go 写一半”
的长期兼容模式。

另有一份只读 `route_ownership_manifest` 把公开路径映射为 `node_owned` 或 `go_owned`，并
列出其要求的 Provider、认证类型、协议、模态和 blob 能力。Node 不得按请求模型临时决定
由谁执行 Relay；共享 `/v1/responses` 只有在该公开 profile 暴露的全部能力均由 Go 覆盖后
才能整条切流。Go canary 尚无 vision/blob 链时必须显式返回 unsupported，不能借 Node
补半条执行链。

## 7. 所有权矩阵

| 能力 | 唯一所有者 | 其他层职责 |
| --- | --- | --- |
| Provider 静态身份与能力声明 | Go Provider Registry | 生成 Node/TS 最小投影 |
| 账号身份、去重、凭据、Profile | Go Account Core + `aih.db` | Node 只持有有界 lease/projection |
| 账号模型与额度 LKG | Go Account Core + `aih.db` | Web 只读投影并显示来源/新鲜度 |
| runtime eligibility、cooldown、hard block | Go Runtime Domain | Node 上报 Native 事实，不直接改状态 |
| 账号征召、别名、retry/failover | Go Relay Core | Node 透明转发 |
| 同协议透传与跨协议 Canonical | Go Protocol Adapters | Provider 契约与真实 fixture 是权威 |
| 原生 CLI、PTY、tmux、Session | Node Native Host | 通过 lease 使用账号，不读 Go SQLite |
| Web/Fabric、文件、Git、SSH | Node BFF | 不拥有账号或 Relay 真相 |
| 浏览器状态与展示 | Web Read Model | 不从缺失字段猜健康或可调度性 |
| 桌面安全存储和系统调用 | Tauri Adapter | 不实现账号业务规则 |

静态 Provider Registry 只声明 `declared` 身份与理论能力；`account_manageable`、`relay_ready`
由 Go 当前 Composition Root 的真实装配产生，`native_runtime_ready` 由 Node 当前主机探测
产生。它们只在 readiness/read model 汇合，动态探测结果不得写回静态 manifest。

## 8. 稳定账号合同

### 8.1 身份与迁移

- `accountRef` 是持久账号主键，创建后不因 API Key 轮换、Token 刷新、邮箱变化或 CLI
  数字别名变化而改变。
- OAuth 使用版本化的 Provider 专属身份策略，稳定字段必须存在；缺失时返回
  `identity_unverifiable`，不得回退邮箱、目录名或随机值。

| `identity_scheme_version=1` | 身份向量 |
| --- | --- |
| Codex OAuth | `user_id + account_id`；没有 workspace 时使用规范 `personal` |
| Claude OAuth | `account_uuid`；organization 暂属 Profile，不参与身份 |

规范化邮箱只用于导入关联与冲突提示。reauth 必须重新派生同一身份；若官方证据要求改变
Claude 等 Provider 的身份向量，必须另写 ADR 和显式 rekey/mapping，不能静默改变既有
`accountRef`。
- API Key 初次去重使用 `provider + normalized_base_url + full_api_key_hash`。同 Provider、
  同 Base URL 发现不同 Key 时，边界必须要求用户明确选择“新增账号”或“轮换旧 Key”。
- Node 旧账号迁移必须生成显式映射账本：`old_account_ref -> account_ref + resolution`。
  冲突逐条裁决；只允许单向导入 `aih.db`，禁止双写、回读 fallback 和影子账号表。
- 凭据写、异步模型刷新和 usage 更新都携带 credential generation/CAS。旧 generation 的
  完成结果不得覆盖新凭据；失败保留 last-known-good。

这里刻意不沿用“OAuth 恒等于 `provider + email`”的旧规则：仅按邮箱会错误合并真实
不同的账号。

### 8.2 NativeCredentialLease

Go-owned 账号启动原生 CLI 时，凭据仍只属于 Go。Go 签发一次有界
`NativeCredentialLease`，至少绑定：

```text
lease_id + account_ref + provider_id + credential_generation
+ runtime_scope + expires_at + runtime_lease_id
```

- Node 只把必要凭据写入 `0700` 临时目录和 `0600` 文件，或通过受控环境/外部认证指令
  注入；不得写入 `app-state.db`、共享 HOME 或长期 Node 凭据库。
- 优先使用 Codex external auth、Claude OAuth proxy 等不要求 Native CLI 写凭据的运行形态。
- Provider 必须自行刷新文件时，Node 只提交
  `CredentialCandidate(lease_id, base_generation, artifact)`。Go Provider Adapter 重新校验
  格式、稳定身份和来源，再以 CAS 写入 `aih.db`；成功后递增 credential generation。
- 同一 Runtime lease 内的自动刷新可以在 CAS 成功后续签到新 generation；显式 reauth、
  API Key/Auth Token 轮换仍必须等待 Runtime lease 释放，避免运行中替换账号主体。
- 陈旧 generation、身份不一致、租约不匹配或无法证明归属的 Claude/Codex 投影一律拒绝
  并隔离保留，不能覆盖 Go，也不能变成 fallback 真相。
- 现有 Node materialize/capture 在迁移完成后只能实现该合同，不得直接更新 Node store。
  release 后清理临时投影；清理失败可重试但不得删除 Go 凭据。

### 8.3 NativeRuntimeLease

账号 Runtime 所有权使用持久化 fencing，而不是一次 probe 或纯 TTL：

```text
acquired(starting) -> bound(exact socket + session + owner_epoch) -> active -> released
                                      \-> indeterminate
```

- Node 必须先在 Go 原子 acquire，才允许签发凭据租约、物化投影或启动 tmux。
- tmux 创建后立即用 exact socket、exact session、Node owner epoch 和 fencing token bind；
  旧 owner 或旧 fencing token 不能 bind、renew、release 或回写凭据。
- `starting`、`bound`、`active`、`indeterminate` 都是 non-terminal，均阻止删除、显式 reauth
  和 credential rotation；只有 `released` 不阻塞。Provider 自动刷新只能走上节带
  generation 的候选提交合同。
- Runtime/Node 重启后按 exact socket/session 和进程身份恢复。TTL 到期只表示“需要复核”，
  没有可靠 negative probe 时不得清租约；文件 registry 只提供寻址证据，不提供锁语义。
- 删除先在 Go 获取排他 deletion fence，阻止新 acquire；可靠证明不存在任何 non-terminal
  lease 后，才在同一串行所有权边界删除账号。检查失败或状态未知时失败关闭。
- release 只接受当前 holder；异常退出进入 reconcile。Native 写回同时携带 runtime fencing
  token 与 credential generation，旧进程不能覆盖新代次。

Runtime lease/fencing 记录属于 `aih.db` 的账号所有权事实；凭据正文仍只存在
`account_credentials`。短期 cooldown 等派生状态可以由 usage、policy 和 attempt 事实重建，
但 Go 重启后必须等 `runtime_projection_ready=true` 才对对应 Relay capability 发布 ready，
不能以空内存状态误判所有账号健康。

### 8.4 公共读模型

Accounts、Chat 账号选择器和账号模型摘要必须消费同一个 `AccountReadModelV1`。其领域
语义由 Go Core 定义，Node 只做鉴权、传输和机械字段映射。响应固定携带
`schema_version: 1`；未知 required 字段、错误版本或不满足不变量时失败关闭。Go、Node 和
Web 通过同一组 contract fixture 验证，不允许 TypeScript 再手写另一套解释。

该合同只列出已 `go_owned` 的账号集合。迁移期 canary 与正式 Node 页面保持独立 profile，
不得把 Node-owned 账号拼接进同一响应；全局消费者必须等待其可见集合整体完成迁移。

最小语义：

| 字段组 | 语义 |
| --- | --- |
| `schema_version` | 固定为 `1`，用于显式合同演进 |
| `account_ref`、`provider_id`、公开资料 | 稳定身份；不包含凭据 |
| `status` | 持久用户生命周期，仅 `active` / `disabled`；不代表当前 Relay 健康 |
| `relay_eligible` | 用户或导入策略允许进入 Server API 池的意图；不等于实际可征召 |
| `server_api` | `state=ready\|blocked\|unknown`；`reason` 只在 blocked 时表达 `unconfigured`、`auth_invalid`、`cooling_down`、`quota_exhausted`、`policy_blocked` 或 `provider_unavailable`；`message` 不参与逻辑 |
| `remainings_snapshot` | 多额度窗口及独立 evidence；每项含 key、标题、`remaining_pct`、窗口和 reset |
| `models` | 模型数量、默认模型、每模型 API 状态、最近成功刷新及 LKG evidence |

`server_api`、`remainings_snapshot` 和 `models` 分别携带自己的 `source`、`observed_at`、
`stale`、`stale_after`，禁止用一组事实的更新时间刷新另一组。`remaining_pct=null` 表示
未知，`remaining_pct=0` 才表示已耗尽。

- 公共合同不长期暴露 `enabled` 或持久化 `schedulable`。迁移期内部 `enabled` 只映射为
  `status`，不得被解释为健康。
- `unknown` 表示没有可信事实：既不计入健康，也不计入阻塞或可调度。
- “本请求是否可征召”是 Go Router 基于不可变候选快照派生的 decision，不是数据库字段。
- `(account, model)` cooldown 必须保留在模型级；只要仍有一个目标模型可征召，就不能把
  整个账号显示为账号级 blocked。
- 综合展示状态由一个共享纯函数按固定优先级生成：`disabled` → `relay_not_eligible` →
  `server_api.unknown` → `server_api.blocked(reason)` → `ready`。Accounts、Chat、Dashboard
  不得各自实现；`message` 永远不参与分支判断。
- 删除、重新认证和 Native Runtime 之间使用 account lease/fencing，替代先检查后删除的
  TOCTOU。Node 持有活动账号 lease 时，Go 删除必须失败关闭。

## 9. 稳定 Relay 合同

- 同客户端协议与上游协议一致时优先原生 Relay/受控透传；跨协议才进入 Canonical。
- Provider 官方协议和真实响应 fixture 是权威。Node/Go shadow 只发现差异，不决定谁对。
- 每个请求创建不可变 Route Plan，固定候选集、协议、模型和 attempt 上限；禁止执行中因
  目录刷新改变候选。
- `request_id` 只用于关联和审计，不提供幂等性。客户端显式 `idempotency_key` 以 client
  principal 隔离，并绑定由 Server 本地密钥计算的 canonical request HMAC fingerprint；
  不保存用于计算它的正文。同 key、同 fingerprint 只能复用已知 terminal，同 key、不同
  fingerprint 返回冲突；日志和索引只保存 idempotency key 的 HMAC，不保存原值。
- 创建 `relay_request` 和首个 attempt 的同一事务必须原子唯一占用
  `(client_principal, idempotency_key_hmac)` 并绑定 fingerprint。相同 fingerprint 的
  `in_progress` 只等待/返回既有请求，`terminal` 复用既有结果，`outcome_unknown` 返回
  类型化不确定结果；三种情况都不得创建新 attempt。不同 fingerprint 返回冲突。
- Provider Adapter 默认声明请求不可安全重试。只有错误明确可重试、Provider/idempotency
  合同能证明没有未知副作用，且尚未向客户端 commit Response Header 或任何 Body/SSE 字节
  时才允许换账号。
- 失败必须区分 request-scoped、`(account, model)` cooldown 和账号级 hard block；取消、
  无效请求、畸形响应或共同上游故障不得污染其他账号。
- 对未知执行结果持久化 `outcome=unknown`，不得自动重放可能已产生副作用的 attempt。
- Node 到 Go 的连接中断一律视为结果未知；Node 不得自行重试 Go 或换回旧 Node Relay。

### 9.1 低敏可观测性

建立追加式但非事件溯源的：

```text
relay_request -> relay_attempt[1..n] -> terminal_receipt
```

调用任何上游 I/O 前，必须先原子提交 `relay_request` 与
`relay_attempt(state=started)`；提交失败则不得发送。进程重启时，所有没有可信 terminal
的 `started` attempt 收敛为 `outcome_unknown`，绝不自动重放。

至少记录 `request_id`、连续 attempt 序号、客户端/上游协议、请求/实际 Provider 与模型、
`account_ref`、跳过或失败分类、latency、TTFT、retry/fallback、Token usage、时间戳和
terminal outcome。禁止记录 prompt、reasoning、access/refresh token、API Key、Cookie、
原始 Header 或完整 Provider 响应。

- `(request_id, attempt_no)` 唯一，`attempt_no` 从 1 连续递增；重复写必须幂等。
- 每个持久化 request 最终恰有一个 terminal receipt。崩溃恢复无法判定真实上游结果时，
  写 `outcome_unknown`，不得伪造失败或成功。
- terminal 写入和 request 完成标记必须原子；清理只能按完整 request 组删除，不能留下
  孤立 attempt。低敏记录默认保留 30 天，配置与默认值只在 Go Config 一个位置定义。
- attempt 日志用于审计和投影，绝不能重放账号领域状态、再次调用上游或恢复副作用。
- 故障注入至少覆盖：intent 提交前崩溃、intent 提交后但上游发送前崩溃、发送后 terminal
  前崩溃、terminal 提交后但客户端响应前崩溃，以及客户端 commit 前/后 Go 崩溃。

运行态事件、请求审计和计费用量是三种不同事实；不能因为都含 Token 或时间戳就写进同一
张模糊表。Relay 统计至少支持 account、provider、protocol、model、request、status 和
time window；Native Session 用量保持独立来源。

Usage 同时区分：

- `attempt_observed_usage`：上游真实报告的每次 attempt 消耗，失败或未交付 attempt 也可能
  产生；以 `(request_id, attempt_no)` 归因，不做去重求和猜测。
- `request_delivered_usage`：最终返回客户端的 request 级用量，不覆盖 attempt 事实。
- Native Session scanner 只能建立来源与关联，不得覆盖、合并或反推 Relay 记录。
- 成本为 nullable，并携带 `pricing_revision` 和 `currency`；没有可信价格时显示“未定价”。

## 10. WebUI 产品方向

### P0：先修语义和真实入口

- 一级导航收敛为 `Overview / Relay`、`Accounts`、`Chat / Sessions`、`Usage`、
  `Infrastructure`、`Settings`；移动端提供 Overview、Accounts、Chat、Usage、More。
- Accounts 与 Chat 使用同一 `AccountReadModel`；Models 下沉到 Account Detail，
  全局模型目录作为二级只读视图。
- `unknown` 使用中性视觉并显示来源、最后更新时间和 stale；连接错误不能伪装成空账号。
- 列表快照是恢复基线，携带 `revision`/ETag；SSE 在本阶段只发送 invalidation hint，收到后
  重新条件读取快照，不承载可重放业务事实。断线状态、最后更新时间和有界轮询降级必须
  可见。只有真实规模或事件频率证明需要时，才增加 `stream_id + seq + fromSeq` 的可重放
  协议，避免在单真相切流前先建设事件日志。
- 先覆盖 Hook mount、断流/重连、真实 BFF 到 Go handler 的组合测试，再声明账号页切流。
- P0 同时统一 `StatusBadge`、Empty/Error/Stale 状态以及键盘焦点基础规范；状态正确性不能
  等到视觉重构阶段再修。

稳定 URL：

| 能力 | 目标路径 | 兼容策略 |
| --- | --- | --- |
| Overview / Relay | `/overview` | `/`、`/dashboard` 显式重定向至少一个 major version |
| Accounts | `/accounts` | 保持现有入口 |
| Account Detail | `/accounts/:provider/:accountRef/:tab` | `tab` 固定为 `overview/models/usage/activity` |
| 全局模型目录 | `/accounts/models` | 旧 `/models` 显式重定向至少一个 major version |
| Chat / Sessions | `/chat` | 保持现有入口与 session deep link |
| Usage | `/usage/relay`、`/usage/native` | 旧 `/usage` 重定向到有来源说明的默认页 |
| Infrastructure | `/infrastructure` | 现有 Fabric/Server 深链保留显式映射 |
| Settings / Developer | `/settings`、`/settings/developer` | Toolkit 入口迁移后保留显式重定向 |

Server 未声明相应 capability 时，路由展示带原因的 unavailable 状态，不能静默隐藏或跳到
无关页面。

### P1：Relay 运维与 Usage 边界

- Overview 展示吞吐、成功率、p50/p95/p99、TTFT、错误分类、retry/fallback、账号池、
  cooldown 和最近 request-attempt 链；不能再用 active/total 账号比例代替服务健康。
- Usage 明确拆成 `Relay observed` 与 `Native session` 两个来源。未知价格显示“未定价”，
  不得格式化为看似真实的零成本。
- 所有聚合可下钻到低敏 request/attempt 证据，但无权读取正文或凭据。

### P2：统一视觉系统

- 只保留机器可读的 `web/src/theme/tokens.json` 作为设计 Token 真相源；生成
  `web/src/styles/design-tokens.css` 与 Ant Design theme，生成物禁止手改，CI 执行 drift
  check。当前 `unified.css`、`config.ts`、`app.tsx` 和页面私有变量必须逐步退出定义权。
- 统一 `PageScaffold`、`Section`、`DataTable`、`StatusBadge`、Empty/Error/Stale 等基础组件。
- 拆分 `Accounts.tsx`、`Models.tsx` 等 God files；Presenter 只接收 Read Model，不直接调 API。
- 完成桌面/移动视觉回归、键盘、焦点、对比度、reduced-motion 和性能预算后，才宣称
  “好看的 WebUI”已交付。

## 11. 参考方向

| 来源 | Adopt | Adapt | Reject |
| --- | --- | --- | --- |
| Codex / Claude 官方源码与协议 | 原生 Session、认证、请求/响应和工具语义 | 固定 revision，建立本地 fixture 与变更审计 | 仅凭文档摘要猜运行行为 |
| AIH 当前 Node 生产链 | Native/tmux/Fabric/Web 的成熟行为和真实故障样本 | 提炼不变量与黑盒合同，再迁入 Go | 把 Node 的缓存 shape、账号 ID 或补丁直接复制成新领域模型 |
| DeepSeek Harness | durable/live 分域、typed receipt、projection watermark、真实 Composition Root 测试 | 用于账号 job generation、Relay attempt；连续序号只在未来可重放 SSE 确有需要时采用 | Cordis 动态微内核、可执行 YAML、全量模型内容事件日志、JSONL 业务真相 |
| sub2api / CLIProxyAPI | 导入导出协议 fixture 和互操作验收 | 只在边界归一，内部仍使用唯一账号合同 | 把外部格式字段扩散进 Account Core |
| `clawdcodex` | 已完成的官方 CLI/参考项目研究和失败复盘 | 迁移研究结论时保留来源、固定 commit 和 adopt/adapt/reject | 编译依赖、代码复制、Rust 核心复活、按旧规划让 ccx 吸收 AIH |

## 12. 交付顺序与门禁

### M0：建立正式双宿主 Composition Root

- 保持 Go Coordinator、HTTP/WebSocket Handler 和 Host Composition Root 的定向测试通过。
- 本轮已增加默认关闭的 Node supervisor 端口/构件/readyz 单元合同，并通过 server wiring 传递显式
  `startGoCore`/`stopGoCore` 能力；这不是正式上线，也不会在 Node `server start` 中隐式拉起 Go。
- 将 Go Server 纳入 npm 安装包、版本匹配、启动、停止和 readiness。
- Node 继续独占公开 `9527` 并监督私有 Go Host；只有 manifest 已标为 `go_owned` 的整项能力
  才允许透明转发，现有正式账号/Relay 路径在上线门禁前不替换。Browser 不再跨端口持
  Management Key。
- 增加真实 CLI/Node/Go assembled topology smoke。
- 将 Web TypeScript tests 纳入明确 runner 和 CI，并至少执行 tests、lint、build；根目录
  Node tests 不得继续冒充 Web 门禁。
- 监督故障注入覆盖：并发双启动、owner lock、stale endpoint、错误 build/contract/manifest、
  management/inference capability 交叉使用、Go 启动前或流中崩溃、客户端断连取消上游、
  无 Node fallback/replay、重启后无孤儿进程/endpoint，以及 SSE/WS 顺序与背压保持。

### M1：Codex API Key + Responses 隔离 canary

- 使用独立 canary profile/隔离 `AIH_HOME`，只暴露 Codex API Key 与已声明支持的 Responses
  文本能力；正式 `/accounts`、Chat 和公开 `/v1/responses` 继续 `node_owned`。
- canary Web/CLI 创建、列表、轮换、停用、删除同一账号，只写 `aih.db`；`app-state.db` 不
  产生账号影子，且不把 Node 账号聚合进 Go 列表。
- `route_ownership_manifest` 明确 vision/blob 等未覆盖能力为 unsupported；未覆盖全部公开
  profile 能力前，不得切换 Node 的共享 `/v1/responses`。
- 两账号 mock：首账号在可证明安全的零输出失败后第二账号成功；固定账号不换号；向客户端
  commit Header 或任一 Body/SSE 字节后不换号。
- 可按 `request_id` 查询不含敏感正文的完整 attempt 序列。
- canary Accounts 与 Chat 从同一 Read Model 得到一致状态和模型摘要；全局页面此时不切流。
- 通过 `AccountReadModelV1` contract/projection、Hook mount、断流快照恢复、Go handler、
  Node BFF、Web tests/lint/build 和路由兼容测试。
- 经用户单独授权后执行一次真实 Codex 非流式和流式 smoke；凭据、正文和 reasoning 不进入
  日志或文档。

### M2：Relay Operations 与 Usage 来源闭环

- 交付 request-attempt 查询、Relay Overview、延迟/失败/fallback 聚合和下钻。
- 分离 `attempt_observed_usage`、`request_delivered_usage` 与 Native Session 用量，验证失败
  attempt、重试和 fallback 不会重复冒充客户端账单。
- 完成 retention、崩溃 `outcome_unknown`、快照 invalidation/轮询恢复和低敏字段拒绝测试。

### M3：Claude OAuth + Native Messages Relay

- 验证 OAuth refresh generation、Native Relay lease、同协议字段保真和跨协议拒绝分类。
- 验证配额多窗口、LKG、重认证、删除 lease 与 Session 生命周期。
- 当正式 Accounts 可见的全部 `(provider, auth_kind)` 均已 `go_owned`，再整体切换正式
  `/accounts`；不得合并 Node/Go 列表。全局 Chat 在其可选 Provider 未全部迁移前仍保持
  `node_owned`。

### M4：逐 Provider 扩展

- 每次只增加一个完整垂直切片，必须同时回答账号注册、认证、模型、额度、Native Runtime、
  Relay 协议、失败策略、导入导出和 Web 展示。
- `declared` 来自 Go 静态 Registry；`account_manageable`、`relay_ready` 来自 Go 装配事实；
  `native_runtime_ready` 来自 Node 主机探测。未装配或未探测能力不得被 readiness/UI 宣称
  可用，也不得把动态结果写回静态 manifest。
- 只有全局 Chat 可选择的 Provider/auth/model capability 全部迁移后，才把 Chat 账号目录
  整体切到 `AccountReadModelV1`；禁止长期双目录合并。

### M5：WebUI 视觉闭环

- 完成统一 Token、页面拆分、移动端信息架构、完整视觉回归、关键 E2E、可访问性和性能
  预算。Relay Overview、Usage 来源隔离和基础状态组件不得拖到本阶段才开始。

每个里程碑都必须提供真实 Composition Root、构建产物和正式入口证据。单元测试、路由
数量、类型检查或 fake handler 只能证明局部性质，不能单独证明可切流。

## 13. Revisit 条件

只有满足下列任一事实，才重新评估 Node/Go 所有权：

- Node BFF 成为经测量的吞吐、内存或发布瓶颈，且 Go 已覆盖对应平台能力；
- 单进程产品部署成为明确硬约束；
- Tauri 需要直接托管 Go Core，且能保持相同监督、密钥和 Read Contract；
- 团队规模与独立扩缩容需求真实增长到值得引入服务拆分。

在这些条件出现前，不新增第三套账号存储、第二套路由器、动态插件容器或 Rust 业务核心。
