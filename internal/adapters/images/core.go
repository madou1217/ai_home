package images

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/imagegeneration"
)

// 本文件承载图片生成的核心合同：错误、账号视图、策略接口、原生能力规格与能力闸门。
// 它对应 Node 的 image-generation-strategy.js、image-generation-model-specs.js、
// image-generation-strategy-registry.js 与 image-generation-executor.js 的闸门部分。

// Mode 是一次请求的图片语义，与 imagegeneration 包保持同一取值。
type Mode = imagegeneration.Mode

// Error 是图片生成的失败，字段与 Node 的 ImageGenerationError 对齐。
type Error struct {
	// StatusCode 是应返回给客户端的 HTTP 状态码。
	StatusCode int
	// Code 是机器可读错误码。
	Code string
	// Detail 是面向调用方的说明。
	Detail string
	// UpstreamBody 是上游原始响应片段，仅用于离线诊断。
	UpstreamBody string
	// UpstreamURL 是本次失败对应的上游地址，不含凭据。
	UpstreamURL string
}

// Error 实现 error。
func (generationError *Error) Error() string {
	return fmt.Sprintf("%s: %s", generationError.Code, generationError.Detail)
}

// AsError 把任意 error 还原成本包错误。
func AsError(err error) (*Error, bool) {
	var generationErr *Error
	if errors.As(err, &generationErr) {
		return generationErr, true
	}
	return nil, false
}

// newError 创建图片生成错误。
func newError(statusCode int, code string, detail string) *Error {
	return &Error{StatusCode: statusCode, Code: code, Detail: detail}
}

// Account 是策略执行所需的最小账号视图。
//
// 它只携带已解出的凭据，不暴露凭据仓储、数据库或运行态。
type Account struct {
	// Provider 是账号归属的规范 Provider。
	Provider string
	// AccountRef 是稳定账号身份。
	AccountRef string
	// Email 是公开邮箱，仅用于诊断头。
	Email string
	// APIKey 是 api-key 账号的上游密钥。
	APIKey string
	// BaseURL 是 api-key 账号的上游地址。
	BaseURL string
	// AccessToken 是 OAuth 账号的访问令牌。
	AccessToken string
	// UpstreamAccountID 是 OAuth 账号的上游工作区 ID。
	UpstreamAccountID string
	// APIKeyMode 表示该账号使用 api-key 而不是 OAuth。
	APIKeyMode bool
}

// HTTPDoer 是策略执行上游调用所需的窄端口。
type HTTPDoer interface {
	Do(request *http.Request) (*http.Response, error)
}

// Input 是一次策略执行输入。
type Input struct {
	Mode              Mode
	Model             string
	Prompt            string
	N                 int
	Size              string
	Quality           string
	ResponseFormat    ResponseFormat
	Images            []imagegeneration.Image
	Mask              *imagegeneration.Image
	Background        string
	OutputFormat      string
	OutputCompression *int
	Moderation        string
	Account           Account
	HTTP              HTTPDoer
}

// Result 是一次策略产出。
type Result struct {
	// Images 是策略解析出的图片。
	Images []GeneratedImage
	// Usage 是上游返回的用量对象，缺失时为 nil。
	Usage json.RawMessage
}

// Capabilities 描述一个策略在某个模型上支持的请求语义。
type Capabilities struct {
	Generation        bool
	Edit              bool
	Mask              bool
	Multiple          bool
	Size              bool
	Quality           bool
	ResponseFormat    bool
	MaxInputImages    int
	Background        bool
	OutputFormat      bool
	OutputCompression bool
	Moderation        bool
}

// Strategy 是一种上游图片线协议的实现。
type Strategy interface {
	// Provider 返回该策略服务的规范 Provider 键。
	Provider() string
	// Kind 返回能力族：native、passthrough 或 unsupported。
	Kind() string
	// Capabilities 返回该模型上的能力集合。
	Capabilities(modelID string) Capabilities
	// SupportsModel 判断该策略能否为该模型生成图片。
	SupportsModel(modelID string) bool
	// Generate 执行一次图片生成或编辑。
	Generate(ctx context.Context, input Input) (Result, error)
}

// modelSpec 是 Provider 原生的图片模型声明。
type modelSpec struct {
	ID                string
	Label             string
	QualityOptions    []string
	MaxInputImages    int
	SupportsSize      bool
	HasMaxInputImages bool
}

// nativeModelSpecs 与 Node 的 NATIVE_IMAGE_MODEL_SPECS 对齐。
//
// 只登记 Go 当前 Provider 范围内的条目（codex 与 agy）。gemini 与 grok 尚未进入
// Go 的 Provider 范围，因此不在这里声明，避免出现没有实现的能力。
var nativeModelSpecs = map[string][]modelSpec{
	"codex": {
		{
			ID:             "gpt-image-2",
			Label:          "GPT Image 2",
			QualityOptions: []string{"low", "medium", "high"},
		},
	},
	"agy": {
		{
			ID:                "gemini-3.1-flash-image",
			Label:             "Gemini 3.1 Flash Image",
			MaxInputImages:    14,
			HasMaxInputImages: true,
			SupportsSize:      true,
		},
		{
			ID:    "gemini-2.5-flash-image",
			Label: "Gemini 2.5 Flash Image",
		},
	},
}

// nativeCapabilities 与 Node 的 NATIVE_IMAGE_CAPABILITIES 对齐。
var nativeCapabilities = map[string]Capabilities{
	"codex": {
		Generation:     true,
		Edit:           true,
		Multiple:       true,
		Size:           true,
		Quality:        true,
		ResponseFormat: true,
		MaxInputImages: 5,
		Background:     true,
	},
	"agy": {
		Generation:     true,
		Edit:           true,
		ResponseFormat: true,
		MaxInputImages: 1,
	},
	"passthrough": {
		Generation:        true,
		Edit:              true,
		Mask:              true,
		Multiple:          true,
		Size:              true,
		Quality:           true,
		ResponseFormat:    true,
		MaxInputImages:    16,
		Background:        true,
		OutputFormat:      true,
		OutputCompression: true,
		Moderation:        true,
	},
}

// NativeCapabilities 返回指定 Provider 在指定模型上的原生图片能力。
//
// 未知 Provider 返回 false，调用方据此落到显式 unsupported 策略。
func NativeCapabilities(provider string, modelID string) (Capabilities, bool) {
	normalized := normalizeProvider(provider)
	capabilities, found := nativeCapabilities[normalized]
	if !found {
		return Capabilities{}, false
	}
	if spec, ok := resolveModelSpec(normalized, modelID); ok {
		if spec.HasMaxInputImages {
			capabilities.MaxInputImages = spec.MaxInputImages
		}
		if spec.SupportsSize {
			capabilities.Size = true
		}
	}
	return capabilities, true
}

// NativeQualityOptions 返回指定 Provider 与模型的可用质量档位。
func NativeQualityOptions(provider string, modelID string) []string {
	normalized := normalizeProvider(provider)
	if normalized == "passthrough" {
		return []string{"low", "medium", "high"}
	}
	spec, found := resolveModelSpec(normalized, modelID)
	if !found || len(spec.QualityOptions) == 0 {
		return nil
	}
	options := make([]string, len(spec.QualityOptions))
	copy(options, spec.QualityOptions)
	return options
}

// NativeImageModels 返回指定 Provider 声明的原生图片模型 ID。
func NativeImageModels(provider string) []string {
	specs := nativeModelSpecs[normalizeProvider(provider)]
	models := make([]string, 0, len(specs))
	for _, spec := range specs {
		models = append(models, spec.ID)
	}
	return models
}

// resolveModelSpec 在 Provider 的原生声明中精确匹配模型 ID。
func resolveModelSpec(provider string, modelID string) (modelSpec, bool) {
	normalized := strings.ToLower(strings.TrimSpace(modelID))
	if normalized == "" {
		return modelSpec{}, false
	}
	for _, spec := range nativeModelSpecs[provider] {
		if strings.ToLower(spec.ID) == normalized {
			return spec, true
		}
	}
	return modelSpec{}, false
}

// normalizeProvider 归一化 Provider 键。
func normalizeProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

// CheckCapabilities 校验请求语义是否被该策略支持。
//
// 与 Node 的 resolveImageCapabilityError 逐条对齐：不支持的语义返回 400 与具体错误码，
// 而不是让请求带着无效参数打到上游再失败。
func CheckCapabilities(
	strategy Strategy,
	provider string,
	request imagegeneration.Request,
) *Error {
	capabilities := strategy.Capabilities(request.Model)
	providerName := strings.TrimSpace(provider)
	if providerName == "" {
		providerName = strategy.Provider()
	}
	if request.Mode == imagegeneration.ModeGeneration && !capabilities.Generation {
		return newError(
			400,
			"unsupported_image_generation",
			fmt.Sprintf("%s does not support image generation", providerName),
		)
	}
	if request.Mode == imagegeneration.ModeEdit && !capabilities.Edit {
		return newError(
			400,
			"unsupported_image_edit",
			fmt.Sprintf("%s does not support image edits", providerName),
		)
	}
	imageCount := len(request.Images)
	maxInputImages := capabilities.MaxInputImages
	if maxInputImages < 1 {
		maxInputImages = 1
	}
	if imageCount > maxInputImages {
		noun := "images"
		if maxInputImages == 1 {
			noun = "image"
		}
		return newError(
			400,
			"unsupported_image_input_count",
			fmt.Sprintf(
				"%s supports at most %d input %s",
				providerName,
				maxInputImages,
				noun,
			),
		)
	}
	if request.Mask != nil && !capabilities.Mask {
		return newError(
			400,
			"unsupported_image_mask",
			fmt.Sprintf("%s does not support image masks", providerName),
		)
	}
	if request.N > 1 && !capabilities.Multiple {
		return newError(
			400,
			"unsupported_image_count",
			fmt.Sprintf("%s does not support multiple image outputs", providerName),
		)
	}
	if request.Size != "" && request.Size != "auto" && !capabilities.Size {
		return newError(
			400,
			"unsupported_image_size",
			fmt.Sprintf("%s does not support explicit image sizes", providerName),
		)
	}
	if request.Quality != "" && request.Quality != "auto" && !capabilities.Quality {
		return newError(
			400,
			"unsupported_image_quality",
			fmt.Sprintf("%s does not support image quality controls", providerName),
		)
	}
	if request.Quality != "" && request.Quality != "auto" {
		options := NativeQualityOptions(providerName, request.Model)
		if len(options) > 0 && !containsString(options, request.Quality) {
			return newError(
				400,
				"unsupported_image_quality_value",
				fmt.Sprintf(
					"%s does not support image quality %s for model %s",
					providerName,
					request.Quality,
					request.Model,
				),
			)
		}
	}
	if request.Background != "" && !capabilities.Background {
		return newError(
			400,
			"unsupported_image_background",
			fmt.Sprintf("%s does not support image background controls", providerName),
		)
	}
	if request.OutputFormat != "" && !capabilities.OutputFormat {
		return newError(
			400,
			"unsupported_image_output_format",
			fmt.Sprintf("%s does not support image output format controls", providerName),
		)
	}
	if request.OutputCompression != nil && !capabilities.OutputCompression {
		return newError(
			400,
			"unsupported_image_output_compression",
			fmt.Sprintf("%s does not support image output compression controls", providerName),
		)
	}
	if request.Moderation != "" && !capabilities.Moderation {
		return newError(
			400,
			"unsupported_image_moderation",
			fmt.Sprintf("%s does not support image moderation controls", providerName),
		)
	}
	return nil
}

// containsString 判断字符串切片是否包含目标值。
func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
