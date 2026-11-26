package upstreamfailure

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	failurecontract "github.com/madou1217/ai_home/contracts/upstream-failure"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// ObserveHTTP 观察一次上游 HTTP 响应并给出统一运行态分类。
//
// 这是「通用 OpenAI 兼容端点」的观察入口：status + header + body → Classification。
// 家族（CodeBuddy / WorkBuddy）有自己更严的信封解析，走各自包的 ObserveHTTP；本函数
// 服务其余 Provider，也是 relaycore 的 BaseProvider 默认实现。
//
// 返回 ErrNoFailureEvidence 表示这次响应没有失败证据（通常是 2xx 且无业务错误码）：
// 调用方据此按成功处理——普通 2xx 正文绝不能被观察器改写成失败。
//
// 判断顺序（先具体后兜底）：
//  1. 站点边缘拒绝（WAF 拦截页 / 网关请求格式拒绝）——与账号凭据无关，不按凭据失效处理；
//  2. 2xx 且无业务错误码 → ErrNoFailureEvidence（按成功处理）；
//  3. 明确结构化业务错误标识（insufficient_quota / quota_exhausted / billing / auth 等）优先于纯状态码映射；
//  4. 状态码保守映射。
func ObserveHTTP(
	statusCode int,
	header http.Header,
	body []byte,
	observedAt time.Time,
) (Classification, error) {
	return ObserveHTTPForProvider("", statusCode, header, body, observedAt)
}

// ObserveHTTPForProvider 是带 Provider 身份的 ObserveHTTP。
//
// 契约里的 provider 专属信号行（例如某个厂商把某个状态码视为池耗尽）只有在
// 这里传入真实 Provider 时才可能命中；空 Provider 只参与 "all" 通用行。
func ObserveHTTPForProvider(
	provider string,
	statusCode int,
	header http.Header,
	body []byte,
	observedAt time.Time,
) (Classification, error) {
	return ObserveHTTPForProviderSurface(provider, "", statusCode, header, body, observedAt)
}

// ObserveHTTPForProviderSurface 是带 Provider + 端点/协议面的 HTTP 观察入口。
//
// surface 为空表示不限端点，行为与 ObserveHTTPForProvider 完全一致。
func ObserveHTTPForProviderSurface(
	provider string,
	surface string,
	statusCode int,
	header http.Header,
	body []byte,
	observedAt time.Time,
) (Classification, error) {
	rawType, rawCode := readOpenAIErrorIdentity(body)
	return ObserveHTTPWithSurfaceIdentity(provider, surface, statusCode, header, body, rawType, rawCode, observedAt)
}

// ObserveHTTPWithSurfaceIdentity 供已经按自家信封解析出稳定错误标识的 Provider 使用
// （例如 zcode 的顶层 {"code":1005,"msg":...}），避免观察器再猜一次正文形状。
func ObserveHTTPWithSurfaceIdentity(
	provider string,
	surface string,
	statusCode int,
	header http.Header,
	body []byte,
	rawType string,
	rawCode string,
	observedAt time.Time,
) (Classification, error) {
	if statusCode <= 0 {
		return Classification{}, ErrInvalidObservation
	}
	if classification, rejected := ObserveEdgeRejection(statusCode, header, body); rejected {
		return classification, nil
	}
	errorType, _ := NormalizeErrorToken(rawType)
	errorCode, _ := NormalizeErrorToken(rawCode)
	if statusCode < http.StatusMultipleChoices && rawType == "" && rawCode == "" {
		return Classification{}, ErrNoFailureEvidence
	}

	attachExplicit := func(classification Classification, err error) (Classification, error) {
		if err != nil {
			return classification, err
		}
		return AttachExplicitRetryAfter(classification, header, observedAt), nil
	}

	if match, matched := failurecontract.Resolve(SignalInputFromSurface(
		provider,
		surface,
		statusCode,
		errorType,
		errorCode,
		0,
		nil,
	)); matched {
		explicitWait, hasExplicit := parseHeaderRetryAfter(header, observedAt)
		explicit := time.Duration(0)
		if hasExplicit && explicitWait > 0 && explicitWait <= runtimecore.MaxCooldownHint {
			explicit = explicitWait
		}
		kind := runtimecore.FailureKind(match.Semantic)
		classification, classifyErr := ClassifySignal(
			match,
			statusCode,
			SignalRetryAfter(kind, statusCode, explicit),
		)
		if classifyErr != nil {
			return classification, classifyErr
		}
		return attachExplicit(classification, nil)
	}

	if kind, scope, blocking, matched := classifyKnownErrorIdentity(statusCode, errorType, errorCode); matched {
		if blocking {
			return attachExplicit(NewBlockingClassification(kind, scope))
		}
		return attachExplicit(NewClassification(kind, 0))
	}

	kind := classifyHTTPStatus(statusCode)
	if kind == runtimecore.FailureUnclassified &&
		statusCode != http.StatusRequestTimeout &&
		statusCode != http.StatusPaymentRequired {
		// 有业务错误标识但状态码不常见：按上游不可用处理（可换号），
		// 而不是留 unclassified 让调用方无从判断。
		kind = runtimecore.FailureUpstreamUnavailable
	}
	if kind == runtimecore.FailureCredentialRejected {
		return attachExplicit(NewBlockingClassification(kind, runtimecore.BlockScopeAccount))
	}
	if kind == runtimecore.FailureRegionUnsupported {
		return attachExplicit(NewBlockingClassification(kind, runtimecore.BlockScopeAccount))
	}
	if kind == runtimecore.FailureWorkspaceDeactivated {
		return attachExplicit(NewBlockingClassification(kind, runtimecore.BlockScopeAccount))
	}
	// Retry-After 只对领域允许进入 cooldown 的瞬态分类生效；请求级无状态失败
	// （例如普通 402/408）必须忽略该头并保持原始响应可透传。
	explicitWait, hasExplicit := parseHeaderRetryAfter(header, observedAt)
	if policy, policyErr := runtimecore.PolicyFor(kind); policyErr == nil && policy.EntersCooldown() {
		if hasExplicit && explicitWait > 0 && explicitWait <= runtimecore.MaxCooldownHint {
			return attachExplicit(NewClassification(kind, explicitWait))
		}
	}
	if retryAfter := defaultRetryAfter(statusCode, kind); retryAfter > 0 {
		return attachExplicit(NewClassification(kind, retryAfter))
	}
	return attachExplicit(NewClassification(kind, 0))
}

// classifyKnownErrorIdentity 仅匹配结构化 OpenAI/Anthropic 稳定 error.type / error.code，
// 不做自由文本启发式猜测，避免把硬额度耗尽/账单停用/凭据失效的 HTTP 429 误判为可重试限流。
func classifyKnownErrorIdentity(
	statusCode int,
	errorType string,
	errorCode string,
) (kind runtimecore.FailureKind, scope runtimecore.BlockScope, blocking bool, matched bool) {
	switch {
	case errorCode == "insufficient_quota" || errorType == "insufficient_quota" ||
		errorCode == "quota_exhausted" || errorType == "quota_exhausted" ||
		errorCode == "quota_error" || errorType == "quota_error" ||
		errorCode == "quota_exceeded" || errorType == "quota_exceeded" ||
		errorCode == "usage_limit_reached" || errorType == "usage_limit_reached":
		return runtimecore.FailureQuotaExhausted, runtimecore.BlockScopeAccount, true, true
	case errorCode == "billing_not_active" || errorType == "billing_not_active" ||
		errorCode == "billing_hard_limit_reached" || errorType == "billing_hard_limit_reached" ||
		errorCode == "billing_error" || errorType == "billing_error":
		return runtimecore.FailureBillingBlocked, runtimecore.BlockScopeAccount, true, true
	case statusCode == http.StatusPaymentRequired && errorCode == "deactivated_workspace":
		return runtimecore.FailureWorkspaceDeactivated, runtimecore.BlockScopeAccount, true, true
	case errorCode == "invalid_api_key" || errorType == "authentication_error":
		return runtimecore.FailureCredentialRejected, runtimecore.BlockScopeAccount, true, true
	case errorCode == "content_policy_violation" || errorCode == "safety_rejected":
		return runtimecore.FailureSafetyRejected, "", false, true
	case errorCode == "model_not_found":
		return runtimecore.FailureModelUnsupported, "", false, true
	default:
		return "", "", false, false
	}
}

// classifyHTTPStatus 把状态码映射为失败种类（与家族包的 Classify 同口径）。
func classifyHTTPStatus(statusCode int) runtimecore.FailureKind {
	switch {
	case statusCode == http.StatusTooManyRequests:
		return runtimecore.FailureRateLimited
	case statusCode == http.StatusUnauthorized:
		return runtimecore.FailureCredentialRejected
	case statusCode == http.StatusForbidden:
		return runtimecore.FailureCredentialRejected
	case statusCode == http.StatusUnavailableForLegalReasons:
		return runtimecore.FailureRegionUnsupported
	case statusCode == http.StatusBadRequest || statusCode == http.StatusUnprocessableEntity:
		return runtimecore.FailureInvalidRequest
	case statusCode == http.StatusRequestTimeout:
		return runtimecore.FailureUnclassified
	case statusCode == 529:
		return runtimecore.FailureModelOverloaded
	case statusCode == http.StatusNotFound:
		return runtimecore.FailureNotFound
	case statusCode >= http.StatusInternalServerError:
		return runtimecore.FailureUpstreamUnavailable
	default:
		return runtimecore.FailureUnclassified
	}
}

// defaultRetryAfter mirrors Node's status-specific recovery hints while keeping
// the domain policy provider-neutral. Explicit Retry-After remains authoritative.
func defaultRetryAfter(statusCode int, kind runtimecore.FailureKind) time.Duration {
	switch {
	case statusCode == http.StatusServiceUnavailable && kind == runtimecore.FailureUpstreamUnavailable:
		return runtimecore.ConfiguredGuessedCooldown()
	case statusCode >= http.StatusInternalServerError && kind == runtimecore.FailureUpstreamUnavailable:
		return runtimecore.ConfiguredGuessedCooldown()
	case statusCode == 529 && kind == runtimecore.FailureModelOverloaded:
		return runtimecore.ConfiguredGuessedCooldown()
	default:
		return 0
	}
}

// readOpenAIErrorIdentity 从 OpenAI 风格错误体里取稳定标识（type / code）。
//
// 只取标识，不取 message：message 是自由文本，不能进低敏观察边界。
func readOpenAIErrorIdentity(body []byte) (errorType string, errorCode string) {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" || trimmed[0] != '{' {
		return "", ""
	}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal([]byte(trimmed), &fields); err != nil {
		return "", ""
	}
	raw, ok := fields["error"]
	if !ok {
		return "", ""
	}
	// 形态一：{"error":{"type":"...","code":"..."}}
	if nested := map[string]json.RawMessage{}; json.Unmarshal(raw, &nested) == nil && nested != nil {
		return readStringField(nested["type"]), readStringField(nested["code"])
	}
	// 形态二：{"error":"..."} —— 没有稳定标识。
	return "", ""
}

// readStringField 只接受 JSON 字符串。
func readStringField(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed[0] != '"' {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

// AttachExplicitRetryAfter 把真实 HTTP 响应头中的 Retry-After 事实独立附加到分类结果上，
// 不改动分类的 FailureKind 或 BlockDirective；超出 duration 表示范围的合法纯数字头
// 保留为溢出标记与原始纯数字值，使上游 429 控制器严格 fail-closed 而不截断或提前重试。
func AttachExplicitRetryAfter(
	classification Classification,
	header http.Header,
	observedAt time.Time,
) Classification {
	if !classification.IsValid() || header == nil || !isObservationTime(observedAt) {
		return classification
	}
	if _, _, hasExplicit := classification.ExplicitRetryAfter(); hasExplicit {
		return classification
	}
	value := strings.TrimSpace(header.Get("Retry-After"))
	if value == "" || len(value) > maxRetryAfterLength || containsControlCharacter(value) {
		return classification
	}
	if wait, ok := ParseRetryAfter(value, observedAt); ok {
		return classification.WithExplicitRetryAfter(wait, observedAt)
	}
	if isDecimal(value) {
		return classification.WithExplicitRetryAfterOverflow(value, observedAt)
	}
	return classification
}

// parseHeaderRetryAfter 仅在需要把有效 duration 传给运行态冷却提示时调用。
func parseHeaderRetryAfter(header http.Header, observedAt time.Time) (time.Duration, bool) {
	if header == nil {
		return 0, false
	}
	value := strings.TrimSpace(header.Get("Retry-After"))
	if value == "" {
		return 0, false
	}
	return ParseRetryAfter(value, observedAt)
}
