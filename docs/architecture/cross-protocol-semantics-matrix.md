# 跨协议语义矩阵（codex ↔ claude）

> 采集日期：2026-08-08。全部结论来自源码，标注了文件与行号，可复核。
> 范围：Canonical 网关承载的两个客户端协议（OpenAI Responses / Anthropic Messages）
> 与两个上游协议（Codex Responses / Claude Messages）之间的语义传递。
>
> 读法：**方向**列的 `A→B` 指「客户端说 A 协议、上游是 B」。
> `codex→claude` = codex CLI 调 claude 账号；`claude→codex` = claude CLI 调 codex 账号。

## 图例

| 标记 | 含义 |
| --- | --- |
| ✅ 已对齐 | 两侧语义等价，Canonical 无损承载 |
| 🔁 可转换 | 语义不同但存在正确映射，已实现 |
| ⚠️ 有损 | 能过去，但信息被压缩或近似 |
| ⛔ 拒绝 | 直接报 unsupported，请求失败 |
| 🗑️ 丢弃 | 静默丢掉，不报错 |
| ❌ 未实现 | 该概念在 Canonical 里不存在 |

---

## 一、请求方向：采样与基本参数

| 概念 | codex→claude | claude→codex | 状态 | 依据 / 处理意见 |
| --- | --- | --- | --- | --- |
| `model` | ✅ | ✅ | **已对齐** | 别名在路由层解析 |
| `stream` | ✅ | ✅ | **已对齐** | Canonical `stream` |
| `temperature` | ✅ | ✅ | **已对齐** | Canonical `temperature` |
| `top_p` | ✅ | ✅ | **已对齐** | Canonical `topP` |
| `top_k` | 🗑️ | ✅ | **单向** | Canonical 有 `topK`，但 OpenAI Responses 请求无此字段，codex→claude 时无来源；claude→codex 时 codex wire 无该字段，丢弃。**意见**：正确，无需处理 |
| `stop_sequences` | 🗑️ | ✅ | **单向** | 同上，OpenAI Responses 无 stop 字段 |
| `max_tokens` / `max_output_tokens` | 🔁 | ✅ | **已处理** | 客户端省略时由 `resolveMaxTokens` 按 Claude Code 源码合同补齐（`max_output_tokens.go`）。Messages 的 `max_tokens` 必填，Responses 可省 |
| `parallel_tool_calls` | ✅ | ⚠️ | **有损** | Canonical 有 `parallelToolCalls`；Claude 侧表达为 `tool_choice.disable_parallel_tool_use`（反向布尔），语义等价但取值域更窄 |

## 二、请求方向：推理 / 思考（用户重点问的一项）

**结论：不是双向对齐，是单向可用。**

Canonical `ReasoningConfig` 有四个维度：`mode`（budget / adaptive / effort）、
`effort`、`budgetTokens`、`summary`。

| 方向 | 行为 | 状态 | 依据 |
| --- | --- | --- | --- |
| codex→claude | Responses 的 `reasoning.effort` → Canonical `ModeEffort` → Claude `thinking:{type:"adaptive"}` + `output_config.effort` | 🔁 **可转换，已实现** | `request_encoder.go:480-490` |
| claude→codex（客户端发 `thinking:{type:"adaptive"}`） | Canonical `ModeAdaptive` → codex 编码器 **⛔ 报 unsupported** | **未实现** | `codex/responses/request_encoder.go:508`：`if config.Mode() != ReasoningModeEffort { return unsupported("reasoning.mode") }` |
| claude→codex（客户端发 `thinking:{type:"enabled",budget_tokens}`） | 同上 ⛔ | **未实现** | 同上 |

**处理意见**：codex 编码器应把 `ModeAdaptive` 与 `ModeBudget` 映射到
`reasoning.effort` 的合理档位，而不是拒绝。adaptive 无固定预算，最接近的表达是
`effort: high`；budget 可按 token 数分档。**当前 claude 客户端带 thinking 调 codex
账号会整个请求失败**，这是比字段丢失严重得多的问题。

补充：`thinking.summary`（Claude 的 `display`）与 Responses 的 `reasoning.summary`
在 Canonical 里是同一个 `summary` 维度，双向已通。

## 三、请求方向：工具

| 概念 | codex→claude | claude→codex | 状态 | 依据 / 处理意见 |
| --- | --- | --- | --- | --- |
| 函数工具（name/description/schema） | ✅ | ✅ | **已对齐** | Canonical `ToolDefinition` |
| `strict` | ✅ | ✅ | **已对齐** | 两侧线协议都有 |
| `defer_loading` | ✅ | ✅ | **已对齐** | 两侧都有 |
| `tool_choice` auto/any/none/具名 | ✅ | ✅ | **已对齐** | Canonical `ToolChoice` |
| `allowed_callers`（Claude 程序化调用） | 🗑️ | — | **丢弃** | Claude wire 有、Responses 无。**意见**：正确，OpenAI 无等价概念 |
| `input_examples`（Claude） | 🗑️ | — | **丢弃** | 同上 |
| `eager_input_streaming`（Claude 细粒度工具流） | 🗑️ | — | **丢弃** | 同上 |
| web_search 内置工具 | ✅ | ⚠️ | **有损** | Canonical `WebSearchTool` 带 `allowed_domains` / `user_location`；codex 侧表达能力较弱 |

## 四、请求方向：缓存与上下文

| 概念 | codex→claude | claude→codex | 状态 | 依据 / 处理意见 |
| --- | --- | --- | --- | --- |
| 提示缓存断点 | 🔁 | 🔁 | **可转换** | Responses 用 `prompt_cache_key` / `prompt_cache_breakpoint`，Claude 用 `cache_control`；Canonical `PromptCacheBreakpoint` 居中。见 `request_encoder.go` 的 `projectPromptCacheBreakpoints` |
| 缓存 TTL（Claude `cache_control.ttl` 5m/1h） | ⚠️ | — | **有损** | Canonical 断点无 TTL 维度。**意见**：与响应侧 `cache_creation` 分项同源，一并处理 |
| `context_management` | ✅ | ✅ | **已对齐** | 两侧线协议都有，Canonical `ContextManagement` |
| `truncation` | ⛔ | — | **拒绝** | `validateRequest` 显式拒绝非 disabled 取值（`request_encoder.go:135`）。**意见**：Claude 无等价语义，拒绝优于静默丢弃 |
| `store` | ⛔ | ✅ | **拒绝** | 同上（`:139`）。Claude 无服务端会话存储 |
| `previous_response_id` / `conversation` | ⛔ | — | **拒绝** | Canonical `Continuation` 存在但 Claude 编码器拒绝（`:132`）。**意见**：Claude 无服务端续话，拒绝正确 |

## 五、请求方向：provider 私有提示

| 概念 | codex→claude | claude→codex | 状态 | 依据 / 处理意见 |
| --- | --- | --- | --- | --- |
| `service_tier` | 🗑️ | 🗑️ | **已处理** | `f162be1` 明确定案：provider 特有调度提示，跨协议静默丢弃、不进 Canonical、不拒绝客户端 |
| `metadata` | 🗑️ | 🗑️ | **已处理** | 同上 |
| `safety_identifier` | 🗑️ | — | **丢弃** | OpenAI 特有 |
| `top_logprobs` / `max_tool_calls` | 🗑️ | — | **丢弃** | OpenAI 特有，Claude 无等价 |
| `container`（Claude 代码执行容器） | — | 🗑️ | **丢弃** | Claude 特有 |
| `inference_geo`（请求侧） | — | 🗑️ | **丢弃** | Claude 特有 |
| `client_metadata` / `prompt_cache_key` | ✅ | ✅ | **已对齐** | Canonical 有对应字段 |

## 六、响应方向：停止原因（用户重点问的一项）

Canonical `StopReason` 七个取值。两侧映射：

| Canonical | ← Claude 上游 | → Claude 客户端 | → OpenAI 客户端 | 状态 |
| --- | --- | --- | --- | --- |
| `end_turn` | `end_turn` | `end_turn` | `completed` | ✅ |
| `stop_sequence` | `stop_sequence` | `stop_sequence` | `completed` | ⚠️ OpenAI 侧无独立表达 |
| `max_tokens` | `max_tokens` | `max_tokens` | `completed` | ⚠️ **应为 `incomplete`**，见下 |
| `tool_use` | `tool_use` | `tool_use` | `completed` | ✅ |
| `pause_turn` | `pause_turn` | `pause_turn` | `completed` | ⚠️ 同上 |
| `content_filter` | `refusal` | `refusal` | `completed` | ⚠️ 同上 |
| `cancelled` | — | ⛔ `ErrUnsupportedResponseEvent` | — | ❌ Claude 侧无表达 |

依据：`anthropicmessages/response_wire.go:279-296`（Canonical→Claude）、
`claude/messages/response_decoder.go:1077-1115`（Claude→Canonical）。

**问题 1：OpenAI 侧永远不发 `incomplete`（已验证）。**

代码层面确认，非流式与流式两条路径都只可能产出两种状态：
- 非流式：`response_aggregator.go:43` 硬编码 `buildResponseWire("completed")`
- 流式：`stream_renderer.go:164-166` 只传 `"completed"` 与 `"failed"`
- `IncompleteDetails` 字段全仓无任何赋值点，`response_wire.go:27` 注释自陈
  「当前成功或失败终态均为空」

即 codex 客户端调 claude 账号、命中 `max_tokens` 截断时，收到的是
`status:"completed"` + `incomplete_details:null`——**客户端会把被截断的半截回答当成
完整回答**，既不会重试也不会提示用户。这是本矩阵里最容易直接造成错误任务结果的
一条，危害高于任何字段丢失。

**意见**：`max_tokens`、`content_filter`、`pause_turn` 三种终态应渲染为
`status:"incomplete"` + `incomplete_details.reason`，而不是 `completed`。

**问题 2：`stop_details` 类别丢失（已单独立项）。**
Claude 的 refusal 类别（`cyber` / `bio` / `reasoning_extraction` / `frontier_llm`）
在 Go 侧未解码未建模。类别决定 fallback 落点，丢失后客户端无法选对回退模型。
详见 `go-node-parity-matrix.md` 的「例外」一节。

## 七、响应方向：内容块

| Canonical ContentKind | ← Claude | → Claude | ← Codex | → OpenAI | 状态 |
| --- | --- | --- | --- | --- | --- |
| `text` | ✅ | ✅ | ✅ | ✅ | **已对齐** |
| `refusal` | ✅ | ✅ | ✅ | ✅ | **已对齐**（内容层，非类别） |
| `image` | ✅ | ✅ | ✅ | ✅ | **已对齐** |
| `document` | ✅ | ✅ | ⚠️ | ⚠️ | Claude 有 document 块，OpenAI 用 file/input_file 近似 |
| `tool_call` | ✅ | ✅ | ✅ | ✅ | **已对齐** |
| `tool_result` | ✅ | ✅ | ✅ | ✅ | **已对齐** |
| `reasoning` | ✅ | ✅ | ✅ | ✅ | **已对齐**，但签名/加密见下 |

**推理内容的可信凭证不同源，且已正确处理（已验证）**：Claude 用
`thinking.signature` + `redacted_thinking`，Codex 用 `encrypted_content`。两者都是
「上游签发、原样回传才有效」的凭证，跨协议无法互认——把 Codex 的
`encrypted_content` 塞进 Claude 的 `signature` 会被上游判为伪造。

实现已按签名**指纹**判定来源而不是无脑透传：
`reasoning_signature.go:25 normalizeClaudeThinkingSignature` 解包后按首字节分流，
`C` 走 CAIS 校验、`E` 走经典 Claude 校验、`R` 解 base64 后再校验内层，任何一项不符
即返回 `false`，调用方（`content_encoder.go:64-77`）随之不带 signature 回传。

也就是说**非 Claude 来源的凭证会被自动识别并剥离**，不会伪造成 Claude 签名。
**状态：✅ 已处理，无需动作。**

## 八、响应方向：usage

| 字段 | Claude 上游 | Canonical | → Claude 客户端 | → OpenAI 客户端 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `input_tokens` | ✅ | ✅ | ✅ | ✅ | **已对齐** |
| `output_tokens` | ✅ | ✅ | ✅ | ✅ | **已对齐** |
| `cache_read_input_tokens` | ✅ | `cachedInputTokens` | ✅ | ✅ | **已对齐** |
| `cache_creation_input_tokens` | ✅ | `cacheWriteInputTokens` | ✅ | ✅ | **已对齐** |
| `reasoning_tokens` | — | ✅ | — | ✅ | 单向，OpenAI 特有 |
| `cache_creation` 1h/5m 分项 | ✅ | ❌ | 恒 `null` | — | **有损**，仅影响计费精度 |
| `service_tier` | ✅ | ❌ | 缺字段 | — | **丢弃**，仅影响可观测性 |
| `inference_geo` | ✅ | ❌ | 恒 `null` | — | **丢弃**，仅影响合规举证 |
| `server_tool_use` | ✅ | ❌ | 已省略 | — | **已处理**（omitempty，`b319f3a`） |

后三项的处理决定见 `go-node-parity-matrix.md`：**不进 Canonical**，靠「同协议走
透传」拿回，跨协议时丢弃是正确语义（OpenAI 客户端无字段可装）。

---

## 待办清单（按危害排序）

| # | 问题 | 危害 | 已处理 |
| --- | --- | --- | --- |
| 1 | claude 客户端带 `thinking` 调 codex 账号 → 整个请求 ⛔ 失败 | **请求不可用** | ❌ |
| 2 | `max_tokens` / `content_filter` 截断在 OpenAI 侧渲染成 `completed` | **客户端把半截答案当完整答案** | ❌ |
| 3 | `stop_details` 类别丢失 → 无法选对 fallback | 本可继续的任务失败 | ❌ |
| 4 | 推理凭证跨协议降级 | 可能被上游判伪造 | ✅ 已按签名指纹识别并剥离 |
| 5 | `cache_creation` TTL 分项（请求侧 + 响应侧） | 计费精度 | ❌（决定：靠透传） |
| 6 | `service_tier` / `inference_geo` 响应侧 | 可观测性 / 合规举证 | ❌（决定：靠透传） |
| 7 | `container` / `citations` / `server_tool_use` 发 `null` | 与上游形状不一致 | ✅ `b319f3a` |
| 8 | `service_tier` / `metadata` 请求侧跨协议拒绝 | 请求失败 | ✅ `f162be1` |

**1 和 2 的危害高于此前讨论的四个字段**，且都不依赖分发改造，可以独立修。
