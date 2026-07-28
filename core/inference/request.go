package inference

import (
	"math"
)

// Capability 是路由征召必须明确满足的推理语义。
type Capability uint8

const (
	// CapabilityTextGeneration 表示可以生成文本或结构化文本。
	CapabilityTextGeneration Capability = iota + 1
	// CapabilityImageInput 表示可以理解图片输入。
	CapabilityImageInput
	// CapabilityDocumentInput 表示可以理解文档输入。
	CapabilityDocumentInput
	// CapabilityTools 表示可以接收工具定义并产生工具调用。
	CapabilityTools
	// CapabilityReasoning 表示可以处理 reasoning 配置或连续性内容。
	CapabilityReasoning
	// CapabilityStructuredOutput 表示可以按 JSON Schema 生成结构化输出。
	CapabilityStructuredOutput
	// CapabilityStreaming 表示可以向客户端提供真实增量事件。
	CapabilityStreaming
)

// String 返回能力的稳定日志与测试名称。
func (capability Capability) String() string {
	switch capability {
	case CapabilityTextGeneration:
		return "text_generation"
	case CapabilityImageInput:
		return "image_input"
	case CapabilityDocumentInput:
		return "document_input"
	case CapabilityTools:
		return "tools"
	case CapabilityReasoning:
		return "reasoning"
	case CapabilityStructuredOutput:
		return "structured_output"
	case CapabilityStreaming:
		return "streaming"
	default:
		return "unknown"
	}
}

// IsValid 判断能力是否已经注册。
func (capability Capability) IsValid() bool {
	return capability >= CapabilityTextGeneration && capability <= CapabilityStreaming
}

// CapabilitySet 使用位图保存小而稳定的能力集合。
//
// 单次请求推导和账号征召均可使用常数时间 Has 检查，不需要热路径 map。
type CapabilitySet uint32

// Has 判断能力集合是否包含指定能力。
func (set CapabilitySet) Has(capability Capability) bool {
	if !capability.IsValid() {
		return false
	}
	return set&(1<<uint(capability-1)) != 0
}

// ContainsAll 判断候选能力集合是否完整覆盖请求能力集合。
func (set CapabilitySet) ContainsAll(required CapabilitySet) bool {
	return set&required == required
}

// with 返回加入一个合法能力后的集合。
func (set CapabilitySet) with(capability Capability) CapabilitySet {
	if !capability.IsValid() {
		return set
	}
	return set | (1 << uint(capability-1))
}

// ReasoningMode 是跨 Provider 的 reasoning 调度意图。
type ReasoningMode string

const (
	// ReasoningModeEffort 表示由抽象强度等级控制 reasoning。
	ReasoningModeEffort ReasoningMode = "effort"
	// ReasoningModeBudget 表示由明确 token 预算控制 reasoning。
	ReasoningModeBudget ReasoningMode = "budget"
	// ReasoningModeAdaptive 表示由上游模型自适应控制 reasoning。
	ReasoningModeAdaptive ReasoningMode = "adaptive"
)

// ReasoningEffort 是低、中、高三个可跨协议映射的强度等级。
type ReasoningEffort string

const (
	// ReasoningEffortNone 表示明确禁用模型 reasoning。
	ReasoningEffortNone ReasoningEffort = "none"
	// ReasoningEffortMinimal 表示最小 reasoning 强度。
	ReasoningEffortMinimal ReasoningEffort = "minimal"
	// ReasoningEffortLow 表示低 reasoning 强度。
	ReasoningEffortLow ReasoningEffort = "low"
	// ReasoningEffortMedium 表示中 reasoning 强度。
	ReasoningEffortMedium ReasoningEffort = "medium"
	// ReasoningEffortHigh 表示高 reasoning 强度。
	ReasoningEffortHigh ReasoningEffort = "high"
	// ReasoningEffortXHigh 表示超高 reasoning 强度。
	ReasoningEffortXHigh ReasoningEffort = "xhigh"
	// ReasoningEffortMax 表示模型允许的最大 reasoning 强度。
	ReasoningEffortMax ReasoningEffort = "max"
)

// IsValid 判断 reasoning 强度是否已经注册。
func (effort ReasoningEffort) IsValid() bool {
	switch effort {
	case ReasoningEffortNone,
		ReasoningEffortMinimal,
		ReasoningEffortLow,
		ReasoningEffortMedium,
		ReasoningEffortHigh,
		ReasoningEffortXHigh,
		ReasoningEffortMax:
		return true
	default:
		return false
	}
}

// ReasoningSummaryMode 是客户端对 reasoning 摘要的输出意图。
type ReasoningSummaryMode string

const (
	// ReasoningSummaryNone 表示不请求 reasoning 摘要。
	ReasoningSummaryNone ReasoningSummaryMode = "none"
	// ReasoningSummaryAuto 表示允许上游决定摘要粒度。
	ReasoningSummaryAuto ReasoningSummaryMode = "auto"
	// ReasoningSummaryConcise 表示请求精简 reasoning 摘要。
	ReasoningSummaryConcise ReasoningSummaryMode = "concise"
	// ReasoningSummaryDetailed 表示请求详细 reasoning 摘要。
	ReasoningSummaryDetailed ReasoningSummaryMode = "detailed"
)

// IsValid 判断 reasoning 摘要模式是否已经注册。
func (mode ReasoningSummaryMode) IsValid() bool {
	return mode == ReasoningSummaryNone ||
		mode == ReasoningSummaryAuto ||
		mode == ReasoningSummaryConcise ||
		mode == ReasoningSummaryDetailed
}

// ReasoningConfig 是不携带 Provider 私有字段的 reasoning 请求意图。
type ReasoningConfig struct {
	mode         ReasoningMode
	effort       ReasoningEffort
	budgetTokens uint64
	summary      ReasoningSummaryMode
}

// NewEffortReasoning 创建 Codex 风格但可由其他 Adapter 显式映射的强度意图。
func NewEffortReasoning(
	effort ReasoningEffort,
	summary ReasoningSummaryMode,
) (ReasoningConfig, error) {
	if (effort == "" && summary == "") ||
		(effort != "" && !effort.IsValid()) ||
		(summary != "" && !summary.IsValid()) {
		return ReasoningConfig{}, ErrInvalidReasoning
	}
	return ReasoningConfig{
		mode:    ReasoningModeEffort,
		effort:  effort,
		summary: summary,
	}, nil
}

// NewBudgetReasoning 创建 Claude 风格但可由其他 Adapter 显式评估的预算意图。
func NewBudgetReasoning(
	budgetTokens uint64,
	summary ReasoningSummaryMode,
) (ReasoningConfig, error) {
	if budgetTokens == 0 || !summary.IsValid() {
		return ReasoningConfig{}, ErrInvalidReasoning
	}
	return ReasoningConfig{
		mode:         ReasoningModeBudget,
		budgetTokens: budgetTokens,
		summary:      summary,
	}, nil
}

// NewAdaptiveReasoning 创建由上游模型自适应控制的 reasoning 意图。
func NewAdaptiveReasoning(summary ReasoningSummaryMode) (ReasoningConfig, error) {
	if !summary.IsValid() {
		return ReasoningConfig{}, ErrInvalidReasoning
	}
	return ReasoningConfig{
		mode:    ReasoningModeAdaptive,
		summary: summary,
	}, nil
}

// Mode 返回 reasoning 控制方式。
func (config ReasoningConfig) Mode() ReasoningMode {
	return config.mode
}

// Effort 返回强度模式的等级，其他模式返回空值。
func (config ReasoningConfig) Effort() ReasoningEffort {
	return config.effort
}

// BudgetTokens 返回预算模式的 token 数，其他模式返回零。
func (config ReasoningConfig) BudgetTokens() uint64 {
	return config.budgetTokens
}

// Summary 返回 reasoning 摘要意图。
func (config ReasoningConfig) Summary() ReasoningSummaryMode {
	return config.summary
}

// IsValid 判断 reasoning 配置只有当前模式所需字段。
func (config ReasoningConfig) IsValid() bool {
	switch config.mode {
	case ReasoningModeEffort:
		return config.budgetTokens == 0 &&
			(config.effort == "" || config.effort.IsValid()) &&
			(config.summary == "" || config.summary.IsValid()) &&
			(config.effort != "" || config.summary != "")
	case ReasoningModeBudget:
		return config.effort == "" && config.budgetTokens > 0 && config.summary.IsValid()
	case ReasoningModeAdaptive:
		return config.effort == "" && config.budgetTokens == 0 && config.summary.IsValid()
	default:
		return false
	}
}

// StructuredOutput 是需要按 JSON Schema 生成的命名输出合同。
type StructuredOutput struct {
	name        string
	description string
	schema      []byte
	strict      bool
}

// NewStructuredOutput 创建可由 Codex 或 Claude Adapter 显式编码的输出合同。
func NewStructuredOutput(
	name string,
	description string,
	schema []byte,
	strict bool,
) (StructuredOutput, error) {
	if !isToolName(name) ||
		(description != "" && !isNonBlankText(description)) ||
		!isJSONObject(schema) {
		return StructuredOutput{}, ErrInvalidRequest
	}
	return StructuredOutput{
		name:        name,
		description: description,
		schema:      cloneBytes(schema),
		strict:      strict,
	}, nil
}

// Name 返回结构化输出合同名称。
func (output StructuredOutput) Name() string {
	return output.name
}

// Description 返回结构化输出合同的可选说明。
func (output StructuredOutput) Description() string {
	return output.description
}

// Schema 返回不能修改内部合同的 JSON Schema 副本。
func (output StructuredOutput) Schema() []byte {
	return cloneBytes(output.schema)
}

// Strict 返回是否要求严格遵循 Schema。
func (output StructuredOutput) Strict() bool {
	return output.strict
}

// IsValid 判断结构化输出合同仍满足名称和 Schema 不变量。
func (output StructuredOutput) IsValid() bool {
	_, err := NewStructuredOutput(output.name, output.description, output.schema, output.strict)
	return err == nil
}

// clone 返回结构化输出及其 Schema 的独立快照。
func (output StructuredOutput) clone() StructuredOutput {
	return StructuredOutput{
		name:        output.name,
		description: output.description,
		schema:      cloneBytes(output.schema),
		strict:      output.strict,
	}
}

// ToolChoiceMode 是客户端选择工具调用方式的稳定意图。
type ToolChoiceMode string

const (
	// ToolChoiceAuto 表示由模型决定是否调用工具。
	ToolChoiceAuto ToolChoiceMode = "auto"
	// ToolChoiceNone 表示禁止调用工具。
	ToolChoiceNone ToolChoiceMode = "none"
	// ToolChoiceRequired 表示必须调用至少一个工具。
	ToolChoiceRequired ToolChoiceMode = "required"
	// ToolChoiceNamed 表示必须调用指定工具。
	ToolChoiceNamed ToolChoiceMode = "named"
)

// ToolChoice 是工具选择模式和可选精确工具名的值对象。
type ToolChoice struct {
	mode ToolChoiceMode
	name string
}

// NewToolChoice 创建自动、禁止或必须调用模式。
func NewToolChoice(mode ToolChoiceMode) (ToolChoice, error) {
	if mode != ToolChoiceAuto && mode != ToolChoiceNone && mode != ToolChoiceRequired {
		return ToolChoice{}, ErrInvalidRequest
	}
	return ToolChoice{mode: mode}, nil
}

// NewNamedToolChoice 创建必须调用指定工具的选择意图。
func NewNamedToolChoice(name string) (ToolChoice, error) {
	if !isToolName(name) {
		return ToolChoice{}, ErrInvalidToolName
	}
	return ToolChoice{mode: ToolChoiceNamed, name: name}, nil
}

// Mode 返回工具选择模式。
func (choice ToolChoice) Mode() ToolChoiceMode {
	return choice.mode
}

// Name 返回命名模式的精确工具名，其他模式返回空值。
func (choice ToolChoice) Name() string {
	return choice.name
}

// IsValid 判断工具选择模式与名称组合是否合法。
func (choice ToolChoice) IsValid() bool {
	if choice.mode == ToolChoiceNamed {
		return isToolName(choice.name)
	}
	return choice.name == "" &&
		(choice.mode == ToolChoiceAuto || choice.mode == ToolChoiceNone || choice.mode == ToolChoiceRequired)
}

// ContinuationKind 是请求显式复用历史上下文的方式。
type ContinuationKind string

const (
	// ContinuationPreviousResponse 表示复用 Responses previous_response_id。
	ContinuationPreviousResponse ContinuationKind = "previous_response"
	// ContinuationConversation 表示复用 Provider 管理的 conversation。
	ContinuationConversation ContinuationKind = "conversation"
)

// IsValid 判断连续性方式是否已经注册。
func (kind ContinuationKind) IsValid() bool {
	return kind == ContinuationPreviousResponse || kind == ContinuationConversation
}

// Continuation 是允许引用请求外历史工具调用的明确上下文身份。
type Continuation struct {
	kind ContinuationKind
	id   string
}

// NewContinuation 创建具有稳定 ID 的历史上下文引用。
func NewContinuation(kind ContinuationKind, id string) (Continuation, error) {
	if !kind.IsValid() || !isCanonicalOpaqueID(id) {
		return Continuation{}, ErrInvalidRequest
	}
	return Continuation{kind: kind, id: id}, nil
}

// Kind 返回历史上下文引用方式。
func (continuation Continuation) Kind() ContinuationKind {
	return continuation.kind
}

// ID 返回历史响应或 conversation 的精确标识。
func (continuation Continuation) ID() string {
	return continuation.id
}

// IsValid 判断连续性方式与 ID 仍满足构造不变量。
func (continuation Continuation) IsValid() bool {
	_, err := NewContinuation(continuation.kind, continuation.id)
	return err == nil
}

// TruncationMode 是请求超出上下文窗口时的处理意图。
type TruncationMode string

const (
	// TruncationAuto 表示允许上游从上下文开头删除输入项。
	TruncationAuto TruncationMode = "auto"
	// TruncationDisabled 表示上下文过长时失败关闭。
	TruncationDisabled TruncationMode = "disabled"
)

// IsValid 判断截断策略是否已经注册。
func (mode TruncationMode) IsValid() bool {
	return mode == TruncationAuto || mode == TruncationDisabled
}

// RequestInput 是 Client Decoder 创建 Canonical Request 的显式输入。
type RequestInput struct {
	// ClientProtocol 是请求进入 AI Home 时使用的协议。
	ClientProtocol ClientProtocolID
	// Model 是客户端请求的模型或已完成别名解析的目标模型。
	Model string
	// Messages 是按原始上下文顺序排列的消息。
	Messages []Message
	// Tools 是当前请求允许模型调用的工具定义。
	Tools []ToolDefinition
	// ToolChoice 是可选的工具选择意图。
	ToolChoice *ToolChoice
	// ParallelToolCalls 表示客户端是否明确允许并行工具调用。
	ParallelToolCalls *bool
	// Reasoning 是可选的 reasoning 控制意图。
	Reasoning *ReasoningConfig
	// StructuredOutput 是可选的 JSON Schema 输出合同。
	StructuredOutput *StructuredOutput
	// Stream 表示客户端需要真实增量事件。
	Stream bool
	// MaxOutputTokens 是可选的最大输出 token，零表示未指定。
	MaxOutputTokens uint64
	// Temperature 是可选采样温度。
	Temperature *float64
	// TopP 是可选 nucleus sampling 概率。
	TopP *float64
	// StopSequences 是必须原样保留的非空停止序列。
	StopSequences []string
	// Store 表示客户端是否明确要求 Provider 保存响应状态。
	Store *bool
	// IncludeEncryptedReasoning 表示客户端要求返回加密 reasoning 连续性。
	IncludeEncryptedReasoning bool
	// Truncation 是可选的上下文截断策略。
	Truncation TruncationMode
	// Continuation 是可选的历史响应或 conversation 引用。
	Continuation *Continuation
	// ExternalToolCallIDs 是 continuation 上下文中明确已知的工具调用 ID。
	//
	// 该字段只允许精确匹配，不允许 Decoder 根据顺序猜测调用。
	ExternalToolCallIDs []string
}

// Request 是 Decoder、路由器和 Encoder 之间的不可变 Canonical Request。
type Request struct {
	clientProtocol    ClientProtocolID
	model             string
	messages          []Message
	tools             []ToolDefinition
	toolChoice        *ToolChoice
	parallelToolCalls *bool
	reasoning         *ReasoningConfig
	structuredOutput  *StructuredOutput
	stream            bool
	maxOutputTokens   uint64
	temperature       *float64
	topP              *float64
	stopSequences     []string
	store             *bool
	includeEncrypted  bool
	truncation        TruncationMode
	continuation      *Continuation
	capabilities      CapabilitySet
}

// NewRequest 校验完整请求并一次性推导路由所需能力。
func NewRequest(input RequestInput) (Request, error) {
	if !input.ClientProtocol.IsValid() ||
		!isCanonicalModelID(input.Model) ||
		len(input.Messages) == 0 ||
		!isValidSampling(input.Temperature, input.TopP) ||
		!areValidStopSequences(input.StopSequences) {
		return Request{}, ErrInvalidRequest
	}
	messages, err := cloneAndValidateMessages(input.Messages)
	if err != nil {
		return Request{}, err
	}
	tools, err := cloneAndValidateTools(input.Tools)
	if err != nil {
		return Request{}, err
	}
	if err := validateRequestOptions(input, tools); err != nil {
		return Request{}, err
	}
	if err := validateToolPairing(messages, input.ExternalToolCallIDs); err != nil {
		return Request{}, err
	}

	request := Request{
		clientProtocol:    input.ClientProtocol,
		model:             input.Model,
		messages:          messages,
		tools:             tools,
		toolChoice:        cloneToolChoice(input.ToolChoice),
		parallelToolCalls: cloneBool(input.ParallelToolCalls),
		reasoning:         cloneReasoning(input.Reasoning),
		structuredOutput:  cloneStructuredOutput(input.StructuredOutput),
		stream:            input.Stream,
		maxOutputTokens:   input.MaxOutputTokens,
		temperature:       cloneFloat(input.Temperature),
		topP:              cloneFloat(input.TopP),
		stopSequences:     append([]string(nil), input.StopSequences...),
		store:             cloneBool(input.Store),
		includeEncrypted:  input.IncludeEncryptedReasoning,
		truncation:        input.Truncation,
		continuation:      cloneContinuation(input.Continuation),
	}
	request.capabilities = deriveRequiredCapabilities(request)
	return request, nil
}

// ClientProtocol 返回客户端入口协议。
func (request Request) ClientProtocol() ClientProtocolID {
	return request.clientProtocol
}

// Model 返回未经 Adapter 改写的目标模型。
func (request Request) Model() string {
	return request.model
}

// Messages 返回全部消息的深拷贝。
func (request Request) Messages() []Message {
	messages := make([]Message, len(request.messages))
	for index, message := range request.messages {
		messages[index] = message.clone()
	}
	return messages
}

// Tools 返回全部工具定义及 Schema 的深拷贝。
func (request Request) Tools() []ToolDefinition {
	tools := make([]ToolDefinition, len(request.tools))
	for index, tool := range request.tools {
		tools[index] = tool.clone()
	}
	return tools
}

// ToolChoice 返回可选工具选择意图。
func (request Request) ToolChoice() (ToolChoice, bool) {
	if request.toolChoice == nil {
		return ToolChoice{}, false
	}
	return *request.toolChoice, true
}

// ParallelToolCalls 返回客户端是否明确设置并行工具调用。
func (request Request) ParallelToolCalls() (bool, bool) {
	if request.parallelToolCalls == nil {
		return false, false
	}
	return *request.parallelToolCalls, true
}

// Reasoning 返回可选 reasoning 控制意图。
func (request Request) Reasoning() (ReasoningConfig, bool) {
	if request.reasoning == nil {
		return ReasoningConfig{}, false
	}
	return *request.reasoning, true
}

// StructuredOutput 返回可选结构化输出合同及其独立 Schema 副本。
func (request Request) StructuredOutput() (StructuredOutput, bool) {
	if request.structuredOutput == nil {
		return StructuredOutput{}, false
	}
	return request.structuredOutput.clone(), true
}

// Stream 返回客户端是否需要真实增量输出。
func (request Request) Stream() bool {
	return request.stream
}

// MaxOutputTokens 返回最大输出 token，零表示客户端未指定。
func (request Request) MaxOutputTokens() uint64 {
	return request.maxOutputTokens
}

// Temperature 返回可选采样温度。
func (request Request) Temperature() (float64, bool) {
	if request.temperature == nil {
		return 0, false
	}
	return *request.temperature, true
}

// TopP 返回可选 nucleus sampling 概率。
func (request Request) TopP() (float64, bool) {
	if request.topP == nil {
		return 0, false
	}
	return *request.topP, true
}

// StopSequences 返回不能修改请求内部状态的停止序列副本。
func (request Request) StopSequences() []string {
	return append([]string(nil), request.stopSequences...)
}

// Store 返回客户端是否明确设置 Provider 响应存储。
func (request Request) Store() (bool, bool) {
	if request.store == nil {
		return false, false
	}
	return *request.store, true
}

// IncludeEncryptedReasoning 返回是否要求响应携带加密 reasoning 连续性。
func (request Request) IncludeEncryptedReasoning() bool {
	return request.includeEncrypted
}

// Truncation 返回可选上下文截断策略。
func (request Request) Truncation() (TruncationMode, bool) {
	return request.truncation, request.truncation != ""
}

// Continuation 返回可选的历史上下文身份。
func (request Request) Continuation() (Continuation, bool) {
	if request.continuation == nil {
		return Continuation{}, false
	}
	return *request.continuation, true
}

// RequiredCapabilities 返回构造时一次性推导的能力位图。
func (request Request) RequiredCapabilities() CapabilitySet {
	return request.capabilities
}

// cloneAndValidateMessages 验证并深拷贝消息切片。
func cloneAndValidateMessages(messages []Message) ([]Message, error) {
	cloned := make([]Message, len(messages))
	for index, message := range messages {
		if !message.IsValid() {
			return nil, ErrInvalidMessage
		}
		cloned[index] = message.clone()
	}
	return cloned, nil
}

// cloneAndValidateTools 验证工具定义、拒绝重名并深拷贝切片。
func cloneAndValidateTools(tools []ToolDefinition) ([]ToolDefinition, error) {
	cloned := make([]ToolDefinition, len(tools))
	names := make(map[string]struct{}, len(tools))
	for index, tool := range tools {
		if !tool.IsValid() {
			return nil, ErrInvalidRequest
		}
		if _, exists := names[tool.name]; exists {
			return nil, ErrInvalidRequest
		}
		names[tool.name] = struct{}{}
		cloned[index] = tool.clone()
	}
	return cloned, nil
}

// validateRequestOptions 校验所有可选配置不会形成无意义组合。
func validateRequestOptions(input RequestInput, tools []ToolDefinition) error {
	if input.ToolChoice != nil {
		if !input.ToolChoice.IsValid() {
			return ErrInvalidRequest
		}
		if len(tools) == 0 && input.ToolChoice.mode != ToolChoiceNone {
			return ErrInvalidRequest
		}
		if input.ToolChoice.mode == ToolChoiceNamed && !hasToolNamed(tools, input.ToolChoice.name) {
			return ErrInvalidRequest
		}
	}
	if input.ParallelToolCalls != nil && len(tools) == 0 {
		return ErrInvalidRequest
	}
	if input.Reasoning != nil && !input.Reasoning.IsValid() {
		return ErrInvalidReasoning
	}
	if input.StructuredOutput != nil && !input.StructuredOutput.IsValid() {
		return ErrInvalidRequest
	}
	if input.Continuation != nil && !input.Continuation.IsValid() {
		return ErrInvalidRequest
	}
	if input.Truncation != "" && !input.Truncation.IsValid() {
		return ErrInvalidRequest
	}
	if len(input.ExternalToolCallIDs) > 0 && input.Continuation == nil {
		return ErrInvalidRequest
	}
	return nil
}

// hasToolNamed 以线性扫描检查命名工具。
//
// 单请求工具数量通常很小，避免为一次选择额外分配 map。
func hasToolNamed(tools []ToolDefinition, name string) bool {
	for _, tool := range tools {
		if tool.name == name {
			return true
		}
	}
	return false
}

// validateToolPairing 使用明确 call ID 校验历史调用和结果，不执行 FIFO 猜配。
func validateToolPairing(messages []Message, externalCallIDs []string) error {
	pendingCalls := make(map[string]struct{}, len(externalCallIDs))
	for _, callID := range externalCallIDs {
		if !isCanonicalOpaqueID(callID) {
			return ErrInvalidToolCallID
		}
		if _, exists := pendingCalls[callID]; exists {
			return ErrInvalidRequest
		}
		pendingCalls[callID] = struct{}{}
	}
	for _, message := range messages {
		for _, content := range message.contents {
			switch typed := content.(type) {
			case ToolCallContent:
				if _, exists := pendingCalls[typed.callID]; exists {
					return ErrInvalidRequest
				}
				pendingCalls[typed.callID] = struct{}{}
			case ToolResultContent:
				if _, exists := pendingCalls[typed.callID]; !exists {
					return ErrUnmatchedToolResult
				}
				delete(pendingCalls, typed.callID)
			}
		}
	}
	if len(pendingCalls) > 0 {
		return ErrMissingToolResult
	}
	return nil
}

// deriveRequiredCapabilities 单次遍历请求内容并生成热路径能力位图。
func deriveRequiredCapabilities(request Request) CapabilitySet {
	required := CapabilitySet(0).with(CapabilityTextGeneration)
	if request.stream {
		required = required.with(CapabilityStreaming)
	}
	if len(request.tools) > 0 {
		required = required.with(CapabilityTools)
	}
	if request.reasoning != nil {
		required = required.with(CapabilityReasoning)
	}
	if request.includeEncrypted {
		required = required.with(CapabilityReasoning)
	}
	if request.structuredOutput != nil {
		required = required.with(CapabilityStructuredOutput)
	}
	for _, message := range request.messages {
		for _, content := range message.contents {
			required = addContentCapabilities(required, content)
		}
	}
	return required
}

// addContentCapabilities 把一个内容块及工具结果嵌套内容加入能力位图。
func addContentCapabilities(required CapabilitySet, content Content) CapabilitySet {
	switch typed := content.(type) {
	case ImageContent:
		return required.with(CapabilityImageInput)
	case DocumentContent:
		return required.with(CapabilityDocumentInput)
	case ToolCallContent:
		return required.with(CapabilityTools)
	case ToolResultContent:
		required = required.with(CapabilityTools)
		for _, resultContent := range typed.contents {
			required = addContentCapabilities(required, resultContent)
		}
		return required
	case ReasoningContent:
		return required.with(CapabilityReasoning)
	default:
		return required
	}
}

// isCanonicalModelID 校验模型 ID 可作为稳定路由键且不执行静默修剪。
func isCanonicalModelID(value string) bool {
	return isCanonicalOpaqueID(value)
}

// isValidSampling 校验可选采样参数的通用安全范围。
func isValidSampling(temperature *float64, topP *float64) bool {
	if temperature != nil && (math.IsNaN(*temperature) || math.IsInf(*temperature, 0) || *temperature < 0 || *temperature > 2) {
		return false
	}
	if topP != nil && (math.IsNaN(*topP) || math.IsInf(*topP, 0) || *topP < 0 || *topP > 1) {
		return false
	}
	return true
}

// areValidStopSequences 校验停止序列非空、没有控制字符且不会重复。
func areValidStopSequences(sequences []string) bool {
	seen := make(map[string]struct{}, len(sequences))
	for _, sequence := range sequences {
		if !isValidDelta(sequence) {
			return false
		}
		if _, exists := seen[sequence]; exists {
			return false
		}
		seen[sequence] = struct{}{}
	}
	return true
}

// cloneToolChoice 返回可选工具选择的独立副本。
func cloneToolChoice(value *ToolChoice) *ToolChoice {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

// cloneReasoning 返回可选 reasoning 配置的独立副本。
func cloneReasoning(value *ReasoningConfig) *ReasoningConfig {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

// cloneStructuredOutput 返回可选结构化输出及 Schema 的独立副本。
func cloneStructuredOutput(value *StructuredOutput) *StructuredOutput {
	if value == nil {
		return nil
	}
	cloned := value.clone()
	return &cloned
}

// cloneBool 返回可选布尔值的独立副本。
func cloneBool(value *bool) *bool {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

// cloneFloat 返回可选浮点值的独立副本。
func cloneFloat(value *float64) *float64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

// cloneContinuation 返回可选历史上下文身份的独立副本。
func cloneContinuation(value *Continuation) *Continuation {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}
