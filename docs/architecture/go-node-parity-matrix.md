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

> **下表的 Node 299 / Go 19 是 2026-08-19 的 Go Refactor .1 基线快照，仅作历史记录。**
> 当前数字见本文「数据面路由补齐」一节（Node 333 / Go 26，`missing_in_go=0`）。
> 最新基线同时冻结在 `contracts/route-ownership/manifest.json` 的 `route_baseline`，
> 并由 `test/go-route-ownership-manifest.test.js` 与源码采集结果逐字段比对。

| 项目 | Node | Go Preview | 口径 |
| --- | ---: | ---: | --- |
| 路由记录 | 299 | 19 | 按方法、传输和协议证据保留记录 |
| endpoint 记录 | 292 | 18 | 实际交给处理器的入口 |
| guard 记录 | 7 | 0 | 作用域/派发判断，不是 endpoint |
| fallback 记录 | 0 | 1 | Go `/` 未命中兜底 |
| endpoint 路径模式 | 220 | 17 | 去重后的标准化 `path` |
| HTTP endpoint 路径模式 | 215 | 17 | 仅 HTTP 传输 |
| WebSocket endpoint 路径模式 | 7 | 1 | 仅 WebSocket 传输 |

### 当前可比较数据面与缺口状态（2026-09-15 更新）

Node 中符合 `/v1*`、`/healthz`、`/readyz` 且为 HTTP endpoint 的记录为 14 条。**这 14 条
Go 现已全部实现，`missing_in_go=0`。** 下表保留这 7 条曾经的缺口及其落点，便于回溯：

| Node capability route | Go 状态 | Go 实现落点 |
| --- | --- | --- |
| `/v1{beta?}/models/{model}:generateContent` | ✅ 已实现 | `internal/adapters/clientprotocol/gemini` + `internal/transport/http/geminiapi` |
| `/v1{beta?}/models/{model}:streamGenerateContent` | ✅ 已实现 | 同上（同协议 ID，流式由路径决定） |
| `/v1/blobs/{id}` | ✅ 已实现 | `internal/adapters/imageblob` + `internal/transport/http/blobsapi` |
| `/v1/images/edits` | ✅ 已实现 | `internal/adapters/images` + `internal/transport/http/imagesapi` |
| `/v1/images/generations` | ✅ 已实现 | 同上 |
| `/v1/messages/count_tokens` | ✅ 已实现 | `internal/adapters/clientprotocol/anthropicmessages/token_count.go` |
| `/v1/models/{id}` | ✅ 已实现 | `internal/transport/http/modelsapi` |

**已实现 ≠ 已切流。** `127.0.0.1:9527` 的 production owner 仍是 Node，manifest 中这 7 个
条目全部保持 `production_owner=node`、`migration_state=node_owned`、
`go_implementation=private_canary`、`cutover_blocking=true`。切流仍需协议 shadow、数据库/
runtime migration、rollback plan 与显式确认。

vision guard 的覆盖面已按 Node 的兜底语义对齐（2026-09-16）：索引命中以索引为准；
未命中但模型名落在已知视觉家族（`claude-`、`gemini-`、`gpt-4o|4.1|5`、`o1|o3`，
含版本分隔符归一化）时保留图片；其余按纯文本处理。**未知模型按纯文本处理而不是放行**，
与 Node 的 `buildFallbackModalities` 同构——两种误判代价不对等：错剥一张图，模型仍能按
文本借视；错放一张图，上游整条 400 拒绝，模型连回合都拿不到。

`GET /v1/blobs/{id}` 的入仓有两条链路：被剥离的图片，以及 `response_format=url` 的图片响应。
**覆盖残留已闭合**（2026-09-16）：索引补上聚合 Provider 命名空间与基座回退后，
不再存在「未映射 Provider + 不属视觉家族 + 实际能看图」的盲区。家族表同时改为按主版本号
判定（`^gpt-[4-9]`、`^o[1-9]`）而不是枚举具体版本——枚举已经腐坏过：Node 的
`gpt-(4o|4[.-]1|5)` 会把目录里已有的 gpt-6 判成看不见图片。`visionguard` 的
`TestVisionFamilyTableAgreesWithSnapshot` 用快照反查家族表，腐坏会直接失败而不是静默剥图。

`/v1/` 和 `/v1beta/` 是 Node 的 scope guard，不是 endpoint。采集器保留它们是为了
保留源码证据，但 manifest 的 `guards_not_endpoints` 只冻结这两个数据面命名空间守卫。
Node 其余 guard 也仍按 `guard` 分类，不能在路由计数中被误读成可调用 endpoint。

### Ownership 与非数据面

manifest 中每个 production entry 都固定为 `production_owner=node`、
`migration_state=node_owned`。Node 的 WebUI、Fabric、Node RPC、Session、PTY 和 Codex
app-server surface 仍由 Node 持有；它们不因 Go Preview 已存在就自动变成 Go 的切流范围。
Go 的账号管理 API `/v1/management/*` 与 Node 的 `/v0/webui/management/*` 是不同语义的
控制面，不通过兼容别名伪装成同一路由。

## Go Preview 当前 endpoint 记录（2026-09-15）

Go 当前为 25 条 endpoint 记录、24 个去重 HTTP 路径模式，另有 1 条 `/` fallback 和 1 条
`/v1/responses` WebSocket endpoint。HTTP 路由的标准化路径如下：

```
/healthz
/readyz
/v1/blobs/{id}
/v1/chat/completions
/v1/claude-relay-leases
/v1/images/edits
/v1/images/generations
/v1/management/account-aliases/
/v1/management/account-auth-jobs
/v1/management/account-auth-jobs/
/v1/management/account-defaults/
/v1/management/account-imports
/v1/management/account-imports/sub2api
/v1/management/account-selections/resolve
/v1/management/accounts
/v1/management/accounts/
/v1/messages
/v1/messages/count_tokens
/v1/models
/v1/models/{id}
/v1/props
/v1/responses
/v1{beta?}/models/{model}:generateContent
/v1{beta?}/models/{model}:streamGenerateContent
```

`/v1/responses` 的 WebSocket dispatch 是单独的 transport record；`/` 是 fallback，不是
业务 endpoint。完整记录（方法、匹配类型、源文件、行号和表达式）由 collector JSON
提供，manifest 只登记用于 ownership/cutover 判断的能力条目。

## 本阶段仍然不做的事情

- 不切换 Node 9527，不启动 Go 作为正式 sidecar，不接入正式 `aih` CLI 或默认 WebUI。
- 不迁移 Provider，不修改生产账号数据库，不执行真实上游请求。
- 不把「Go 已有路由」等同于「已切流」：7 条路由已实现，但 manifest 中它们仍是
  `node_owned` + `cutover_blocking`，切流必须走
  `node_owned -> write_frozen -> migrated_and_verified -> go_owned` 状态机并显式确认。
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

- **这个字段在 Node 内部确实被消费（2026-09-15 更正）。** 早先本节写「今天没有任何消费者」，
  这是错的：`lib/server/v1-router.js:202` 的 `filterModelsByCapability` 会读取每个模型项的
  `aih_modalities`，用 `input.includes('image')` / `output.includes('image')` 实现
  `?capability=vision|image_out` 过滤，取不到才回退到按模型名匹配；`test/server.v1-router.test.js`
  也直接断言该字段。所以它不是死字段，**不能以「没人用」为理由从 Node 删掉**。
  外部消费者仍然只有 `docs/aih-skills-roadmap.md` 里两个尚未实现的 skill 计划。
- **Node 自己承认这有兼容风险。** 同文件注释写明：除 `aih_modalities` 外其余自定义
  字段都被剥掉，因为 Claude Code 这类严格客户端可能拒绝带未知字段的模型对象。

结论不变但理由要改：Node 是在「所有客户端都会调用」的最热路径上，为了一个**只有内部过滤
在用**的字段长期担着 schema 风险。这是本仓的设计选择，不是 provider 契约。Go 侧因此**默认
不带该字段、改由 opt-in 暴露**；但 Go 若日后要实现 `?capability=` 过滤，必须自己持有等价能力
数据，不能假设可以依赖响应体里的自定义字段。

**Go 侧已实现：`/v1/models` 默认严格标准形状，模态经显式 opt-in 暴露，能力过滤独立持有数据。**

- `GET /v1/models` 仍只返回 `id/object/created/owned_by`，不会泄漏自定义字段。
- `GET /v1/models?include=modalities` 才为每项增加
  `aih_modalities: {input,output}`。
- `GET /v1/models?capability=vision|image_out`（2026-09-15 补齐）：Go 不再依赖响应体里的
  自定义字段，而是直接读模态索引判定，因此**不需要** `include=modalities` 就能过滤。
  两条语义与 Node 的 `filterOpenAIModelsBodyByCapability` 对齐：
  - `vision` 看输入模态、`image_out` 看输出模态；
  - **未知取值失败开放**（不过滤），与 Node 的 `modelMatchesCapability` 一致——拼错的
    能力名应该让目录原样返回，客户端拿到空列表比拿到未过滤列表更难排查；
  - 过滤发生在**去重之后**，每个模型项只按首个 Provider 的模态判一次。Node 作用在已去重的
    `data` 数组上，若 Go 在去重前逐 (Provider, 模型) 过滤，同名模型会因不同 Provider 的模态
    不同而在两端得到不同结果。
- `capability` 可与 `include=modalities` 组合；**不可**与 `client_version` 组合。Node 那条
  Codex 路径不套过滤器（`isCodexNativeModelsRequest` 分支直接调 `handleCodexModels`），
  混用会静默丢掉过滤意图；Go 选择返回 `400 invalid_query` 而不是假装过滤生效。
  `capability` 取空值等同「没有要求过滤」（与 Node 的 `if (!capability) return bodyText`
  一致）；其余未知键仍按 Go 既有严格合同报 400。
- `client_version` 继续选择 Codex 目录合同；未知、重复或混合 query 一律返回
  `400 invalid_query`，避免客户端意图被静默误判。
- `owned_by` 输出**厂商名**而不是 AIH 的 Provider ID（2026-09-15 修正）。Go 原先直接输出
  `claude` / `codex` / `agy` / `zcode`，并在同名模型冲突时改写成 `aih`——两个都是 AIH 内部
  词汇。判据不是「Node 这么做」，而是两条独立证据：
  1. **OpenAI 合同**：`owned_by` 是「拥有该模型的组织」，`anthropic` / `google` / `openai`
     才是组织名，`agy` / `zcode` / `qoder` 是 AIH 的路由标签，对外部客户端没有意义。
  2. **本仓有真实消费者，且消费者依赖厂商名**：Node 的 WebUI 在
     `lib/server/webui-openai-model-routes.js` 的 `resolveProviderFromOpenAIModel` 里
     **反查** `owned_by` 来把模型归到 Provider 分组（`anthropic→claude`、`openai→codex`、
     `google→gemini`、`zhipu→zcode`、`opencode→opencode`）。写内部 ID 会让分组整块落空。
  实现按 `resolveModelOwner` = `inferOwnerFromModelID(id) || inferOwnerFromProvider(provider)
  || 'aih-server'`，与 Node 的 `lib/server/models.js` 同序。与 Node 的唯一差别是大小写：
  Node 用区分大小写的 `startsWith`，Go 先转小写——方向是「多认出来」而不是认错，且模型 ID
  在两端本来就是规范小写。聚合 Provider（agy / qoder / kiro / codebuddy / workbuddy …）
  承载多家模型，模型名认不出时返回 `aih-server` 兜底，不猜厂商。
  单模型回显 `GET /v1/models/{id}` 的 `owned_by: "aih-server"` 两端本来就一致。
- 权威数据由 `internal/tools/modelsdevmodalities` 从 `@opencode-ai/models` SDK 离线快照
  生成，全部 canonical model 被嵌入 Go 二进制。服务启动时只解码和校验一次，
  HTTP 热路径是 O(1) 只读 map，
  不访问 SQLite、文件系统或上游。
- 快照收录 canonical models **加** 消费方会用到的 Provider 命名空间（`providerNamespaces`，
  共 16 个：openai、github-copilot、anthropic、google、google-vertex、xai、moonshotai、
  moonshotai-cn、kimi-for-coding、zai、zhipuai、zai-coding-plan、zhipuai-coding-plan、
  zhipu、opencode、opencode-go），共 656 条记录。聚合 Provider 的模型只存在于它们自己的
  命名空间里，只读 canonical models 会让这些模型一律查不到。
- 查找分三层，与 Node 的 `models-dev-metadata` 同构：
  1. 该 Provider 的**候选命名空间列表**按序精确命中（列表而非单值：聚合 Provider 的模型 ID
     来自多个厂商，映射到任何单一命名空间都是查错）；
  2. 基座模型回退——按模型名前缀推断厂商命名空间（`gpt-*`/`o<数字>`/`claude-*`/`gemini-*`/
     `grok-*`/`kimi-*`/`glm-*`）；
  3. 逐步裁掉尾段再试，让 provider 自定义的能力/档位后缀（`…-thinking`、`…-high`）
     落到基座模型的模态。
  三层都不命中才降级为 `{input:["text"],output:["text"]}`，不靠模型名猜测能力。
  `provider_mapping_test.go` 用快照里真实存在的模型逐个钉住映射——写错命名空间不会报错，
  只会静默退化成「查不到」。

- 端口有两个方法，对应两类消费方的不同诉求：
  - `LookupModalities` 是**纯快照查询**，三层都不命中就返回未命中。需要「权威性」的调用方
    用它（例如给模型目录补 `aih_modalities` 时宁可降级为纯文本，也不猜）。
  - `LookupOrInferModalities` 是**总是有答案**的判定（快照命中 → 家族兜底 → 未命中），
    供 `?capability=` 过滤与 vision guard 使用。两者共用同一份判定，不会各自演化出两套规则。

- 家族兜底（对应 Node 的 `buildFallbackModalities` + `computeModelModalities`）有两条规则：
  1. **视觉家族**只影响输入：`^claude-` / `^gemini-` / `^gpt-[4-9]` / `^o[1-9]($|[.-])`。
     OpenAI 一条刻意**按主版本号**而不是枚举具体版本——枚举会随时间腐坏。
  2. **图像生成家族**同时影响输入与输出，逐字对应 Node 的 `IMAGE_MODEL_PATTERN`：
     `(?:^|[-_/])image(?:$|[-_])|nano-?banana|flash-image`。这条规则对**快照命中**与
     **家族兜底**两条路径都生效（Node 的 `computeModelModalities` 末段同样无条件补）：
     少补输入会让 vision guard 剥掉用户贴给 `gemini-3.1-flash-image` 的图，少补输出会让
     `?capability=image_out` 漏掉这批模型。
     这条判定**不做**版本分隔符归一化（Node 的 `isImageGenerationModel` 只用小写原名），
     与视觉家族那张表刻意不同，两端必须保持这个差别。

- **家族表已双向同步（2026-09-15）**：Go 的 `^gpt-[4-9]` / `^o[1-9]` 反向同步回了 Node 的
  `VISION_INPUT_MODEL_PATTERNS`。Node 原先写的是枚举 `gpt-(4o|4[.-]1|5)` 与 `o[13]`，
  目录里出现 `gpt-6-astra` 之后会把能看图的 gpt-6 判成纯文本，进而剥掉它的图片。放宽边界
  逐条对当前快照验证过：`gpt-3.5-turbo` 与 `gpt-oss-*` 在快照里是纯文本，仍被排除在外。

- 已知**未对齐**项（有意保留）：Node 的模态索引还有一层运行时覆盖
  `registerProbedModelModalities`（上游 OAuth/API 实时 `/models` 探测结果会覆盖快照，
  见 `lib/server/http-utils.js`）。Go 侧没有这层——快照是唯一数据源，因为 Go 的模型目录
  不走上游探测。探测结果与快照不一致时，两端对同一模型的 `?capability=` 判定可能不同。

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
「另写 ADR 和显式 rekey」的变更——**ADR 已于 2026-09-16 落地**
（[`codex-oauth-identity-vector-adr.md`](./codex-oauth-identity-vector-adr.md)），
决策为「统一到 `user_id`、Node 改」，但 rekey 本身**未执行**，需先补 §8.1 要求的映射账本。

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

原「本阶段不做的事情」冻结了 7 条 Go 缺失数据面路由；用户已明确授权补齐，**7 条现已全部
实现并闭环（`missing_in_go=0`）**。本节记录落点、必须同步修改的采集器缺陷，以及仍然生效的
切流边界。
复核命令：`node scripts/collect-gateway-routes.js --json`。

| 缺失路由 | 状态 |
| --- | --- |
| `GET /v1/models/{id}` | ✅ 已补（`3da26cf0`） |
| `GET /v1/blobs/{id}` | ✅ 已补（`ae9ba450`，含 `internal/adapters/imageblob` 内容寻址 LRU 仓） |
| `POST /v1/messages/count_tokens` | ✅ 已补（`142541ea`，纯本地估算，规则与 Node 逐条同构） |
| `POST /v1{beta?}/models/{model}:generateContent`、`:streamGenerateContent` | ✅ 已补（`17357be8`，新增 Gemini 客户端协议） |
| `/v1/images/generations`、`/v1/images/edits` | ✅ 已补（`545b217d`，含 codex / agy / passthrough / unsupported 四个策略） |

**当前采集结果：`node_endpoint=14`、`go_endpoint=24`、`missing_in_go=0`。7 条缺口全部闭环。**

### 补齐时必须同时改采集器

三条早期路由各暴露了一个采集器缺陷；**在 Go 里加路由后必须重跑采集器**，否则对齐矩阵会继续
显示「缺失」，而实际上功能已经存在：

1. **Go 常量只认字符串字面量。** 拼接式常量（`PathPrefix = Path + "/"`）解析不到，挂载会被
   静默跳过。`PathPrefix` 因此改为字面量，并用 `TestPathPrefixMatchesPath` 守住一致性。
2. **`routeIdentity` 把 match 维度算进身份。** Go 前缀挂载永远匹配不上 Node 的 regex 条目。
3. **采集器只在 Node 侧套用 `normalizePrefixPath`。** Go 侧保留原始字面量路径。

2 与 3 由 `GO_PREFIX_MOUNT_OVERRIDES` 逐条显式改记解决（一个挂载可映射多条 Node 能力，
`addRoute` 按 path 去重）。

### Gemini 入口的三个易错点（`17357be8`）

1. **`/v1/models/` 现在承载两条能力**，dispatcher 必须先判 Gemini 的路径形态。单模型回显
   接受任意非空段，`gemini-3.0-pro:generateContent` 会被当成模型 ID 直接 200 回显，
   Gemini 入口则永久不可达且**没有任何报错**。
2. **Gemini 的 `functionCall` 没有必填调用 ID**，`functionResponse` 按 name 回指；缺失时调用
   ID 回退为函数名，代价是同一轮内对同一函数的两次并行调用会共用 ID。
3. **流式必须缓冲工具参数**：`functionCall.args` 是对象而不是字符串增量，逐段成帧会反复覆盖。

### 图像子系统（`545b217d`）

- 策略：`codex`（OAuth Images API，模型固定 `gpt-image-2`）、`agy`（Code Assist
  `:generateContent` + `responseModalities:[TEXT,IMAGE]`）、`passthrough`（api-key 账号转发到
  `{baseUrl}/v1/images/*`）、`unsupported`（显式 400）。
- 能力闸门逐条复刻 Node 的错误码（mask / 输入数量 / size / quality 取值 / background /
  output_format / output_compression / moderation）。
- 输出归一化拒绝非规范 base64、非图片字节、声明与字节不一致的媒体类型、带凭据的 URL。
- **一处必须记住的 Go 陷阱**：`response, err := sendUpstream(...)` 复用了上面 `json.Marshal`
  已经声明为 `error` 的 `err`，导致成功路径上的 nil `*Error` 被装箱成非 nil interface——
  **每一次成功的 codex / agy 图片生成都会被当成失败**。三个策略现在都用新变量接收该错误。
- Provider 解析：请求显式声明优先；否则按本地可路由模型目录反查，多个候选时拒绝而不是
  任意选一个。

## Go 新特性 → Node 的核对结果（2026-09-15）

用户要求「Go 新增的特性同步到 Node」。逐条核对后的结论是：**真正只存在于 Go、且值得同步的
只有一处，而且它需要 ADR；其余几条 Go 侧看起来更「新」的设计，Node 其实已经有等价实现，
或差异不足以支撑改动。** 记录如下，避免以后重复核对。

| 项 | Go | Node | 结论 |
| --- | --- | --- | --- |
| Codex OAuth 身份向量 | `oauth:codex:<user_id>` | `oauth:codex:<email>` | **真实分歧，需 ADR**（见下） |
| Gateway provider 认证 | `env_key=AIH_GATEWAY_CLIENT_KEY` + `env_http_headers={X-Account-Ref=…}` | 命令行字面 `http_headers.X-Account-Ref=acct_…` | 差异存在但收益边际：accountRef 是非秘密哈希，改 Node 的 PTY 启动链风险大于收益，暂不改 |
| 刷新被拒后的抑制 | `suppressesRefresh`（按 AccountRef + credential.updated_at 精确匹配） | `lib/server/kimi-token-refresh.js` 的 `reason:'suppressed'`、`lib/server/token-refresh-result.js` 的 `invalid_grant` 分类、`codex-auth-invalid-reconciler.js` 的 `refresh_rejected_access_token_still_valid` | **Node 已有等价能力**，不是缺口 |
| `deactivated_workspace` | 按错误码映射为 `FailureWorkspaceDeactivated` → 账号级阻断 | 已有：`upstream-failure-policy.js:286` + `:720`，但**门控不同**——Node 要求 `statusCode === 402` 且 detail 命中，Go 只看错误码 | 两边都处理了，但门控不一致；改任何一边都需要上游真实响应证据，本轮只登记不改 |
| `aih_modalities` | 默认不返回，`?include=modalities` 才暴露 | 每个模型项内联 | Node 内部过滤在用（已更正本文早先的错误说法），不是死字段 |

### Codex OAuth 身份向量：已决策，ADR 已落地（2026-09-16）

两端 `acct_` 派生算法逐字节一致（`acct_` + `sha256("unique:" + identitySeed)` 前 20 位十六进制），
差异只在种子。用户 2026-09-16 选定「写 ADR + 显式 rekey」，ADR 见
[`codex-oauth-identity-vector-adr.md`](./codex-oauth-identity-vector-adr.md)。

**结论：统一到 `user_id`，Go 不改、Node 改。** 判据不是「跟 Go 走」，而是 §8.1 自己写死的两条
约束 Node 都违反了：`accountRef` 不得因邮箱变化而改变、不得回退邮箱。更硬的一条证据是
Node 的 email 取值链**优先读存储字段**（`payload.email`/`credentials.email`/`meta.email` …
六个本地字段，只有最后两个才解 JWT），所以 Node 的 `accountRef` 可能根本不由上游事实决定。
而 Node 其实**已经**解出了 `chatgptUserId` / `userId`（`codex-auth-metadata.js:68-69`），
只是身份没用它们——改动量小。

**rekey 工具已落地**（2026-09-16）：§8.1 要求的映射账本此前在仓库里**只以散文形式存在、
没有任何实现**，现已补齐——`lib/cli/services/account/codex-identity-rekey.js` +
`scripts/codex-identity-rekey.js`（默认 dry-run 只写账本；`--apply` 需 `--confirm-apply`，
且账本有冲突/不可迁移/不属于已知向量的条目就拒绝执行）。重写按构造完整：枚举 SQLite schema
重写每一个 `account_ref` 列，不靠手工表清单。**对真实数据的 apply 仍待操作者复核账本后执行**
——仓库里没有真实数据，盲目跑一遍正是 §8.1 禁止的「静默改变既有 accountRef」。

## `/readyz`：同一条路径上的两套语义（2026-09-16 已按方案 1 闭合）

manifest 的 `gateway.readiness` 条目曾写着 blocker：**「readiness semantics are not yet the
public Node contract」**，但本文此前从未解释这条 blocker 具体指什么。补上核对结论与解法。

`/healthz` 两端**已经一致**：Node 与 Go 都返回 `{ok:true, service:"aih-server"}`，没有多余字段。
分歧全在 `/readyz`：

| 维度 | Node（`lib/server/server.js:1110`） | Go（改前） | Go（改后） |
| --- | --- | --- | --- |
| HTTP 状态码 | **恒为 200** | catalog 未就绪时 503 | **恒为 200** |
| `ready` 的含义 | 有没有可用账号 | catalog 就绪 | **有没有可用账号** |
| `accounts` | 每个受支持 Provider 的账号数 | 不返回 | **返回（全部 Provider，缺席记 0）** |
| `gateway` | `{ready, connectedServers, availableAccounts}` | 不返回 | **返回（恒为「未发现」的真值）** |
| Go 额外字段 | — | `capabilities[]`、`inference_catalog_ready`、`inference_catalog_stale`、`model_count`、`route_count` | 原样保留（追加） |

### 为什么必须按 Node 的语义改，而不是各写各的

Node 那侧的 `200 + ready=false` 是**被文档依赖的诊断信号**，不是疏漏：

- `docs/fabric/08-current-status.md` 多处用「`/readyz` 当前 HTTP 200 但 `ready=false`，
  provider account counts 全为 0」证明「节点活着，缺的是 provider 账号，不是控制面能力」。
  若该端点返回 503，同一条诊断会被读成「节点挂了」——**结论反向**。
- `README.md:493` 把 `gateway` 字段写成对外契约：「`/readyz` 的 `gateway` 字段可用于确认
  Server 1 是否已发现可用的反向账号网关」。
- Fabric registry agent 的 `--runtime-diagnostics` 会读取 `/readyz` 的 provider account counts，
  产出 `missing_provider_account:<provider> (cli=yes account_total=0 account_source=readyz)`，
  再由 `aih fabric nodes <node>` 展示。**省略键**会让它把「这个 Provider 没有账号」读成
  「不认识这个 Provider」，诊断直接落空——所以 `accounts` 必须铺满全部 Provider 而不是只列有账号的。

同一条路径上的两套语义比缺一个字段更危险：消费方不会报错，只会静默得到相反的结论。
这就是它此前必须是 `cutover_blocking` 的原因。

### 实现

- `internal/adapters/accounts/sqliteaccount/routing_index.go` 的 `countByProvider` +
  `store.go` 的 `CountAccountsByProvider`：直接读进程内路由索引（`map[AccountRef]indexedRoutingAccount`，
  启动时构建、每次账号写入同步更新），**不访问 SQLite、不需要 ctx、不可能失败**。
  这条性质是它能挂在未鉴权端点上的前提——没有数据库读，也没有额外缓存要维护。
  这正是 Node `state.accounts[provider].length` 的同构物。
- `internal/host/aihserver/readiness.go` 的 `accountCountsByProvider`：先用
  `catalog.List()` 铺满全部受支持 Provider 的 0，再用真实计数覆盖；数据库里残留的已下线
  Provider 账号被丢弃，避免消费方看到「不存在的 Provider 有账号」。
- `router.go`：`ready = hasEnabledProviderAccount(accounts) || gateway.ready`，状态码恒 200，
  `ok` 恒 true。「目录是否就绪」没有丢，走追加字段 `inference_catalog_ready`。
- `gatewayReadinessView` 的键名刻意用 Node 的 camelCase（`connectedServers` /
  `availableAccounts`）：这是跨实现契约字段，改成本仓惯用的 snake_case 会让 Node 侧消费方
  静默拿到 `undefined`。

### 仍然存在的差异（有意保留）

- Go 没有 Fabric 数据面，`gateway` 恒为 `{ready:false, connectedServers:0, availableAccounts:0}`。
  这是**真值**（确实没发现任何反向账号网关），不是占位符；等 Go 接入 Fabric 时再填真实值。
- Go 只接受 `GET`/`HEAD`，Node 不校验方法。Go 更严格，已记在 manifest 的 `go_routes.methods`。
- 账号数含**已停用账号**（与 Node 一致）：运维在 `/readyz` 上要看的是「这台机器有没有账号」，
  停用账号仍占一个席位。

## 维护

路径清单会随开发漂移。重新采集：

```bash
node scripts/collect-gateway-routes.js            # 打印分组清单
node scripts/collect-gateway-routes.js --json     # 机器可读，供 CI 比对
```
