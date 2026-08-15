package upstreamfailure

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

const (
	// modelAtCapacityMessage 是当前已确认的 Codex Responses 容量错误原文。
	modelAtCapacityMessage       = "Selected model is at capacity. Please try a different model."
	modelNotFoundCode            = "model_not_found"
	websocketConnectionLimitCode = "websocket_connection_limit_reached"
	previousResponseNotFoundCode = "previous_response_not_found"
)

// codexModelMissingSignature 是 Node 真实 relay 回归确认的文案模板。
// prefix 与 suffix 之间只能出现一个非空、无空白的模型标识。
type codexModelMissingSignature struct {
	prefix string
	suffix string
}

var codexModelMissingSignatures = [...]codexModelMissingSignature{
	{
		prefix: "/responses: invalid model name passed in model=",
		suffix: ". call `/v1/models` to view available models for your key.",
	},
	{
		prefix: `model "`,
		suffix: `" is not supported by any configured account in this group`,
	},
	{
		prefix: "the '",
		suffix: "' model is not supported when using codex with a chatgpt account.",
	},
	{
		prefix: "the model `",
		suffix: "` does not exist or you do not have access to it.",
	},
}

// codexErrorFields 只接收分类所需字段；Message 仅在 Observer 内匹配已确认签名。
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

// codexWebSocketErrorEnvelope 是官方 Responses WS 包装错误的最小投影。
type codexWebSocketErrorEnvelope struct {
	Type       string                     `json:"type"`
	Status     int                        `json:"status"`
	StatusCode int                        `json:"status_code"`
	Error      *codexErrorFields          `json:"error"`
	Headers    map[string]json.RawMessage `json:"headers"`
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

// ObserveWebSocket 观察 Responses WS 文本错误帧，并读取其中包装的状态与
// Retry-After。普通事件返回 observed=false，Provider 正文不会离开 Observer。
func ObserveWebSocket(
	input sharedfailure.SSEInput,
) (sharedfailure.Classification, bool, error) {
	if input.Data == nil {
		return sharedfailure.Classification{},
			false,
			sharedfailure.ErrInvalidObservation
	}
	eventType, ok := sharedfailure.NormalizeErrorToken(input.EventType)
	if !ok || (eventType != "error" && eventType != "response.failed") {
		return sharedfailure.Classification{}, false, nil
	}
	if eventType == "response.failed" {
		return ObserveSSE(input)
	}
	var envelope codexWebSocketErrorEnvelope
	if err := sharedfailure.DecodeErrorPayload(
		input.Data,
		&envelope,
	); err != nil || envelope.Type != "error" {
		classification, classifyErr := sharedfailure.NewClassification(
			runtimecore.FailureMalformedResponse,
			0,
		)
		return classification, true, classifyErr
	}
	statusCode := envelope.Status
	if statusCode == 0 {
		statusCode = envelope.StatusCode
	}
	if statusCode == 0 {
		statusCode = http.StatusOK
	}
	fields := codexErrorFields{}
	if envelope.Error != nil {
		fields = *envelope.Error
	}
	errorType, _ := sharedfailure.NormalizeErrorToken(fields.Type)
	errorCode, _ := sharedfailure.NormalizeErrorToken(fields.Code)
	// 这两个错误只描述当前 WS 连接或 previous_response_id 连续性，不能把
	// 健康账号写入 cooldown 或策略阻塞。
	if errorCode == websocketConnectionLimitCode ||
		errorCode == previousResponseNotFoundCode {
		classification, classifyErr := sharedfailure.NewClassification(
			runtimecore.FailureUnclassified,
			0,
		)
		return classification, true, classifyErr
	}
	retryAfter, _ := sharedfailure.ParseRetryAfter(
		webSocketHeader(envelope.Headers, "Retry-After"),
		input.ObservedAt,
	)
	classification, err := Classify(Input{
		StatusCode: statusCode,
		ErrorType:  errorType,
		ErrorCode:  errorCode,
		RetryAfter: retryAfter,
	})
	return classification, true, err
}

// webSocketHeader 只接受一个可安全表示为 HTTP Header 的字符串。
func webSocketHeader(
	headers map[string]json.RawMessage,
	name string,
) string {
	for candidate, raw := range headers {
		if !strings.EqualFold(candidate, name) {
			continue
		}
		var value string
		if json.Unmarshal(raw, &value) == nil {
			return value
		}
		return ""
	}
	return ""
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
	errorCode := codexErrorCode(statusCode, fields)
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

// codexErrorCode 优先保留 Provider 的稳定业务 code；只有 code 缺失或只是
// HTTP 数字、且 400/404 message 完整命中已确认模板时，才合成 model_not_found。
func codexErrorCode(statusCode int, fields codexErrorFields) string {
	errorCode, _ := sharedfailure.NormalizeErrorToken(fields.Code)
	if errorCode == "" &&
		strings.TrimSpace(fields.Message) == modelAtCapacityMessage {
		return "model_at_capacity"
	}
	if isMessageOnlyModelMissing(statusCode, errorCode, fields.Message) {
		return modelNotFoundCode
	}
	return errorCode
}

// isMessageOnlyModelMissing 仅识别来源提交 15518c3 固化的四种真实文案。
// 普通参数错误、相似散词和其他状态都不能改变原始 HTTP 分类。
func isMessageOnlyModelMissing(
	statusCode int,
	errorCode string,
	message string,
) bool {
	if statusCode != http.StatusBadRequest &&
		statusCode != http.StatusNotFound {
		return false
	}
	if errorCode != "" && errorCode != strconv.Itoa(statusCode) {
		return false
	}
	normalized := strings.ToLower(strings.TrimSpace(message))
	for _, signature := range codexModelMissingSignatures {
		if matchesModelMissingSignature(normalized, signature) {
			return true
		}
	}
	return false
}

// matchesModelMissingSignature 要求模板完整且模型槽唯一非空，避免宽泛的
// model/not supported 关键字把用户参数错误误判为账号模型能力问题。
func matchesModelMissingSignature(
	message string,
	signature codexModelMissingSignature,
) bool {
	if !strings.HasPrefix(message, signature.prefix) ||
		!strings.HasSuffix(message, signature.suffix) {
		return false
	}
	modelID := strings.TrimSuffix(
		strings.TrimPrefix(message, signature.prefix),
		signature.suffix,
	)
	return modelID != "" && !strings.ContainsAny(modelID, " \t\r\n")
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
