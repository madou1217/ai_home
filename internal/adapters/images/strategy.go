package images

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

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
	requestBody, err := json.Marshal(map[string]any{
		"model":            input.Model,
		"contents":         []map[string]any{{"role": "user", "parts": parts}},
		"generationConfig": generationConfig,
	})
	if err != nil {
		return Result{}, newError(500, "agy_transport_unavailable", "agy payload is not encodable")
	}

	// 同 codex：不要复用上面已声明为 error 的 err。
	response, sendErr := sendUpstream(ctx, input.HTTP, strategy.Endpoint, func(request *http.Request) {
		request.Header.Set("Authorization", "Bearer "+accessToken)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "application/json")
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
type PassthroughStrategy struct{}

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
func (PassthroughStrategy) Generate(
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
	url := base + "/v1/images/" + imageSuffix(input.Mode)

	fields := passthroughFields(input)
	var body []byte
	contentType := "application/json"
	if input.Mode == imagegeneration.ModeEdit {
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
	response, sendErr := sendUpstream(ctx, input.HTTP, url, func(request *http.Request) {
		request.Header.Set("Authorization", "Bearer "+apiKey)
		request.Header.Set("Accept", "application/json")
		request.Header.Set("Content-Type", contentType)
		if input.Account.AccountRef != "" {
			request.Header.Set("x-aih-account-ref", input.Account.AccountRef)
		}
		if input.Account.Email != "" {
			request.Header.Set("x-aih-account-email", input.Account.Email)
		}
	}, body)
	if sendErr != nil {
		return Result{}, sendErr
	}
	return parseOpenAIImagesResponse(response)
}

// passthroughFields 组装上游通用的 OpenAI 图片字段。
func passthroughFields(input Input) map[string]any {
	fields := map[string]any{
		"model":  input.Model,
		"prompt": input.Prompt,
		"n":      input.N,
	}
	responseFormat := string(input.ResponseFormat)
	if responseFormat == "" {
		responseFormat = string(ResponseFormatB64JSON)
	}
	fields["response_format"] = responseFormat
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
