package messages

import (
	"encoding/json"
	"math"

	"github.com/madou1217/ai_home/core/inference"
)

const (
	// defaultMaxTokens 是客户端未指定上限时发送给 Anthropic 的显式值。
	defaultMaxTokens = 8192

	// 下列 beta 名称来自当前 vendored Claude Code 的线协议常量。
	betaClaudeCode          = "claude-code-20250219"
	betaInterleavedThinking = "interleaved-thinking-2025-05-14"
	betaStructuredOutputs   = "structured-outputs-2025-12-15"
	betaAdvancedToolUse     = "advanced-tool-use-2025-11-20"
	betaEffort              = "effort-2025-11-24"
	betaPromptCachingScope  = "prompt-caching-scope-2026-01-05"
	betaFilesAPI            = "files-api-2025-04-14"
	betaRedactThinking      = "redact-thinking-2026-02-12"
)

// encodedRequest 保存 JSON 正文及其功能所需的 beta Header。
type encodedRequest struct {
	payload     []byte
	betaHeaders []string
}

// requestEncoder 把一次 Canonical Request 转换为 Messages 请求。
type requestEncoder struct {
	request        inference.Request
	effectiveModel string
	maxTokens      uint64
	cache          cacheLayout
	betas          []string
}

// encodeRequest 在创建网络请求前完成全部可表达性检查。
func encodeRequest(
	request inference.Request,
	effectiveModel string,
) (encodedRequest, error) {
	maxTokens, err := resolveMaxTokens(request)
	if err != nil || effectiveModel == "" {
		return encodedRequest{}, ErrUnsupportedRequest
	}
	cache, err := newCacheLayout(request.PromptCacheBreakpoints())
	if err != nil {
		return encodedRequest{}, err
	}
	encoder := &requestEncoder{
		request:        request,
		effectiveModel: effectiveModel,
		maxTokens:      maxTokens,
		cache:          cache,
	}
	if err := encoder.validateRequest(); err != nil {
		return encodedRequest{}, err
	}
	wire, err := encoder.encode()
	if err != nil {
		return encodedRequest{}, err
	}
	payload, err := json.Marshal(wire)
	if err != nil {
		return encodedRequest{}, ErrUnsupportedRequest
	}
	return encodedRequest{
		payload:     payload,
		betaHeaders: append([]string(nil), encoder.betas...),
	}, nil
}

// resolveMaxTokens 为 Messages 必填字段选择明确上限。
func resolveMaxTokens(request inference.Request) (uint64, error) {
	maxTokens := request.MaxOutputTokens()
	if maxTokens == 0 {
		maxTokens = defaultMaxTokens
		if reasoning, found := request.Reasoning(); found &&
			reasoning.Mode() == inference.ReasoningModeBudget &&
			reasoning.BudgetTokens() >= maxTokens {
			if reasoning.BudgetTokens() == math.MaxUint64 {
				return 0, ErrUnsupportedRequest
			}
			maxTokens = reasoning.BudgetTokens() + 1
		}
	}
	return maxTokens, nil
}

// validateRequest 拒绝 Messages 没有等价表达的 Provider 状态选项。
func (encoder *requestEncoder) validateRequest() error {
	if _, found := encoder.request.Continuation(); found {
		return ErrUnsupportedRequest
	}
	if truncation, found := encoder.request.Truncation(); found &&
		truncation != inference.TruncationDisabled {
		return ErrUnsupportedRequest
	}
	if store, found := encoder.request.Store(); found && store {
		return ErrUnsupportedRequest
	}
	return nil
}

// encode 组装根请求，具体内容和选项由专一方法编码。
func (encoder *requestEncoder) encode() (requestDTO, error) {
	system, messages, err := encoder.encodeMessages()
	if err != nil {
		return requestDTO{}, err
	}
	tools, err := encoder.encodeTools()
	if err != nil {
		return requestDTO{}, err
	}
	toolChoice, err := encoder.encodeToolChoice()
	if err != nil {
		return requestDTO{}, err
	}
	thinking, outputConfig, err := encoder.encodeReasoningAndOutput()
	if err != nil {
		return requestDTO{}, err
	}
	metadata := encoder.encodeMetadata()
	rootCache := encodeCacheControl(encoder.cache.request)
	if rootCache != nil && rootCache.Scope != "" {
		encoder.addBeta(betaPromptCachingScope)
	}
	if encoder.request.IncludeEncryptedReasoning() {
		// Claude 通过 redacted_thinking 块返回不可读但可续接的 reasoning。
		encoder.addBeta(betaRedactThinking)
	}
	return requestDTO{
		Model:         encoder.effectiveModel,
		MaxTokens:     encoder.maxTokens,
		Messages:      messages,
		System:        system,
		Stream:        true,
		Temperature:   optionalFloat(encoder.request.Temperature()),
		TopP:          optionalFloat(encoder.request.TopP()),
		TopK:          optionalUint64(encoder.request.TopK()),
		StopSequences: encoder.request.StopSequences(),
		Tools:         tools,
		ToolChoice:    toolChoice,
		Thinking:      thinking,
		OutputConfig:  outputConfig,
		Metadata:      metadata,
		CacheControl:  rootCache,
	}, nil
}

// encodeMessages 把前置 system/developer 指令和对话消息分开。
func (encoder *requestEncoder) encodeMessages() (
	[]contentDTO,
	[]messageDTO,
	error,
) {
	messages := encoder.request.Messages()
	system := make([]contentDTO, 0)
	conversation := make([]messageDTO, 0, len(messages))
	conversationStarted := false
	for messageIndex, message := range messages {
		role := message.Role()
		if role == inference.RoleSystem || role == inference.RoleDeveloper {
			if conversationStarted {
				return nil, nil, ErrUnsupportedRequest
			}
			contents, err := encoder.encodeContents(
				uint32(messageIndex),
				message.Contents(),
			)
			if err != nil {
				return nil, nil, err
			}
			system = append(system, contents...)
			continue
		}
		conversationStarted = true
		contents, err := encoder.encodeContents(
			uint32(messageIndex),
			message.Contents(),
		)
		if err != nil {
			return nil, nil, err
		}
		wireRole := string(role)
		if wireRole != "user" && wireRole != "assistant" {
			return nil, nil, ErrUnsupportedRequest
		}
		conversation = append(conversation, messageDTO{
			Role:    wireRole,
			Content: contents,
		})
	}
	if len(conversation) == 0 {
		return nil, nil, ErrUnsupportedRequest
	}
	return system, conversation, nil
}

// encodeTools 编码工具定义及工具级缓存断点。
func (encoder *requestEncoder) encodeTools() ([]toolDTO, error) {
	tools := encoder.request.Tools()
	wireTools := make([]toolDTO, len(tools))
	for index, tool := range tools {
		wire := toolDTO{
			Type:        "custom",
			Name:        tool.Name(),
			Description: tool.Description(),
			InputSchema: json.RawMessage(tool.InputSchema()),
			CacheControl: encodeCacheControl(
				encoder.cache.toolCacheControlAt(uint32(index)),
			),
		}
		if strict, specified := tool.Strict(); specified {
			wire.Strict = &strict
			encoder.addBeta(betaStructuredOutputs)
		}
		for _, caller := range tool.AllowedCallers() {
			wire.AllowedCallers = append(
				wire.AllowedCallers,
				string(caller),
			)
		}
		if value, specified := tool.DeferLoading(); specified {
			wire.DeferLoading = &value
		}
		if value, specified := tool.EagerInputStreaming(); specified {
			wire.EagerInputStreaming = &value
		}
		for _, example := range tool.InputExamples() {
			wire.InputExamples = append(
				wire.InputExamples,
				json.RawMessage(example),
			)
		}
		if len(wire.AllowedCallers) > 0 ||
			wire.DeferLoading != nil ||
			wire.EagerInputStreaming != nil ||
			len(wire.InputExamples) > 0 {
			encoder.addBeta(betaClaudeCode)
			encoder.addBeta(betaAdvancedToolUse)
		}
		if wire.CacheControl != nil && wire.CacheControl.Scope != "" {
			encoder.addBeta(betaPromptCachingScope)
		}
		wireTools[index] = wire
	}
	return wireTools, nil
}

// encodeToolChoice 反转 Anthropic disable_parallel_tool_use 语义。
func (encoder *requestEncoder) encodeToolChoice() (*toolChoiceDTO, error) {
	choice, found := encoder.request.ToolChoice()
	parallel, parallelSpecified := encoder.request.ParallelToolCalls()
	if !found && !parallelSpecified {
		return nil, nil
	}
	wire := toolChoiceDTO{Type: "auto"}
	if found {
		switch choice.Mode() {
		case inference.ToolChoiceAuto:
			wire.Type = "auto"
		case inference.ToolChoiceNone:
			wire.Type = "none"
		case inference.ToolChoiceRequired:
			wire.Type = "any"
		case inference.ToolChoiceNamed:
			wire.Type = "tool"
			wire.Name = choice.Name()
		default:
			return nil, ErrUnsupportedRequest
		}
	}
	if parallelSpecified {
		if wire.Type == "none" {
			return nil, ErrUnsupportedRequest
		}
		disabled := !parallel
		wire.DisableParallelToolUse = &disabled
	}
	return &wire, nil
}

// encodeReasoningAndOutput 合并 thinking、effort 和结构化输出。
func (encoder *requestEncoder) encodeReasoningAndOutput() (
	*thinkingDTO,
	*outputConfigDTO,
	error,
) {
	var thinking *thinkingDTO
	var output outputConfigDTO
	if reasoning, found := encoder.request.Reasoning(); found {
		var err error
		thinking, output.Effort, err = encoder.encodeReasoning(reasoning)
		if err != nil {
			return nil, nil, err
		}
	}
	if structured, found := encoder.request.StructuredOutput(); found {
		if !structured.Strict() {
			return nil, nil, ErrUnsupportedRequest
		}
		output.Format = &outputFormatDTO{
			Type:   "json_schema",
			Schema: json.RawMessage(structured.Schema()),
		}
		encoder.addBeta(betaStructuredOutputs)
	}
	if output.Effort == "" && output.Format == nil {
		return thinking, nil, nil
	}
	return thinking, &output, nil
}

// encodeReasoning 映射 Claude 支持的 thinking 和 effort 组合。
func (encoder *requestEncoder) encodeReasoning(
	reasoning inference.ReasoningConfig,
) (*thinkingDTO, string, error) {
	display, err := reasoningDisplay(reasoning.Summary())
	if err != nil {
		return nil, "", err
	}
	effort, err := anthropicEffort(reasoning.Effort())
	if err != nil {
		return nil, "", err
	}
	if effort != "" {
		encoder.addBeta(betaEffort)
	}
	if temperature, found := encoder.request.Temperature(); found &&
		temperature != 1 &&
		(reasoning.Mode() == inference.ReasoningModeBudget ||
			reasoning.Mode() == inference.ReasoningModeAdaptive) {
		return nil, "", ErrUnsupportedRequest
	}
	switch reasoning.Mode() {
	case inference.ReasoningModeBudget:
		budget := reasoning.BudgetTokens()
		if budget < 1024 || budget >= encoder.maxTokens {
			return nil, "", ErrUnsupportedRequest
		}
		encoder.addBeta(betaInterleavedThinking)
		return &thinkingDTO{
			Type:         "enabled",
			BudgetTokens: &budget,
			Display:      display,
		}, effort, nil
	case inference.ReasoningModeAdaptive:
		encoder.addBeta(betaInterleavedThinking)
		return &thinkingDTO{
			Type:    "adaptive",
			Display: display,
		}, effort, nil
	case inference.ReasoningModeEffort:
		if reasoning.Effort() == inference.ReasoningEffortNone {
			return &thinkingDTO{Type: "disabled"}, "", nil
		}
		return nil, effort, nil
	default:
		return nil, "", ErrUnsupportedRequest
	}
}

// reasoningDisplay 映射 Anthropic 当前公开的 summarized/omitted 两档。
func reasoningDisplay(
	summary inference.ReasoningSummaryMode,
) (string, error) {
	switch summary {
	case "", inference.ReasoningSummaryAuto:
		return "summarized", nil
	case inference.ReasoningSummaryNone:
		return "omitted", nil
	default:
		return "", ErrUnsupportedRequest
	}
}

// anthropicEffort 拒绝 Anthropic 没有等价档位的强度。
func anthropicEffort(
	effort inference.ReasoningEffort,
) (string, error) {
	switch effort {
	case "", inference.ReasoningEffortNone:
		return "", nil
	case inference.ReasoningEffortLow,
		inference.ReasoningEffortMedium,
		inference.ReasoningEffortHigh,
		inference.ReasoningEffortMax:
		return string(effort), nil
	default:
		return "", ErrUnsupportedRequest
	}
}

// encodeMetadata 只投影客户端明确给出的低敏 user_id。
func (encoder *requestEncoder) encodeMetadata() *metadataDTO {
	userID, found := encoder.request.UserID()
	if !found {
		return nil
	}
	return &metadataDTO{UserID: userID}
}

// addBeta 保持 beta Header 首次声明顺序并去重。
func (encoder *requestEncoder) addBeta(value string) {
	encoder.betas = appendUniqueBeta(encoder.betas, value)
}

// appendUniqueBeta 返回加入单个非重复 beta 后的切片。
func appendUniqueBeta(values []string, value string) []string {
	if value == "" || containsBeta(values, value) {
		return values
	}
	return append(values, value)
}

// containsBeta 判断 beta 是否已存在。
func containsBeta(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

// optionalFloat 将 getter 的 found 位转换为 JSON 指针。
func optionalFloat(value float64, found bool) *float64 {
	if !found {
		return nil
	}
	return &value
}

// optionalUint64 将 getter 的 found 位转换为 JSON 指针。
func optionalUint64(value uint64, found bool) *uint64 {
	if !found {
		return nil
	}
	return &value
}
