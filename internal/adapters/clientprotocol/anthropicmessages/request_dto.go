package anthropicmessages

import "encoding/json"

// requestDTO 是 Messages create 请求的严格根 DTO。
type requestDTO struct {
	Model         string            `json:"model"`
	MaxTokens     *uint64           `json:"max_tokens"`
	Messages      []json.RawMessage `json:"messages"`
	System        json.RawMessage   `json:"system"`
	Stream        bool              `json:"stream"`
	Temperature   *float64          `json:"temperature"`
	TopP          *float64          `json:"top_p"`
	TopK          *uint64           `json:"top_k"`
	StopSequences []string          `json:"stop_sequences"`
	Tools         []json.RawMessage `json:"tools"`
	ToolChoice    json.RawMessage   `json:"tool_choice"`
	Thinking      json.RawMessage   `json:"thinking"`
	OutputConfig  json.RawMessage   `json:"output_config"`
	Metadata      json.RawMessage   `json:"metadata"`
	ServiceTier   *string           `json:"service_tier"`
	CacheControl  json.RawMessage   `json:"cache_control"`
	Container     json.RawMessage   `json:"container"`
	InferenceGeo  json.RawMessage   `json:"inference_geo"`
}

// messageDTO 是 user 或 assistant 历史消息。
type messageDTO struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

// contentHeaderDTO 是内容块联合类型的判别头。
type contentHeaderDTO struct {
	Type string `json:"type"`
}

// textContentDTO 是普通文本输入块。
type textContentDTO struct {
	Type         string          `json:"type"`
	Text         string          `json:"text"`
	CacheControl json.RawMessage `json:"cache_control"`
	Citations    json.RawMessage `json:"citations"`
}

// imageContentDTO 是图片输入块。
type imageContentDTO struct {
	Type         string          `json:"type"`
	Source       json.RawMessage `json:"source"`
	CacheControl json.RawMessage `json:"cache_control"`
}

// documentContentDTO 是 PDF、URL 或纯文本文档输入块。
type documentContentDTO struct {
	Type         string          `json:"type"`
	Source       json.RawMessage `json:"source"`
	Title        *string         `json:"title"`
	Context      *string         `json:"context"`
	Citations    json.RawMessage `json:"citations"`
	CacheControl json.RawMessage `json:"cache_control"`
}

// sourceHeaderDTO 是媒体来源联合类型的判别头。
type sourceHeaderDTO struct {
	Type string `json:"type"`
}

// base64SourceDTO 是图片或 PDF 的 Base64 来源。
type base64SourceDTO struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
}

// urlSourceDTO 是图片或 PDF 的 URL 来源。
type urlSourceDTO struct {
	Type string `json:"type"`
	URL  string `json:"url"`
}

// textSourceDTO 是 document 的纯文本来源。
type textSourceDTO struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
}

// thinkingContentDTO 是可回传的 Claude thinking 历史块。
type thinkingContentDTO struct {
	Type      string `json:"type"`
	Thinking  string `json:"thinking"`
	Signature string `json:"signature"`
}

// redactedThinkingContentDTO 是不可读但必须保真的 thinking 连续性。
type redactedThinkingContentDTO struct {
	Type string `json:"type"`
	Data string `json:"data"`
}

// toolUseContentDTO 是 assistant 发起的客户端工具调用。
type toolUseContentDTO struct {
	Type         string          `json:"type"`
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Input        json.RawMessage `json:"input"`
	Caller       json.RawMessage `json:"caller"`
	CacheControl json.RawMessage `json:"cache_control"`
}

// toolResultContentDTO 是 user 返回的客户端工具结果。
type toolResultContentDTO struct {
	Type         string          `json:"type"`
	ToolUseID    string          `json:"tool_use_id"`
	Content      json.RawMessage `json:"content"`
	IsError      *bool           `json:"is_error"`
	CacheControl json.RawMessage `json:"cache_control"`
}

// toolDTO 是当前阶段支持的 Anthropic custom tool。
type toolDTO struct {
	Type                *string           `json:"type"`
	Name                string            `json:"name"`
	Description         string            `json:"description"`
	InputSchema         json.RawMessage   `json:"input_schema"`
	Strict              *bool             `json:"strict"`
	AllowedCallers      []string          `json:"allowed_callers"`
	DeferLoading        *bool             `json:"defer_loading"`
	EagerInputStreaming *bool             `json:"eager_input_streaming"`
	InputExamples       []json.RawMessage `json:"input_examples"`
	CacheControl        json.RawMessage   `json:"cache_control"`
}

// toolChoiceHeaderDTO 是工具选择联合类型的判别头。
type toolChoiceHeaderDTO struct {
	Type string `json:"type"`
}

// toolChoiceModeDTO 是 auto、any 或 none 工具选择。
type toolChoiceModeDTO struct {
	Type                   string `json:"type"`
	DisableParallelToolUse *bool  `json:"disable_parallel_tool_use"`
}

// namedToolChoiceDTO 是精确指定工具的选择。
type namedToolChoiceDTO struct {
	Type                   string `json:"type"`
	Name                   string `json:"name"`
	DisableParallelToolUse *bool  `json:"disable_parallel_tool_use"`
}

// thinkingHeaderDTO 是 thinking 配置联合类型的判别头。
type thinkingHeaderDTO struct {
	Type string `json:"type"`
}

// budgetThinkingDTO 是明确 token 预算的 thinking 配置。
type budgetThinkingDTO struct {
	Type         string  `json:"type"`
	BudgetTokens *uint64 `json:"budget_tokens"`
	Display      *string `json:"display"`
}

// adaptiveThinkingDTO 是模型自适应 thinking 配置。
type adaptiveThinkingDTO struct {
	Type    string  `json:"type"`
	Display *string `json:"display"`
}

// disabledThinkingDTO 是显式禁用 thinking 的配置。
type disabledThinkingDTO struct {
	Type string `json:"type"`
}

// outputConfigDTO 是结构化输出和 effort 的组合配置。
type outputConfigDTO struct {
	Effort *string         `json:"effort"`
	Format json.RawMessage `json:"format"`
}

// outputFormatDTO 是 Anthropic JSON Schema 输出格式。
type outputFormatDTO struct {
	Type   string          `json:"type"`
	Schema json.RawMessage `json:"schema"`
}

// metadataDTO 是当前 Messages 公开的低敏请求 metadata。
type metadataDTO struct {
	UserID *string `json:"user_id"`
}

// cacheControlDTO 是 Anthropic ephemeral 提示缓存断点。
type cacheControlDTO struct {
	Type  string  `json:"type"`
	TTL   *string `json:"ttl"`
	Scope *string `json:"scope"`
}
