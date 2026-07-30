package messages

import "encoding/json"

// requestDTO 只描述 Anthropic Messages create 请求线协议。
type requestDTO struct {
	Model         string           `json:"model"`
	MaxTokens     uint64           `json:"max_tokens"`
	Messages      []messageDTO     `json:"messages"`
	System        []contentDTO     `json:"system,omitempty"`
	Stream        bool             `json:"stream"`
	Temperature   *float64         `json:"temperature,omitempty"`
	TopP          *float64         `json:"top_p,omitempty"`
	TopK          *uint64          `json:"top_k,omitempty"`
	StopSequences []string         `json:"stop_sequences,omitempty"`
	Tools         []toolDTO        `json:"tools,omitempty"`
	ToolChoice    *toolChoiceDTO   `json:"tool_choice,omitempty"`
	Thinking      *thinkingDTO     `json:"thinking,omitempty"`
	OutputConfig  *outputConfigDTO `json:"output_config,omitempty"`
	Metadata      *metadataDTO     `json:"metadata,omitempty"`
	CacheControl  *cacheControlDTO `json:"cache_control,omitempty"`
}

// messageDTO 是 Anthropic 只允许的 user 或 assistant 历史消息。
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
	Thinking     string           `json:"thinking,omitempty"`
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

// toolChoiceDTO 统一表达 auto、any、none 和指定 tool。
type toolChoiceDTO struct {
	Type                   string `json:"type"`
	Name                   string `json:"name,omitempty"`
	DisableParallelToolUse *bool  `json:"disable_parallel_tool_use,omitempty"`
}

// thinkingDTO 表达 disabled、enabled 和 adaptive 三种 thinking 配置。
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
	Citations json.RawMessage `json:"citations"`
}

// contentDeltaDTO 覆盖文本、thinking、signature 和工具参数增量。
type contentDeltaDTO struct {
	Type        string `json:"type"`
	Text        string `json:"text"`
	Thinking    string `json:"thinking"`
	Signature   string `json:"signature"`
	PartialJSON string `json:"partial_json"`
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
