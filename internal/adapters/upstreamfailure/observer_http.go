package upstreamfailure

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

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
//  3. 状态码映射（OpenAI 错误体只用于确认「确有失败」，分类仍按状态码）。
func ObserveHTTP(
	statusCode int,
	header http.Header,
	body []byte,
	observedAt time.Time,
) (Classification, error) {
	if statusCode <= 0 {
		return Classification{}, ErrInvalidObservation
	}
	if classification, rejected := ObserveEdgeRejection(statusCode, header, body); rejected {
		return classification, nil
	}
	errorType, errorCode := readOpenAIErrorIdentity(body)
	if statusCode < http.StatusMultipleChoices && errorType == "" && errorCode == "" {
		return Classification{}, ErrNoFailureEvidence
	}
	kind := classifyHTTPStatus(statusCode)
	if statusCode == http.StatusPaymentRequired && errorCode == "deactivated_workspace" {
		kind = runtimecore.FailureWorkspaceDeactivated
	}
	if kind == runtimecore.FailureUnclassified &&
		statusCode != http.StatusRequestTimeout &&
		statusCode != http.StatusPaymentRequired {
		// 有业务错误标识但状态码不常见：按上游不可用处理（可换号），
		// 而不是留 unclassified 让调用方无从判断。
		kind = runtimecore.FailureUpstreamUnavailable
	}
	if kind == runtimecore.FailureCredentialRejected {
		return NewBlockingClassification(kind, runtimecore.BlockScopeAccount)
	}
	if kind == runtimecore.FailureRegionUnsupported {
		return NewBlockingClassification(kind, runtimecore.BlockScopeAccount)
	}
	if kind == runtimecore.FailureWorkspaceDeactivated {
		return NewBlockingClassification(kind, runtimecore.BlockScopeAccount)
	}
	// Retry-After 只对领域允许进入 cooldown 的瞬态分类生效；请求级无状态失败
	// （例如普通 402/408）必须忽略该头并保持原始响应可透传。
	if policy, policyErr := runtimecore.PolicyFor(kind); policyErr == nil && policy.EntersCooldown() {
		if retryAfter := readRetryAfter(header, observedAt); retryAfter > 0 {
			return NewClassification(kind, retryAfter)
		}
	}
	if retryAfter := defaultRetryAfter(statusCode, kind); retryAfter > 0 {
		return NewClassification(kind, retryAfter)
	}
	return NewClassification(kind, 0)
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
		return runtimecore.GuessedCooldown
	case statusCode >= http.StatusInternalServerError && kind == runtimecore.FailureUpstreamUnavailable:
		return runtimecore.GuessedCooldown
	case statusCode == 529 && kind == runtimecore.FailureModelOverloaded:
		return runtimecore.GuessedCooldown
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

// readRetryAfter 读取 Retry-After，超过冷却上限的值不采纳。
func readRetryAfter(header http.Header, observedAt time.Time) time.Duration {
	if header == nil {
		return 0
	}
	value := strings.TrimSpace(header.Get("Retry-After"))
	if value == "" {
		return 0
	}
	wait, ok := ParseRetryAfter(value, observedAt)
	if !ok || wait <= 0 || wait > runtimecore.MaxCooldownHint {
		return 0
	}
	return wait
}
