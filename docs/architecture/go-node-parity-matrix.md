# Go / Node 网关功能矩阵

> **2026-08-19 Go Refactor .1 决策：** 本矩阵记录源码路由能力差异和 ownership，
> 不授权 Go 直接占用或替换生产 `127.0.0.1:9527`。本阶段公开端口、正式 `aih` CLI、
> 默认 WebUI 和 Provider 迁移均保持不变；Go 只通过隔离 Preview 验证。详见
> [`product-direction-node-go-2026-08-15.md` 第 6.2 节](./product-direction-node-go-2026-08-15.md#62-go-上线前的公开端口禁令)
> 与 [`contracts/route-ownership/manifest.json`](../../contracts/route-ownership/manifest.json)。
> 采集方式是只读源码扫描，未启动服务，也不代替协议/运行时验收。

## 结论先行

Go Refactor .1 的交付物是可复核的路由基线和 ownership manifest，不是切流实现。当前
`127.0.0.1:9527` 的 production owner 固定为 Node，migration state 为 `node_owned`；Go
Preview Server 使用 `127.0.0.1:19527`，Preview Web 使用 `127.0.0.1:19528`，不得声明
9527 ownership。

路由采集结果（`node scripts/collect-gateway-routes.js --json`）：

| 项目 | Node | Go Preview | 口径 |
| --- | ---: | ---: | --- |
| 路由记录 | 299 | 19 | 按方法、传输和协议证据保留记录 |
| endpoint 记录 | 292 | 18 | 实际交给处理器的入口 |
| guard 记录 | 7 | 0 | 作用域/派发判断，不是 endpoint |
| fallback 记录 | 0 | 1 | Go `/` 未命中兜底 |
| endpoint 路径模式 | 220 | 17 | 去重后的标准化 `path` |
| HTTP endpoint 路径模式 | 215 | 17 | 仅 HTTP 传输 |
| WebSocket endpoint 路径模式 | 7 | 1 | 仅 WebSocket 传输 |

### 当前可比较数据面与明确缺口

Node 中符合 `/v1*`、`/healthz`、`/readyz` 且为 HTTP endpoint 的记录为 14 条。Go
当前明确缺少以下 7 个 capability route：

| Node capability route | Go 状态 | 说明 |
| --- | --- | --- |
| `/v1{beta?}/models/{model}:generateContent` | 缺失 | Gemini 非流式；Node 同时匹配 `/v1` 与 `/v1beta` |
| `/v1{beta?}/models/{model}:streamGenerateContent` | 缺失 | Gemini 流式；Node 同时匹配 `/v1` 与 `/v1beta` |
| `/v1/blobs/{id}` | 缺失 | vision guard 使用的图像 blob 读取链路 |
| `/v1/images/edits` | 缺失 | OpenAI image edit |
| `/v1/images/generations` | 缺失 | OpenAI image generation |
| `/v1/messages/count_tokens` | 缺失 | Anthropic 本地 token count，不发起推理 |
| `/v1/models/{id}` | 缺失 | 单模型查询 |

`/v1/` 和 `/v1beta/` 是 Node 的 scope guard，不是 endpoint。采集器保留它们是为了
保留源码证据，但 manifest 的 `guards_not_endpoints` 只冻结这两个数据面命名空间守卫。
Node 其余 5 个 guard 也仍按 `guard` 分类，不能在路由计数中被误读成可调用 endpoint。

### Ownership 与非数据面

manifest 中每个 production entry 都固定为 `production_owner=node`、
`migration_state=node_owned`。Node 的 WebUI、Fabric、Node RPC、Session、PTY 和 Codex
app-server surface 仍由 Node 持有；它们不因 Go Preview 已存在就自动变成 Go 的切流范围。
Go 的账号管理 API `/v1/management/*` 与 Node 的 `/v0/webui/management/*` 是不同语义的
控制面，不通过兼容别名伪装成同一路由。

## Go Preview 当前 endpoint 记录

Go 当前为 18 条 endpoint 记录、17 个去重路径模式，另有 1 条 `/` fallback 和 1 条
`/v1/responses` WebSocket endpoint。HTTP 路由的标准化路径如下：

```
/healthz
/readyz
/v1/chat/completions
/v1/claude-relay-leases
/v1/management/account-aliases/
/v1/management/account-auth-jobs/
/v1/management/account-auth-jobs
/v1/management/account-defaults/
/v1/management/account-imports/sub2api
/v1/management/account-imports
/v1/management/account-selections/resolve
/v1/management/accounts/
/v1/management/accounts
/v1/messages
/v1/models
/v1/props
/v1/responses
```

`/v1/responses` 的 WebSocket dispatch 是单独的 transport record；`/` 是 fallback，不是
业务 endpoint。完整记录（方法、匹配类型、源文件、行号和表达式）由 collector JSON
提供，manifest 只登记用于 ownership/cutover 判断的能力条目。

## 本阶段不做的事情

- 不补齐上述 7 个 Go route，不把源码缺口伪装成已迁移能力。
- 不切换 Node 9527，不启动 Go 作为正式 sidecar，不接入正式 `aih` CLI 或默认 WebUI。
- 不迁移 Provider，不修改生产账号数据库，不执行真实上游请求。
- 下一阶段若要推进，必须在 capability parity、协议 shadow、数据库/runtime migration、
  rollback plan 和显式切流确认全部具备后，按 manifest 的
  `node_owned -> write_frozen -> migrated_and_verified -> go_owned` 状态机推进。

## 判定原则：权威是 provider 契约，不是 Node

本文档前几版把「与 Node 一致」当成目标，这是错的——Node 正是因为有问题才要被
替换。影子比对给出的是**差异**，不是**判决**。每条差异必须回到权威来源判断谁对：

| 场景 | 权威 |
| --- | --- |
| `/v1/messages` | Anthropic 真实响应。Node 在这条路径是字节透传，所以它的输出**恰好**等于权威——权威性来自透传，不来自 Node |
| `/v1/responses`、`/v1/chat/completions` | OpenAI 对应 API 契约 |
| `aih_*` 自定义字段 | 没有 provider 权威，属本仓设计决策，必须单独论证 |

推论：**Node 的行为不构成 Go 的验收标准。** 三种可能结论都要允许出现——Go 错、
Node 错、两边都要改。

## 第三步：影子比对结果（2026-08-08 首轮）

同一账号、同一时刻、同一请求分别发给 Node 9527 与 Go，比状态码与响应结构。
5 条探针全部 200，**3 条结构不一致**。

```bash
node scripts/gateway-shadow-compare.js \
  --node http://127.0.0.1:9527 --go http://127.0.0.1:19550 \
  --include-inference
```

### 1. `/v1/models` 的 `aih_modalities`：不照抄 Node 的做法

Node 给每个模型对象内联一个 `aih_modalities`（`lib/server/models.js:81`），数据源
是 models.dev 元数据加家族兜底。

查证后有两点让「Go 照抄」不成立：

- **今天没有任何消费者。** 全仓（`lib/`、`web/src/`、skills）唯一引用它的是
  `lib/server/models.js` 自己和它的测试。`docs/aih-skills-roadmap.md` 里两个尚未
  实现的 skill 计划依赖它。
- **Node 自己承认这有兼容风险。** 同文件注释写明：除 `aih_modalities` 外其余自定义
  字段都被剥掉，因为 Claude Code 这类严格客户端可能拒绝带未知字段的模型对象。

也就是说 Node 为一个还没人用的字段，在「所有客户端都会调用」的最热路径上长期
担着 schema 风险。这是本仓的设计选择，不是 provider 契约，没有理由继承。

**Go 侧已实现：`/v1/models` 默认严格标准形状，模态经显式 opt-in 暴露。**

- `GET /v1/models` 仍只返回 `id/object/created/owned_by`，不会泄漏自定义字段。
- `GET /v1/models?include=modalities` 才为每项增加
  `aih_modalities: {input,output}`。
- `client_version` 继续选择 Codex 目录合同；它不能与 `include` 混用。未知、重复或混合
  query 一律返回 `400 invalid_query`，避免客户端意图被静默误判。
- 权威数据由 `internal/tools/modelsdevmodalities` 从 `@opencode-ai/models` SDK 离线快照
  生成，全部 canonical model 被嵌入 Go 二进制。服务启动时只解码和校验一次，
  HTTP 热路径是 O(1) 只读 map，
  不访问 SQLite、文件系统或上游。
- 只映射当前重构范围内的 `codex -> openai`、`claude -> anthropic`。权威快照未命中时
  明确降级为 `{input:["text"],output:["text"]}`，不靠模型名猜测能力。

升级 SDK 依赖后重新生成索引：

```bash
npm install @opencode-ai/models@latest
npm run models:generate
```

roadmap 里的 `aih_context_length` 可以沿用显式 `include` 机制，但当前没有实现，避免把
modalities 交付扩大为尚无消费者的 context/pricing 设计。

### 2. `/v1/responses`：谁更贴近 OpenAI 契约要按契约判，不按 Node 判

已按 [OpenAI Responses Create 官方合同](https://developers.openai.com/api/reference/resources/responses/methods/create)
逐字段复核。Go 原先多出的 `completed_at`、`error`、`text.format`、`tools`，以及
`usage.input_tokens_details` / `usage.output_tokens_details` 都是正式 Response 对象成员，
不能为追平 Node 的精简形状而删除。

复核同时确认 Go 最小响应原先漏了六个正式成员：`instructions`、`metadata`、
`parallel_tool_calls`、`temperature`、`tool_choice`、`top_p`。当前实现已经补齐：

- `instructions`、`metadata` 由单次 `clientprotocol.Exchange` 私有绑定并原样回显，
  不进入 Canonical、账号征召或 Provider 编码。
- 未声明时返回诚实且符合 schema 的值：`instructions: null`、`metadata: {}`、
  `parallel_tool_calls: true`、`temperature: null`、`tool_choice: "auto"`、`top_p: null`。
- `metadata` 按官方合同限制为最多 16 个字符串键值对，键最多 64 个字符、值最多
  512 个字符；重复键和越界输入直接拒绝。
- 非流式 JSON 和 SSE `response.completed` 共用同一投影与状态机，HTTP 入口不会
  二次解析请求，也不会因 Canonical 转换丢失客户端回显。

这里的 `null` 不是猜测上游实际采样值：Responses schema 明确允许
`temperature/top_p` 为 `number | null`；客户端未声明且 Canonical 没有事实时，AIH
不伪造某个 Provider 的有效默认值。

### 3. `/v1/messages`：分成两类，一类已修

权威是 Anthropic 真实响应（Node 在这条路径是字节透传，其输出恰好等于权威）。
首轮差异混着两类问题，分开后结论完全不同：

**(A) 序列化缺陷——已修。** `container`、`content[].citations`、
`usage.server_tool_use` 都是 Anthropic 的真实可选字段，Go 并没有自造数据；问题是
这些指针字段缺 `omitempty`，nil 被序列化成显式 `null`，而 Anthropic 缺省时是
**省略**。加上 `omitempty` 后三个幽灵字段消失，`content[]` 与上游逐字段一致。

首轮把这一类描述成「Go 注入了上游没发的字段」是不准确的，已纠正。

**(B) Canonical 模型的信息丢失——同协议已由 Native Relay 绕开，跨协议仍按能力边界处理。**
剩余差异全部属于此类：

| 字段 | 上游 | Go |
| --- | --- | --- |
| `stop_details` | `null`（refusal 时有值） | 模型里没有该字段 |
| `usage.service_tier` | 字符串 | 模型里没有该字段 |
| `usage.inference_geo` | 字符串 | 恒 `null` |
| `usage.cache_creation` | 对象（1h/5m 分项） | 恒 `null` |

这四个不是打 tag 能解决的，需要 Canonical 响应模型承载它们。计费与缓存可观测性
依赖 `usage.*`，`stop_details` 是 refusal 分类的唯一出口。

同协议的 Claude Messages 请求现在统一进入 Native Relay：官方端点 OAuth 且满足
请求合同时字节透传，`stop_details`、`service_tier`、`inference_geo` 和
`cache_creation` 不再经过 Canonical 因而不会丢失；非官方端点凭据、跨协议模型或
不满足透传合同的请求才交回 Canonical。跨协议没有等价字段时继续丢弃是有意的，
`stop_details` 的跨协议细化仍是独立的 Canonical 课题。

### 结论

- 1：不照抄，按 opt-in 重新设计；模态数据源仍要补。
- 2：已按 OpenAI 契约收口；Go 必需字段补齐，协议私有回显保持在 Exchange 边界。
- 3：(A) 已修；(B) 同协议 Native Relay 已修；跨协议的 `stop_details` 细化仍待独立建模。

影子比对应在每次改动 Canonical 编解码后重跑。

## (B) 的正确解法：不是扩 Canonical，是让同协议走透传

> **先修正一处归类错误。** 本节初版把四个字段一并归为「provider 特有、应丢弃」。
> 复查后 `stop_details` 不属于此类，见下方「例外」。其余三个的论证成立。

直觉做法是把 `usage.service_tier`、`usage.inference_geo`、`usage.cache_creation`
加进 `core/inference.Usage`。**这个做法是错的**，两条依据：

1. **违反依赖内向。** 这三个都是 Anthropic 特有词汇：`service_tier` 是 Anthropic
   的调度层级，`inference_geo` 是它的地域标识，`cache_creation` 的 1h/5m 分项是
   它的 TTL taxonomy。让协议中立的 core 认识某一家 provider 的词汇，就是
   「依赖外向」（AGENTS.md 架构原则）。

   它们描述的是「这次请求怎么被服务的」，不是「模型做了什么」，因此丢弃**不影响
   任务产出**，只影响计费精度与合规举证。跨协议时 OpenAI 客户端也没有字段可装。
   注意 `cache_creation_input_tokens` 总量是带着的，丢的只是 TTL 拆分。

2. **与请求方向的既定原则冲突。** `f162be1` 已经定过一次：`service_tier` 和
   `metadata` 是 provider 特有提示，跨协议转码时**静默丢弃，不进 Canonical**。
   响应方向若一致适用，这四个字段同样不该进 Canonical。

那么信息丢失说明的是另一件事：**claude 客户端调 claude 账号，本就不该走
Canonical。** 同协议时这些信息是 1:1 的，重建一遍只会丢；跨协议时它们在目标
协议里根本没有等价物，丢弃才是正确语义。无损通道已经存在——Native Relay。

当前入口已由 `internal/host/aihserver/router.go` 统一挂载
`handlers.claudeNativeRelay`。有可信租约时，Relay 严格使用租约账号；普通客户端
由调度器提供账号并保留模型筛选、冷却、别名解析和公平轮转。满足官方端点 OAuth
与 Messages 请求合同时字节透传，否则将原始正文和已选 `AccountRef` 交回 Canonical，
避免为了传输降级重新征召账号。

`transportpolicy.GatewayPolicy` 仍是凭据能力的策略边界；Relay 使用
`RequiresNativeOAuth` 判定是否可以保留官方证明，第三方 Base URL 的 OAuth 形态
凭据不会被错误地送往官方端点。

## 例外：`stop_details` 应该进 Canonical

按语义而不是按它在 Anthropic 响应里的位置重新归类，`stop_details` 与上面三个不同。

**现状**：refusal 这件事本身没丢——`response_decoder.go:1108` 把 Anthropic 的
`stop_reason: "refusal"` 映射为 `inference.StopReasonContentFilter`，Canonical 也有
`ContentRefusal` / `EventRefusalDelta`。丢的是**类别**（`cyber` / `bio` /
`reasoning_extraction` / `frontier_llm` 等），Go 侧完全没有解码也没有建模。

**为什么这会影响任务效果**：refusal 的类别决定该回退到哪个模型（例如 cyber 类
拒绝的推荐落点是 Opus 4.8）。类别丢失后，客户端只知道「被拒了」不知道为什么，
无法选择正确 fallback——本可换模型继续的任务直接失败；也无法向用户说明原因。
跨协议更糟：OpenAI 形状的客户端会看到一个 `completed` 但内容异常的响应。

**为什么它不属于「provider 特有词汇」**：「终态为什么发生」本就是 Canonical 的
职责，它已经有 `ResponseFailure` 失败码体系与 `StopReason` 分类，refusal 类别只是
同一件事的更细粒度。把它排除在外是按字段位置而非语义归类，归错了。

同源问题：`refusal → StopReasonContentFilter` 这个映射本身也是有损的——Anthropic
的 refusal 与通用「内容过滤」不是一回事。

**结论**：`stop_details` 独立于分发改造，即使同协议走了透传，跨协议路径仍然需要
它。应作为 refusal 分类的细化进入 Canonical。

## Codex workspace 与账号身份对齐（2026-09-15）

**问题**：同一 Codex OAuth 账号在两端派生出的 `accountRef` 不同。两端的 `acct_` 派生
算法逐字节一致（`acct_` + `sha256("unique:" + identitySeed)` 的前 20 个十六进制字符），
差异只在身份种子：

| 实现 | 身份种子 | 依据 |
| --- | --- | --- |
| Node | `oauth:codex:<email>` | `lib/account/account-identity.js`、`lib/account/transfer-core.js`（`buildOAuthIdentity`） |
| Go（改前） | `oauth:codex:<user_id>:<account_id>` | `core/accounts/codex/account_profile.go`（`oauthIdentitySeed`） |

实测（`alice@example.com` / `user-123` / `workspace-456`）：

```
Node  acct_84132d53950d53bf0f8e
Go    acct_22e13c417833aef26cec   （workspace-456）
Go    acct_4a6fd2d115fe1edacb4a   （personal）
```

**权威判定**：Node 的行为在这条路径上是权威，因为它同时被两份最新文档固定，且 Go 的
实现直接违反其中一条：

- `README.md`（导入 / 导出去重规则）：「不读取 provider `account_id`、`chatgpt_account_id`
  或 refresh token hash 作为本地 `accountRef` 身份」；并把 Codex `account_id` 定义为上游
  协议字段，进入内部模型后统一命名为 `upstreamAccountId`，不参与本地账号寻址。
- `docs/architecture/codex-native-credential-sync.md`：「No workspace-specific accountRef
  scheme is introduced.」

**已修（Go）**：`oauthIdentitySeed` 改为只取稳定用户 ID，工作区从本地账号身份中移除，
仅经 `UpstreamAccountID()` 保留并回写上游。同一用户切换工作区不再产生第二个本地账号。
改动文件：

- `core/accounts/codex/account_profile.go` — 身份种子与 `IsValid` 同步收紧
- `core/accounts/codex/oauth.go` — 构造器改用新种子；`AccountID` 注释明确其为上游元数据
- `core/accounts/codex/auth_test.go`、`internal/adapters/codex/authfile/codec_test.go` —
  断言从「不同 workspace 必须不同身份」反转为「工作区不参与身份」

验证：`go test ./...` 全部通过（84 个包）。

**仍未闭环**：Go 现为 `oauth:codex:<user_id>`，Node 仍为 `oauth:codex:<email>`。两端
`accountRef` 依然不同，因此 Node 旧账号迁移仍必须按
[`product-direction-node-go-2026-08-15.md` §8.1](./product-direction-node-go-2026-08-15.md)
生成显式映射账本。把 Node 切到 `user_id` 会改写既有生产 `accountRef`，属于 §8.1 要求
「另写 ADR 和显式 rekey」的变更，本轮不执行。

### 受管 Codex provider key

Node 的受管 provider 规范键只有一个：`aih_server` / `AIH Server`
（`lib/cli/services/ai-cli/codex-provider-args.js`、`lib/cli/services/pty/codex-config-sync.js`）。
Node 的 `codex-session-provider-alignment` 把任何 `aih` / `aih_*` 中不等于该规范键的值
判定为旧形态并重写（`isLegacyAihProvider`），覆盖 codex state DB 的
`threads.model_provider` 与 rollout `session_meta`。线程里记录的 provider 名若在
`config.toml` 查不到，Codex 桌面端会拒绝恢复该线程——即
`docs/codex-native-credential-sync.md` 记录的 missing-provider / thread-restore 问题。

Go 原先有两个键，都不等于规范键：

| Go 策略 | 改前 | 改后 |
| --- | --- | --- |
| 账号 API Key 启动（`clilaunch/strategy.go`） | `aih_account` / `AIH Account` | `aih_server` / `AIH Server` |
| Gateway profile 启动（`clilaunch/gateway_strategy.go`） | `aih_gateway` / `AIH Gateway` | 未改，见下 |

**已修**：账号启动策略改用规范键。其 provider 形状（`wire_api=responses` +
`env_key=OPENAI_API_KEY` + 指向网关的 `base_url`）与 Node 沙箱侧 `aih_server` 定义一致。
验证：`go test ./...` 全绿，`test/pty-launch.test.js`、`test/codex-provider-args.test.js`
24 项通过。

**仍未闭环**：`gateway_strategy.go` 仍用 `aih_gateway`，且其认证模型与 Node 的
`aih_server` 不同——Go 用 `env_key=AIH_GATEWAY_CLIENT_KEY` +
`env_http_headers={X-Account-Ref=AIH_GATEWAY_ACCOUNT_REF}`，Node 用宿主
`[model_providers.aih_server.auth]` 命令表或沙箱 `env_key=OPENAI_API_KEY`，账号固定走
`http_headers.X-Account-Ref` 字面值。只改键名会让同一个 `aih_server` 在两端出现两种
认证定义，因此这一项需要先就认证模型（env 变量命名与 header 传递方式）达成一致，本轮
不单方面改。

## 数据面路由补齐（2026-09-15 起，用户授权解除本阶段冻结）

原「本阶段不做的事情」冻结了 7 条 Go 缺失数据面路由；用户已明确授权补齐，本节记录进度。
复核命令：`node scripts/collect-gateway-routes.js --json`。

| 缺失路由 | 状态 |
| --- | --- |
| `GET /v1/models/{id}` | ✅ 已补（`3da26cf0`） |
| `GET /v1/blobs/{id}` | ✅ 已补（`ae9ba450`，含 `internal/adapters/imageblob` 内容寻址 LRU 仓） |
| `POST /v1/messages/count_tokens` | ✅ 已补（`142541ea`，纯本地估算，规则与 Node 逐条同构） |
| `/v1/images/generations`、`/v1/images/edits` | ⬜ 待做（需新建图像子系统） |
| `POST /v1{beta?}/models/{model}:generateContent`、`:streamGenerateContent` | ⬜ 待做（需新建 Gemini 客户端协议 adapter） |

当前采集结果：`node_endpoint=14`、`go_endpoint=20`、`missing_in_go=4`。

### 补齐时必须同时改采集器

三条已补路由各暴露了一个采集器缺陷；**在 Go 里加路由后必须重跑采集器**，否则对齐矩阵会继续
显示「缺失」，而实际上功能已经存在：

1. **Go 常量只认字符串字面量。** `collectGoRoutes` 通过 `parseGoStringConstants` 解析 Go 常量，
   其正则只匹配 `Ident = "字面量"`。写成 `PathPrefix = Path + "/"` 的拼接常量解析不到，
   挂载会被静默跳过。`PathPrefix` 因此改为字面量，并用 `TestPathPrefixMatchesPath` 守住它与
   `Path` 的一致性。
2. **`routeIdentity` 把 match 维度算进身份。** Go 的 `http.ServeMux` 只能按前缀或精确路径挂载，
   参数化路径只能写成前缀子树；而 Node 侧可能是 regex。前缀形态永远匹配不上 regex 条目。
3. **采集器只在 Node 侧套用 `normalizePrefixPath`。** Go 侧保留原始字面量路径，于是同一个能力
   在两端得到不同的 path。`/v1/blobs` 就是这种情况：Node 侧被映射为 `/v1/blobs/{id}`，
   Go 侧却是 `/v1/blobs/`。

缺陷 2 与 3 由 `GO_PREFIX_MOUNT_OVERRIDES` 逐条显式改记解决（每条附上 Node 侧的对应形态），
并在挂载循环里跳过其原始形态，保证一条能力只产生一条记录。

### 剩余 4 条的真实成本

不是补胶水，而是两个新子系统。

**图像子系统（2 条：`/v1/images/generations`、`/v1/images/edits`）**

已完成纯函数层（`223ec657`）：

- `internal/adapters/imagedata` ← `lib/server/image-data.js`：媒体类型归一化、规范 base64
  解码（重新编码后逐字节比对）、魔数嗅探。
- `internal/adapters/imagegeneration` ← `lib/server/image-generation-request.js`：模式选择、
  必填项、`n`/`size`/`quality`/`response_format`、background 与 output_format 交互、
  mask 规则、image/images 二选一。

两个易错点已用测试钉住：Node 用 `Number(body.n)`，所以 `n: "2"` 与 `n: true` 被接受、
`n: ""` 与 `n: 2.5` 被拒（严格要求 JSON 数字会让 Go 在 Node 成功的请求上报 400）；
请求入口白名单是 `{png,jpeg,webp}` 且**刻意不含 gif**，尽管底层 image-data 认 gif——
共用一个集合会让 gif 绕过请求闸门。

**仍需决策才能继续的部分**（不是纯函数，无法靠对照 Node 直接定）：

- 图片端点要按请求的模型征召 Provider + 账号，再向该账号的上游发 passthrough 调用。
  Go 侧可复用的缝是 `accountrouting.Recruiter.Recruit`（api-key 账号的 `Credential()`
  直接给出 `APIKey()` 与 `BaseURL()`）。**未定的是：Go 当前 Provider 范围（codex/claude/agy）
  中哪些声明支持图片**，以及是否复用聊天链路的 capability router。Node 侧由
  `image-generation-strategy.js` 注册四个策略（agy/gemini Code Assist、codex Images API、
  passthrough、unsupported）来回答这个问题。
- 多部分（multipart）编辑请求的解析（Node 的 `image-generation-multipart.js`）与错误
  envelope 渲染可以直接照搬，无阻塞。

**Gemini 客户端协议（2 条：`:generateContent`、`:streamGenerateContent`）**

需要新增协议 ID + `clientprotocol.Adapter`（请求解码 + 非流式聚合 + 流式渲染）+ 带冒号
形态的路径 Handler + 注册接线。参照量级：`openaichatcompletions` adapter 约 3000 行（含测试）。

**接线前必须先定的两处语义**（都在共享层，猜错会静默改变行为）：

1. `application/inferencegateway/route_rule.go` 的 `RouteScope.accepts` 决定哪些模型路由规则
   对该入口生效。当前未列出的协议只接受 `RouteScopeAll` 规则——这是一个保守默认值，
   但 Gemini 入口该归 Codex / Claude / 还是新设 agy 作用域，需要明确决定。
2. `internal/adapters/codex/responses/request_encoder.go` 的 `isCrossProtocolClient` 决定
   哪些客户端协议已完成字段投影审查。Gemini→Responses 按定义属于跨协议，若不加进去，
   codex 上游会对 Gemini 请求套用更严格的字段投影，属于静默行为差异。

两者都需要按模块分批实现并各自带测试，不能合并成一次改动。

## 维护

路径清单会随开发漂移。重新采集：

```bash
node scripts/collect-gateway-routes.js            # 打印分组清单
node scripts/collect-gateway-routes.js --json     # 机器可读，供 CI 比对
```
