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
	"github.com/madou1217/ai_home/application/effortalign"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
	claudefailure "github.com/madou1217/ai_home/internal/adapters/claude/upstreamfailure"
	sharedsse "github.com/madou1217/ai_home/internal/adapters/sse"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
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
	client       HTTPClient
	clock        Clock
	decodeErrors func(error)
	// rules 可选：账号自定义上游错误规则求值端口，见 ObserveUpstreamRules。
	rules configured.Rules
	// aligner 可选：把请求的推理强度压进目标模型的档位阶梯，见 ObserveEffortLadders。
	aligner *effortalign.Aligner
}

// 编译期确认 Adapter 完整实现上游端口。
var _ inferencegateway.UpstreamAdapter = (*Adapter)(nil)

// NewAdapter 创建显式注入 HTTP Client 和时钟的 Adapter。
func NewAdapter(
	client HTTPClient,
	clock Clock,
	decodeErrorObservers ...func(error),
) (*Adapter, error) {
	if client == nil || clock == nil || len(decodeErrorObservers) > 1 {
		return nil, ErrInvalidDependencies
	}
	var decodeErrors func(error)
	if len(decodeErrorObservers) == 1 {
		decodeErrors = decodeErrorObservers[0]
	}
	return &Adapter{
		client:       client,
		clock:        clock,
		decodeErrors: decodeErrors,
	}, nil
}

// ProtocolID 返回 Claude Messages 的精确线协议身份。
func (*Adapter) ProtocolID() inference.ProtocolID {
	return inference.ProtocolClaudeMessages
}

// ObserveUpstreamRules 注入账号自定义上游错误规则求值端口。
//
// nil 表示 Go 未承接该能力：分类完全由内置 Observer 决定，行为与不注入时一致。
// 注入后命中规则的账号，其上游错误按规则映射的状态、作用域和冷却记账。
func (adapter *Adapter) ObserveUpstreamRules(rules configured.Rules) {
	if adapter == nil {
		return
	}
	adapter.rules = rules
}

// ObserveEffortLadders 注入目标模型的推理强度档位来源。
//
// nil 表示 Go 不承接强度对齐：请求原样透传，档位收敛仍由 encodeReasoning 的既有规则决定。
func (adapter *Adapter) ObserveEffortLadders(ladders effortalign.LadderReader) {
	if adapter == nil {
		return
	}
	adapter.aligner = effortalign.New(ladders)
}

// SupportsCredential 只接受能够由 Go Messages Adapter 精确承载的 Claude 凭据。
// 订阅 OAuth 也在其中：官方客户端仍优先走 Native Relay，但跨协议客户端只能
// 由 Canonical 承载，能力边界因此不再按凭据类型排除订阅账号。
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
	// 强度对齐必须发生在编码之前：encodeReasoning 只认识 Anthropic 的档位词汇，
	// 把 Codex 的 xhigh/ultra 交给它会在各条路径各夹一次、方向还可能相反。
	aligned := adapter.aligner.Apply(invocation.Request(), invocation.Route().ProviderID(), effectiveModel)
	encoded, err := encodeRequest(
		aligned,
		effectiveModel,
		auth.officialClient,
	)
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
		// 规则求值需要原始正文；按观察器的同一上限预读一次，再把它交回观察器。
		rejectionBody, readErr := io.ReadAll(io.LimitReader(response.Body, sharedfailure.MaxErrorPayloadBytes+1))
		if readErr != nil {
			return malformedAttempt()
		}
		response.Body = io.NopCloser(bytes.NewReader(rejectionBody))
		classification, observeErr := configured.ClassifyWithRules(
			adapter.rules,
			string(invocation.Account().Ref()),
			response.StatusCode,
			rejectionBody,
			func() (sharedfailure.Classification, error) {
				return claudefailure.ObserveHTTP(
					response,
					observedAt,
				)
			},
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
			string(invocation.Account().Ref()),
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
			string(invocation.Account().Ref()),
		)
	case "application/json":
		return adapter.executeJSONResponse(
			response,
			observedAt,
			effectiveModel,
			emit,
			encoded.toolNames,
			string(invocation.Account().Ref()),
		)
	default:
		if isJSONMediaType(mediaType) {
			return adapter.executeJSONResponse(
				response,
				observedAt,
				effectiveModel,
				emit,
				encoded.toolNames,
				string(invocation.Account().Ref()),
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
	accountRef string,
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
		if result, observed, observeErr := adapter.observeSSEFailure(
			event,
			response.Header,
			observedAt,
			accountRef,
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
				adapter.observeDecodeError(
					newDecodeDiagnosticError(decoder, event.Type(), event.Data()),
				)
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
	accountRef string,
) (inferencegateway.AttemptResult, error) {
	payload, err := readBoundedJSON(response.Body)
	if err != nil {
		return malformedAttempt()
	}
	observedResponse := http.Response{
		StatusCode: response.StatusCode,
		Header:     response.Header.Clone(),
		Body:       io.NopCloser(bytes.NewReader(payload)),
	}
	classification, observeErr := configured.ClassifyWithRules(
		adapter.rules,
		accountRef,
		observedResponse.StatusCode,
		payload,
		func() (sharedfailure.Classification, error) {
			return claudefailure.ObserveHTTP(&observedResponse, observedAt)
		},
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
			adapter.observeDecodeError(
				newDecodeDiagnosticError(decoder, "message", payload),
			)
			return malformedAttempt()
		}
		return inferencegateway.AttemptResult{}, err
	}
	if !decoder.Terminal() {
		return incompleteStreamAttempt(io.EOF)
	}
	return inferencegateway.CompletedAttempt(), nil
}

// observeDecodeError 把已经脱敏的上游结构诊断交给可选 Host 观察者。
func (adapter *Adapter) observeDecodeError(err error) {
	if adapter != nil && adapter.decodeErrors != nil && err != nil {
		adapter.decodeErrors(err)
	}
}

// observeSSEFailure 复用 Claude 低敏 Observer，普通内容事件不产生结果。
//
// 账号自定义规则优先：命中规则的失败事件按规则映射的状态与作用域记账，
// 未命中或未注入规则时逐字节等价于只调用内置 Observer。
func (adapter *Adapter) observeSSEFailure(
	event sharedsse.Event,
	header http.Header,
	observedAt time.Time,
	accountRef string,
) (inferencegateway.AttemptResult, bool, error) {
	classification, observed, err := configured.ClassifySSEWithRules(
		adapter.rules,
		accountRef,
		http.StatusOK,
		event.Data(),
		func() (sharedfailure.Classification, bool, error) {
			return claudefailure.ObserveSSE(
				sharedfailure.SSEInput{
					EventType:  event.Type(),
					Data:       bytes.NewReader(event.Data()),
					Header:     header,
					ObservedAt: observedAt,
				},
			)
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
