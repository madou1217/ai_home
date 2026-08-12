package openairesponses

import "encoding/json"

// requestDTO 只描述 Responses 客户端线协议，不得被应用层直接使用。
type requestDTO struct {
	// Model 是客户端请求的模型 ID。
	Model string `json:"model"`
	// Input 是字符串或输入项数组。
	Input json.RawMessage `json:"input"`
	// Instructions 是当前请求额外插入的系统或开发者指令。
	Instructions json.RawMessage `json:"instructions"`
	// Stream 表示客户端是否请求 SSE 增量响应。
	Stream bool `json:"stream"`
	// MaxOutputTokens 是可选最大输出 token。
	MaxOutputTokens *uint64 `json:"max_output_tokens"`
	// Temperature 是可选采样温度。
	Temperature *float64 `json:"temperature"`
	// TopP 是可选 nucleus sampling 概率。
	TopP *float64 `json:"top_p"`
	// Tools 是客户端声明的工具 DTO 列表。
	Tools []json.RawMessage `json:"tools"`
	// ToolChoice 是字符串或命名工具选择对象。
	ToolChoice json.RawMessage `json:"tool_choice"`
	// ParallelToolCalls 表示是否明确允许并行工具调用。
	ParallelToolCalls *bool `json:"parallel_tool_calls"`
	// Reasoning 是 reasoning 控制对象。
	Reasoning json.RawMessage `json:"reasoning"`
	// Text 是普通文本或结构化输出配置。
	Text json.RawMessage `json:"text"`
	// PreviousResponseID 是 Responses 原生历史响应引用。
	PreviousResponseID string `json:"previous_response_id"`
	// Conversation 是字符串或包含 id 的 conversation 引用。
	Conversation json.RawMessage `json:"conversation"`
	// Store 表示客户端是否要求保存响应状态。
	Store *bool `json:"store"`
	// Include 是客户端要求额外返回的数据类别。
	Include []string `json:"include"`
	// Truncation 是上下文过长时的截断策略。
	Truncation string `json:"truncation"`
	// Background 表示是否使用后台响应。
	Background *bool `json:"background"`
	// ContextManagement 是尚待与 Claude 共同建模的上下文管理配置。
	ContextManagement json.RawMessage `json:"context_management"`
	// PromptCacheKey 是跨上游转换时保留的缓存亲和键。
	PromptCacheKey *string `json:"prompt_cache_key"`
	// ClientMetadata 是 Codex 客户端的非语义诊断元数据。
	ClientMetadata map[string]string `json:"client_metadata"`
	// PromptCacheOptions 是尚待共同建模的缓存策略。
	PromptCacheOptions json.RawMessage `json:"prompt_cache_options"`
	// PromptCacheRetention 是已弃用但仍需显式识别的缓存保留策略。
	PromptCacheRetention *string `json:"prompt_cache_retention"`
	// Metadata 是响应需要回显的客户端元数据。
	Metadata json.RawMessage `json:"metadata"`
	// ServiceTier 是 OpenAI 特有的服务层级。
	ServiceTier *string `json:"service_tier"`
	// SafetyIdentifier 是 OpenAI 风控使用的最终用户标识。
	SafetyIdentifier *string `json:"safety_identifier"`
	// TopLogprobs 是输出 token 概率明细数量。
	TopLogprobs *uint64 `json:"top_logprobs"`
	// MaxToolCalls 是内置工具的最大调用次数。
	MaxToolCalls *uint64 `json:"max_tool_calls"`
}

// inputItemHeaderDTO 只用于选择具体输入项 Decoder。
type inputItemHeaderDTO struct {
	// Type 是 Responses 输入项判别字段。
	Type string `json:"type"`
	// Role 是省略 type 时识别消息项的角色。
	Role string `json:"role"`
}

// messageDTO 是 Responses message 输入项。
type messageDTO struct {
	// Type 固定为 message，也允许 EasyInputMessage 省略。
	Type string `json:"type"`
	// Role 是消息参与方。
	Role string `json:"role"`
	// Content 是字符串或内容块数组。
	Content json.RawMessage `json:"content"`
	// Phase 是 Codex assistant commentary 或 final_answer 阶段。
	Phase string `json:"phase"`
	// ID 是重放 ResponseOutputMessage 时携带的输出项 ID。
	ID string `json:"id"`
	// Status 是重放输出项时携带的历史状态。
	Status string `json:"status"`
}

// contentHeaderDTO 只用于选择具体内容块 Decoder。
type contentHeaderDTO struct {
	// Type 是 Responses 内容块判别字段。
	Type string `json:"type"`
}

// textContentDTO 是 input_text 或 output_text 内容块。
type textContentDTO struct {
	// Type 是 input_text 或 output_text。
	Type string `json:"type"`
	// Text 是完整文本。
	Text string `json:"text"`
	// PromptCacheBreakpoint 是尚待共同建模的显式缓存边界。
	PromptCacheBreakpoint json.RawMessage `json:"prompt_cache_breakpoint"`
	// Annotations 是 output_text 的引用信息。
	Annotations json.RawMessage `json:"annotations"`
	// Logprobs 是 output_text 的 token 概率信息。
	Logprobs json.RawMessage `json:"logprobs"`
}

// refusalContentDTO 是历史 Assistant 拒绝内容块。
type refusalContentDTO struct {
	// Type 固定为 refusal。
	Type string `json:"type"`
	// Refusal 是完整拒绝说明。
	Refusal string `json:"refusal"`
}

// imageContentDTO 是 input_image 内容块。
type imageContentDTO struct {
	// Type 固定为 input_image。
	Type string `json:"type"`
	// Detail 是图片解析精度。
	Detail string `json:"detail"`
	// FileID 是可选 Provider 文件引用。
	FileID string `json:"file_id"`
	// ImageURL 是可选 HTTP URL 或 data URL。
	ImageURL string `json:"image_url"`
	// PromptCacheBreakpoint 是尚待共同建模的显式缓存边界。
	PromptCacheBreakpoint json.RawMessage `json:"prompt_cache_breakpoint"`
}

// fileContentDTO 是 input_file 内容块。
type fileContentDTO struct {
	// Type 固定为 input_file。
	Type string `json:"type"`
	// Detail 是文档解析精度。
	Detail string `json:"detail"`
	// FileData 是可选 data URL 文件内容。
	FileData string `json:"file_data"`
	// FileID 是可选 Provider 文件引用。
	FileID string `json:"file_id"`
	// FileURL 是可选 HTTP 文件地址。
	FileURL string `json:"file_url"`
	// Filename 是可选文件标题。
	Filename string `json:"filename"`
	// PromptCacheBreakpoint 是尚待共同建模的显式缓存边界。
	PromptCacheBreakpoint json.RawMessage `json:"prompt_cache_breakpoint"`
}

// functionCallDTO 是历史函数工具调用输入项。
type functionCallDTO struct {
	// Type 固定为 function_call。
	Type string `json:"type"`
	// ID 是 Provider 输出项 ID。
	ID string `json:"id"`
	// CallID 是工具结果精确引用的调用 ID。
	CallID string `json:"call_id"`
	// Name 是函数工具名。
	Name string `json:"name"`
	// Namespace 是函数工具所属的可选命名空间。
	Namespace string `json:"namespace"`
	// Arguments 是 JSON Object 编码字符串。
	Arguments string `json:"arguments"`
	// Status 是历史调用状态。
	Status string `json:"status"`
}

// functionCallOutputDTO 是函数工具结果输入项。
type functionCallOutputDTO struct {
	// Type 固定为 function_call_output。
	Type string `json:"type"`
	// ID 是 Provider 输出项 ID。
	ID string `json:"id"`
	// CallID 是被结果精确引用的调用 ID。
	CallID string `json:"call_id"`
	// Output 是字符串或多模态内容块数组。
	Output json.RawMessage `json:"output"`
	// Status 是历史工具结果状态。
	Status string `json:"status"`
}

// reasoningItemDTO 是历史 Responses reasoning 输入项。
type reasoningItemDTO struct {
	// Type 固定为 reasoning。
	Type string `json:"type"`
	// ID 是 reasoning 输出项 ID。
	ID string `json:"id"`
	// Summary 是可见 reasoning 摘要列表。
	Summary []reasoningSummaryDTO `json:"summary"`
	// EncryptedContent 是无状态连续性所需的加密数据。
	EncryptedContent string `json:"encrypted_content"`
	// Content 是当前阶段尚未建模的 reasoning 原文列表。
	Content json.RawMessage `json:"content"`
	// Status 是历史 reasoning 项状态。
	Status string `json:"status"`
}

// reasoningSummaryDTO 是 reasoning 摘要文本项。
type reasoningSummaryDTO struct {
	// Type 固定为 summary_text。
	Type string `json:"type"`
	// Text 是可见摘要文本。
	Text string `json:"text"`
}

// functionToolDTO 是 Responses function 工具定义。
type functionToolDTO struct {
	// Type 固定为 function。
	Type string `json:"type"`
	// Name 是工具名。
	Name string `json:"name"`
	// Description 是可选工具说明。
	Description string `json:"description"`
	// Parameters 是 JSON Schema Object。
	Parameters json.RawMessage `json:"parameters"`
	// Strict 是可选严格 Schema 遵循意图。
	Strict *bool `json:"strict"`
}

// clientToolSearchDTO 是 Codex CLI 客户端执行的延迟工具发现元工具。
//
// 它只在客户端边界出现，不能被误编码成上游可执行的 function tool。
type clientToolSearchDTO struct {
	// Type 固定为 tool_search。
	Type string `json:"type"`
	// Execution 固定为 client，表示由 Codex 客户端执行。
	Execution string `json:"execution"`
	// Description 是客户端展示给模型的工具发现说明。
	Description string `json:"description"`
	// Parameters 是 Codex 当前请求的工具发现参数 Schema。
	Parameters json.RawMessage `json:"parameters"`
}

// namespaceToolDTO 是 Responses namespace 及其函数子工具集合。
type namespaceToolDTO struct {
	// Type 固定为 namespace。
	Type string `json:"type"`
	// Name 是 namespace 身份。
	Name string `json:"name"`
	// Description 是 namespace 的可选公共说明。
	Description string `json:"description"`
	// Tools 是 namespace 内的函数工具。
	Tools []json.RawMessage `json:"tools"`
}

// webSearchToolDTO 是 Responses 服务器侧 web_search 配置。
type webSearchToolDTO struct {
	// Type 固定为 web_search。
	Type string `json:"type"`
	// ExternalWebAccess 表示是否允许实时外网内容。
	ExternalWebAccess *bool `json:"external_web_access"`
	// Filters 是可选结果来源过滤器。
	Filters json.RawMessage `json:"filters"`
	// UserLocation 是可选近似用户位置。
	UserLocation json.RawMessage `json:"user_location"`
	// SearchContextSize 是 Claude 当前没有等价控制的搜索上下文大小。
	SearchContextSize string `json:"search_context_size"`
	// SearchContentTypes 是 Claude 当前没有等价控制的内容类型列表。
	SearchContentTypes []string `json:"search_content_types"`
}

// webSearchFiltersDTO 保存可跨协议映射的允许域名列表。
type webSearchFiltersDTO struct {
	AllowedDomains []string `json:"allowed_domains"`
}

// webSearchLocationDTO 保存 Responses approximate 位置字段。
type webSearchLocationDTO struct {
	Type     string `json:"type"`
	Country  string `json:"country"`
	Region   string `json:"region"`
	City     string `json:"city"`
	Timezone string `json:"timezone"`
}

// toolChoiceObjectDTO 是命名函数工具选择对象。
type toolChoiceObjectDTO struct {
	// Type 固定为 function。
	Type string `json:"type"`
	// Name 是必须调用的工具名。
	Name string `json:"name"`
	// Namespace 是命名工具所属的可选 namespace。
	Namespace string `json:"namespace"`
}

// reasoningConfigDTO 是 Responses reasoning 请求配置。
type reasoningConfigDTO struct {
	// Effort 是 reasoning 强度。
	Effort string `json:"effort"`
	// Summary 是当前 reasoning 摘要模式。
	Summary string `json:"summary"`
	// GenerateSummary 是已弃用的 reasoning 摘要模式字段。
	GenerateSummary string `json:"generate_summary"`
	// Context 是尚待共同建模的 reasoning 历史范围。
	Context string `json:"context"`
	// Mode 是尚待共同建模的 standard 或 pro 执行模式。
	Mode string `json:"mode"`
}

// textConfigDTO 是 Responses 文本输出配置。
type textConfigDTO struct {
	// Format 是 text、json_schema 或 json_object 输出格式。
	Format json.RawMessage `json:"format"`
	// Verbosity 是尚待共同建模的输出详细程度。
	Verbosity string `json:"verbosity"`
}

// textFormatHeaderDTO 只用于选择具体文本输出格式 Decoder。
type textFormatHeaderDTO struct {
	// Type 是 text、json_schema 或 json_object。
	Type string `json:"type"`
}

// plainTextFormatDTO 是默认普通文本输出格式。
type plainTextFormatDTO struct {
	// Type 固定为 text。
	Type string `json:"type"`
}

// structuredTextFormatDTO 是 JSON Schema 输出格式。
type structuredTextFormatDTO struct {
	// Type 固定为 json_schema。
	Type string `json:"type"`
	// Name 是输出合同名。
	Name string `json:"name"`
	// Description 是可选输出说明。
	Description string `json:"description"`
	// Schema 是 JSON Schema Object。
	Schema json.RawMessage `json:"schema"`
	// Strict 表示是否严格遵循 Schema。
	Strict *bool `json:"strict"`
}

// conversationDTO 是对象形式的 Responses conversation 引用。
type conversationDTO struct {
	// ID 是 conversation 的稳定标识。
	ID string `json:"id"`
}
