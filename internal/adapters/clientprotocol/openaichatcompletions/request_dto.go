package openaichatcompletions

import "encoding/json"

// requestDTO 只描述 Chat Completions 客户端线协议。
type requestDTO struct {
	// Model 是客户端请求的模型或别名。
	Model string `json:"model"`
	// Messages 是按上下文顺序排列的历史消息。
	Messages []json.RawMessage `json:"messages"`
	// Tools 是当前请求声明的函数工具。
	Tools []json.RawMessage `json:"tools"`
	// ToolChoice 是字符串模式或命名函数选择对象。
	ToolChoice json.RawMessage `json:"tool_choice"`
	// ParallelToolCalls 表示是否允许并行工具调用。
	ParallelToolCalls *bool `json:"parallel_tool_calls"`
	// ReasoningEffort 是抽象 reasoning 强度。
	ReasoningEffort *string `json:"reasoning_effort"`
	// ResponseFormat 是普通文本或 JSON Schema 输出合同。
	ResponseFormat json.RawMessage `json:"response_format"`
	// Stream 表示客户端是否请求 SSE 增量输出。
	Stream bool `json:"stream"`
	// StreamOptions 保存 usage 尾块等流式意图。
	StreamOptions json.RawMessage `json:"stream_options"`
	// MaxCompletionTokens 是当前推荐的输出 token 上限。
	MaxCompletionTokens *uint64 `json:"max_completion_tokens"`
	// MaxTokens 是兼容旧客户端的输出 token 上限。
	MaxTokens *uint64 `json:"max_tokens"`
	// Temperature 是可选采样温度。
	Temperature *float64 `json:"temperature"`
	// TopP 是可选 nucleus sampling 概率。
	TopP *float64 `json:"top_p"`
	// Stop 是字符串或字符串数组形式的停止序列。
	Stop json.RawMessage `json:"stop"`
	// Store 表示客户端是否要求 Provider 保存响应状态。
	Store *bool `json:"store"`
	// User 是客户端提供的低敏最终用户标识。
	User *string `json:"user"`
	// N 是请求生成的 choice 数量。
	N *uint64 `json:"n"`
	// Logprobs 表示是否返回 token 对数概率。
	Logprobs *bool `json:"logprobs"`
	// TopLogprobs 是每个位置返回的高概率 token 数量。
	TopLogprobs *uint64 `json:"top_logprobs"`
	// Audio 是语音输出配置。
	Audio json.RawMessage `json:"audio"`
	// Modalities 是请求的文本或语音输出类别。
	Modalities []string `json:"modalities"`
	// Prediction 是预测输出加速配置。
	Prediction json.RawMessage `json:"prediction"`
	// FrequencyPenalty 是频率惩罚。
	FrequencyPenalty *float64 `json:"frequency_penalty"`
	// PresencePenalty 是出现惩罚。
	PresencePenalty *float64 `json:"presence_penalty"`
	// LogitBias 是 token 级采样偏置。
	LogitBias json.RawMessage `json:"logit_bias"`
	// Seed 是尽力确定性采样种子。
	Seed *int64 `json:"seed"`
	// ServiceTier 是 OpenAI 服务层级提示。
	ServiceTier *string `json:"service_tier"`
	// Metadata 是响应存储关联的客户端元数据。
	Metadata json.RawMessage `json:"metadata"`
	// WebSearchOptions 是内置网络搜索配置。
	WebSearchOptions json.RawMessage `json:"web_search_options"`
	// Functions 是已经废弃的顶层函数定义。
	Functions []json.RawMessage `json:"functions"`
	// FunctionCall 是已经废弃的函数选择配置。
	FunctionCall json.RawMessage `json:"function_call"`
}

// messageDTO 是五类 Chat 历史消息的字段并集。
type messageDTO struct {
	// Role 是 system、developer、user、assistant 或 tool。
	Role string `json:"role"`
	// Content 是字符串、null 或内容块数组。
	Content json.RawMessage `json:"content"`
	// Name 是旧式参与方名称。
	Name *string `json:"name"`
	// ReasoningContent 是 Chat 扩展的可见 reasoning。
	ReasoningContent *string `json:"reasoning_content"`
	// Refusal 是 Assistant 的策略拒绝内容。
	Refusal *string `json:"refusal"`
	// ToolCalls 是 Assistant 发起的完整函数调用。
	ToolCalls []json.RawMessage `json:"tool_calls"`
	// ToolCallID 是 tool 结果引用的精确调用 ID。
	ToolCallID *string `json:"tool_call_id"`
	// FunctionCall 是已经废弃的单函数调用字段。
	FunctionCall json.RawMessage `json:"function_call"`
	// Audio 是 Assistant 音频输出引用。
	Audio json.RawMessage `json:"audio"`
}

// contentHeaderDTO 只用于选择具体消息内容块 Decoder。
type contentHeaderDTO struct {
	// Type 是文本或图片 URL 内容判别字段。
	Type string `json:"type"`
}

// textContentDTO 是 Chat 文本内容块。
type textContentDTO struct {
	// Type 固定为 text。
	Type string `json:"type"`
	// Text 是非空可见文本。
	Text string `json:"text"`
}

// imageContentDTO 是 Chat 图片 URL 内容块。
type imageContentDTO struct {
	// Type 固定为 image_url。
	Type string `json:"type"`
	// ImageURL 保存实际来源和解析精度。
	ImageURL imageURLDTO `json:"image_url"`
}

// imageURLDTO 保存 URL 和解析精度。
type imageURLDTO struct {
	// URL 是 HTTP 地址或 Base64 data URL。
	URL string `json:"url"`
	// Detail 是 auto、low 或 high。
	Detail string `json:"detail"`
}

// toolCallDTO 是 Assistant 历史函数调用。
type toolCallDTO struct {
	// ID 是后续工具结果必须引用的调用标识。
	ID string `json:"id"`
	// Type 固定为 function。
	Type string `json:"type"`
	// Function 保存工具名和参数。
	Function toolFunctionDTO `json:"function"`
}

// toolFunctionDTO 保存函数名和 JSON Object 参数字符串。
type toolFunctionDTO struct {
	// Name 是函数工具名。
	Name string `json:"name"`
	// Arguments 是编码为字符串的 JSON Object。
	Arguments string `json:"arguments"`
}

// functionToolDTO 是 Chat function 工具定义。
type functionToolDTO struct {
	// Type 固定为 function。
	Type string `json:"type"`
	// Function 是函数工具合同。
	Function functionDefinitionDTO `json:"function"`
}

// functionDefinitionDTO 保存函数工具的公开合同。
type functionDefinitionDTO struct {
	// Name 是函数工具名。
	Name string `json:"name"`
	// Description 是可选工具说明。
	Description string `json:"description"`
	// Parameters 是 JSON Schema Object。
	Parameters json.RawMessage `json:"parameters"`
	// Strict 区分缺省、false 和 true。
	Strict *bool `json:"strict"`
}

// toolChoiceObjectDTO 是命名函数工具选择对象。
type toolChoiceObjectDTO struct {
	// Type 固定为 function。
	Type string `json:"type"`
	// Function 保存必须调用的函数名。
	Function namedFunctionDTO `json:"function"`
}

// namedFunctionDTO 只保存命名工具选择需要的函数名。
type namedFunctionDTO struct {
	// Name 是必须调用的函数名。
	Name string `json:"name"`
}

// responseFormatHeaderDTO 选择文本或 JSON Schema 输出格式。
type responseFormatHeaderDTO struct {
	// Type 是 text、json_schema 或 json_object。
	Type string `json:"type"`
}

// textResponseFormatDTO 是默认文本输出格式。
type textResponseFormatDTO struct {
	// Type 固定为 text。
	Type string `json:"type"`
}

// structuredResponseFormatDTO 是 Chat JSON Schema 输出格式。
type structuredResponseFormatDTO struct {
	// Type 固定为 json_schema。
	Type string `json:"type"`
	// JSONSchema 是命名结构化输出合同。
	JSONSchema structuredJSONSchemaDTO `json:"json_schema"`
}

// structuredJSONSchemaDTO 保存命名 JSON Schema 合同。
type structuredJSONSchemaDTO struct {
	// Name 是结构化输出合同名。
	Name string `json:"name"`
	// Description 是可选输出说明。
	Description string `json:"description"`
	// Schema 是 JSON Schema Object。
	Schema json.RawMessage `json:"schema"`
	// Strict 表示是否严格遵循 Schema。
	Strict *bool `json:"strict"`
}

// streamOptionsDTO 保存 Chat 流式响应附加意图。
type streamOptionsDTO struct {
	// IncludeUsage 表示是否在 DONE 前输出独立 usage 尾块。
	IncludeUsage *bool `json:"include_usage"`
}
