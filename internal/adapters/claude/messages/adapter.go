package messages

import (
	"bytes"
	"context"
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
	claudefailure "github.com/madou1217/ai_home/internal/adapters/claude/upstreamfailure"
	sharedsse "github.com/madou1217/ai_home/internal/adapters/sse"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

const (
	// maxJSONResponseBytes 限制兼容端点完整 Message 的内存占用。
	maxJSONResponseBytes = 16 * 1024 * 1024
)

// HTTPClient 是 Adapter 执行单个 HTTP 请求所需的最小端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Clock 为 Retry-After 日期解析提供确定性业务时间。
type Clock func() time.Time

// Adapter 实现 Claude 原生 Messages 上游协议。
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

// ProtocolID 返回 Claude Messages 的精确线协议身份。
func (*Adapter) ProtocolID() inference.ProtocolID {
	return inference.ProtocolClaudeMessages
}

// SupportsCredential 只接受能够由 Go Messages Adapter 精确承载的 Claude 凭据。
// 官方订阅 OAuth 通过原生 Claude Code HTTP 外层合同发送。
func (adapter *Adapter) SupportsCredential(
	credential accountapp.Credential,
) bool {
	if adapter == nil ||
		credential == nil ||
		credential.ProviderID() != string(inference.ProviderClaude) {
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
	encoded, err := encodeRequest(invocation.Request(), effectiveModel)
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	request, err := buildHTTPRequest(ctx, auth, encoded)
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
		classification, observeErr := claudefailure.ObserveHTTP(
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
		// 请求固定声明 stream=true；缺失媒体类型时按已请求的 SSE 合同解析。
		return adapter.executeEventStream(
			response,
			observedAt,
			effectiveModel,
			emit,
			encoded.toolNames,
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
			encoded.toolNames,
		)
	case "application/json":
		return adapter.executeJSONResponse(
			response,
			observedAt,
			effectiveModel,
			emit,
			encoded.toolNames,
		)
	default:
		if isJSONMediaType(mediaType) {
			return adapter.executeJSONResponse(
				response,
				observedAt,
				effectiveModel,
				emit,
				encoded.toolNames,
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
		invocation.Route().ProviderID() != inference.ProviderClaude ||
		invocation.Route().ProtocolID() != inference.ProtocolClaudeMessages ||
		invocation.Credential() == nil ||
		invocation.Credential().ProviderID() !=
			string(inference.ProviderClaude) {
		return ErrInvalidInvocation
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return nil
}

// executeEventStream 读取完整 SSE 事件并在明确 message_stop 后停止。
func (adapter *Adapter) executeEventStream(
	response *http.Response,
	observedAt time.Time,
	effectiveModel string,
	emit inferencegateway.EventSink,
	toolNames toolNameMapper,
) (inferencegateway.AttemptResult, error) {
	decoder, err := newResponseDecoder(effectiveModel, emit, toolNames)
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	reader, err := sharedsse.NewReader(response.Body)
	if err != nil {
		return malformedAttempt()
	}
	for {
		event, readErr := reader.Next()
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				if decoder.Terminal() {
					return inferencegateway.CompletedAttempt(), nil
				}
				return incompleteStreamAttempt(io.EOF)
			}
			if errors.Is(readErr, sharedsse.ErrInvalidEvent) ||
				errors.Is(readErr, sharedsse.ErrInvalidSource) {
				return malformedAttempt()
			}
			var upstreamRead *sharedsse.ReadError
			if errors.As(readErr, &upstreamRead) {
				return incompleteStreamAttempt(upstreamRead.Cause())
			}
			return malformedAttempt()
		}
		if bytes.Equal(bytes.TrimSpace(event.Data()), []byte("[DONE]")) {
			return incompleteStreamAttempt(io.EOF)
		}
		if result, observed, observeErr := observeSSEFailure(
			event,
			response.Header,
			observedAt,
		); observeErr != nil {
			return inferencegateway.AttemptResult{}, observeErr
		} else if observed {
			return result, nil
		}
		if err := decoder.Apply(event.Type(), event.Data()); err != nil {
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

// executeJSONResponse 支持兼容端点返回完整 Message JSON 的保守分支。
func (adapter *Adapter) executeJSONResponse(
	response *http.Response,
	observedAt time.Time,
	effectiveModel string,
	emit inferencegateway.EventSink,
	toolNames toolNameMapper,
) (inferencegateway.AttemptResult, error) {
	payload, err := readBoundedJSON(response.Body)
	if err != nil {
		return malformedAttempt()
	}
	classification, observeErr := claudefailure.ObserveHTTP(
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
	decoder, err := newResponseDecoder(effectiveModel, emit, toolNames)
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	if err := decoder.DecodeMessage(payload); err != nil {
		var sinkErr eventSinkError
		if errors.As(err, &sinkErr) {
			return inferencegateway.AttemptResult{}, sinkErr.Cause()
		}
		if errors.Is(err, ErrInvalidUpstreamResponse) {
			return malformedAttempt()
		}
		return inferencegateway.AttemptResult{}, err
	}
	if !decoder.Terminal() {
		return incompleteStreamAttempt(io.EOF)
	}
	return inferencegateway.CompletedAttempt(), nil
}

// observeSSEFailure 复用 Claude 低敏 Observer，普通内容事件不产生结果。
func observeSSEFailure(
	event sharedsse.Event,
	header http.Header,
	observedAt time.Time,
) (inferencegateway.AttemptResult, bool, error) {
	classification, observed, err := claudefailure.ObserveSSE(
		sharedfailure.SSEInput{
			EventType:  event.Type(),
			Data:       bytes.NewReader(event.Data()),
			Header:     header,
			ObservedAt: observedAt,
		},
	)
	if err != nil {
		return inferencegateway.AttemptResult{}, false, err
	}
	if !observed {
		return inferencegateway.AttemptResult{}, false, nil
	}
	failure, err := newAttemptFailure(classification)
	if err != nil {
		return inferencegateway.AttemptResult{}, false, err
	}
	return inferencegateway.FailedAttempt(failure), true, nil
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
