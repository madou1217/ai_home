// Package geminiapi 提供 Gemini generateContent 的 HTTP 入站适配器。
//
// 与其它协议入口的关键差异：模型名在 URL 路径里，因此本包负责从
// `/v1{beta?}/models/{model}:generateContent` 解析模型与流式意图，再把它们交给
// Gemini 协议 Adapter。
package geminiapi

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/gemini"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

const (
	// PathPrefix 是稳定版 Gemini 入口前缀。
	PathPrefix = "/v1/models/"
	// BetaPathPrefix 是 beta 版 Gemini 入口前缀。
	BetaPathPrefix = "/v1beta/models/"
	// GenerateContentSuffix 是单次响应入口后缀。
	GenerateContentSuffix = ":generateContent"
	// StreamGenerateContentSuffix 是流式响应入口后缀。
	StreamGenerateContentSuffix = ":streamGenerateContent"

	// DefaultMaxBodyBytes 覆盖常规内联图片请求，同时保持明确内存上限。
	DefaultMaxBodyBytes int64 = 32 * 1024 * 1024
	// MaxBodyBytesLimit 防止 Composition Root 意外关闭请求体边界。
	MaxBodyBytesLimit int64 = 256 * 1024 * 1024
)

var (
	// ErrInvalidDependencies 表示 Handler 缺少 Adapter、执行器或鉴权策略。
	ErrInvalidDependencies = errors.New("Gemini generateContent HTTP Handler 依赖无效")
	// ErrStreamingUnsupported 表示 ResponseWriter 不能即时刷新 SSE。
	ErrStreamingUnsupported = inferenceapi.ErrStreamingUnsupported
)

// Authorizer 是 generateContent 请求使用的客户端鉴权策略。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 集中声明 generateContent HTTP 入站适配器依赖。
type Dependencies struct {
	// Adapter 提供 Gemini 请求解码与两种响应渲染器。
	Adapter gemini.Adapter
	// Executor 执行与客户端协议解耦的 Canonical 请求。
	Executor inferencegateway.Executor
	// Authorizer 在读取请求体前校验客户端凭据。
	Authorizer Authorizer
	// MaxBodyBytes 是单请求允许读取的最大字节数。
	MaxBodyBytes int64
}

// Handler 负责鉴权、路径解析、请求解码、Canonical 执行和 Gemini 输出渲染。
type Handler struct {
	adapter      gemini.Adapter
	executor     inferencegateway.Executor
	authorizer   Authorizer
	maxBodyBytes int64
}

// NewHandler 创建默认失败关闭的 generateContent Handler。
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
	return &Handler{
		adapter:      dependencies.Adapter,
		executor:     dependencies.Executor,
		authorizer:   dependencies.Authorizer,
		maxBodyBytes: maxBodyBytes,
	}, nil
}

// Target 是一次 generateContent 路径解析的结果。
type Target struct {
	// Model 是路径中声明的模型名。
	Model string
	// Stream 表示走 :streamGenerateContent 入口。
	Stream bool
}

// ParseTarget 从请求路径解析模型与流式意图。
//
// 只有恰好落在 `{prefix}{model}:{method}` 形态上才算命中，因此
// `/v1/models/{id}` 这类单模型查询不会被误吞。
func ParseTarget(path string) (Target, bool) {
	for _, prefix := range []string{PathPrefix, BetaPathPrefix} {
		if !strings.HasPrefix(path, prefix) {
			continue
		}
		remainder := path[len(prefix):]
		suffix := ""
		switch {
		case strings.HasSuffix(remainder, StreamGenerateContentSuffix):
			suffix = StreamGenerateContentSuffix
		case strings.HasSuffix(remainder, GenerateContentSuffix):
			suffix = GenerateContentSuffix
		default:
			return Target{}, false
		}
		rawModel := strings.TrimSuffix(remainder, suffix)
		if rawModel == "" || strings.Contains(rawModel, "/") {
			return Target{}, false
		}
		decoded, err := url.PathUnescape(rawModel)
		if err != nil {
			return Target{}, false
		}
		model := strings.TrimSpace(decoded)
		if model == "" {
			return Target{}, false
		}
		return Target{
			Model:  model,
			Stream: suffix == StreamGenerateContentSuffix,
		}, true
	}
	return Target{}, false
}

// ServeHTTP 按鉴权、路径、方法、请求体的顺序失败关闭。
func (handler *Handler) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	if handler == nil ||
		handler.authorizer == nil ||
		!handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "UNAUTHENTICATED", "Invalid client key")
		return
	}
	target, ok := ParseTarget(request.URL.Path)
	if !ok {
		writeError(response, http.StatusNotFound, "NOT_FOUND", "Resource not found")
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "FAILED_PRECONDITION", "Method not allowed")
		return
	}
	ctx, err := inferenceapi.ContextWithPinnedAccount(request)
	if err != nil {
		writeError(response, http.StatusBadRequest, "INVALID_ARGUMENT", "Invalid account reference")
		return
	}
	request = request.WithContext(ctx)

	body, err := inferenceapi.ReadJSONBody(response, request, handler.maxBodyBytes)
	if err != nil {
		writeRequestError(response, err)
		return
	}
	exchange, err := handler.adapter.BindWithModel(target.Model, body, target.Stream)
	if err != nil {
		writeDecodeError(response, err)
		return
	}
	canonicalRequest := exchange.CanonicalRequest()
	if canonicalRequest.Stream() {
		handler.executeStream(
			response,
			request,
			canonicalRequest,
			exchange.NewStreamRenderer(),
		)
		return
	}
	handler.executeNonStream(
		response,
		request,
		canonicalRequest,
		exchange.NewResponseAggregator(),
	)
}

// executeNonStream 聚合完整 Canonical 事件流后一次写入 JSON。
func (handler *Handler) executeNonStream(
	response http.ResponseWriter,
	request *http.Request,
	canonicalRequest inference.Request,
	aggregator clientprotocol.ResponseAggregator,
) {
	sink := inferenceapi.NewNonStreamSink(aggregator)
	executionErr := handler.executor.Execute(
		request.Context(),
		canonicalRequest,
		sink.Accept,
	)
	failure, failed := sink.Failure()
	switch {
	case sink.Err() != nil:
		writeError(
			response,
			http.StatusBadGateway,
			"INTERNAL",
			"Invalid upstream response",
		)
	case executionErr != nil:
		writeExecutionError(response, request.Context())
	case failed:
		writeCanonicalFailure(response, failure)
	default:
		data, err := aggregator.Marshal()
		if err != nil {
			writeError(
				response,
				http.StatusBadGateway,
				"INTERNAL",
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
	renderer clientprotocol.StreamRenderer,
) {
	stream, err := inferenceapi.NewSSEStream(response)
	if err != nil {
		writeError(
			response,
			http.StatusInternalServerError,
			"INTERNAL",
			"Streaming is unavailable",
		)
		return
	}
	execution := newResponseStream(response, stream, renderer)
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
	if errors.Is(request.Context().Err(), context.Canceled) {
		return
	}
	switch {
	case execution.RenderFailed():
		execution.Finish(streamFailure{
			status:  http.StatusBadGateway,
			code:    "INTERNAL",
			message: "Invalid upstream response",
		})
	case executionErr != nil:
		execution.Finish(streamFailure{
			status:  http.StatusServiceUnavailable,
			code:    "UNAVAILABLE",
			message: "Inference service is unavailable",
		})
	default:
		execution.Finish(streamFailure{
			status:  http.StatusBadGateway,
			code:    "INTERNAL",
			message: "Upstream response ended unexpectedly",
		})
	}
}
