package relaycore

import (
	"net/http"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// Provider 描述一个同协议透传通道的**差异面**。
//
// 设计原则：接口只暴露**会变**的东西。不变的（尝试循环、响应交付、记账、交还 Canonical）
// 留在 Handler 里由所有 Provider 共用；会变的按下面的方法逐条表达，每一条都对应某个
// Provider 的真实约束（不是预设的扩展点）。
//
// 实现方式：嵌入 BaseProvider 拿默认行为，只覆盖真正不同的方法。
type Provider interface {
	// ID 返回本 Provider 的标识（用于归属响应头与日志）。
	ID() string

	// Resolve 给定账号所属的 Provider ID，返回服务它的 Provider 变体。
	//
	// 为什么需要它：一个透传通道可能服务多个 Provider ID —— 家族四支
	// （codebuddy / codebuddycn / workbuddy / workbuddycn）共用一个 Handler，
	// 而「站点根」「Origin」等差异取决于**账号**属于哪一支，不是通道级常量。
	// 返回 false 表示本通道不服务该 Provider（调用方交还 Canonical）。
	//
	// 单 Provider 的通道（如 cline）由 BaseProvider 默认实现处理：ID 相等即可。
	Resolve(providerID string) (Provider, bool)

	// Endpoint 解析上游 URL。返回 false 表示该 Provider 本通道表达不了（交还 Canonical）。
	Endpoint() (string, bool)

	// AccessToken 从账号凭据里取鉴权令牌。
	// 返回 ErrUnsupportedCredential 表示凭据形态不适配：交还 Canonical，且**不换号**
	// （因凭据不适配就跳到下一个，会让透传系统性偏向某类账号，公平轮转失效）。
	AccessToken(credential accountapp.Credential) (string, error)

	// RewriteRequest 按上游硬约束改写请求体。
	// 默认实现原样返回 —— 这是多数派的正确行为。
	RewriteRequest(body []byte) (RewriteResult, error)

	// DecorateUpstream 补齐上游要求的外层标识（UA / Origin / 额外头）。
	// 默认实现只写 Content-Type / Accept / Authorization。
	//
	// 覆盖时的约定：先调 BaseProvider.DecorateUpstream 拿默认，再追加自己的 ——
	// 这样通用头不会因为覆盖而漏掉。
	DecorateUpstream(request *http.Request, accessToken string)

	// ClassifyFailure 解析上游错误响应，给出运行态分类。
	// 默认实现走通用 OpenAI 错误体分类。
	ClassifyFailure(
		statusCode int,
		header http.Header,
		body []byte,
		now time.Time,
	) (sharedfailure.Classification, error)
}

// RewriteResult 是请求体改写的结论：既给出新请求体，也给出「本次改写丢掉了什么」。
//
// 默认实现（不改写）返回 Body 为入参、其余字段零值。
type RewriteResult struct {
	// Body 是交给上游的请求体（未触碰的字段应逐字节保留）。
	Body []byte
	// Degradations 是丢信息的改写码列表。只列**真的丢信息**的改写：等价改写与纯增补
	// 都不算有损，因此不进这个列表。客户端据此知道「它要求的语义没有被完整执行」。
	Degradations []string
}

// BaseProvider 是「朴素 OpenAI 兼容端点」的默认行为，供具体 Provider 嵌入。
//
// 多数派 Provider（cline / opencode / kimi / grok 这类上游就是标准 OpenAI 端点的）
// 嵌入它之后**一个字都不用改**，只需提供端点与凭据取法。
//
// 默认值的取向是刻意的：这里写的是**多数派**行为，不是家族行为。若把家族的
// 「stream 恒为 true」写成默认，别的 Provider 就要去关掉它 —— 那会让多数派代码里
// 出现绕开别人默认值的噪音，且新增 Provider 时默认行为是错的。
type BaseProvider struct {
	providerID string
	endpoint   string
	// clientDependent 为 true 时表示该 Provider 的推理依赖本机客户端，服务端不承接。
	// 这类 Provider 不该被装配进 Handler，保留字段是为了让误配快速失败。
	clientDependent bool
}

// NewBaseProvider 构造默认行为基类。
func NewBaseProvider(providerID string, endpoint string) BaseProvider {
	return BaseProvider{providerID: providerID, endpoint: endpoint}
}

// ID 返回 Provider 标识。
func (base BaseProvider) ID() string { return base.providerID }

// Resolve 是单 Provider 通道的默认实现：只有 ID 相等才认。
//
// 多 Provider 通道（家族四支共用一个 Handler）覆盖它，按账号所属支返回对应变体。
func (base BaseProvider) Resolve(providerID string) (Provider, bool) {
	if strings.EqualFold(strings.TrimSpace(providerID), base.providerID) {
		return base, true
	}
	return nil, false
}

// Endpoint 返回构造时声明的上游 URL。
func (base BaseProvider) Endpoint() (string, bool) {
	if base.endpoint == "" || base.clientDependent {
		return "", false
	}
	return base.endpoint, true
}

// AccessToken 是基类的保守默认：**不猜测**凭据形态，一律报告不适配。
//
// 每个 Provider 的凭据形状不同（家族读 credentials.auth.accessToken，cline 读 providers
// 槽位…），猜错会把「取不到令牌」变成「拿错误字段去上游换 401」。因此具体 Provider
// 必须覆盖本方法；基类的默认值让「忘了覆盖」立刻表现为交还 Canonical，而不是静默错发。
func (base BaseProvider) AccessToken(accountapp.Credential) (string, error) {
	return "", ErrUnsupportedCredential
}

// RewriteRequest 默认原样透传：不做任何改写。
//
// 这是多数派的正确行为。需要改写的 Provider 覆盖它，而不是让基类预设某个 Provider
// 的约束、其余 Provider 去关掉。
func (base BaseProvider) RewriteRequest(body []byte) (RewriteResult, error) {
	return RewriteResult{Body: body}, nil
}

// DecorateUpstream 默认只补 Content-Type / Accept / Bearer 鉴权。
//
// 覆盖方应先调用本方法再追加自己的头（见 Provider 接口的约定）。
func (base BaseProvider) DecorateUpstream(request *http.Request, accessToken string) {
	request.Header.Set("Content-Type", "application/json")
	// 上游一律按流式回应（透传通道的响应交付同时支持流式与聚合），
	// 声明 Accept 让上游不做非流式降级。
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("Authorization", "Bearer "+accessToken)
}

// ClassifyFailure 默认走通用上游错误分类（边缘拒绝 / OpenAI 错误体 / 状态码映射）。
func (base BaseProvider) ClassifyFailure(
	statusCode int,
	header http.Header,
	body []byte,
	now time.Time,
) (sharedfailure.Classification, error) {
	return sharedfailure.ObserveHTTP(statusCode, header, body, now)
}
