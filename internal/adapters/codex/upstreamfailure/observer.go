package upstreamfailure

import (
	"io"
	"net/http"
	"strings"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

const (
	// modelAtCapacityMessage 是当前已确认的 Codex Responses 容量错误原文。
	modelAtCapacityMessage = "Selected model is at capacity. Please try a different model."
)

// codexErrorFields 只接收分类所需字段；Message 仅用于一个精确容量签名。
type codexErrorFields struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// codexResponseFields 是 Responses 流内 response.failed 的最小投影。
type codexResponseFields struct {
	Error *codexErrorFields `json:"error"`
}

// codexErrorEnvelope 覆盖已确认的 OpenAI、Codex detail 和 Responses 错误形状。
type codexErrorEnvelope struct {
	Type     string               `json:"type"`
	Code     string               `json:"code"`
	Error    *codexErrorFields    `json:"error"`
	Detail   *codexErrorFields    `json:"detail"`
	Response *codexResponseFields `json:"response"`
}

// ObserveHTTP 从真实 Codex HTTP 错误响应生成低敏分类。
//
// 调用方仍拥有 Body 的关闭责任；Observer 只在固定上限内消费错误正文。
func ObserveHTTP(
	response *http.Response,
	observedAt time.Time,
) (sharedfailure.Classification, error) {
	if response == nil || response.Body == nil {
		return sharedfailure.Classification{},
			sharedfailure.ErrInvalidObservation
	}
	envelope, decoded := decodeCodexEnvelope(response.Body)
	input, bodyEvidence := codexInput(
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

// ObserveSSE 观察 SSE decoder 切出的单个 Codex JSON 事件。
//
// observed=false 表示普通成功事件；只有明确失败事件的畸形 JSON 才返回 malformed 分类。
func ObserveSSE(
	input sharedfailure.SSEInput,
) (sharedfailure.Classification, bool, error) {
	if input.Data == nil {
		return sharedfailure.Classification{},
			false,
			sharedfailure.ErrInvalidObservation
	}
	explicitFailure := isCodexFailureEvent(input.EventType)
	envelope, decoded := decodeCodexEnvelope(input.Data)
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
	if !explicitFailure && !isCodexFailureEvent(envelope.Type) {
		return sharedfailure.Classification{}, false, nil
	}
	classification, err := Classify(codexInputFromEnvelope(
		http.StatusOK,
		input.Header,
		input.ObservedAt,
		envelope,
	))
	return classification, true, err
}

// decodeCodexEnvelope 有界解析错误结构，不把正文或 message 返回给调用方。
func decodeCodexEnvelope(
	reader io.Reader,
) (codexErrorEnvelope, bool) {
	var envelope codexErrorEnvelope
	if err := sharedfailure.DecodeErrorPayload(
		reader,
		&envelope,
	); err != nil {
		return codexErrorEnvelope{}, false
	}
	return envelope, true
}

// codexInput 同时返回正文是否包含结构化失败证据。
func codexInput(
	statusCode int,
	header http.Header,
	observedAt time.Time,
	envelope codexErrorEnvelope,
) (Input, bool) {
	input := codexInputFromEnvelope(
		statusCode,
		header,
		observedAt,
		envelope,
	)
	return input, hasCodexErrorEvidence(envelope)
}

// codexInputFromEnvelope 只把安全 type/code 和 Retry-After 交给分类器。
func codexInputFromEnvelope(
	statusCode int,
	header http.Header,
	observedAt time.Time,
	envelope codexErrorEnvelope,
) Input {
	fields := selectCodexErrorFields(envelope)
	errorType, _ := sharedfailure.NormalizeErrorToken(fields.Type)
	errorCode, _ := sharedfailure.NormalizeErrorToken(fields.Code)
	if errorCode == "" &&
		strings.TrimSpace(fields.Message) == modelAtCapacityMessage {
		errorCode = "model_at_capacity"
	}
	retryAfter, _ := sharedfailure.ParseRetryAfter(
		header.Get("Retry-After"),
		observedAt,
	)
	return Input{
		StatusCode: statusCode,
		ErrorType:  errorType,
		ErrorCode:  errorCode,
		RetryAfter: retryAfter,
	}
}

// selectCodexErrorFields 按 Responses、标准 error、detail、顶层字段顺序取值。
func selectCodexErrorFields(
	envelope codexErrorEnvelope,
) codexErrorFields {
	if envelope.Response != nil &&
		envelope.Response.Error != nil {
		return *envelope.Response.Error
	}
	if envelope.Error != nil {
		return *envelope.Error
	}
	if envelope.Detail != nil {
		return *envelope.Detail
	}
	return codexErrorFields{
		Type: envelope.Type,
		Code: envelope.Code,
	}
}

// hasCodexErrorEvidence 判断成功状态正文是否明确承载错误 envelope。
func hasCodexErrorEvidence(envelope codexErrorEnvelope) bool {
	if envelope.Response != nil &&
		envelope.Response.Error != nil ||
		envelope.Error != nil ||
		envelope.Detail != nil ||
		envelope.Code != "" {
		return true
	}
	return isCodexFailureEvent(envelope.Type)
}

// isCodexFailureEvent 只识别已经确认的 Responses/OpenAI 失败事件名。
func isCodexFailureEvent(value string) bool {
	normalized, ok := sharedfailure.NormalizeErrorToken(value)
	return ok &&
		(normalized == "response.failed" || normalized == "error")
}
