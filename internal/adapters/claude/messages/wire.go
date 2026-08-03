package messages

import "encoding/json"

// requestDTO 只描述 Anthropic Messages create 请求线协议。
type requestDTO struct {
	Model             string                `json:"model"`
	MaxTokens         uint64                `json:"max_tokens"`
	Messages          []messageDTO          `json:"messages"`
	System            []contentDTO          `json:"system,omitempty"`
	Stream            bool                  `json:"stream"`
	Temperature       *float64              `json:"temperature,omitempty"`
	TopP              *float64              `json:"top_p,omitempty"`
	TopK              *uint64               `json:"top_k,omitempty"`
	StopSequences     []string              `json:"stop_sequences,omitempty"`
	Tools             []json.RawMessage     `json:"tools,omitempty"`
	ToolChoice        *toolChoiceDTO        `json:"tool_choice,omitempty"`
	Thinking          *thinkingDTO          `json:"thinking,omitempty"`
	OutputConfig      *outputConfigDTO      `json:"output_config,omitempty"`
	Metadata          *metadataDTO          `json:"metadata,omitempty"`
	CacheControl      *cacheControlDTO      `json:"cache_control,omitempty"`
	ContextManagement *contextManagementDTO `json:"context_management,omitempty"`
}

// messageDTO 是 Anthropic Beta Messages 的 user、assistant 或 system 历史消息。
type messageDTO struct {
	Role    string       `json:"role"`
	Content []contentDTO `json:"content"`
}

// contentDTO 是当前 Canonical Content 可映射到的 Messages 内容块联合结构。
type contentDTO struct {
	Type         string           `json:"type"`
	Text         string           `json:"text,omitempty"`
	Source       *sourceDTO       `json:"source,omitempty"`
	Title        string           `json:"title,omitempty"`
	Thinking     *string          `json:"thinking,omitempty"`
	Signature    string           `json:"signature,omitempty"`
	Data         string           `json:"data,omitempty"`
	ID           string           `json:"id,omitempty"`
	Name         string           `json:"name,omitempty"`
	Input        json.RawMessage  `json:"input,omitempty"`
	ToolUseID    string           `json:"tool_use_id,omitempty"`
	Content      any              `json:"content,omitempty"`
	IsError      *bool            `json:"is_error,omitempty"`
	CacheControl *cacheControlDTO `json:"cache_control,omitempty"`
}

// sourceDTO 是图片和文档来源的联合结构。
type sourceDTO struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type,omitempty"`
	Data      string `json:"data,omitempty"`
	URL       string `json:"url,omitempty"`
	FileID    string `json:"file_id,omitempty"`
}

// toolDTO 是 Anthropic custom tool 的完整公开结构。
type toolDTO struct {
	Type                string            `json:"type,omitempty"`
	Name                string            `json:"name"`
	Description         string            `json:"description,omitempty"`
	InputSchema         json.RawMessage   `json:"input_schema"`
	Strict              *bool             `json:"strict,omitempty"`
	AllowedCallers      []string          `json:"allowed_callers,omitempty"`
	DeferLoading        *bool             `json:"defer_loading,omitempty"`
	EagerInputStreaming *bool             `json:"eager_input_streaming,omitempty"`
	InputExamples       []json.RawMessage `json:"input_examples,omitempty"`
	CacheControl        *cacheControlDTO  `json:"cache_control,omitempty"`
}

// webSearchToolDTO 是 Claude 服务器侧网络搜索工具。
type webSearchToolDTO struct {
	Type           string                    `json:"type"`
	Name           string                    `json:"name"`
	AllowedDomains []string                  `json:"allowed_domains,omitempty"`
	UserLocation   *webSearchUserLocationDTO `json:"user_location,omitempty"`
}

// webSearchUserLocationDTO 是 Anthropic approximate 搜索位置。
type webSearchUserLocationDTO struct {
	Type     string `json:"type"`
	Country  string `json:"country,omitempty"`
	Region   string `json:"region,omitempty"`
	City     string `json:"city,omitempty"`
	Timezone string `json:"timezone,omitempty"`
}

// toolChoiceDTO 统一表达 auto、any、none 和指定 tool。
type toolChoiceDTO struct {
	Type                   string `json:"type"`
	Name                   string `json:"name,omitempty"`
	DisableParallelToolUse *bool  `json:"disable_parallel_tool_use,omitempty"`
}

// thinkingDTO 表达 Claude Code 当前发送的 disabled、enabled 和 adaptive 配置。
type thinkingDTO struct {
	Type         string  `json:"type"`
	BudgetTokens *uint64 `json:"budget_tokens,omitempty"`
	Display      string  `json:"display,omitempty"`
}

// outputConfigDTO 同时承载 effort 和 JSON Schema 输出。
type outputConfigDTO struct {
	Effort string           `json:"effort,omitempty"`
	Format *outputFormatDTO `json:"format,omitempty"`
}

// outputFormatDTO 是 Anthropic 结构化输出合同。
type outputFormatDTO struct {
	Type   string          `json:"type"`
	Schema json.RawMessage `json:"schema"`
}

// metadataDTO 只发送客户端明确提供的低敏 user_id。
type metadataDTO struct {
	UserID string `json:"user_id"`
}

// cacheControlDTO 是 Anthropic ephemeral 提示缓存控制。
type cacheControlDTO struct {
	Type  string `json:"type"`
	TTL   string `json:"ttl,omitempty"`
	Scope string `json:"scope,omitempty"`
}

// contextManagementDTO 是 Anthropic 请求级上下文编辑集合。
type contextManagementDTO struct {
	Edits []json.RawMessage `json:"edits"`
}

// contextMetricDTO 是带明确单位的上下文阈值或保留数量。
type contextMetricDTO struct {
	Type  string `json:"type"`
	Value uint64 `json:"value"`
}

// clearThinkingEditDTO 是 clear_thinking_20251015 的线协议结构。
type clearThinkingEditDTO struct {
	Type string          `json:"type"`
	Keep json.RawMessage `json:"keep,omitempty"`
}

// clearToolUsesEditDTO 是 clear_tool_uses_20250919 的线协议结构。
type clearToolUsesEditDTO struct {
	Type            string            `json:"type"`
	Trigger         *contextMetricDTO `json:"trigger,omitempty"`
	Keep            *contextMetricDTO `json:"keep,omitempty"`
	ClearAtLeast    *contextMetricDTO `json:"clear_at_least,omitempty"`
	ClearToolInputs json.RawMessage   `json:"clear_tool_inputs,omitempty"`
	ExcludeTools    []string          `json:"exclude_tools,omitempty"`
}

// streamEventDTO 是 Claude SSE 事件的有界判别结构。
type streamEventDTO struct {
	Type         string          `json:"type"`
	Message      json.RawMessage `json:"message"`
	Index        *uint32         `json:"index"`
	ContentBlock json.RawMessage `json:"content_block"`
	Delta        json.RawMessage `json:"delta"`
	Usage        json.RawMessage `json:"usage"`
}

// messageResponseDTO 是 message_start 和非流式成功响应的共同结构。
type messageResponseDTO struct {
	ID           string            `json:"id"`
	Type         string            `json:"type"`
	Role         string            `json:"role"`
	Model        string            `json:"model"`
	Content      []json.RawMessage `json:"content"`
	StopReason   *string           `json:"stop_reason"`
	StopSequence *string           `json:"stop_sequence"`
	Usage        json.RawMessage   `json:"usage"`
}

// outputContentDTO 覆盖 Claude 当前可产生的客户端输出块。
type outputContentDTO struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	Signature string          `json:"signature"`
	Data      string          `json:"data"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	Citations json.RawMessage `json:"citations"`
}

// contentDeltaDTO 覆盖文本、thinking、signature 和工具参数增量。
type contentDeltaDTO struct {
	Type        string          `json:"type"`
	Text        string          `json:"text"`
	Thinking    string          `json:"thinking"`
	Signature   string          `json:"signature"`
	PartialJSON string          `json:"partial_json"`
	Citation    json.RawMessage `json:"citation"`
}

// webSearchCitationDTO 是 Claude web_search_result_location 引用。
type webSearchCitationDTO struct {
	Type           string  `json:"type"`
	CitedText      string  `json:"cited_text"`
	EncryptedIndex string  `json:"encrypted_index"`
	Title          *string `json:"title"`
	URL            string  `json:"url"`
}

// webSearchResultDTO 是隐藏结果块中的单条服务器搜索结果。
type webSearchResultDTO struct {
	Type             string  `json:"type"`
	EncryptedContent string  `json:"encrypted_content"`
	PageAge          *string `json:"page_age"`
	Title            string  `json:"title"`
	URL              string  `json:"url"`
}

// webSearchResultErrorDTO 是服务器搜索失败结果。
type webSearchResultErrorDTO struct {
	Type      string `json:"type"`
	ErrorCode string `json:"error_code"`
}

// messageDeltaDTO 保存响应终态原因。
type messageDeltaDTO struct {
	StopReason   string  `json:"stop_reason"`
	StopSequence *string `json:"stop_sequence"`
}

// usageDTO 使用指针区分 SSE 中缺省字段与明确的零值。
type usageDTO struct {
	InputTokens              *uint64 `json:"input_tokens"`
	OutputTokens             *uint64 `json:"output_tokens"`
	CacheCreationInputTokens *uint64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     *uint64 `json:"cache_read_input_tokens"`
}
