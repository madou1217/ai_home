package images

import (
	"context"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/imagegeneration"
)

// 本文件承载策略注册表与编排，对应 Node 的 image-generation-strategy-registry.js
// 与 image-generation-executor.js 的账号尝试循环。

// maxAttempts 是一次请求最多尝试的账号数。
const maxAttempts = 3

// AccountSource 按公平轮转顺序提供候选账号。
//
// 它是本包与宿主征召器之间的唯一接缝：本包不读数据库、不做运行态判断，
// 只消费已解出的凭据视图。
type AccountSource interface {
	// Candidates 返回可服务该 Provider 与模型的候选账号。
	//
	// exclude 中的账号必须被跳过，用于失败换号。
	Candidates(ctx context.Context, provider string, model string, exclude []string) ([]Account, error)
}

// Registry 按 (Provider, 账号形态) 解析图片策略。
type Registry struct {
	codex       CodexStrategy
	agy         AgyStrategy
	passthrough PassthroughStrategy
}

// NewRegistry 创建图片策略注册表。
func NewRegistry(codexBaseURL string, agyEndpoint string) Registry {
	return Registry{
		codex:       NewCodexStrategy(codexBaseURL),
		agy:         AgyStrategy{Endpoint: agyEndpoint},
		passthrough: PassthroughStrategy{},
	}
}

// Resolve 返回服务该 (Provider, 账号) 的策略。
//
// api-key 账号一律走 passthrough：其上游就是 OpenAI 兼容端点，由端点决定支持哪些模型。
// OAuth 账号走 Provider 原生策略；未知 Provider 落到显式 unsupported。
func (registry Registry) Resolve(provider string, account Account) Strategy {
	if account.APIKeyMode {
		return registry.passthrough
	}
	switch normalizeProvider(provider) {
	case "codex":
		return registry.codex
	case "agy":
		return registry.agy
	default:
		return NewUnsupportedStrategy(provider)
	}
}

// Execution 是一次成功的图片执行。
type Execution struct {
	// Provider 是实际使用的 Provider。
	Provider string
	// Account 是实际使用的账号。
	Account Account
	// Result 是策略产出并已归一化的结果。
	Result Result
	// Strategy 是实际使用的策略。
	Strategy Strategy
}

// ExecuteOptions 声明编排层的可调参数。
type ExecuteOptions struct {
	// HTTP 是执行上游调用的客户端。
	HTTP HTTPDoer
}

// Execute 在候选账号上执行一次图片请求。
//
// 与 Node 的 executeImageGeneration 对齐：先按模型支持与能力闸门过滤候选，再按顺序
// 尝试；只有可重试的失败才换号，能力类失败（400）直接返回，避免把客户端的错误参数
// 变成对多个账号的无效轰炸。
func Execute(
	ctx context.Context,
	registry Registry,
	source AccountSource,
	provider string,
	request imagegeneration.Request,
	options ExecuteOptions,
) (Execution, error) {
	if source == nil {
		return Execution{}, newError(500, "image_account_selector_unavailable", "image account selector is not configured")
	}
	candidates, err := source.Candidates(ctx, provider, request.Model, nil)
	if err != nil {
		return Execution{}, newError(503, "no_available_account", "no available "+provider+" account")
	}
	eligible := filterEligible(registry, provider, request, candidates)
	if len(eligible) == 0 {
		return Execution{}, noEligibleAccountError(registry, provider, request, candidates)
	}

	attempted := make([]string, 0, maxAttempts)
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		remaining, err := source.Candidates(ctx, provider, request.Model, attempted)
		if err != nil {
			break
		}
		next, found := firstEligible(registry, provider, request, remaining, attempted)
		if !found {
			break
		}
		attempted = append(attempted, next.AccountRef)
		strategy := registry.Resolve(provider, next)
		result, generateErr := strategy.Generate(ctx, Input{
			Mode:              request.Mode,
			Model:             request.Model,
			Prompt:            request.Prompt,
			N:                 request.N,
			Size:              request.Size,
			Quality:           request.Quality,
			ResponseFormat:    ResponseFormat(request.ResponseFormat),
			Images:            request.Images,
			Mask:              request.Mask,
			Background:        request.Background,
			OutputFormat:      request.OutputFormat,
			OutputCompression: request.OutputCompression,
			Moderation:        request.Moderation,
			Account:           next,
			HTTP:              options.HTTP,
		})
		if generateErr == nil {
			return Execution{
				Provider: provider,
				Account:  next,
				Result:   result,
				Strategy: strategy,
			}, nil
		}
		lastErr = generateErr
		if !retryable(generateErr) {
			return Execution{}, generateErr
		}
	}
	if lastErr != nil {
		return Execution{}, lastErr
	}
	return Execution{}, newError(
		503,
		"no_available_account",
		"no healthy "+provider+" account can serve model "+request.Model,
	)
}

// filterEligible 返回通过模型支持与能力闸门的候选。
func filterEligible(
	registry Registry,
	provider string,
	request imagegeneration.Request,
	candidates []Account,
) []Account {
	eligible := make([]Account, 0, len(candidates))
	for _, candidate := range candidates {
		strategy := registry.Resolve(provider, candidate)
		if !strategy.SupportsModel(request.Model) {
			continue
		}
		if CheckCapabilities(strategy, provider, request) != nil {
			continue
		}
		eligible = append(eligible, candidate)
	}
	return eligible
}

// firstEligible 返回尚未尝试过的第一个合格候选。
func firstEligible(
	registry Registry,
	provider string,
	request imagegeneration.Request,
	candidates []Account,
	attempted []string,
) (Account, bool) {
	for _, candidate := range candidates {
		if containsString(attempted, candidate.AccountRef) {
			continue
		}
		strategy := registry.Resolve(provider, candidate)
		if !strategy.SupportsModel(request.Model) {
			continue
		}
		if CheckCapabilities(strategy, provider, request) != nil {
			continue
		}
		return candidate, true
	}
	return Account{}, false
}

// noEligibleAccountError 区分「能力不支持」与「模型不支持」两类原因。
func noEligibleAccountError(
	registry Registry,
	provider string,
	request imagegeneration.Request,
	candidates []Account,
) error {
	for _, candidate := range candidates {
		strategy := registry.Resolve(provider, candidate)
		if !strategy.SupportsModel(request.Model) {
			continue
		}
		if capabilityErr := CheckCapabilities(strategy, provider, request); capabilityErr != nil {
			return capabilityErr
		}
	}
	hasStrategy := false
	for _, candidate := range candidates {
		if registry.Resolve(provider, candidate).Kind() != "unsupported" {
			hasStrategy = true
			break
		}
	}
	if hasStrategy {
		return newError(
			400,
			"unsupported_model_for_images",
			"model "+request.Model+" is not supported for "+provider+" image generation",
		)
	}
	return newError(
		400,
		"unsupported_image_provider",
		"provider "+provider+" has no image generation support",
	)
}

// retryable 判断一次失败是否值得换号重试。
//
// 与 Node 的 RETRYABLE_ACCOUNT_FAILURE_CODES 对齐：凭据、端点、输出质量问题可换号；
// 429 与 5xx 也可换号；其余（含 4xx 参数错误）直接返回。
func retryable(err error) bool {
	generationErr, ok := AsError(err)
	if !ok {
		return false
	}
	switch generationErr.Code {
	case "invalid_access_token",
		"infinite_loop_detected",
		"account_base_url_missing",
		"gemini_code_assist_not_applicable",
		"invalid_image_output",
		"invalid_image_output_url",
		"image_output_missing",
		"upstream_response_too_large":
		return true
	}
	if generationErr.StatusCode == 429 || generationErr.StatusCode >= 500 {
		return true
	}
	return false
}

// ProviderFromRequest 返回请求显式声明的 Provider。
//
// 空值表示调用方需要按模型解析 Provider。
func ProviderFromRequest(request imagegeneration.Request) string {
	return strings.ToLower(strings.TrimSpace(request.Provider))
}
