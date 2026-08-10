# Go / Node 网关功能矩阵

> 目的：把「Go 什么时候能取代 Node 9527」从感觉变成账。
> 初次采集日期：2026-08-08；当前复核日期：2026-08-10。Node 侧 106 条路径 /
> 35 组，Go 侧按业务入口归并为 14 条。
> 采集方式：只读扫描 `lib/server/{server,v1-router,web-ui-router,webui-*-routes}.js`
> 与 `internal/host/aihserver/router.go` 的路径字面量，未启动服务。

## 结论先行

**阻塞切流的只有 3 组，不是 35 组。** Node 的 106 条路径里约 80 条是 WebUI 自己的
后端（终端、文件树、git、ssh、项目、会话），与「推理网关」无关。把它们算进
Go 的必做清单是把重构范围放大了一个数量级。

三档分类：

| 档 | 含义 | 组数 | 路径数 |
| --- | --- | ---: | ---: |
| **A 阻塞** | 不补齐就不能切流 | 3 | 9 |
| **B 需决策** | 归属未定，先定归属再排期 | 4 | 15 |
| **C 不阻塞** | WebUI 后端，重构范围之外 | 28 | 82 |

---

## A 档：阻塞切流（必须补齐）

| Node 路径 | Go 现状 | 说明 |
| --- | --- | --- |
| `/v1/responses` | ✅ 已有 | OpenAI Responses HTTP/SSE + Codex Responses WebSocket；WS 在首帧读取 model 后征召账号，保持原生文本帧 |
| `/v1/chat/completions` | ✅ 已有 | OpenAI Chat 入口 |
| `/v1/messages` | ✅ 已有 | Canonical + Native Relay 双路分发 |
| `/v1/models` | ✅ 已有 | 模型目录 |
| `/healthz` `/readyz` | ✅ 已有 | 存活/就绪 |
| `/v1/props` | ✅ 已有 | 客户端能力协商，返回 `{object:"props",data:{}}` |
| `/v1/blobs/{id}` | ❌ **缺失** | 视觉 blob 句柄，见下方说明 |
| ~~`/v1/`~~ | — | **不是端点**：`v1-router.js:592` 的作用域守卫 |
| ~~`/v1beta/`~~ | — | **不是端点**：同上。全仓 `/v1beta` 只出现在该守卫里，无任何处理器 |

采集脚本按路径字面量收集，会把这两条守卫当成端点。**已实测证伪**：对活着的
Node 9527 探测，`/v1beta/models` 与 `/v1/unknown-endpoint` 均返回 404，而
`/v1/props` 返回 200。

所以数据面剩余缺口是 **1 条**，不是 4 条：

1. `/v1/blobs/{id}` —— 依赖 vision-image-guard 的 blob 存储：非视觉模型收到图片时
   网关剥图存 blob、正文留句柄，视觉子代理再回来取。Go 侧没有这条链路，补端点
   而不补链路没有意义。**归入「Go 支持视觉借用」的独立课题，不算切流阻塞。**

## B 档：需要先定归属

| 组 | Node | Go | 决策点 |
| --- | --- | --- | --- |
| 管理面账号 | `/v0/webui/management/accounts` 等 11 条 | `/v1/management/*` | **语义不同，不做别名**：旧路径是 Node WebUI 运维 facade；Go 路径是账号领域 API。后续 TypeScript 客户端直接使用 `/v1/management`。 |
| `/v0/management` | ✅ | ❌ | 控制面入口，是否由 Go 承载 |
| `/v0/node-rpc/status` | ✅ | ❌ | Fabric 节点 RPC |
| `/v0/webui/nodes/*`（6） | ✅ | ❌ | 远程节点编排，属 Fabric 主线 |

管理面命名空间已经定案：不把旧 WebUI facade 伪装成 Go 账号 API，也不在 Go 中增加
`/v0` 兼容层。前端迁移属于消费者改造；其余三项取决于 Fabric 是否也迁 Go。

## C 档：WebUI 后端，不阻塞

以下 28 组共 82 条路径服务于 WebUI 自身，与推理网关正交。切流时应继续由 Node
提供，或由前端直连 Node。列出仅为完整性。

`accounts`(6) `chat`(5) `config`(1) `control-plane`(5) `desktop-menu`(1)
`fs`(5) `git`(2) `internal`(1) `model-aliases`(1) `projects`(含 sessions/watch)
`provider-hooks`(2) `server`(1) `server-config`(2) `server-routes`(6)
`session-events`(1) `sessions`(6) `slash-commands`(1) `ssh-connections`(3)
`ssh-hosts`(1) `ssh-workspaces`(2) `terminal`(7) `ui`(2) `webui` 根(2) 等。

---

## Go 侧完整路由清单（14）

```
/healthz
/readyz
/v1/models
/v1/props
/v1/responses
/v1/chat/completions
/v1/messages                              (Canonical / Native Relay 分发)
/v1/claude-relay-leases
/v1/management/accounts        (+ /)
/v1/management/account-imports (+ /sub2api)
/v1/management/account-defaults/
/v1/management/account-selections/resolve
/v1/management/account-auth-jobs (+ /)
```

## 第二步的工作清单

1. ✅ `/v1/props` —— 已补齐。
2. 管理面命名空间对齐（B 档硬伤）—— 需先决策由谁改，非纯实现工作。

不在清单内且有理由：

- `/v1/blobs/{id}`：依赖 Go 侧尚不存在的 vision-guard blob 链路，独立课题。
- `/v1beta/`、`/v1/` 兜底：不是端点（见 A 档说明）。

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
- 权威数据由 `internal/tools/modelsdevmodalities` 从固定子模块指针生成，299 个基础模型
  被嵌入 Go 二进制。服务启动时只解码和校验一次，HTTP 热路径是 O(1) 只读 map，
  不访问 SQLite、文件系统或上游。
- 只映射当前重构范围内的 `codex -> openai`、`claude -> anthropic`。权威快照未命中时
  明确降级为 `{input:["text"],output:["text"]}`，不靠模型名猜测能力。

同步 `third_party/models.dev` 后运行：

```bash
go generate ./internal/adapters/modelmetadata/modelsdev
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

**(B) Canonical 模型的信息丢失——未修，切流硬门。** 剩余差异全部属于此类：

| 字段 | 上游 | Go |
| --- | --- | --- |
| `stop_details` | `null`（refusal 时有值） | 模型里没有该字段 |
| `usage.service_tier` | 字符串 | 模型里没有该字段 |
| `usage.inference_geo` | 字符串 | 恒 `null` |
| `usage.cache_creation` | 对象（1h/5m 分项） | 恒 `null` |

这四个不是打 tag 能解决的，需要 Canonical 响应模型承载它们。计费与缓存可观测性
依赖 `usage.*`，`stop_details` 是 refusal 分类的唯一出口。

### 结论

- 1：不照抄，按 opt-in 重新设计；模态数据源仍要补。
- 2：已按 OpenAI 契约收口；Go 必需字段补齐，协议私有回显保持在 Exchange 边界。
- 3：(A) 已修；(B) 见下节——它不是「给 Canonical 加四个字段」的问题。

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

真正的缺口在分发层：`internal/host/aihserver/router.go:93-103` 的
`claudeMessagesDispatcher` **只按 Relay Token 头决定是否透传**，也就是只有官方
Claude Code 托管启动才走无损路径；其它任何客户端打 `/v1/messages`，即使上游就是
claude 账号，也被送进 Canonical 重建。

而 `transportpolicy.GatewayPolicy` 其实**已经**表达了「官方 OAuth 优先保留原生
证明」这个策略（`TransportNativeOAuth` / `TransportCanonical`），只是 HTTP 入口
没有消费它。

### 下一步的实际工作

让 `/v1/messages` 的分发消费 `GatewayPolicy`，而不是只看 Relay Token。

已知障碍（不是拍脑袋能绕过的）：Native Relay 现在从**可信租约**解析 AccountRef
（`claudenativerelay.Authorizer`），而普通客户端只有网关 client key，没有租约。
所以需要一个由**调度器**而非租约提供账号的 relay 变体，且仍要保留冷却、别名解析
与多账号轮转。

这条路走通后，上述三个字段自然无损，不需要污染 Canonical；Canonical 回归它真正
该负责的场景——跨协议。

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

## 维护

路径清单会随开发漂移。重新采集：

```bash
node scripts/collect-gateway-routes.js            # 打印分组清单
node scripts/collect-gateway-routes.js --json     # 机器可读，供 CI 比对
```
