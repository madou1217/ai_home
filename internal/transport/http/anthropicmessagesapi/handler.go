// Package anthropicmessagesapi 提供 Anthropic Messages 的 HTTP 入站适配器。
package anthropicmessagesapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

const (
	// Path 是 Anthropic Messages create 的规范 HTTP 路径。
	Path = "/v1/messages"
	// DefaultMaxBodyBytes 覆盖常规图片和文档请求，同时保持明确内存上限。
	DefaultMaxBodyBytes int64 = 32 * 1024 * 1024
	// MaxBodyBytesLimit 防止 Composition Root 意外关闭请求体边界。
	MaxBodyBytesLimit int64 = 256 * 1024 * 1024
	// claudeCodeBetaQuery 是当前官方 Claude Code/SDK 的 Messages 查询合同。
	claudeCodeBetaQuery = "beta=true"
)

var (
	// ErrInvalidDependencies 表示 Handler 缺少协议、执行器或鉴权策略。
	ErrInvalidDependencies = errors.New("Anthropic Messages HTTP Handler 依赖无效")
	// ErrStreamingUnsupported 表示 ResponseWriter 不能即时刷新 SSE。
	ErrStreamingUnsupported = inferenceapi.ErrStreamingUnsupported
)

// Authorizer 是 Messages 请求使用的 API Key 鉴权策略。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 集中声明 Messages HTTP 入站适配器依赖。
type Dependencies struct {
	Protocols           *clientprotocol.Registry
	Executor            inferencegateway.Executor
	Authorizer          Authorizer
	DecodeErrorObserver func(error)
	MaxBodyBytes        int64
}

// Handler 负责鉴权、请求解码、Canonical 执行和 Messages 响应渲染。
type Handler struct {
	adapter             clientprotocol.Adapter
	executor            inferencegateway.Executor
	authorizer          Authorizer
	decodeErrorObserver func(error)
	maxBodyBytes        int64
}

// NewHandler 解析一次协议注册并创建默认失败关闭的 Messages Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Executor == nil || dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	maxBodyBytes := dependencies.MaxBodyBytes
	if maxBodyBytes == 0 {
		maxBodyBytes = DefaultMaxBodyBytes
	}
	if maxBodyBytes < 1 || maxBodyBytes > MaxBodyBytesLimit {
		return nil, ErrInvalidDependencies
	}
	adapter, err := dependencies.Protocols.Resolve(
		inference.ClientProtocolAnthropicMessages,
	)
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		adapter:             adapter,
		executor:            dependencies.Executor,
		authorizer:          dependencies.Authorizer,
		decodeErrorObserver: dependencies.DecodeErrorObserver,
		maxBodyBytes:        maxBodyBytes,
	}, nil
}

// ServeHTTP 按鉴权、路由、方法、媒体类型和请求体的顺序失败关闭。
func (handler *Handler) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	if handler == nil ||
		handler.authorizer == nil ||
		!handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeAPIError(
			response,
			http.StatusUnauthorized,
			"authentication_error",
			"Invalid API key",
		)
		return
	}
	if request.URL.Path != Path {
		writeAPIError(
			response,
			http.StatusNotFound,
			"not_found_error",
			"Resource not found",
		)
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeAPIError(
			response,
			http.StatusMethodNotAllowed,
			"invalid_request_error",
			"Method not allowed",
		)
		return
	}
	if request.URL.ForceQuery ||
		request.URL.RawQuery != "" &&
			request.URL.RawQuery != claudeCodeBetaQuery {
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_request_error",
			"Query parameters are not supported",
		)
		return
	}
	ctx, err := inferenceapi.ContextWithPinnedAccount(request)
	if err != nil {
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_request_error",
			"Invalid account reference",
		)
		return
	}
	request = request.WithContext(ctx)

	body, err := readJSONBody(response, request, handler.maxBodyBytes)
	if err != nil {
		writeRequestError(response, err)
		return
	}
	canonicalRequest, err := handler.adapter.Decode(body)
	if err != nil {
		if handler.decodeErrorObserver != nil {
			handler.decodeErrorObserver(err)
		}
		writeDecodeError(response, err)
		return
	}
	if canonicalRequest.Stream() {
		handler.executeStream(response, request, canonicalRequest)
		return
	}
	handler.executeNonStream(response, request, canonicalRequest)
}

// executeNonStream 聚合完整 Canonical 事件流后一次写入 JSON。
func (handler *Handler) executeNonStream(
	response http.ResponseWriter,
	request *http.Request,
	canonicalRequest inference.Request,
) {
	aggregator := handler.adapter.NewResponseAggregator(canonicalRequest)
	var sinkErr error
	var failure inference.ResponseFailure
	var failed bool
	var observed bool
	executionErr := handler.executor.Execute(
		request.Context(),
		canonicalRequest,
		func(event inference.StreamEvent) error {
			eventFailure, isFailure := event.(inference.ResponseFailedEvent)
			if isFailure {
				if !observed {
					failure = eventFailure.Failure()
					if event.Sequence() != 0 || !failure.IsValid() {
						sinkErr = errInvalidPreCommitFailure
						return sinkErr
					}
					observed = true
					failed = true
					return nil
				}
				failure = eventFailure.Failure()
				failed = true
			}
			if failed && !isFailure {
				sinkErr = errInvalidPreCommitFailure
				return sinkErr
			}
			observed = true
			if err := aggregator.Add(event); err != nil {
				sinkErr = err
				return err
			}
			return nil
		},
	)
	switch {
	case sinkErr != nil:
		writeAPIError(
			response,
			http.StatusBadGateway,
			"api_error",
			"Invalid upstream response",
		)
	case executionErr != nil:
		writeExecutionError(response, request.Context(), executionErr)
	case failed:
		writeCanonicalFailure(response, failure)
	default:
		data, err := aggregator.Marshal()
		if err != nil {
			writeAPIError(
				response,
				http.StatusBadGateway,
				"api_error",
				"Upstream response ended unexpectedly",
			)
			return
		}
		writeJSON(response, http.StatusOK, data)
	}
}

// executeStream 按 Renderer 事件即时写出 SSE，并保持调用方背压。
func (handler *Handler) executeStream(
	response http.ResponseWriter,
	request *http.Request,
	canonicalRequest inference.Request,
) {
	stream, err := newSSEStream(response)
	if err != nil {
		writeAPIError(
			response,
			http.StatusInternalServerError,
			"api_error",
			"Streaming is unavailable",
		)
		return
	}
	renderer := handler.adapter.NewStreamRenderer(canonicalRequest)
	execution := newResponseStream(stream, renderer)
	executionErr := handler.executor.Execute(
		request.Context(),
		canonicalRequest,
		execution.Accept,
	)
	if execution.WriteFailed() {
		return
	}
	if failure, found := execution.PreCommitFailure(); found {
		writeCanonicalFailure(response, failure)
		return
	}
	if execution.Terminal() {
		return
	}
	switch {
	case execution.RenderFailed():
		writeStreamFailure(
			stream,
			response,
			http.StatusBadGateway,
			"api_error",
			"Invalid upstream response",
		)
	case executionErr != nil:
		if errors.Is(request.Context().Err(), context.Canceled) {
			return
		}
		writeStreamFailure(
			stream,
			response,
			http.StatusServiceUnavailable,
			"api_error",
			"Inference service is unavailable",
		)
	default:
		writeStreamFailure(
			stream,
			response,
			http.StatusBadGateway,
			"api_error",
			"Upstream response ended unexpectedly",
		)
	}
}
