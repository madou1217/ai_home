// Package imagesapi 提供 OpenAI 兼容图片接口的 HTTP 入站适配器。
//
// 它对应 Node 的 image-generations-endpoint.js：负责入口校验、请求归一、Provider 解析、
// 账号编排调用与响应渲染，本身不拥有任何上游线协议翻译。
package imagesapi

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/imagegeneration"
	"github.com/madou1217/ai_home/internal/adapters/images"
)

const (
	// GenerationsPath 是图片生成入口。
	GenerationsPath = "/v1/images/generations"
	// EditsPath 是图片编辑入口。
	EditsPath = "/v1/images/edits"

	// DefaultMaxBodyBytes 覆盖多图编辑，同时保持明确内存上限。
	DefaultMaxBodyBytes int64 = 32 * 1024 * 1024
	// MaxBodyBytesLimit 防止 Composition Root 意外关闭请求体边界。
	MaxBodyBytesLimit int64 = 256 * 1024 * 1024
)

var (
	// ErrInvalidDependencies 表示 Handler 缺少编排端口或鉴权策略。
	ErrInvalidDependencies = errors.New("图片 HTTP Handler 依赖无效")
)

// Authorizer 是图片请求使用的客户端鉴权策略。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// ProviderResolver 把请求解析为可服务它的 Provider。
//
// 空 Provider 表示请求没有显式声明，调用方需要按模型解析。
type ProviderResolver interface {
	// ResolveProvider 返回服务该模型的 Provider；找不到时返回错误。
	ResolveProvider(
		ctx context.Context,
		provider string,
		model string,
	) (string, error)
}

// Dependencies 集中声明图片 HTTP 入站适配器依赖。
type Dependencies struct {
	// Registry 提供按 (Provider, 账号) 解析的图片策略。
	Registry images.Registry
	// Accounts 提供候选账号。
	Accounts images.AccountSource
	// Providers 把请求解析为 Provider。
	Providers ProviderResolver
	// HTTP 是执行上游调用的客户端；为 nil 时使用 http.DefaultClient。
	HTTP images.HTTPDoer
	// Authorizer 在读取请求体前校验客户端凭据。
	Authorizer Authorizer
	// Blobs 在 response_format=url 时接收生成的图片。
	Blobs images.BlobWriter
	// BlobBaseURL 是请求没有 Host 头时使用的 blob URL 兜底前缀。
	BlobBaseURL string
	// MaxBodyBytes 是单请求允许读取的最大字节数。
	MaxBodyBytes int64
	// Now 提供响应时间；为 nil 时使用 time.Now。
	Now func() time.Time
}

// Handler 负责入口校验、请求归一、编排调用与响应渲染。
type Handler struct {
	registry     images.Registry
	accounts     images.AccountSource
	providers    ProviderResolver
	http         images.HTTPDoer
	authorizer   Authorizer
	blobs        images.BlobWriter
	blobBaseURL  string
	maxBodyBytes int64
	now          func() time.Time
}

// NewHandler 创建默认失败关闭的图片 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Accounts == nil ||
		dependencies.Providers == nil ||
		dependencies.Authorizer == nil {
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
		registry:     dependencies.Registry,
		accounts:     dependencies.Accounts,
		providers:    dependencies.Providers,
		http:         dependencies.HTTP,
		authorizer:   dependencies.Authorizer,
		blobs:        dependencies.Blobs,
		blobBaseURL:  strings.TrimRight(strings.TrimSpace(dependencies.BlobBaseURL), "/"),
		maxBodyBytes: maxBodyBytes,
		now:          dependencies.Now,
	}, nil
}

// ServeHTTP 按鉴权、路径、方法、媒体类型和请求体的顺序失败关闭。
func (handler *Handler) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	if handler == nil ||
		handler.authorizer == nil ||
		!handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, &images.Error{
			StatusCode: http.StatusUnauthorized,
			Code:       "invalid_api_key",
			Detail:     "Invalid API key",
		})
		return
	}
	path := request.URL.Path
	if path != GenerationsPath && path != EditsPath {
		writeError(response, &images.Error{
			StatusCode: http.StatusNotFound,
			Code:       "not_found",
			Detail:     "Resource not found",
		})
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, &images.Error{
			StatusCode: http.StatusMethodNotAllowed,
			Code:       "method_not_allowed",
			Detail:     "Method not allowed",
		})
		return
	}

	// 与其它推理入口一致：x-account-ref 把请求钉到指定账号（agy relay soak：生图曾被改派）。
	ctx, pinErr := inferenceapi.ContextWithPinnedAccount(request)
	if pinErr != nil {
		writeError(response, &images.Error{
			StatusCode: http.StatusBadRequest,
			Code:       "invalid_account_ref",
			Detail:     "Invalid account reference",
		})
		return
	}
	request = request.WithContext(ctx)

	body, err := handler.readBody(request)
	if err != nil {
		writeError(response, err)
		return
	}
	parsed, parseErr := imagegeneration.Parse(body, path, imagegeneration.Options{})
	if parseErr != nil {
		writeParseError(response, parseErr)
		return
	}

	provider, providerErr := handler.providers.ResolveProvider(
		request.Context(),
		images.ProviderFromRequest(parsed),
		parsed.Model,
	)
	if providerErr != nil {
		writeError(response, &images.Error{
			StatusCode: http.StatusServiceUnavailable,
			Code:       "no_available_account",
			Detail:     providerErr.Error(),
		})
		return
	}

	execution, executeErr := images.Execute(
		request.Context(),
		handler.registry,
		handler.accounts,
		provider,
		parsed,
		images.ExecuteOptions{HTTP: handler.http},
	)
	if executeErr != nil {
		writeError(response, asImageError(executeErr))
		return
	}

	rendered, renderErr := images.Render(execution.Result.Images, images.RenderOptions{
		ResponseFormat: images.ResponseFormat(parsed.ResponseFormat),
		BlobBaseURL:    blobBaseURL(request, handler.blobBaseURL),
		Blobs:          handler.blobs,
	})
	if renderErr != nil {
		writeError(response, &images.Error{
			StatusCode: http.StatusBadGateway,
			Code:       "invalid_image_output",
			Detail:     "Image response is not renderable",
		})
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("x-aih-server-provider", execution.Provider)
	response.Header().Set("x-aih-server-account-ref", execution.Account.AccountRef)
	if execution.Account.Email != "" {
		response.Header().Set("x-aih-server-account-email", execution.Account.Email)
	}
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(rendered)
}

// blobBaseURL 返回客户端可达的 blob URL 前缀。
//
// 优先复用客户端实际使用的 Host 头：网关可能被多个地址访问（127.0.0.1、局域网 IP、
// 反向代理域名），写死监听地址会给出客户端取不到的 URL。没有 Host 时回退到配置值。
func blobBaseURL(request *http.Request, fallback string) string {
	// 经 Node 宿主转发时 Host 是 Go 的私有端点；宿主用 X-Forwarded-Host 告知客户端实际访问的地址
	// （宿主总是覆盖客户端自带的值，Go 私有端点只接受宿主持有的 Client Key）。
	host := strings.TrimSpace(request.Header.Get("X-Forwarded-Host"))
	if host == "" || strings.ContainsAny(host, "/\\ \t\r\n,") {
		host = strings.TrimSpace(request.Host)
	}
	if host == "" {
		return strings.TrimRight(strings.TrimSpace(fallback), "/")
	}
	return "http://" + host
}

// readBody 读取并归一请求体：JSON 直接返回，multipart 归一成同构 JSON。
func (handler *Handler) readBody(request *http.Request) ([]byte, *images.Error) {
	if IsMultipart(request.Header.Get("Content-Type")) {
		return normalizeMultipartBody(request, handler.maxBodyBytes)
	}
	if request.Body == nil {
		return []byte("{}"), nil
	}
	// 显式上限：图片请求会内联大体积 base64，不能无界读取。
	limited := io.LimitReader(request.Body, handler.maxBodyBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, &images.Error{
			StatusCode: http.StatusBadRequest,
			Code:       "invalid_request_body",
			Detail:     "Request body is not readable",
		}
	}
	if int64(len(body)) > handler.maxBodyBytes {
		return nil, &images.Error{
			StatusCode: http.StatusRequestEntityTooLarge,
			Code:       "request_too_large",
			Detail:     "Request body too large",
		}
	}
	return body, nil
}

// writeParseError 把请求解析错误映射为 OpenAI 错误 envelope。
func writeParseError(response http.ResponseWriter, err error) {
	if requestErr, ok := imagegeneration.AsError(err); ok {
		writeError(response, &images.Error{
			StatusCode: requestErr.StatusCode,
			Code:       requestErr.Code,
			Detail:     requestErr.Detail,
		})
		return
	}
	writeError(response, &images.Error{
		StatusCode: http.StatusBadRequest,
		Code:       "invalid_request_body",
		Detail:     "Request body is not valid",
	})
}

// asImageError 把任意 error 归一为本包错误。
func asImageError(err error) *images.Error {
	if generationErr, ok := images.AsError(err); ok {
		return generationErr
	}
	return &images.Error{
		StatusCode: http.StatusBadGateway,
		Code:       "upstream_failed",
		Detail:     "Image generation failed",
	}
}

// openAIErrorEnvelope 是 OpenAI 图片接口的错误响应体。
type openAIErrorEnvelope struct {
	Error openAIErrorDetail `json:"error"`
}

// openAIErrorDetail 是错误明细。
type openAIErrorDetail struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    string `json:"code"`
}

// writeError 写入禁止缓存的 OpenAI 风格错误。
func writeError(response http.ResponseWriter, err *images.Error) {
	status := err.StatusCode
	if status < 400 || status > 599 {
		status = http.StatusBadGateway
	}
	errorType := "invalid_request_error"
	if status >= 500 {
		errorType = "server_error"
	}
	code := strings.TrimSpace(err.Code)
	if code == "" {
		code = "upstream_failed"
	}
	detail := strings.TrimSpace(err.Detail)
	if detail == "" {
		detail = "Image generation failed"
	}
	encoded, marshalErr := json.Marshal(openAIErrorEnvelope{
		Error: openAIErrorDetail{
			Message: detail,
			Type:    errorType,
			Code:    code,
		},
	})
	if marshalErr != nil {
		http.Error(response, "internal error", http.StatusInternalServerError)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_, _ = response.Write(encoded)
}
