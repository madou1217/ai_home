package messages

import (
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
)

const (
	// 下列 beta 名称来自当前 vendored Claude Code 的线协议常量。
	betaClaudeCode          = "claude-code-20250219"
	betaInterleavedThinking = "interleaved-thinking-2025-05-14"
	betaStructuredOutputs   = "structured-outputs-2025-12-15"
	betaAdvancedToolUse     = "advanced-tool-use-2025-11-20"
	betaEffort              = "effort-2025-11-24"
	betaPromptCachingScope  = "prompt-caching-scope-2026-01-05"
	betaFilesAPI            = "files-api-2025-04-14"
	betaRedactThinking      = "redact-thinking-2026-02-12"
	betaWebSearch           = "web-search-2025-03-05"
	betaContextManagement   = "context-management-2025-06-27"
)

// encodedRequest 保存 JSON 正文及其功能所需的 beta Header。
type encodedRequest struct {
	payload     []byte
	betaHeaders []string
	toolNames   toolNameMapper
}

// requestEncoder 把一次 Canonical Request 转换为 Messages 请求。
type requestEncoder struct {
	request        inference.Request
	effectiveModel string
	maxTokens      uint64
	cache          cacheLayout
	toolNames      toolNameMapper
	betas          []string
	// officialClient 表示本次调用使用订阅 OAuth，须按 Claude Code 客户端合同发送。
	officialClient bool
}

// encodeRequest 在创建网络请求前完成全部可表达性检查。
func encodeRequest(
	request inference.Request,
	effectiveModel string,
	officialClient bool,
) (encodedRequest, error) {
	if effectiveModel == "" {
		return encodedRequest{}, ErrUnsupportedRequest
	}
	maxTokens := resolveMaxTokens(request, effectiveModel)
	cacheBreakpoints, err := projectPromptCacheBreakpoints(request)
	if err != nil {
		return encodedRequest{}, err
	}
	cache, err := newCacheLayout(cacheBreakpoints)
	if err != nil {
		return encodedRequest{}, err
	}
	toolNames, err := newToolNameMapper(request)
	if err != nil {
		return encodedRequest{}, err
	}
	encoder := &requestEncoder{
		request:        request,
		effectiveModel: effectiveModel,
		maxTokens:      maxTokens,
		cache:          cache,
		toolNames:      toolNames,
		officialClient: officialClient,
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
		toolNames:   toolNames,
	}, nil
}

// projectPromptCacheBreakpoints 把 Responses 缓存亲和键转成 Claude 请求级缓存意图。
//
// Anthropic 不接收任意缓存键，而是按完整提示前缀复用缓存；因此仅在客户端没有
// 更精确断点时增加默认 request 断点，不把键值泄漏到模型输入或上游 metadata。
func projectPromptCacheBreakpoints(
	request inference.Request,
) ([]inference.PromptCacheBreakpoint, error) {
	breakpoints := request.PromptCacheBreakpoints()
	if _, found := request.PromptCacheKey(); !found || hasRequestCacheBreakpoint(breakpoints) {
		return breakpoints, nil
	}
	control, err := inference.NewPromptCacheControl(
		inference.PromptCacheTTLDefault,
		inference.PromptCacheScopeDefault,
	)
	if err != nil {
		return nil, ErrUnsupportedRequest
	}
	breakpoint, err := inference.NewRequestPromptCacheBreakpoint(control)
	if err != nil {
		return nil, ErrUnsupportedRequest
	}
	return append(breakpoints, breakpoint), nil
}

// hasRequestCacheBreakpoint 判断客户端是否已经声明请求级缓存控制。
func hasRequestCacheBreakpoint(values []inference.PromptCacheBreakpoint) bool {
	for _, value := range values {
		if value.Target() == inference.PromptCacheTargetRequest {
			return true
		}
	}
	return false
}

// resolveMaxTokens 优先保留客户端上限；仅当源协议没有该字段时，才使用
// Claude Code 对当前模型的兼容策略补齐 Messages 必填字段。
func resolveMaxTokens(request inference.Request, effectiveModel string) uint64 {
	if maxTokens := request.MaxOutputTokens(); maxTokens != 0 {
		return maxTokens
	}
	return claudeCodeDefaultMaxOutputTokens(effectiveModel)
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
	contextManagement, err := encoder.encodeContextManagement()
	if err != nil {
		return requestDTO{}, err
	}
	rootCache := encodeCacheControl(encoder.cache.request)
	if rootCache != nil && rootCache.Scope != "" {
		encoder.addBeta(betaPromptCachingScope)
	}
	return requestDTO{
		Model:             encoder.effectiveModel,
		MaxTokens:         encoder.maxTokens,
		Messages:          messages,
		System:            prependClaudeCodeSystem(system, encoder.officialClient),
		Stream:            true,
		Temperature:       optionalFloat(encoder.request.Temperature()),
		TopP:              optionalFloat(encoder.request.TopP()),
		TopK:              optionalUint64(encoder.request.TopK()),
		StopSequences:     encoder.request.StopSequences(),
		Tools:             tools,
		ToolChoice:        toolChoice,
		Thinking:          thinking,
		OutputConfig:      outputConfig,
		Metadata:          metadata,
		CacheControl:      rootCache,
		ContextManagement: contextManagement,
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
			contents, err := encoder.encodeContents(
				uint32(messageIndex),
				message.Contents(),
			)
			if err != nil {
				return nil, nil, err
			}
			if !conversationStarted {
				system = append(system, contents...)
				continue
			}
			if role != inference.RoleSystem {
				return nil, nil, ErrUnsupportedRequest
			}
			conversation = appendClaudeConversationMessage(
				conversation,
				messageDTO{Role: "system", Content: contents},
			)
			encoder.addBeta(betaClaudeCode)
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
		conversation = appendClaudeConversationMessage(conversation, messageDTO{
			Role:    wireRole,
			Content: contents,
		})
	}
	if len(conversation) == 0 {
		return nil, nil, ErrUnsupportedRequest
	}
	return system, conversation, nil
}

// appendClaudeConversationMessage 合并相邻同角色历史项，与 Claude Messages
// 服务端语义一致，并保证 Responses reasoning 与随后 assistant 输出同块回放。
func appendClaudeConversationMessage(
	conversation []messageDTO,
	message messageDTO,
) []messageDTO {
	if len(message.Content) == 0 {
		return conversation
	}
	if len(conversation) == 0 ||
		conversation[len(conversation)-1].Role != message.Role {
		return append(conversation, message)
	}
	last := &conversation[len(conversation)-1]
	last.Content = append(last.Content, message.Content...)
	return conversation
}

// encodeTools 编码工具定义及工具级缓存断点。
func (encoder *requestEncoder) encodeTools() ([]json.RawMessage, error) {
	tools := encoder.request.Tools()
	wireTools := make([]json.RawMessage, 0, len(tools)+1)
	for index, tool := range tools {
		wireName, err := encoder.toolNames.encode(tool.Identity())
		if err != nil {
			return nil, err
		}
		wire := toolDTO{
			Type:        "custom",
			Name:        wireName,
			Description: claudeToolDescription(tool),
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
		encoded, err := json.Marshal(wire)
		if err != nil {
			return nil, ErrUnsupportedRequest
		}
		wireTools = append(wireTools, encoded)
	}
	if webSearch, found := encoder.request.WebSearch(); found {
		wire, err := encodeWebSearchTool(webSearch)
		if err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(wire)
		if err != nil {
			return nil, ErrUnsupportedRequest
		}
		wireTools = append(wireTools, encoded)
		encoder.addBeta(betaWebSearch)
	}
	return wireTools, nil
}

// encodeWebSearchTool 把共同搜索配置映射到 Claude Code 当前使用的工具版本。
func encodeWebSearchTool(
	tool inference.WebSearchTool,
) (webSearchToolDTO, error) {
	if external, specified := tool.ExternalWebAccess(); specified && !external {
		return webSearchToolDTO{}, ErrUnsupportedRequest
	}
	wire := webSearchToolDTO{
		Type:           "web_search_20250305",
		Name:           "web_search",
		AllowedDomains: tool.AllowedDomains(),
	}
	if location, found := tool.Location(); found {
		wire.UserLocation = &webSearchUserLocationDTO{
			Type:     "approximate",
			Country:  location.Country(),
			Region:   location.Region(),
			City:     location.City(),
			Timezone: location.Timezone(),
		}
	}
	return wire, nil
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
			wire.Name, _ = encoder.toolNames.encode(choice.Identity())
			if wire.Name == "" {
				return nil, ErrUnsupportedRequest
			}
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

// claudeToolDescription 把 namespace 公共说明显式投影到扁平 Claude 工具。
func claudeToolDescription(tool inference.ToolDefinition) string {
	namespace, namespaced := tool.Namespace()
	if !namespaced {
		return tool.Description()
	}
	prefix := "Namespace: " + namespace
	if description := tool.NamespaceDescription(); description != "" {
		prefix += ". " + description
	}
	if description := tool.Description(); description != "" {
		return prefix + "\n\n" + description
	}
	return prefix
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
		encoder.addThinkingBetas(reasoning.Summary())
		return &thinkingDTO{
			Type:         "enabled",
			BudgetTokens: &budget,
			Display:      anthropicThinkingDisplay(reasoning.Summary()),
		}, effort, nil
	case inference.ReasoningModeAdaptive:
		encoder.addThinkingBetas(reasoning.Summary())
		return &thinkingDTO{
			Type:    "adaptive",
			Display: anthropicThinkingDisplay(reasoning.Summary()),
		}, effort, nil
	case inference.ReasoningModeEffort:
		if reasoning.Effort() == inference.ReasoningEffortNone {
			return &thinkingDTO{Type: "disabled"}, "", nil
		}
		// Responses 的 effort 表达“启用并控制 reasoning 强度”；Claude 的
		// output_config.effort 只调节强度，不能代替 thinking 开关。
		encoder.addThinkingBetas(reasoning.Summary())
		return &thinkingDTO{
			Type:    "adaptive",
			Display: anthropicThinkingDisplay(reasoning.Summary()),
		}, effort, nil
	default:
		return nil, "", ErrUnsupportedRequest
	}
}

// anthropicThinkingDisplay 把客户端明确的不显示意图投影为 Claude Code
// redact-thinking 合同要求的 omitted 值；其他摘要模式不发送 Provider 私有字段。
func anthropicThinkingDisplay(summary inference.ReasoningSummaryMode) string {
	if summary == inference.ReasoningSummaryNone {
		return "omitted"
	}
	return ""
}

// addThinkingBetas 为已启用的 thinking 添加精确 beta。
//
// redact-thinking 只由客户端明确的 omitted 摘要意图驱动；Responses 的
// encrypted_content include 仅控制下游输出，不能改变 Claude 上游形态。
func (encoder *requestEncoder) addThinkingBetas(
	summary inference.ReasoningSummaryMode,
) {
	encoder.addBeta(betaInterleavedThinking)
	if summary == inference.ReasoningSummaryNone {
		encoder.addBeta(betaRedactThinking)
	}
}

// anthropicEffort 拒绝 Anthropic 没有等价档位的强度。
func anthropicEffort(
	effort inference.ReasoningEffort,
) (string, error) {
	switch effort {
	case "", inference.ReasoningEffortNone:
		return "", nil
	case inference.ReasoningEffortMinimal:
		// Claude 没有 minimal 档，向上收敛到最低可用的 low。
		return string(inference.ReasoningEffortLow), nil
	case inference.ReasoningEffortLow,
		inference.ReasoningEffortMedium,
		inference.ReasoningEffortHigh,
		inference.ReasoningEffortMax:
		return string(effort), nil
	case inference.ReasoningEffortXHigh:
		// Codex xhigh 与 Claude max 都表示高于 high 的最高公开档位。
		return string(inference.ReasoningEffortMax), nil
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
