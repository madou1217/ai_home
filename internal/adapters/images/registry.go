package images

import (
	"context"
	"fmt"
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
//
// fetcher 用于取回上游自己的图片链接（同源回取）；为 nil 时只保留上游链接。
func NewRegistry(codexBaseURL string, agyEndpoint string, fetcher ImageFetcher) Registry {
	return Registry{
		codex:       NewCodexStrategy(codexBaseURL),
		agy:         AgyStrategy{Endpoint: agyEndpoint},
		passthrough: PassthroughStrategy{Fetcher: fetcher},
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
		if !account.APIKeyMode && account.AccessToken != "" {
			return registry.codex
		}
		return registry.passthrough
	case "agy":
		if !account.APIKeyMode && account.AccessToken != "" {
			return registry.agy
		}
		return registry.passthrough
	default:
		// 通用策略优先：任何厂商只要账号带 OpenAI 兼容 base URL 与密钥，就先按
		// /v1/images/{generations|edits} 试通（grok、阿里等新接入无需先写专用策略）；
		// 跑不通再补 Provider 专用实现。
		if strings.TrimSpace(account.BaseURL) != "" && strings.TrimSpace(account.APIKey) != "" {
			return registry.passthrough
		}
		return NewUnsupportedStrategy(provider)
	}
}

// CapabilityCatalog 返回已声明模型的客户端能力事实。
//
// 未知厂商走通用透传，其模型集合由上游决定，因此不在静态目录里伪造条目；
// 客户端对它们应直接请求，由上游给出权威答案。
func (registry Registry) CapabilityCatalog() []ModelCapability {
	out := ImageModels(registry.codex)
	out = append(out, ImageModels(registry.agy)...)
	return out
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
	// AttemptFailure 在每次换号前报告「这次是哪把凭据失败了」；为 nil 时不观察。
	AttemptFailure AttemptFailureObserver
}

// AttemptFailureObserver 观察一次账号级失败。
//
// 上游只会说「你的请求失败了」，它并不知道我们用的是哪把凭据 ——「哪个账号失败」是
// 编排层自己的事实：换号循环里 next 就是刚刚失败的那个账号。把它交出去，宿主才能像
// Node 的 markProxyAccountFailure 那样给账号记冷却；否则坏账号在 Go 的生图链上永远
// 「健康」，每个请求都要先赔一次失败才换号。
//
// 观察者不得改变执行结果：它的返回值被忽略，记账失败也只影响统计。
type AttemptFailureObserver func(account Account, model string, err error)

// Execute 在候选账号上执行一次图片请求。
//
// 与 Node 的 executeImageGeneration 对齐：先按模型支持与能力闸门过滤候选，再按顺序
// 尝试；只有可重试的失败才换号，能力类失败（400）直接返回，避免把客户端的错误参数
// 变成对多个账号的无效轰炸。
//
// N>1 且策略原生单图时，闸门按原生能力（n=1）放行，实际输出由 EmulateMultiple 串行
// 模拟；转码在合并之后一次性完成，客户端拿到的始终是请求格式的全量图片。
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
		if request.PassthroughOnly {
			return Execution{}, newError(
				400,
				"passthrough_account_unavailable",
				"no passthrough account can serve model "+request.Model,
			)
		}
		// 这个 Provider 在 Go 里根本没有图片实现：别把「没做」说成「没号」。
		if !registry.HasProviderStrategy(provider) {
			return Execution{}, newError(
				400,
				"unsupported_image_provider",
				"provider "+provider+" has no image generation support",
			)
		}
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
		attemptInput := Input{
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
			Raw:               request.Raw,
			JSONOnly:          request.JSONOnly,
			Account:           next,
			HTTP:              options.HTTP,
		}
		// 输入侧归一化：入口接受 png/jpeg/webp/gif，上游只收它声明的格式；
		// 差异在这里转码吸收，Provider 策略永远只面对自己声明支持的字节。
		normalizedInput, normalizeErr := NormalizeInputs(attemptInput, strategy.Capabilities(request.Model))
		if normalizeErr != nil {
			return Execution{}, normalizeErr
		}
		result, generateErr := EmulateMultiple(ctx, strategy, normalizedInput, request.N)
		if generateErr == nil {
			// 统一格式交付：策略只产原生字节（N>1 被模拟时是多次调用合并后的全部图片），
			// 客户端要的格式在这里**一次性**转码，转码器必须看到所有图片。
			// 转码失败沿用与上游失败相同的换号/重试判定（400 能力类失败不换号）。
			transcoded, transcodeErr := TranscodeResult(result, request.OutputFormat, strategy.Capabilities(request.Model))
			if transcodeErr == nil {
				return Execution{
					Provider: provider,
					Account:  next,
					Result:   transcoded,
					Strategy: strategy,
				}, nil
			}
			generateErr = transcodeErr
		}
		lastErr = generateErr
		if options.AttemptFailure != nil {
			options.AttemptFailure(next, request.Model, generateErr)
		}
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

// EmulateMultiple 产出请求要求的 n 张图片，并在网关侧吸收「上游一次只能出一张」的差异。
//
// 分工：
//   - 策略原生支持多图（Capabilities.Multiple）时一次调用把 n 交给上游；
//   - 原生单图时按 n 次串行 Generate（每次 n=1）模拟，并按调用顺序拼接 Images。
//
// 上限：模拟是有界的（maxEmulatedOutputImages）。每次模拟都是一次真实上游调用与一份
// 额度，无界的 n 会把一个客户端请求放大成 n 次消耗；超过上限直接 400。
//
// 失败语义是「全有或全无」：任何一次模拟调用失败都中止整条请求并返回该错误，此前已产出
// 的图片全部丢弃，不返回部分结果。部分成功会让客户端拿到数量不足、却已经花掉额度的响应，
// 调用方也无从判断该不该重试。
//
// 透传策略把上游原始响应体放在 PassthroughBody 里：多份原始体无法合并成一份合法响应，
// 因此单图策略 + n>1 遇到原始体时显式 400，而不是悄悄丢掉原始体、退回重新编码后的等价
// 结果。透传族在生成前就能判定（见 effectiveCapabilityFrom），先拒绝以免白花一次上游调用；
// 循环里再按实际结果兜底，覆盖任何非透传族却返回原始体的策略。
func EmulateMultiple(ctx context.Context, strategy Strategy, input Input, n int) (Result, error) {
	if n < 1 {
		n = 1
	}
	capabilities := strategy.Capabilities(input.Model)
	if capabilities.Multiple {
		// 原生多图：N 原样交给上游，网关不拆分也不设模拟上限。
		return strategy.Generate(ctx, input)
	}
	if n == 1 {
		single := input
		single.N = 1
		return strategy.Generate(ctx, single)
	}
	if n > maxEmulatedOutputImages {
		return Result{}, newError(
			400,
			"unsupported_image_count",
			fmt.Sprintf(
				"%s generates one image per request; the gateway emulates at most %d image outputs (requested n=%d)",
				strategy.Provider(),
				maxEmulatedOutputImages,
				n,
			),
		)
	}
	if strategy.Kind() == "passthrough" {
		return Result{}, rawBodyEmulationError(n)
	}
	merged := Result{}
	for index := 0; index < n; index++ {
		attempt := input
		attempt.N = 1
		result, err := strategy.Generate(ctx, attempt)
		if err != nil {
			// 已产出的图片随本次错误一并丢弃：不做部分成功（见函数注释）。
			return Result{}, err
		}
		if len(result.PassthroughBody) > 0 {
			return Result{}, rawBodyEmulationError(n)
		}
		// 用量不做跨调用累加：不同上游的 usage 字段形状不同，猜测相加会伪造数字。
		// 保留第一次非空声明，作为「这次请求确实消耗了额度」的证据。
		if len(merged.Usage) == 0 {
			merged.Usage = result.Usage
		}
		merged.Images = append(merged.Images, result.Images...)
	}
	return merged, nil
}

// rawBodyEmulationError 是「原始响应体无法合并」的显式拒绝。
func rawBodyEmulationError(n int) *Error {
	return newError(
		400,
		"unsupported_image_count",
		fmt.Sprintf(
			"this account returns the upstream raw response body, which cannot be merged across the %d emulated calls required for n=%d",
			n,
			n,
		),
	)
}

// OutputCountError 判定请求的输出数量能否被服务；nil 表示可以。
//
// 这是「一个 Provider 一次能出几张图」的唯一判定：原生多图直接放行；单图策略在
// 模拟上限内放行；透传族（原始响应体无法合并）与超上限显式 400。校验层与其它
// 候选判定（例如 429 换号重试池）都调用它，避免各自复制一份规则。
func OutputCountError(
	strategy Strategy,
	provider string,
	request imagegeneration.Request,
) *Error {
	if request.N <= 1 {
		return nil
	}
	providerName := strings.TrimSpace(provider)
	if providerName == "" {
		providerName = strategy.Provider()
	}
	if strategy.Capabilities(request.Model).Multiple {
		return nil
	}
	if strategy.Kind() == "passthrough" {
		return rawBodyEmulationError(request.N)
	}
	if request.N > maxEmulatedOutputImages {
		return newError(
			400,
			"unsupported_image_count",
			fmt.Sprintf(
				"%s generates one image per request; the gateway emulates at most %d image outputs (requested n=%d)",
				providerName,
				maxEmulatedOutputImages,
				request.N,
			),
		)
	}
	return nil
}

// outputCountGate 返回能力闸门应当看到的请求。
//
// 闸门（CheckCapabilities）校验的是策略的**原生**能力；串行模拟（EmulateMultiple）是
// 编排层的网关能力，不在闸门的判据里。原生单图策略因此以 n=1 过闸，N 是否超出模拟上限、
// 以及多份原始响应体能否合并，统一由 EmulateMultiple 裁决。
func outputCountGate(strategy Strategy, request imagegeneration.Request) imagegeneration.Request {
	if request.N <= 1 || strategy.Capabilities(request.Model).Multiple {
		return request
	}
	gated := request
	gated.N = 1
	return gated
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
		if !candidateEligible(registry, provider, request, candidate) {
			continue
		}
		eligible = append(eligible, candidate)
	}
	return eligible
}

// candidateEligible 判断一个候选账号能否承载这条请求。
//
// 宽松口径（透传回落）只投透传账号，且跳过能力闸门：参数合法性的权威是上游，网关这一跳
// 不能把上游支持的参数（dall-e-3 的 quality=hd、style、http 图片引用……）判成 400。
func candidateEligible(
	registry Registry,
	provider string,
	request imagegeneration.Request,
	candidate Account,
) bool {
	strategy := registry.Resolve(provider, candidate)
	if request.PassthroughOnly {
		return strategy.Kind() == "passthrough"
	}
	if !strategy.SupportsModel(request.Model) {
		return false
	}
	return CheckCapabilities(strategy, provider, outputCountGate(strategy, request)) == nil
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
		if !candidateEligible(registry, provider, request, candidate) {
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
	if request.PassthroughOnly {
		// 调用方据此抛回严格解析的原始错误：没有透传账号时，客户端该看到的是「参数不合法」。
		return newError(
			400,
			"passthrough_account_unavailable",
			"no passthrough account can serve model "+request.Model,
		)
	}
	for _, candidate := range candidates {
		strategy := registry.Resolve(provider, candidate)
		if !strategy.SupportsModel(request.Model) {
			continue
		}
		if capabilityErr := CheckCapabilities(strategy, provider, outputCountGate(strategy, request)); capabilityErr != nil {
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
		"image_endpoint_unavailable",
		"invalid_image_output",
		"invalid_image_output_url",
		"image_output_missing",
		"upstream_response_too_large":
		return true
	}
	// 401/403 是账号级凭据拒绝：必须换号，不能把同一次请求重打在同一把凭据上。
	// 编排层用 attempted 排除已试账号，因此这里返回 true 只会跳到下一个候选。
	if generationErr.StatusCode == 401 || generationErr.StatusCode == 403 ||
		generationErr.StatusCode == 429 || generationErr.StatusCode >= 500 {
		return true
	}
	return false
}

// HasProviderStrategy 报告本仓是否为该 Provider 注册了原生图片策略。
//
// 它只用来把「能力缺失」与「暂时没有账号」分开：前者是 400，后者是 503。api-key 账号走
// passthrough，不依赖这里的原生策略，因此不进这张表。
func (registry Registry) HasProviderStrategy(provider string) bool {
	switch normalizeProvider(provider) {
	case "codex", "agy":
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
