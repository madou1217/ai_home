// Package openaichatcompletionsapi 提供 OpenAI Chat Completions 的 Go HTTP 入站适配器。
package openaichatcompletionsapi

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
	// Path 是 OpenAI Chat Completions create 的规范 HTTP 路径。
	Path = "/v1/chat/completions"
	// DefaultMaxBodyBytes 覆盖常规图片请求，同时保持明确内存上限。
	DefaultMaxBodyBytes int64 = 32 * 1024 * 1024
	// MaxBodyBytesLimit 防止 Composition Root 意外关闭请求体边界。
	MaxBodyBytesLimit int64 = 256 * 1024 * 1024
)

var (
	// ErrInvalidDependencies 表示 Handler 缺少协议、执行器或鉴权策略。
	ErrInvalidDependencies = errors.New("OpenAI Chat Completions HTTP Handler 依赖无效")
	// ErrStreamingUnsupported 表示 ResponseWriter 不能即时刷新 SSE。
	ErrStreamingUnsupported = inferenceapi.ErrStreamingUnsupported
)

// Authorizer 是 Chat Completions 请求使用的 Bearer 鉴权策略。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 集中声明 Chat Completions HTTP 入站适配器依赖。
type Dependencies struct {
	// Protocols 提供精确的 Chat Completions Decoder 和 Renderer。
	Protocols *clientprotocol.Registry
	// Executor 执行与客户端协议解耦的 Canonical 请求。
	Executor inferencegateway.Executor
	// Authorizer 在读取请求体前校验客户端凭据。
	Authorizer Authorizer
	// MaxBodyBytes 是单请求允许读取的最大字节数。
	MaxBodyBytes int64
}

// Handler 负责鉴权、请求解码、Canonical 执行和 Chat Completions 输出渲染。
type Handler struct {
	adapter      clientprotocol.Adapter
	executor     inferencegateway.Executor
	authorizer   Authorizer
	maxBodyBytes int64
}

// NewHandler 解析一次协议注册并创建默认失败关闭的 Chat Completions Handler。
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
		inference.ClientProtocolOpenAIChatCompletions,
	)
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		adapter:      adapter,
		executor:     dependencies.Executor,
		authorizer:   dependencies.Authorizer,
		maxBodyBytes: maxBodyBytes,
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
			"invalid_api_key",
			"Invalid API key",
		)
		return
	}
	if request.URL.Path != Path {
		writeAPIError(
			response,
			http.StatusNotFound,
			"invalid_request_error",
			"not_found",
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
			"method_not_allowed",
			"Method not allowed",
		)
		return
	}
	if request.URL.RawQuery != "" {
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_request_error",
			"invalid_query",
			"Query parameters are not supported",
		)
		return
	}

	body, err := inferenceapi.ReadJSONBody(
		response,
		request,
		handler.maxBodyBytes,
	)
	if err != nil {
		writeRequestError(response, err)
		return
	}
	canonicalRequest, err := handler.adapter.Decode(body)
	if err != nil {
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
	executionErr := handler.executor.Execute(
		request.Context(),
		canonicalRequest,
		func(event inference.StreamEvent) error {
			if eventFailure, ok := event.(inference.ResponseFailedEvent); ok {
				failure = eventFailure.Failure()
				failed = true
			}
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
			"server_error",
			"invalid_upstream_response",
			"Invalid upstream response",
		)
	case executionErr != nil:
		writeExecutionError(response, request.Context())
	case failed:
		writeCanonicalFailure(response, failure)
	default:
		data, err := aggregator.Marshal()
		if err != nil {
			writeAPIError(
				response,
				http.StatusBadGateway,
				"server_error",
				"incomplete_upstream_response",
				"Upstream response ended unexpectedly",
			)
			return
		}
		writeJSON(response, http.StatusOK, data)
	}
}

// executeStream 按 Renderer 事件即时写出 data-only SSE，并保持调用方背压。
func (handler *Handler) executeStream(
	response http.ResponseWriter,
	request *http.Request,
	canonicalRequest inference.Request,
) {
	stream, err := inferenceapi.NewSSEStream(response)
	if err != nil {
		writeAPIError(
			response,
			http.StatusInternalServerError,
			"server_error",
			"streaming_unavailable",
			"Streaming is unavailable",
		)
		return
	}
	renderer := handler.adapter.NewStreamRenderer(canonicalRequest)
	execution := newResponseStream(response, stream, renderer)
	executionErr := handler.executor.Execute(
		request.Context(),
		canonicalRequest,
		execution.Accept,
	)
	if execution.WriteFailed() || execution.Terminal() {
		return
	}
	if errors.Is(request.Context().Err(), context.Canceled) {
		return
	}
	switch {
	case execution.RenderFailed():
		execution.Finish(streamFailure{
			status:  http.StatusBadGateway,
			code:    "invalid_upstream_response",
			message: "Invalid upstream response",
		})
	case executionErr != nil:
		execution.Finish(streamFailure{
			status:  http.StatusServiceUnavailable,
			code:    "upstream_unavailable",
			message: "Inference service is unavailable",
		})
	default:
		execution.Finish(streamFailure{
			status:  http.StatusBadGateway,
			code:    "stream_disconnected",
			message: "Upstream response ended unexpectedly",
		})
	}
}
