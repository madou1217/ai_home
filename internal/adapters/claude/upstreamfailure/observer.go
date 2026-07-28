package upstreamfailure

import (
	"io"
	"net/http"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

const (
	// unifiedStatusHeader 是 Claude 统一额度窗口的当前状态。
	unifiedStatusHeader = "anthropic-ratelimit-unified-status"
	// unifiedOverageStatusHeader 是 Claude 额外用量是否仍可继续使用。
	unifiedOverageStatusHeader = "anthropic-ratelimit-unified-overage-status"
)

// claudeErrorFields 只接收 Claude 分类所需的稳定 type/code。
type claudeErrorFields struct {
	Type string `json:"type"`
	Code string `json:"code"`
}

// claudeErrorEnvelope 覆盖 Anthropic HTTP 和 SSE error envelope。
type claudeErrorEnvelope struct {
	Type  string             `json:"type"`
	Code  string             `json:"code"`
	Error *claudeErrorFields `json:"error"`
}

// ObserveHTTP 从真实 Claude HTTP 错误响应生成低敏分类。
//
// 调用方仍拥有 Body 的关闭责任；Observer 不返回 message 或完整 Header。
func ObserveHTTP(
	response *http.Response,
	observedAt time.Time,
) (sharedfailure.Classification, error) {
	if response == nil || response.Body == nil {
		return sharedfailure.Classification{},
			sharedfailure.ErrInvalidObservation
	}
	envelope, decoded := decodeClaudeEnvelope(response.Body)
	input, bodyEvidence := claudeInput(
		response.StatusCode,
		response.Header,
		observedAt,
		envelope,
	)
	if response.StatusCode < http.StatusMultipleChoices &&
		(!decoded || !bodyEvidence) {
		return sharedfailure.Classification{},
			sharedfailure.ErrNoFailureEvidence
	}
	return Classify(input)
}

// ObserveSSE 观察 SSE decoder 切出的单个 Claude JSON 事件。
//
// observed=false 表示普通内容事件，不会构造无意义的失败状态。
func ObserveSSE(
	input sharedfailure.SSEInput,
) (sharedfailure.Classification, bool, error) {
	if input.Data == nil {
		return sharedfailure.Classification{},
			false,
			sharedfailure.ErrInvalidObservation
	}
	explicitFailure := isClaudeFailureEvent(input.EventType)
	envelope, decoded := decodeClaudeEnvelope(input.Data)
	if !decoded {
		if explicitFailure {
			classification, err := sharedfailure.NewClassification(
				runtimecore.FailureMalformedResponse,
				0,
			)
			return classification, true, err
		}
		return sharedfailure.Classification{}, false, nil
	}
	if !explicitFailure && !isClaudeFailureEnvelope(envelope) {
		return sharedfailure.Classification{}, false, nil
	}
	classification, err := Classify(claudeInputFromEnvelope(
		http.StatusOK,
		input.Header,
		input.ObservedAt,
		envelope,
	))
	return classification, true, err
}

// decodeClaudeEnvelope 有界解析 Claude 错误结构并丢弃未声明字段。
func decodeClaudeEnvelope(
	reader io.Reader,
) (claudeErrorEnvelope, bool) {
	var envelope claudeErrorEnvelope
	if err := sharedfailure.DecodeErrorPayload(
		reader,
		&envelope,
	); err != nil {
		return claudeErrorEnvelope{}, false
	}
	return envelope, true
}

// claudeInput 同时返回正文是否包含结构化失败证据。
func claudeInput(
	statusCode int,
	header http.Header,
	observedAt time.Time,
	envelope claudeErrorEnvelope,
) (Input, bool) {
	input := claudeInputFromEnvelope(
		statusCode,
		header,
		observedAt,
		envelope,
	)
	return input, isClaudeFailureEnvelope(envelope)
}

// claudeInputFromEnvelope 只投影安全 type/code、Retry-After 和统一额度证据。
func claudeInputFromEnvelope(
	statusCode int,
	header http.Header,
	observedAt time.Time,
	envelope claudeErrorEnvelope,
) Input {
	fields := selectClaudeErrorFields(envelope)
	errorType, _ := sharedfailure.NormalizeErrorToken(fields.Type)
	errorCode, _ := sharedfailure.NormalizeErrorToken(fields.Code)
	retryAfter, _ := sharedfailure.ParseRetryAfter(
		header.Get("Retry-After"),
		observedAt,
	)
	return Input{
		StatusCode:       statusCode,
		ErrorType:        errorType,
		ErrorCode:        errorCode,
		RetryAfter:       retryAfter,
		UnifiedRateLimit: isUnifiedRateLimitRejected(header),
	}
}

// selectClaudeErrorFields 跳过 envelope 的固定 "error" 类型并读取内部错误。
func selectClaudeErrorFields(
	envelope claudeErrorEnvelope,
) claudeErrorFields {
	if envelope.Error != nil {
		return *envelope.Error
	}
	return claudeErrorFields{
		Type: envelope.Type,
		Code: envelope.Code,
	}
}

// isClaudeFailureEnvelope 判断 JSON 是否是 Claude error 事件或直接错误类型。
func isClaudeFailureEnvelope(envelope claudeErrorEnvelope) bool {
	if envelope.Error != nil || envelope.Code != "" {
		return true
	}
	normalized, ok := sharedfailure.NormalizeErrorToken(envelope.Type)
	return ok &&
		(normalized == "error" || isKnownClaudeErrorType(normalized))
}

// isClaudeFailureEvent 只把 event:error 视为明确 SSE 失败。
func isClaudeFailureEvent(value string) bool {
	normalized, ok := sharedfailure.NormalizeErrorToken(value)
	return ok && normalized == "error"
}

// isKnownClaudeErrorType 识别允许直接出现在顶层的 Claude 稳定错误类型。
func isKnownClaudeErrorType(value string) bool {
	switch value {
	case "rate_limit_error",
		"overloaded_error",
		"authentication_error",
		"permission_error",
		"billing_error",
		"quota_error",
		"invalid_request_error",
		"api_error":
		return true
	default:
		return false
	}
}

// isUnifiedRateLimitRejected 判断统一额度已拒绝且 overage 不能继续承载请求。
func isUnifiedRateLimitRejected(header http.Header) bool {
	status, statusOK := sharedfailure.NormalizeErrorToken(
		header.Get(unifiedStatusHeader),
	)
	if !statusOK || status != "rejected" {
		return false
	}
	overageStatus, _ := sharedfailure.NormalizeErrorToken(
		header.Get(unifiedOverageStatusHeader),
	)
	return overageStatus != "allowed" &&
		overageStatus != "allowed_warning"
}
