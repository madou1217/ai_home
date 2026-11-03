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

	"github.com/madou1217/ai_home/core/inference"
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

	// recordTimeout 限制响应写出后的记账窗口；客户端断开不应连带取消记账。
	recordTimeout = 5 * time.Second
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
	// Fetcher 在流式事件只能带 b64_json 时取回上游图片链接的字节；为 nil 时按 HTTP 自建。
	Fetcher images.ImageFetcher
	// Usage 记录成功生图的 token 用量；为 nil 时不记账（与推理路径同一个用量管道）。
	Usage UsageRecorder
	// Outcomes 记录生图成功（账号页最近成功 + 清 cooldown）；为 nil 时不记录。
	Outcomes ImageOutcomes
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
	fetcher      images.ImageFetcher
	usage        UsageRecorder
	outcomes     ImageOutcomes
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
	fetcher := dependencies.Fetcher
	if fetcher == nil {
		fetcher = images.NewFetcher(dependencies.HTTP)
	}
	return &Handler{
		registry:     dependencies.Registry,
		accounts:     dependencies.Accounts,
		providers:    dependencies.Providers,
		http:         dependencies.HTTP,
		authorizer:   dependencies.Authorizer,
		blobs:        dependencies.Blobs,
		fetcher:      fetcher,
		usage:        dependencies.Usage,
		outcomes:     dependencies.Outcomes,
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
		// 参数值不在网关白名单时可以回落到透传口径：上游才是参数合法性的权威。回落后的请求
		// 只投透传账号；一个都没有时，客户端看到的仍是严格解析的原始错误。
		if !imagegeneration.IsPassthroughCandidateError(parseErr) {
			writeParseError(response, parseErr)
			return
		}
		lenient, lenientErr := imagegeneration.ParsePassthrough(body, path, imagegeneration.Options{})
		if lenientErr != nil {
			writeParseError(response, parseErr)
			return
		}
		parsed = lenient
	}

	provider, providerErr := handler.providers.ResolveProvider(
		request.Context(),
		images.ProviderFromRequest(parsed),
		parsed.Model,
	)
	if providerErr != nil {
		if parseErr != nil {
			// 宽松请求解析不出 Provider：抛回严格解析的原始错误，别让客户端看到 503。
			writeParseError(response, parseErr)
			return
		}
		writeError(response, &images.Error{
			StatusCode: http.StatusServiceUnavailable,
			Code:       "no_available_account",
			Detail:     providerErr.Error(),
		})
		return
	}

	executeOptions := images.ExecuteOptions{HTTP: handler.http}
	if handler.outcomes != nil {
		// 观察者只在换号那一刻被调用：账号是我们自己选的，失败事实也由我们交出去。
		// 记账用不受客户端断开取消的 ctx，且不参与执行结果。
		requestCtx := request.Context()
		executeOptions.AttemptFailure = func(account images.Account, model string, attemptErr error) {
			recordCtx, cancel := context.WithTimeout(context.WithoutCancel(requestCtx), recordTimeout)
			defer cancel()
			handler.outcomes.RecordImageFailure(recordCtx, account.AccountRef, model, attemptErr)
		}
	}
	execution, executeErr := images.Execute(
		request.Context(),
		handler.registry,
		handler.accounts,
		provider,
		parsed,
		executeOptions,
	)
	if executeErr != nil {
		if parseErr != nil && isPassthroughUnavailable(executeErr) {
			// 没有透传账号能承载这条宽松请求：抛回严格解析的原始错误。
			writeParseError(response, parseErr)
			return
		}
		writeError(response, asImageError(executeErr))
		return
	}

	var (
		payload     []byte
		renderErr   error
		contentType = "application/json; charset=utf-8"
	)
	if parsed.Stream {
		// 客户端要流式：完成结果按 OpenAI Images 流式协议发 SSE（见 images.RenderStream）。
		// 事件只能带 b64_json，上游只给链接时在这里补齐字节；失败仍在写头之前。
		streamImages, inlineErr := handler.inlineStreamImages(request.Context(), execution.Result.Images)
		if inlineErr != nil {
			writeError(response, inlineErr)
			return
		}
		payload, renderErr = images.RenderStream(streamImages, execution.Result.Usage, images.StreamOptions{
			Mode:         parsed.Mode,
			Size:         parsed.Size,
			Quality:      parsed.Quality,
			Background:   parsed.Background,
			OutputFormat: parsed.OutputFormat,
			Now:          handler.now,
		})
		contentType = "text/event-stream; charset=utf-8"
	} else if len(execution.Result.PassthroughBody) > 0 {
		// 透传口径直接回上游原体：created / usage / model 与额外字段不在网关这一跳被重新编码掉。
		payload, renderErr = images.RenderPassthrough(execution.Result, images.RenderOptions{
			ResponseFormat: images.ResponseFormat(parsed.ResponseFormat),
			BlobBaseURL:    blobBaseURL(request, handler.blobBaseURL),
			Blobs:          handler.blobs,
		})
	} else {
		payload, renderErr = images.Render(execution.Result.Images, images.RenderOptions{
			ResponseFormat: images.ResponseFormat(parsed.ResponseFormat),
			BlobBaseURL:    blobBaseURL(request, handler.blobBaseURL),
			Blobs:          handler.blobs,
		})
	}
	if renderErr != nil {
		writeError(response, &images.Error{
			StatusCode: http.StatusBadGateway,
			Code:       "invalid_image_output",
			Detail:     "Image response is not renderable",
		})
		return
	}
	if parsed.Stream {
		// SSE 不能被前置反代（本项目 webui/nginx 场景）整段缓冲，也不能被缓存。
		response.Header().Set("Cache-Control", "no-cache")
		response.Header().Set("X-Accel-Buffering", "no")
		response.Header().Set("Connection", "keep-alive")
	} else {
		response.Header().Set("Cache-Control", "no-store")
	}
	response.Header().Set("Content-Type", contentType)
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("x-aih-server-provider", execution.Provider)
	response.Header().Set("x-aih-server-account-ref", execution.Account.AccountRef)
	if execution.Account.Email != "" {
		response.Header().Set("x-aih-server-account-email", execution.Account.Email)
	}
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(payload)
	// 响应已发出：记账与结果统计共用一份不被客户端断开取消的 ctx。
	recordCtx, cancel := context.WithTimeout(context.WithoutCancel(request.Context()), recordTimeout)
	defer cancel()
	handler.recordUsage(recordCtx, execution, parsed.Model)
	handler.recordOutcome(recordCtx, execution, parsed.Model)
}

// UsageRecorder 记录一次成功生图的 token 用量。
//
// 生图同样消耗 token（Gemini 的 image 输出、OpenAI 的 image tokens），不记账的话账号页与
// 用量账本会把这条路径当零消耗。
type UsageRecorder interface {
	RecordImageUsage(
		ctx context.Context,
		accountRef string,
		model string,
		usage inference.Usage,
		at time.Time,
	)
}

// ImageOutcomes 记录生图结果，语义等价于 Node 的 markProxyAccountSuccess /
// markProxyAccountFailure。
//
// 生图是账号真实可用的一次证明：记下来既让账号页状态条有最近成功时间，也让运行态清掉
// 该 (账号, 模型) 的 cooldown，避免上一次失败把可用账号一直挡在调度之外。
//
// 失败同样要记：上游只回「这次请求失败了」，它不知道我们用的是哪把凭据；失败账号是
// 编排层自己选的（见 images.Execute 的 AttemptFailure 观察者）。不记的话坏账号在 Go
// 的生图链上永远「健康」，每个请求都要先赔一次换号。
type ImageOutcomes interface {
	RecordImageSuccess(
		ctx context.Context,
		accountRef string,
		model string,
		at time.Time,
	)
	RecordImageFailure(
		ctx context.Context,
		accountRef string,
		model string,
		cause error,
	)
}

// recordUsage 把成功生图的 token 用量交给宿主记账。
//
// 上游没给可用用量时跳过，不伪造 0；记账失败只影响用量统计，绝不影响已经发出的响应。
func (handler *Handler) recordUsage(
	ctx context.Context,
	execution images.Execution,
	model string,
) {
	if handler.usage == nil {
		return
	}
	counts, found := execution.Result.UsageTokens()
	if !found {
		return
	}
	usage, usageErr := inference.NewUsage(inference.UsageInput{
		InputTokens:       counts.InputTokens,
		OutputTokens:      counts.OutputTokens,
		CachedInputTokens: counts.CachedTokens,
		ReasoningTokens:   counts.ReasoningTokens,
	})
	if usageErr != nil {
		// 上游自相矛盾（子集大于总数）：退回只记输入输出，别整条丢掉。
		usage, usageErr = inference.NewUsage(inference.UsageInput{
			InputTokens:  counts.InputTokens,
			OutputTokens: counts.OutputTokens,
		})
	}
	if usageErr != nil || usage.TotalTokens() == 0 {
		return
	}
	handler.usage.RecordImageUsage(
		ctx,
		execution.Account.AccountRef,
		model,
		usage,
		time.Now(),
	)
}

// recordOutcome 把生图成功记给账号运行态；失败只影响统计，不影响已发出的响应。
func (handler *Handler) recordOutcome(
	ctx context.Context,
	execution images.Execution,
	model string,
) {
	if handler.outcomes == nil {
		return
	}
	handler.outcomes.RecordImageSuccess(ctx, execution.Account.AccountRef, model, time.Now())
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
// inlineStreamImages 保证每个流式事件都能带 b64_json。
//
// 与策略层的同源回取分工不同：这里不携带任何账号凭据，因此禁私网。取回发生在图已经生成之后，
// 失败既不能换号也不能重生成，直接回给客户端（此时还没写任何字节）。
func (handler *Handler) inlineStreamImages(
	ctx context.Context,
	generated []images.GeneratedImage,
) ([]images.GeneratedImage, *images.Error) {
	resolved := make([]images.GeneratedImage, len(generated))
	copy(resolved, generated)
	for index := range resolved {
		image := &resolved[index]
		if image.B64JSON != "" || len(image.Rehosted) > 0 || image.URL == "" {
			continue
		}
		if handler.fetcher == nil {
			return nil, &images.Error{
				StatusCode: http.StatusBadGateway,
				Code:       "image_output_unavailable",
				Detail:     "streaming requires inline image bytes",
			}
		}
		fetched, fetchErr := handler.fetcher.Fetch(ctx, image.URL, images.FetchOptions{})
		if fetchErr != nil {
			if generationErr, ok := images.AsError(fetchErr); ok {
				return nil, generationErr
			}
			return nil, &images.Error{
				StatusCode: http.StatusBadGateway,
				Code:       "image_fetch_failed",
				Detail:     "upstream image url is not fetchable",
			}
		}
		image.Rehosted = fetched.Bytes
		image.MIME = string(fetched.MIME)
	}
	return resolved, nil
}

// isPassthroughUnavailable 判断失败是否只是「没有透传账号」，而不是上游真的出错。
func isPassthroughUnavailable(err error) bool {
	generationErr, ok := images.AsError(err)
	return ok && generationErr.Code == "passthrough_account_unavailable"
}

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
