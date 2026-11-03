package images

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	agycodeassist "github.com/madou1217/ai_home/internal/adapters/agy/codeassist"
	"github.com/madou1217/ai_home/internal/adapters/imagedata"
	"github.com/madou1217/ai_home/internal/adapters/imagegeneration"
)

// 本文件承载三个上游策略：codex 原生 Images API、agy/gemini Code Assist，以及
// api-key 账号的 OpenAI 兼容 passthrough，另加显式 unsupported。
// 它们对应 Node 的 image-generation-codex.js、image-generation-agy-gemini.js、
// image-generation-passthrough.js 与 image-generation-unsupported.js。

// ChatGPTCodexBaseURL 是 Codex OAuth 账号的默认上游前缀。
//
// 与 internal/adapters/codex/responses 的 chatGPTCodexBaseURL 同源：Codex 的图片扩展
// 挂在同一个 backend-api codex 前缀下（`/images/generations`、`/images/edits`）。
const ChatGPTCodexBaseURL = "https://chatgpt.com/backend-api/codex"

// codexImageModel 是 codex 原生图片策略唯一支持的模型。
const codexImageModel = "gpt-image-2"

// upstreamTimeoutMS 是图片上游的最小超时；图片生成远慢于对话。
const upstreamTimeoutMS = 120000

// upstreamTimeout 返回图片上游的最小超时。
func upstreamTimeout() time.Duration {
	return time.Duration(upstreamTimeoutMS) * time.Millisecond
}

// upstreamTimeoutError 把超时映射成 504：既让客户端看得出是超时，也让换号逻辑按 >=500 处理。
func upstreamTimeoutError(action string) *Error {
	return newError(
		504,
		"upstream_timeout",
		action+" within "+strconv.Itoa(upstreamTimeoutMS)+" ms",
	)
}

// maxUpstreamBodyBytes 是上游响应体上限，避免无界读取。
const maxUpstreamBodyBytes int64 = 64 * 1024 * 1024

// UnsupportedStrategy 对没有图片能力的 Provider 返回显式 400。
//
// 保留为策略而不是在编排层分支，保证所有 Provider 走同一条分派路径。
type UnsupportedStrategy struct {
	providerName string
}

// NewUnsupportedStrategy 创建显式不支持的策略。
func NewUnsupportedStrategy(provider string) UnsupportedStrategy {
	normalized := normalizeProvider(provider)
	if normalized == "" {
		normalized = "unknown"
	}
	return UnsupportedStrategy{providerName: normalized}
}

// Provider 返回该策略代表的 Provider。
func (strategy UnsupportedStrategy) Provider() string { return strategy.providerName }

// Kind 返回 unsupported 能力族。
func (UnsupportedStrategy) Kind() string { return "unsupported" }

// Capabilities 返回空能力集合。
func (UnsupportedStrategy) Capabilities(string) Capabilities { return Capabilities{} }

// SupportsModel 永远返回 false：没有图片能力的 Provider 不支持任何图片模型。
func (UnsupportedStrategy) SupportsModel(string) bool { return false }

// Generate 返回显式 400。
func (strategy UnsupportedStrategy) Generate(
	context.Context,
	Input,
) (Result, error) {
	return Result{}, newError(
		400,
		"unsupported_image_provider",
		"provider "+strategy.providerName+" has no image generation support",
	)
}

// CodexStrategy 是 Codex OAuth 账号的原生图片策略。
type CodexStrategy struct {
	baseURL string
}

// NewCodexStrategy 创建 codex 图片策略；baseURL 为空时使用官方前缀。
func NewCodexStrategy(baseURL string) CodexStrategy {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmed == "" {
		trimmed = ChatGPTCodexBaseURL
	}
	return CodexStrategy{baseURL: trimmed}
}

// Provider 返回 codex。
func (CodexStrategy) Provider() string { return "codex" }

// Kind 返回 native 能力族。
func (CodexStrategy) Kind() string { return "native" }

// Capabilities 返回 codex 在指定模型上的能力。
func (CodexStrategy) Capabilities(modelID string) Capabilities {
	capabilities, _ := NativeCapabilities("codex", modelID)
	return capabilities
}

// SupportsModel 只接受 codex 的专用图片模型。
func (CodexStrategy) SupportsModel(modelID string) bool {
	return strings.ToLower(strings.TrimSpace(modelID)) == codexImageModel
}

// codexImagePayload 是 codex Images API 的请求体。
type codexImagePayload struct {
	Prompt     string                `json:"prompt"`
	Background string                `json:"background"`
	Model      string                `json:"model"`
	N          int                   `json:"n,omitempty"`
	Quality    string                `json:"quality"`
	Size       string                `json:"size"`
	Images     []codexImageReference `json:"images,omitempty"`
}

// codexImageReference 是编辑请求的输入图片引用。
type codexImageReference struct {
	ImageURL string `json:"image_url"`
}

// Generate 向 codex Images API 发起一次生成或编辑。
func (strategy CodexStrategy) Generate(
	ctx context.Context,
	input Input,
) (Result, error) {
	if input.HTTP == nil {
		return Result{}, newError(500, "codex_transport_unavailable", "codex transport is not configured")
	}
	accessToken := strings.TrimSpace(input.Account.AccessToken)
	if accessToken == "" {
		return Result{}, newError(400, "invalid_access_token", "codex account has no usable access token")
	}
	if strategy.baseURL == "" {
		return Result{}, newError(502, "infinite_loop_detected", "codex upstream base url is not usable")
	}
	if input.Mode == imagegeneration.ModeEdit && len(input.Images) < 1 {
		return Result{}, newError(400, "image_required", "image is required for image edits")
	}

	payload := codexImagePayload{
		Prompt:     strings.TrimSpace(input.Prompt),
		Background: valueOr(input.Background, "auto"),
		Model:      codexImageModel,
		Quality:    valueOr(input.Quality, "auto"),
		Size:       valueOr(input.Size, "auto"),
	}
	if input.N > 1 {
		payload.N = input.N
	}
	if input.Mode == imagegeneration.ModeEdit {
		payload.Images = make([]codexImageReference, 0, len(input.Images))
		for _, image := range input.Images {
			payload.Images = append(payload.Images, codexImageReference{
				ImageURL: "data:" + string(image.MIME) + ";base64," + image.Data,
			})
		}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return Result{}, newError(500, "codex_transport_unavailable", "codex payload is not encodable")
	}

	url := strategy.baseURL + "/images/" + imageSuffix(input.Mode)
	// 必须用新变量接收：上面的 json.Marshal 已经把 err 声明为 error，若在这里复用，
	// sendUpstream 返回的 nil *Error 会被装箱成非 nil 的 error，成功也会被当成失败。
	response, sendErr := sendUpstream(ctx, input.HTTP, url, func(request *http.Request) {
		request.Header.Set("Authorization", "Bearer "+accessToken)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "application/json")
		request.Header.Set("originator", "codex_cli_rs")
		if input.Account.AccountRef != "" {
			request.Header.Set("x-aih-account-ref", input.Account.AccountRef)
		}
		if input.Account.Email != "" {
			request.Header.Set("x-aih-account-email", input.Account.Email)
		}
		if input.Account.UpstreamAccountID != "" {
			request.Header.Set("chatgpt-account-id", input.Account.UpstreamAccountID)
		}
	}, body)
	if sendErr != nil {
		return Result{}, sendErr
	}
	return parseOpenAIImagesResponse(response)
}

// AgyStrategy 是 agy OAuth 账号的原生图片策略，走 Code Assist generateContent。
type AgyStrategy struct {
	// Endpoint 是 Code Assist generateContent 的完整地址。
	Endpoint string
}

// Provider 返回 agy。
func (AgyStrategy) Provider() string { return "agy" }

// Kind 返回 native 能力族。
func (AgyStrategy) Kind() string { return "native" }

// Capabilities 返回 agy 在指定模型上的能力。
func (strategy AgyStrategy) Capabilities(modelID string) Capabilities {
	capabilities, _ := NativeCapabilities(strategy.Provider(), modelID)
	return capabilities
}

// SupportsModel 接受 agy 声明的 Gemini 图片模型。
func (strategy AgyStrategy) SupportsModel(modelID string) bool {
	normalized := strings.ToLower(strings.TrimSpace(modelID))
	if normalized == "" {
		return false
	}
	for _, declared := range NativeImageModels(strategy.Provider()) {
		if strings.ToLower(declared) == normalized {
			return true
		}
	}
	return false
}

// imageSizeAspectRatios 把 OpenAI 尺寸映射到 Gemini 的原生宽高比。
//
// 只做映射，不做缩放：像素尺寸保持上游原生。
var imageSizeAspectRatios = map[string]string{
	"1024x1024": "1:1",
	"1536x1024": "3:2",
	"1024x1536": "2:3",
	"1792x1024": "16:9",
	"1024x1792": "9:16",
	"1408x1056": "4:3",
	"1056x1408": "3:4",
}

// Generate 通过 Code Assist generateContent 生成图片。
func (strategy AgyStrategy) Generate(
	ctx context.Context,
	input Input,
) (Result, error) {
	if input.HTTP == nil || strategy.Endpoint == "" {
		return Result{}, newError(500, "agy_transport_unavailable", "agy gemini transport is not configured")
	}
	accessToken := strings.TrimSpace(input.Account.AccessToken)
	if accessToken == "" {
		return Result{}, newError(400, "invalid_access_token", "agy account has no usable access token")
	}

	imageConfig, configErr := buildGeminiImageConfig(input.Size)
	if configErr != nil {
		return Result{}, configErr
	}
	parts := []map[string]any{{"text": input.Prompt}}
	if input.Mode == imagegeneration.ModeEdit {
		if len(input.Images) < 1 {
			return Result{}, newError(400, "image_required", "image is required for image edits")
		}
		for _, image := range input.Images {
			parts = append(parts, map[string]any{
				"inlineData": map[string]any{
					"mimeType": string(image.MIME),
					"data":     image.Data,
				},
			})
		}
	}
	generationConfig := map[string]any{
		"responseModalities": []string{"TEXT", "IMAGE"},
	}
	if imageConfig != nil {
		generationConfig["imageConfig"] = imageConfig
	}
	// Code Assist 只接受 antigravity agent 信封（需先查询账号 project），与推理路径共用同一实现。
	// 这次 project 查询也是上游调用：没有 deadline 会无限挂起，同样按图片上游时限收敛。
	prepareCtx, cancelPrepare := context.WithTimeout(ctx, upstreamTimeout())
	defer cancelPrepare()
	requestBody, applyHeaders, prepareErr := agycodeassist.PrepareImageGenerateContent(
		prepareCtx,
		input.HTTP,
		accessToken,
		input.Model,
		map[string]any{
			"contents":         []map[string]any{{"role": "user", "parts": parts}},
			"generationConfig": generationConfig,
		},
	)
	if prepareErr != nil {
		if errors.Is(prepareCtx.Err(), context.DeadlineExceeded) {
			return Result{}, upstreamTimeoutError("agy code assist project lookup did not finish")
		}
		return Result{}, newError(502, "upstream_failed", "agy code assist project is unavailable")
	}

	// 同 codex：不要复用上面已声明为 error 的 err。
	response, sendErr := sendUpstream(ctx, input.HTTP, strategy.Endpoint, func(request *http.Request) {
		applyHeaders(request)
		if input.Account.AccountRef != "" {
			request.Header.Set("x-aih-account-ref", input.Account.AccountRef)
		}
	}, requestBody)
	if sendErr != nil {
		return Result{}, sendErr
	}
	return parseGeminiImageResponse(response)
}

// buildGeminiImageConfig 把 OpenAI 尺寸映射为 Gemini imageConfig。
func buildGeminiImageConfig(size string) (map[string]any, *Error) {
	if size == "" || size == "auto" {
		return nil, nil
	}
	aspectRatio, found := imageSizeAspectRatios[size]
	if !found {
		return nil, newError(
			400,
			"unsupported_image_size",
			"gemini image size must be auto or one of 1024x1024, 1536x1024, "+
				"1024x1536, 1792x1024, 1024x1792, 1408x1056, 1056x1408",
		)
	}
	return map[string]any{"aspectRatio": aspectRatio, "imageSize": "1K"}, nil
}

// PassthroughStrategy 把 api-key 账号的请求原样转发到 OpenAI 兼容上游。
type PassthroughStrategy struct {
	// Fetcher 取回落在账号上游自己源上的图片链接：客户端只有网关密钥，打不开上游的鉴权链接。
	Fetcher ImageFetcher
}

// Provider 返回 passthrough。
func (PassthroughStrategy) Provider() string { return "passthrough" }

// Kind 返回 passthrough 能力族。
func (PassthroughStrategy) Kind() string { return "passthrough" }

// Capabilities 返回 passthrough 的能力集合。
func (PassthroughStrategy) Capabilities(modelID string) Capabilities {
	capabilities, _ := NativeCapabilities("passthrough", modelID)
	return capabilities
}

// SupportsModel 永远返回 true：上游端点才是模型的权威。
func (PassthroughStrategy) SupportsModel(string) bool { return true }

// Generate 把请求转发到上游的 /v1/images/{generations|edits}。
func (strategy PassthroughStrategy) Generate(
	ctx context.Context,
	input Input,
) (Result, error) {
	if input.HTTP == nil {
		return Result{}, newError(500, "passthrough_transport_unavailable", "image API transport is not configured")
	}
	apiKey := strings.TrimSpace(input.Account.APIKey)
	if apiKey == "" {
		return Result{}, newError(400, "invalid_access_token", "api-key account has no usable key")
	}
	base := strings.TrimRight(strings.TrimSpace(input.Account.BaseURL), "/")
	if base == "" {
		return Result{}, newError(400, "account_base_url_missing", "api-key account has no base url")
	}
	url := base + imageUpstreamPath(input.Account.Provider, input.Mode)

	fields := passthroughRequestFields(input)
	var body []byte
	contentType := "application/json"
	// 图片引用解不出字节（http 链接、file_id）时只能按 JSON 转发：multipart 里没有文件可放。
	if input.Mode == imagegeneration.ModeEdit && !input.JSONOnly {
		multipartBody, boundary, err := buildUpstreamMultipart(input, fields)
		if err != nil {
			return Result{}, err
		}
		body = multipartBody
		contentType = "multipart/form-data; boundary=" + boundary
	} else {
		encoded, err := json.Marshal(fields)
		if err != nil {
			return Result{}, newError(500, "passthrough_transport_unavailable", "payload is not encodable")
		}
		body = encoded
	}

	// 同 codex：sendUpstream 返回 *Error，必须用新变量接收，否则 nil 会被装箱成非 nil error。
	// 上游一律当作标准 OpenAI 兼容端点：只带标准鉴权，不带本端账号标识（没有上游消费它，
	// 对第三方上游还会泄露本地账号邮箱；与 Node 的 image-generation-api-transport 一致）。
	response, sendErr := sendUpstream(ctx, input.HTTP, url, func(request *http.Request) {
		request.Header.Set("Authorization", "Bearer "+apiKey)
		request.Header.Set("Accept", "application/json")
		request.Header.Set("Content-Type", contentType)
	}, body)
	if sendErr != nil {
		// 上游根本没有图片端点（404/405/501）：这不是请求写错，而是这个账号的上游不提供生图。
		// 与 Node 的 image_endpoint_unavailable 同义 —— 换号重试，只给这个（账号,模型）记一次短冷却。
		if generationErr, ok := AsError(sendErr); ok && imageEndpointMissing(generationErr.StatusCode) {
			generationErr.Code = "image_endpoint_unavailable"
		}
		return Result{}, sendErr
	}
	result, parseErr := parseOpenAIImagesResponse(response)
	if parseErr != nil {
		return Result{}, parseErr
	}
	// 透传口径把上游原体也带上：非流式入口直接回它，上游的 created / usage / model 与额外字段
	// 不会在网关这一跳被重新编码掉（对应 Node 的 passthroughBody）。
	result.PassthroughBody = append(json.RawMessage(nil), response...)
	return rehostSameOriginImages(ctx, strategy.Fetcher, input, result), nil
}

// rehostSameOriginImages 取回落在账号上游自己源上的图片链接。
//
// 只处理同源链接：字节必须由账号自己的凭据取，凭据不会发往第三方域名。取回失败保留上游链接
// 并继续 —— 图已经生成（额度已花掉），不该把整次请求判失败、更不该换号重生成（与 Node 同义）。
func rehostSameOriginImages(
	ctx context.Context,
	fetcher ImageFetcher,
	input Input,
	result Result,
) Result {
	if fetcher == nil || len(result.Images) == 0 {
		return result
	}
	headers := http.Header{}
	if input.Account.APIKey != "" {
		headers.Set("Authorization", "Bearer "+input.Account.APIKey)
	}
	for index := range result.Images {
		image := &result.Images[index]
		if image.URL == "" || image.B64JSON != "" || len(image.Rehosted) > 0 {
			continue
		}
		if !sameOrigin(image.URL, input.Account.BaseURL) {
			continue
		}
		fetched, fetchErr := fetcher.Fetch(ctx, image.URL, FetchOptions{
			Headers:      headers,
			AllowPrivate: true,
		})
		if fetchErr != nil {
			continue
		}
		image.Rehosted = fetched.Bytes
		image.MIME = string(fetched.MIME)
	}
	return result
}

// stripV1ImageProviders 是「上游 base 已含版本根，路径里不能再带 /v1」的 Provider 集合，
// 与 Node 的 STRIP_V1_PROVIDERS 对齐（upstream-endpoints-path.js）。
var stripV1ImageProviders = map[string]struct{}{
	"gemini": {},
	"agy":    {},
	"claude": {},
	"codex":  {},
	"grok":   {},
	"kimi":   {},
	"kiro":   {},
	"cline":  {},
}

// imageUpstreamPath 返回相对账号 base 的图片路径。
//
// 常见配置把 base 写成 https://api.openai.com/v1：这些 Provider 再拼 /v1/images/* 会变成
// /v1/v1/images/*（404）。与 Node 同一口径：命中集合的 Provider 去掉 /v1 前缀。
func imageUpstreamPath(provider string, mode imagegeneration.Mode) string {
	prefix := "/v1/images/"
	if _, found := stripV1ImageProviders[strings.ToLower(strings.TrimSpace(provider))]; found {
		prefix = "/images/"
	}
	return prefix + imageSuffix(mode)
}

// passthroughForwardOmittedFields 是不转发给上游的字段：provider 是网关的路由参数；
// stream / partial_images 会让上游改回 SSE，而本入口按 JSON 读响应 —— 客户端要的流式由入口
// 把完成结果渲染成 SSE（与 Node 的 FORWARD_OMITTED_FIELDS 一致）。
var passthroughForwardOmittedFields = []string{"provider", "stream", "partial_images"}

// imageEndpointMissingStatuses 是「上游没有图片端点」的状态码。
var imageEndpointMissingStatuses = map[int]struct{}{
	http.StatusNotFound:         {},
	http.StatusMethodNotAllowed: {},
	http.StatusNotImplemented:   {},
}

// imageEndpointMissing 判断状态码是否表示上游没有图片端点。
func imageEndpointMissing(statusCode int) bool {
	_, found := imageEndpointMissingStatuses[statusCode]
	return found
}

// passthroughFileFields 是 multipart 里的文件字段：图片与蒙版由字节重建，不能当文本重复发送。
var passthroughFileFields = map[string]struct{}{
	"image":    {},
	"image[]":  {},
	"images":   {},
	"images[]": {},
	"mask":     {},
	"mask[]":   {},
}

// passthroughRequestFields 返回要发给上游的字段。
//
// 客户端原体存在时按 Node 的 forward 口径原样转发：只去掉网关自有字段，模型换成别名解析后的
// 有效值。这样网关不认识的参数（style、user、seed、dall-e-3 的 quality=hd、http 图片引用……）
// 仍然由上游裁决，而不是在网关这一跳被白名单悄悄丢掉。没有原体时退回网关自编码的规范字段。
func passthroughRequestFields(input Input) map[string]any {
	if len(input.Raw) == 0 {
		return passthroughFields(input)
	}
	var document map[string]any
	if err := json.Unmarshal(input.Raw, &document); err != nil || document == nil {
		return passthroughFields(input)
	}
	for _, key := range passthroughForwardOmittedFields {
		delete(document, key)
	}
	document["model"] = input.Model
	if input.Mode == imagegeneration.ModeEdit {
		for key := range passthroughFileFields {
			delete(document, key)
		}
	}
	return document
}

// passthroughFields 组装上游通用的 OpenAI 图片字段。
func passthroughFields(input Input) map[string]any {
	fields := map[string]any{
		"model":  input.Model,
		"prompt": input.Prompt,
		"n":      input.N,
	}
	// GPT Image 不接受 response_format（永远返回 base64），发了会被拒；其它模型照旧要 base64
	// （与 Node 的 acceptsResponseFormatParameter 同一判定）。
	if acceptsResponseFormatParameter(input.Model) {
		responseFormat := string(input.ResponseFormat)
		if responseFormat == "" {
			responseFormat = string(ResponseFormatB64JSON)
		}
		fields["response_format"] = responseFormat
	}
	if input.Size != "" {
		fields["size"] = input.Size
	}
	if input.Quality != "" {
		fields["quality"] = input.Quality
	}
	if input.Background != "" {
		fields["background"] = input.Background
	}
	if input.OutputFormat != "" {
		fields["output_format"] = input.OutputFormat
	}
	if input.OutputCompression != nil {
		fields["output_compression"] = *input.OutputCompression
	}
	if input.Moderation != "" {
		fields["moderation"] = input.Moderation
	}
	return fields
}

// imageSuffix 返回上游路径后缀。
func imageSuffix(mode Mode) string {
	if mode == imagegeneration.ModeEdit {
		return "edits"
	}
	return "generations"
}

// gptImageModelPattern 匹配 GPT Image 家族（gpt-image-* / chatgpt-image-*，允许命名空间前缀）。
var gptImageModelPattern = regexp.MustCompile(`(?i)^(?:[a-z0-9._-]+/)?(?:gpt-image|chatgpt-image)(?:$|[-._])`)

// acceptsResponseFormatParameter 判断上游模型是否接受 response_format。
//
// OpenAI 文档把 response_format 标为只给已退役 DALL·E 用的旧参数，GPT Image 一律返回
// base64，发了会被拒；第三方兼容端点上的非 GPT 生图模型仍可能需要它来拿 base64。
func acceptsResponseFormatParameter(modelID string) bool {
	return !gptImageModelPattern.MatchString(strings.TrimSpace(modelID))
}

// valueOr 返回非空值或兜底值。
func valueOr(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

// 编译期确认三个策略满足统一合同。
var (
	_ Strategy = UnsupportedStrategy{}
	_ Strategy = CodexStrategy{}
	_ Strategy = AgyStrategy{}
	_ Strategy = PassthroughStrategy{}
)

// 编译期确认图片底层包仍提供规范化 base64 解码，输出归一化依赖它。
var _ = imagedata.MIMEPNG
