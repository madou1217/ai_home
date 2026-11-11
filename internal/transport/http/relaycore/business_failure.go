package relaycore

import (
	"net/http"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// BusinessFailureClassifier 识别「HTTP 2xx 但业务失败」的响应。
//
// 为什么需要它：有些上游用 200 + 业务错误体表达拒绝（zcode: {"code":1005,"msg":...}）。
// 这类响应如果在**记账之后**才被发现，账号会被错误地记为成功；如果在交付阶段改写成
// 错误，客户端看到的是错误、但运行态仍认为账号健康。所以判定必须发生在 recordSuccess
// 之前，并且只对 JSON 响应做（SSE 成功流不能被读走）。
type BusinessFailureClassifier interface {
	// ClassifyBusinessFailure 返回 ok=true 表示这确实是业务失败。
	ClassifyBusinessFailure(
		statusCode int,
		header http.Header,
		body []byte,
	) (sharedfailure.Classification, bool)
}

// StreamBusinessFailureClassifier 是流式响应的业务失败判定。
//
// 为什么不能复用 BusinessFailureClassifier：SSE 成功流的正文是逐帧产生的，
// 读整段等于把「首 token 延迟」变成「整段延迟」。这里只交付**首个事件**（已按 SSE
// 规范切好），判定方既能拿到完整信封、又不必等流结束；relaycore 会把读走的字节
// 原样回放，下游 transformer 看到的仍是同一条流。
type StreamBusinessFailureClassifier interface {
	// ClassifyStreamBusinessFailure 返回 ok=true 表示首个事件已经是失败，而不是数据。
	ClassifyStreamBusinessFailure(
		statusCode int,
		header http.Header,
		firstEvent []byte,
	) (sharedfailure.Classification, bool)
}

// BusinessFailurePresentation 是业务失败交付给客户端的完整形态。
type BusinessFailurePresentation struct {
	// StatusCode 为 0 时使用 relaycore 的默认映射。
	StatusCode int
	// Code 为空时使用 upstream_business_failure。
	Code string
	// Message 为空时使用默认文案。
	Message string
	// Header 是必须随响应交付的额外头（例如 Retry-After）。
	Header http.Header
}

// BusinessFailurePresenter 让 Provider 决定业务失败怎么交付给客户端。
//
// 为什么不让 relaycore 按错误码硬编码：同一个 kind 下各 Provider 的客户端契约不同
// （qoder 排队是 429 + qoder_resource_limit + Retry-After；zcode 额度是 429 +
// upstream_business_failure）。Provider 知道自己的协议形状，relaycore 只负责
// 判定与记账的时机。
type BusinessFailurePresenter interface {
	PresentBusinessFailure(classification sharedfailure.Classification) BusinessFailurePresentation
}

// HTTPStatusFailurePresenter 让 Provider 把「状态码失败但其实是容量/排队」的响应
// 交付成客户端可退避的形态。
//
// 为什么与 BusinessFailurePresenter 分开：那个只管 2xx 业务失败。若让它同时接管
// 非 2xx，所有 Provider 的呈现（含默认 502）都会被套到 429/5xx 上，改变既有透传
// 语义。这里必须由 Provider 显式表态才生效 —— qoder 的排队实测是 HTTP 403 +
// 10605，通用分类会把它判成凭据被拒并硬阻塞账号，正是要避免的那类误锁。
type HTTPStatusFailurePresenter interface {
	// PresentHTTPStatusFailure 返回 ok=true 表示由 Provider 接管本次失败的交付。
	PresentHTTPStatusFailure(
		statusCode int,
		classification sharedfailure.Classification,
	) (BusinessFailurePresentation, bool)
}

// businessFailurePresentation 合并 Provider 的呈现与 relaycore 的兜底。
func businessFailurePresentation(
	provider Provider,
	classification sharedfailure.Classification,
) BusinessFailurePresentation {
	fallback := defaultBusinessFailurePresentation(classification)
	presenter, ok := provider.(BusinessFailurePresenter)
	if !ok {
		return fallback
	}
	presented := presenter.PresentBusinessFailure(classification)
	if presented.StatusCode == 0 {
		presented.StatusCode = fallback.StatusCode
	}
	if presented.Code == "" {
		presented.Code = fallback.Code
	}
	if presented.Message == "" {
		presented.Message = fallback.Message
	}
	return presented
}

// presentHTTPStatusFailure 询问 Provider 是否接管非 2xx 失败的交付形态。
//
// 只有 Provider 显式实现 HTTPStatusFailurePresenter 并返回 ok=true 才生效；其余
// Provider 保持「原样透传上游响应」的既有语义（状态码与正文都不改）。
func presentHTTPStatusFailure(
	provider Provider,
	statusCode int,
	classification sharedfailure.Classification,
) (BusinessFailurePresentation, bool) {
	presenter, ok := provider.(HTTPStatusFailurePresenter)
	if !ok {
		return BusinessFailurePresentation{}, false
	}
	presented, ok := presenter.PresentHTTPStatusFailure(statusCode, classification)
	if !ok {
		return BusinessFailurePresentation{}, false
	}
	fallback := defaultBusinessFailurePresentation(classification)
	if presented.StatusCode == 0 {
		presented.StatusCode = fallback.StatusCode
	}
	if presented.Code == "" {
		presented.Code = fallback.Code
	}
	if presented.Message == "" {
		presented.Message = fallback.Message
	}
	return presented, true
}

// defaultBusinessFailurePresentation 是「Provider 没表态」时的统一呈现。
//
// 可重试的容量/限流类失败回 429（客户端库按 429 退避），其余回 502：
// 把它们洗成 200 或 500 都会让客户端做出错误的重试决策。
func defaultBusinessFailurePresentation(classification sharedfailure.Classification) BusinessFailurePresentation {
	status := http.StatusBadGateway
	switch classification.Kind() {
	case runtimecore.FailureQuotaExhausted,
		runtimecore.FailureRateLimited,
		runtimecore.FailureModelOverloaded:
		status = http.StatusTooManyRequests
	}
	return BusinessFailurePresentation{
		StatusCode: status,
		Code:       "upstream_business_failure",
		Message:    "上游返回业务错误",
	}
}
