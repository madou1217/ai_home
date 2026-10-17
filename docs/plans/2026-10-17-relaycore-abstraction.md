# relaycore：同协议透传的抽象层

> 状态：**Proposed**（待评审）
> 上游决策：[`2026-10-17-inference-capability-registry.md`](./2026-10-17-inference-capability-registry.md) 的 P1
> 参照实现：`internal/transport/http/codebuddyfamilyrelay`（3042 行，已上线）

## 1. 为什么要抽

家族透传（CodeBuddy / WorkBuddy 四支）已完整落地：账号选择、请求改写、上游透传、
响应回写、尝试记账、失败分类。P1 要给 cline 补同一条通道，而 cline 的上游线协议
**同样是 OpenAI chat completions**——两份实现会有 80% 以上的重复。

重复的代价不是行数，是**行为分叉**：仓库已经吃过一次亏（`model-account-pool-selector.js`
的注释记录了「codex-adapter 与 upstream-endpoints 各抄一份收窄逻辑，一次整文件覆盖
悄悄抹掉其中一份的倒排分支，单测因为回退路径也能给出同样结论而全绿」）。

所以抽公共层。但抽之前必须先回答一个问题。

## 2. 核心问题：形态一致但不全一致，差异怎么处理

这是本设计的**唯一难点**。差异不是一维的，而是多维的：

| 维度 | 家族四支 | cline | opencode / kimi / grok | zcode |
|---|---|---|---|---|
| 上游路径 | `/v2/chat/completions`（**非标准**） | `/chat/completions` | `/chat/completions` | Anthropic 协议 |
| 上游线协议 | OpenAI chat | OpenAI chat | OpenAI chat | **Anthropic** |
| 鉴权头 | `Authorization: Bearer` | `Authorization: Bearer` | 同 | `x-api-key` |
| User-Agent | **强制真实 UA**（脚本 UA 被 WAF 403） | 无要求 | 无要求 | 无要求 |
| Origin / Referer | **必需** | 无 | 无 | 无 |
| `stream` 必须为 true | **是**（非流式 400） | 否 | 否 | n/a |
| `messages[0]` 必须是 system | **是**（否则 400） | 否 | 否 | n/a |
| `tool_choice` 只认字符串 | **是**（object 直接 400） | 否 | 否 | n/a |
| 错误信封 | 腾讯 `{code,msg,displayMsg}` | OpenAI `{error:{...}}` | OpenAI | Anthropic |

**九条差异里，家族占了六条，其余多数派一条都没有。** 这正是抽象必须处理的形态。

### 2.1 三条设计规则

**规则一：默认值必须覆盖多数派。**

基类的每个默认实现都写成「朴素 OpenAI 兼容端点」的行为——无额外头、不改写、不聚合。
于是 cline / opencode / kimi / grok 这类 provider **一行都不用写**，只声明端点与凭据取法。
家族则显式覆盖它需要的那几处。

反例（禁止）：把家族的 `stream=true` 写成基类默认，让别的 provider 去"关掉"它。
那会让多数派代码里出现「为了绕开别人的默认值」的噪音，且新增 provider 时默认行为是错的。

**规则二：差异必须显式声明，不许藏在共享代码里。**

基类里**不允许出现 provider 名判断**。家族的六条差异只能以两种形式存在：
- 覆盖基类方法（`RewriteRequest` / `UpstreamHeaders`）
- 声明能力位（如 `RequiresStreaming bool`）

守卫测试扫 `relaycore` 包内不得出现 provider 名字面量（与 design-patterns.md 的
「新增 provider 能力禁止写 if (provider === '…')」同一条铁律）。

**规则三：边界是「同协议」，不是「都能透传」。**

relaycore 的**准入条件**是：上游线协议 == 客户端入口协议。
- cline / opencode / kimi / grok：上游是 OpenAI chat，入口也是 chat completions → 准入
- zcode：上游是 Anthropic 协议 → **不准入**，它需要协议翻译（Canonical 的职责）
- claude / codex / agy：已有 canonical 适配器，不走透传

这条边界让抽象保持诚实：relaycore 不承诺"什么都能转发"，只承诺"同协议下逐字节保真"。
把协议翻译塞进来会让它退化成第二个 Canonical。

## 3. 结构：接口 + 基类（非 final）+ 具体 Provider

Go 没有继承，等价形态是**接口定契约 + 可嵌入基类给默认 + 外层覆盖**。

```
relaycore/
  handler.go     —— 编排骨架（唯一一份），依赖 Provider 接口
  provider.go    —— Provider 接口（契约）+ BaseProvider（默认实现，可嵌入）
  response.go    —— 响应交付（流式透传 / 非流式聚合），全 provider 共用
  failure.go     —— 失败分类与换号判定骨架
  errors.go      —— 网关自有错误写出（OpenAI 错误体形态）
  httpjson.go    —— 纯函数 JSON 工具（decodeRawObject / rawString / …）
```

### 3.1 Provider 接口（契约）

只列**真正会变**的点，每一条都对应上表里的一行：

```go
// Provider 描述一个同协议透传通道的差异面。
//
// 设计原则：接口只暴露**会变**的东西。不变的（尝试循环、响应交付、记账、
// 交还 Canonical）留在 Handler 里，由所有 Provider 共用。
type Provider interface {
    // ID 返回该 Provider 的标识（用于归属头与日志）。
    ID() string

    // Endpoint 解析上游 URL。返回 false 表示该 Provider 本通道表达不了（交还 Canonical）。
    Endpoint() (string, bool)

    // AccessToken 从账号凭据里取鉴权令牌。返回 ErrUnsupportedCredential 表示
    // 凭据形态不适配（交还 Canonical，且**不换号**）。
    AccessToken(credential accountapp.Credential) (string, error)

    // RewriteRequest 按上游硬约束改写请求体。默认实现是「原样返回」。
    RewriteRequest(body []byte) (RewriteResult, error)

    // DecorateUpstream 补齐上游要求的外层标识（UA / Origin / 额外头）。
    // 默认实现只写 Content-Type 与 Authorization。
    DecorateUpstream(request *http.Request, accessToken string)

    // ClassifyFailure 解析上游错误响应，给出运行态分类。
    // 默认实现走通用 OpenAI 错误体分类（见下方 §3.5 的 API 缺口说明）。
    ClassifyFailure(statusCode int, header http.Header, body []byte, now time.Time) (
        sharedfailure.Classification, error)
}
```

### 3.2 BaseProvider（默认实现）

```go
// BaseProvider 是「朴素 OpenAI 兼容端点」的默认行为，供具体 Provider 嵌入。
//
// 嵌入后只需覆盖真正不同的方法 —— 多数派 Provider（cline / opencode / kimi / grok）
// 一个字都不用改，只提供 Endpoint 与 AccessToken。
type BaseProvider struct {
    providerID string
    endpoint   string
}

func (base BaseProvider) ID() string { return base.providerID }
func (base BaseProvider) Endpoint() (string, bool) { ... }

// RewriteRequest 默认原样透传：不做任何改写。
//
// 这是**多数派**的正确行为。需要改写的 Provider（如家族的四条硬约束）覆盖它，
// 而不是让基类预设某个 Provider 的约束、其余 Provider 去关掉。
func (base BaseProvider) RewriteRequest(body []byte) (RewriteResult, error) {
    return RewriteResult{Body: body}, nil
}

// DecorateUpstream 默认只补 Content-Type 与 Bearer 鉴权。
func (base BaseProvider) DecorateUpstream(request *http.Request, accessToken string) {
    request.Header.Set("Content-Type", "application/json")
    request.Header.Set("Accept", "text/event-stream")
    request.Header.Set("Authorization", "Bearer "+accessToken)
}

// ClassifyFailure 默认走通用上游错误分类（OpenAI 错误体）。
func (base BaseProvider) ClassifyFailure(...) { return sharedfailure.ObserveHTTP(...) }
```

### 3.3 具体 Provider 只写差异

**cline**（多数派，零覆盖）：

```go
// internal/transport/http/clinerelay/provider.go
type Provider struct {
    relaycore.BaseProvider
    accountRef accountcore.AccountRef   // 钉选时非空
}

func NewProvider() Provider {
    return Provider{BaseProvider: relaycore.NewBaseProvider(
        "cline", "https://api.cline.bot/api/v1/chat/completions")}
}
// 无覆盖：改写、头、错误分类全用基类默认。
```

**家族**（覆盖六处差异，且差异全部集中在这一个文件）：

```go
// internal/transport/http/codebuddyfamilyrelay/provider.go
type Provider struct {
    relaycore.BaseProvider
    siteBase string
}

// RewriteRequest 覆盖：四条硬约束（stream=true、messages[0]=system、tool_choice 翻译、
// 路径抬升在 Endpoint 里）。
func (p Provider) RewriteRequest(body []byte) (relaycore.RewriteResult, error) {
    return RewriteRequestBody(body, RewriteOptions{...})   // 既有实现，语义不变
}

// DecorateUpstream 覆盖：真实 UA + Origin/Referer（WAF 要求）。
func (p Provider) DecorateUpstream(request *http.Request, token string) {
    p.BaseProvider.DecorateUpstream(request, token)   // 先拿默认
    request.Header.Set("User-Agent", UserAgent)
    request.Header.Set("X-Requested-With", "XMLHttpRequest")
    request.Header.Set("Origin", p.siteBase)
    request.Header.Set("Referer", p.siteBase+"/")
}

// ClassifyFailure 覆盖：腾讯信封。
func (p Provider) ClassifyFailure(...) { return familyfailure.ObserveHTTP(...) }
```

### 3.4 为什么这样能解决「形态一致但不全一致」

三条机制各管一件事：

| 问题 | 机制 |
|---|---|
| 多数派不想写代码 | 基类默认 = 多数派行为，零覆盖 |
| 少数派的差异要能表达 | 覆盖对应方法，差异**局部化在一个文件** |
| 差异不能污染共享逻辑 | 基类禁止 provider 名判断（守卫测试盯） |

关键在**默认值的取向**：默认给多数派，特例覆盖。反过来（默认给家族、别人关掉）
会让每个新增 provider 都从错误起点出发——这正是要避免的形态。

### 3.5 已知 API 缺口（M1 必须补）

`internal/adapters/upstreamfailure` 目前**没有**「从 HTTP 响应观察失败」的入口：

| 现有导出 | 用途 |
|---|---|
| `NormalizeResponseInput(ResponseInput)` | 校验**低敏投影**（status/errorType/errorCode/retryAfter） |
| `ClassifyTransport(kind)` / `ClassifyTransportError(err)` | 传输层失败 |
| `NewClassification(...)` / `NewBlockingClassification(...)` | 构造分类 |

家族侧之所以能用，是因为 `internal/adapters/codebuddyfamily/upstreamfailure.ObserveHTTP`
提供了「status + header + body → Classification」这一层（含信封解析与边缘拒绝识别）。
**多数派需要一个对等物**：一个通用 OpenAI 错误体的 `ObserveHTTP`。

M1 的补法：在 `internal/adapters/upstreamfailure` 新增 `observer_http.go`，
提供 `ObserveHTTP(statusCode, header, body, now) (Classification, error)`：
- 识别边缘拒绝（复用既有的 `edge_rejection.go`）
- 识别 OpenAI 错误体 `{"error":{"type","code","message"}}`
- 其余按状态码走 `ClassifyTransport` 的既有映射

这不是为 relaycore 造新概念——家族侧已有同形实现，只是当时下沉到了家族包内。
通用化后**家族也可以改为复用**（消除第二份），但那是 M1 之后的收敛，不阻塞。

## 4. Handler 骨架（唯一一份）

```go
// Handler 编排「账号选择 → 凭据 → 改写 → 上游 → 回写 → 记账」。
//
// 这些步骤对所有同协议透传通道完全一致，因此只有一份实现。
// Provider 只提供差异面（见 Provider 接口）。
type Handler struct {
    provider     Provider
    accounts     AccountSource
    fallback     http.Handler
    credentials  CredentialResolver
    client       HTTPClient
    attempts     *inferencegateway.ObservedAttemptRecorder
    clock        func() time.Time
    maxAttempts  int
}
```

从家族 handler.go 原样搬过来的（**行为零变化**）：

- `ServeHTTP` 的合同检查 → 读全正文 → 交还兜底 → 账号来源解析
- `attemptRelay` 的尝试循环（首字节前可换号、耗尽交付真实上游响应）
- `writeResponse` 的流式逐字节透传 + 非流式 SSE 聚合
- `recordSuccess` / `recordTransportFailure` / `recordHTTPFailure` / `recordClassification`
- `retryableKind` 的换号判定
- `copyResponseHeaders` / `copyStreaming` / 跳转头过滤
- `pinnedAccountSource` / `singleAccountCursor`
- `writeRelayError` 的 OpenAI 错误体

## 5. 迁移路径（家族先迁，行为零变化）

**M1 — 建 relaycore，家族改为消费它**
- 新建 `internal/transport/http/relaycore`：从家族搬公共部分，Provider 接口 + BaseProvider
- 补 `internal/adapters/upstreamfailure/observer_http.go` 的通用 `ObserveHTTP`（见 §3.5）
- 家族新增 `provider.go` 实现 Provider（覆盖六处差异）
- 家族 `handler.go` 缩为薄壳：构造 `relaycore.Handler{Provider: familyProvider}` 并 ServeHTTP
- `request_rewrite.go` / `aggregate.go` **原地不动**（它们已是纯函数，被 Provider 调用）
- **验收**：家族全部既���测试（handler_relay / aggregate / request_rewrite / family_provider）
  全绿且**一行断言不改**；`goInferenceChannel` 矩阵不变

**M2 — cline 接入**
- `internal/transport/http/clinerelay`：`Provider` 零覆盖（多数派），只声明端点与凭据取法
- Go 账号层补 cline 解码策略（`nativeaccount/decoder.go`）
- `go-import-translator.js` 补 `translateCline`
- Go `relayHosts.go` 改 `supported: true`
- **验收**：真实 cline 账号端到端 200；`claude-*` 别名链路恢复；分类器连续 10 次全 200

**M3 — 其余多数派批量接入**
- opencode / kimi / grok：各自 `Provider` 也只声明端点与凭据（若确无差异）
- 每接一个：Go `relayHosts.go` 改 true，守卫测试差异清单划掉一行

## 6. 验收标准

| # | 标准 | 证据 |
|---|---|---|
| 1 | relaycore 内无 provider 名字面量 | `grep -n "codebuddy\|cline\|opencode" internal/transport/http/relaycore/` 无命中 |
| 2 | 多数派零覆盖 | cline 的 Provider 只实现 Endpoint + AccessToken |
| 3 | 差异局部化 | 家族的六处差异全在 `codebuddyfamilyrelay/provider.go` 一个文件 |
| 4 | 家族行为零变化 | 既有测试全绿且断言未改 |
| 5 | 同协议边界 | zcode 不接入（上游 Anthropic 协议，需翻译） |

## 7. 明确不做

- **不做协议翻译**：上游协议 ≠ 入口协议的 provider（zcode）不进 relaycore
- **不迁 canonical 三支**：codex / claude / agy 已有完整上游适配器，透传对它们无收益
- **不改 Node 侧**：Node 的家族/cline 链路继续工作，Go 侧是并行通道
