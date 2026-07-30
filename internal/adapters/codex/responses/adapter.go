package responses

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
	codexfailure "github.com/madou1217/ai_home/internal/adapters/codex/upstreamfailure"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

const (
	// maxJSONResponseBytes 限制异常非流式成功响应的内存占用。
	maxJSONResponseBytes = 16 * 1024 * 1024
)

// HTTPClient 是 Adapter 执行单个 HTTP 请求所需的最小端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Clock 为 Retry-After 日期解析提供确定性业务时间。
type Clock func() time.Time

// Adapter 实现 Codex 原生 Responses 上游协议。
type Adapter struct {
	client HTTPClient
	clock  Clock
}

// 编译期确认 Adapter 完整实现上游端口。
var _ inferencegateway.UpstreamAdapter = (*Adapter)(nil)

// NewAdapter 创建显式注入 HTTP Client 和时钟的 Adapter。
func NewAdapter(client HTTPClient, clock Clock) (*Adapter, error) {
	if client == nil || clock == nil {
		return nil, ErrInvalidDependencies
	}
	return &Adapter{
		client: client,
		clock:  clock,
	}, nil
}

// ProtocolID 返回 Codex Responses 的精确线协议身份。
func (*Adapter) ProtocolID() inference.ProtocolID {
	return inference.ProtocolCodexResponses
}

// SupportsCredential 接受 Responses Adapter 已实现的 Codex OAuth 和 API Key。
func (adapter *Adapter) SupportsCredential(
	credential accountapp.Credential,
) bool {
	if adapter == nil ||
		credential == nil ||
		credential.ProviderID() != string(inference.ProviderCodex) {
		return false
	}
	_, err := projectAuth(credential)
	return err == nil
}

// Execute 编码请求、执行 HTTP 传输并同步输出 Canonical 事件。
func (adapter *Adapter) Execute(
	ctx context.Context,
	invocation inferencegateway.Invocation,
	emit inferencegateway.EventSink,
) (inferencegateway.AttemptResult, error) {
	if err := adapter.validateInvocation(ctx, invocation, emit); err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	observedAt := adapter.clock()
	if observedAt.IsZero() ||
		observedAt.Year() < 1970 ||
		observedAt.Year() > 9999 {
		return inferencegateway.AttemptResult{}, ErrInvalidDependencies
	}
	auth, err := projectAuth(invocation.Credential())
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	effectiveModel := invocation.Route().EffectiveModel()
	profile := requestProfileForModel(effectiveModel)
	payload, err := encodeRequest(
		invocation.Request(),
		effectiveModel,
		auth.kind,
		profile,
	)
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	request, err := buildHTTPRequest(ctx, auth, payload, profile)
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	response, err := adapter.client.Do(request)
	if err != nil {
		closeResponse(response)
		failure, classifyErr := newTransportFailure(err)
		if classifyErr != nil {
			return inferencegateway.AttemptResult{}, classifyErr
		}
		return inferencegateway.FailedAttempt(failure), nil
	}
	if response == nil || response.Body == nil {
		closeResponse(response)
		return malformedAttempt()
	}
	defer response.Body.Close()

	if response.StatusCode < http.StatusOK ||
		response.StatusCode >= http.StatusMultipleChoices {
		classification, observeErr := codexfailure.ObserveHTTP(
			response,
			observedAt,
		)
		if observeErr != nil {
			return malformedAttempt()
		}
		failure, classifyErr := newAttemptFailure(classification)
		if classifyErr != nil {
			return inferencegateway.AttemptResult{}, classifyErr
		}
		return inferencegateway.FailedAttempt(failure), nil
	}

	rawMediaType := strings.TrimSpace(response.Header.Get("Content-Type"))
	if rawMediaType == "" {
		// 官方 Codex 成功流不依赖响应媒体类型，真实 ChatGPT 后端也可能省略该 Header。
		// 本 Adapter 固定发送 stream=true，因此缺失 Header 时仍按明确请求的 SSE 合同解析。
		return adapter.executeEventStream(
			response,
			observedAt,
			effectiveModel,
			emit,
		)
	}
	mediaType, _, err := mime.ParseMediaType(rawMediaType)
	if err != nil {
		return malformedAttempt()
	}
	switch mediaType {
	case "text/event-stream":
		return adapter.executeEventStream(
			response,
			observedAt,
			effectiveModel,
			emit,
		)
	case "application/json":
		return adapter.executeJSONResponse(
			response,
			observedAt,
			effectiveModel,
			emit,
		)
	default:
		if isJSONMediaType(mediaType) {
			return adapter.executeJSONResponse(
				response,
				observedAt,
				effectiveModel,
				emit,
			)
		}
		return malformedAttempt()
	}
}

// validateInvocation 拒绝跨 Provider、跨协议或零值调用。
func (adapter *Adapter) validateInvocation(
	ctx context.Context,
	invocation inferencegateway.Invocation,
	emit inferencegateway.EventSink,
) error {
	if adapter == nil ||
		adapter.client == nil ||
		adapter.clock == nil ||
		ctx == nil ||
		emit == nil ||
		invocation.Route().ProviderID() != inference.ProviderCodex ||
		invocation.Route().ProtocolID() != inference.ProtocolCodexResponses ||
		invocation.Credential() == nil ||
		invocation.Credential().ProviderID() != string(inference.ProviderCodex) {
		return ErrInvalidInvocation
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return nil
}

// executeEventStream 读取完整 SSE 事件并在明确终态后停止。
func (adapter *Adapter) executeEventStream(
	response *http.Response,
	observedAt time.Time,
	effectiveModel string,
	emit inferencegateway.EventSink,
) (inferencegateway.AttemptResult, error) {
	decoder, err := newResponseDecoder(effectiveModel, emit)
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	reader := newSSEReader(response.Body)
	for {
		event, readErr := reader.Next()
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				if decoder.Terminal() {
					return inferencegateway.CompletedAttempt(), nil
				}
				return incompleteStreamAttempt(io.EOF)
			}
			var upstreamRead upstreamReadError
			if errors.As(readErr, &upstreamRead) {
				return incompleteStreamAttempt(upstreamRead.Cause())
			}
			return malformedAttempt()
		}
		if bytes.Equal(bytes.TrimSpace(event.data), []byte("[DONE]")) {
			return incompleteStreamAttempt(io.EOF)
		}
		var wireEvent streamEventDTO
		if json.Unmarshal(event.data, &wireEvent) != nil ||
			wireEvent.Type == "" ||
			event.eventType != "" &&
				event.eventType != wireEvent.Type {
			return malformedAttempt()
		}
		if wireEvent.Type == "response.failed" ||
			wireEvent.Type == "error" {
			return observeSSEFailure(
				event,
				response.Header,
				observedAt,
			)
		}
		if err := decoder.Apply(wireEvent); err != nil {
			var sinkErr eventSinkError
			if errors.As(err, &sinkErr) {
				return inferencegateway.AttemptResult{},
					sinkErr.Cause()
			}
			if errors.Is(err, ErrInvalidUpstreamResponse) {
				return malformedAttempt()
			}
			return inferencegateway.AttemptResult{}, err
		}
		if decoder.Terminal() {
			return inferencegateway.CompletedAttempt(), nil
		}
	}
}

// executeJSONResponse 支持代理返回完整 Response JSON 的保守分支。
func (adapter *Adapter) executeJSONResponse(
	response *http.Response,
	observedAt time.Time,
	effectiveModel string,
	emit inferencegateway.EventSink,
) (inferencegateway.AttemptResult, error) {
	payload, err := readBoundedJSON(response.Body)
	if err != nil {
		return malformedAttempt()
	}
	classification, observeErr := codexfailure.ObserveHTTP(
		&http.Response{
			StatusCode: response.StatusCode,
			Header:     response.Header.Clone(),
			Body:       io.NopCloser(bytes.NewReader(payload)),
		},
		observedAt,
	)
	if observeErr == nil {
		failure, classifyErr := newAttemptFailure(classification)
		if classifyErr != nil {
			return inferencegateway.AttemptResult{}, classifyErr
		}
		return inferencegateway.FailedAttempt(failure), nil
	}
	if !errors.Is(observeErr, sharedfailure.ErrNoFailureEvidence) {
		return malformedAttempt()
	}
	var envelope streamEventDTO
	if json.Unmarshal(payload, &envelope) == nil && envelope.Type != "" {
		if envelope.Type == "response.failed" || envelope.Type == "error" {
			return observeSSEFailure(
				sseEvent{eventType: envelope.Type, data: payload},
				response.Header,
				observedAt,
			)
		}
		return adapter.decodeSingleEvent(
			envelope,
			effectiveModel,
			emit,
		)
	}
	var wireResponse responseDTO
	if json.Unmarshal(payload, &wireResponse) != nil {
		return malformedAttempt()
	}
	switch wireResponse.Status {
	case "completed":
		encoded, marshalErr := json.Marshal(wireResponse)
		if marshalErr != nil {
			return malformedAttempt()
		}
		return adapter.decodeSingleEvent(
			streamEventDTO{
				Type:     "response.completed",
				Response: encoded,
			},
			effectiveModel,
			emit,
		)
	case "incomplete":
		encoded, marshalErr := json.Marshal(wireResponse)
		if marshalErr != nil {
			return malformedAttempt()
		}
		return adapter.decodeSingleEvent(
			streamEventDTO{
				Type:     "response.incomplete",
				Response: encoded,
			},
			effectiveModel,
			emit,
		)
	case "failed":
		synthetic, marshalErr := json.Marshal(streamEventDTO{
			Type:     "response.failed",
			Response: payload,
		})
		if marshalErr != nil {
			return malformedAttempt()
		}
		return observeSSEFailure(
			sseEvent{
				eventType: "response.failed",
				data:      synthetic,
			},
			response.Header,
			observedAt,
		)
	default:
		return malformedAttempt()
	}
}

// decodeSingleEvent 把完整 JSON 终态交给同一个响应状态机。
func (adapter *Adapter) decodeSingleEvent(
	event streamEventDTO,
	effectiveModel string,
	emit inferencegateway.EventSink,
) (inferencegateway.AttemptResult, error) {
	decoder, err := newResponseDecoder(effectiveModel, emit)
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	if err := decoder.Apply(event); err != nil {
		var sinkErr eventSinkError
		if errors.As(err, &sinkErr) {
			return inferencegateway.AttemptResult{}, sinkErr.Cause()
		}
		return malformedAttempt()
	}
	if !decoder.Terminal() {
		return incompleteStreamAttempt(io.EOF)
	}
	return inferencegateway.CompletedAttempt(), nil
}

// observeSSEFailure 复用 Codex 低敏 Observer 生成失败结果。
func observeSSEFailure(
	event sseEvent,
	header http.Header,
	observedAt time.Time,
) (inferencegateway.AttemptResult, error) {
	classification, observed, err := codexfailure.ObserveSSE(
		sharedfailure.SSEInput{
			EventType:  event.eventType,
			Data:       bytes.NewReader(event.data),
			Header:     header,
			ObservedAt: observedAt,
		},
	)
	if err != nil || !observed {
		return malformedAttempt()
	}
	failure, err := newAttemptFailure(classification)
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	return inferencegateway.FailedAttempt(failure), nil
}

// readBoundedJSON 完整读取单个 JSON 值并拒绝超限正文。
func readBoundedJSON(reader io.Reader) ([]byte, error) {
	limited := &io.LimitedReader{
		R: reader,
		N: maxJSONResponseBytes + 1,
	}
	payload, err := io.ReadAll(limited)
	if err != nil ||
		len(payload) == 0 ||
		len(payload) > maxJSONResponseBytes {
		return nil, ErrInvalidUpstreamResponse
	}
	return payload, nil
}

// malformedAttempt 创建不会进入 cooldown 的响应格式失败。
func malformedAttempt() (inferencegateway.AttemptResult, error) {
	failure, err := newClassifiedFailure(
		runtimecore.FailureMalformedResponse,
	)
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	return inferencegateway.FailedAttempt(failure), nil
}

// incompleteStreamAttempt 创建保留传输错误身份的提前断流失败。
func incompleteStreamAttempt(
	err error,
) (inferencegateway.AttemptResult, error) {
	failure, classifyErr := newIncompleteStreamFailure(err)
	if classifyErr != nil {
		return inferencegateway.AttemptResult{}, classifyErr
	}
	return inferencegateway.FailedAttempt(failure), nil
}

// closeResponse 关闭 Do 同时返回的异常响应。
func closeResponse(response *http.Response) {
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
}

// isJSONMediaType 判断带 +json 后缀的标准 JSON 类型。
func isJSONMediaType(value string) bool {
	return value == "application/json" ||
		strings.HasSuffix(value, "+json")
}
