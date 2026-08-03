package responses

import "encoding/json"

// requestDTO 只描述 Codex Responses 请求线协议。
type requestDTO struct {
	Model             string             `json:"model"`
	Instructions      string             `json:"instructions,omitempty"`
	Input             []inputItemDTO     `json:"input"`
	Tools             *[]json.RawMessage `json:"tools,omitempty"`
	ToolChoice        any                `json:"tool_choice"`
	ParallelToolCalls bool               `json:"parallel_tool_calls"`
	Reasoning         *reasoningDTO      `json:"reasoning"`
	Store             bool               `json:"store"`
	Stream            bool               `json:"stream"`
	Include           []string           `json:"include"`
	ServiceTier       *string            `json:"service_tier,omitempty"`
	PromptCacheKey    *string            `json:"prompt_cache_key,omitempty"`
	Text              *textControlDTO    `json:"text,omitempty"`
	ClientMetadata    map[string]string  `json:"client_metadata,omitempty"`
}

// inputItemDTO 覆盖当前 Canonical Request 能产生的 Responses 输入项。
type inputItemDTO struct {
	Type             string                `json:"type"`
	Role             string                `json:"role,omitempty"`
	AdditionalTools  *[]json.RawMessage    `json:"tools,omitempty"`
	Content          []contentItemDTO      `json:"content,omitempty"`
	Phase            string                `json:"phase,omitempty"`
	Name             string                `json:"name,omitempty"`
	Namespace        string                `json:"namespace,omitempty"`
	Arguments        string                `json:"arguments,omitempty"`
	CallID           string                `json:"call_id,omitempty"`
	Output           any                   `json:"output,omitempty"`
	Summary          []reasoningSummaryDTO `json:"summary,omitempty"`
	EncryptedContent string                `json:"encrypted_content,omitempty"`
}

// contentItemDTO 是消息或工具结果中的类型化内容块。
type contentItemDTO struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Refusal  string `json:"refusal,omitempty"`
	Detail   string `json:"detail,omitempty"`
	FileID   string `json:"file_id,omitempty"`
	ImageURL string `json:"image_url,omitempty"`
	FileData string `json:"file_data,omitempty"`
	FileURL  string `json:"file_url,omitempty"`
	Filename string `json:"filename,omitempty"`
}

// reasoningSummaryDTO 是 Responses reasoning 的可见摘要。
type reasoningSummaryDTO struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// toolDTO 是 Codex function 工具定义。
type toolDTO struct {
	Type         string          `json:"type"`
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	Strict       bool            `json:"strict"`
	DeferLoading *bool           `json:"defer_loading,omitempty"`
	Parameters   json.RawMessage `json:"parameters"`
}

// namespaceToolDTO 保留 namespace 与其局部函数列表的层级关系。
type namespaceToolDTO struct {
	Type        string    `json:"type"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Tools       []toolDTO `json:"tools"`
}

// webSearchToolDTO 是 Codex 服务器侧网络搜索配置。
type webSearchToolDTO struct {
	Type              string                    `json:"type"`
	ExternalWebAccess *bool                     `json:"external_web_access,omitempty"`
	Filters           *webSearchFiltersDTO      `json:"filters,omitempty"`
	UserLocation      *webSearchUserLocationDTO `json:"user_location,omitempty"`
}

// webSearchFiltersDTO 保存允许搜索的来源域名。
type webSearchFiltersDTO struct {
	AllowedDomains []string `json:"allowed_domains,omitempty"`
}

// webSearchUserLocationDTO 保存不含精确坐标的近似位置。
type webSearchUserLocationDTO struct {
	Type     string `json:"type"`
	Country  string `json:"country,omitempty"`
	Region   string `json:"region,omitempty"`
	City     string `json:"city,omitempty"`
	Timezone string `json:"timezone,omitempty"`
}

// namedToolChoiceDTO 是必须调用指定 function 的选择合同。
type namedToolChoiceDTO struct {
	Type      string `json:"type"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
}

// reasoningDTO 是 Codex 支持的 effort/summary 推理控制。
type reasoningDTO struct {
	Effort  string `json:"effort,omitempty"`
	Summary string `json:"summary,omitempty"`
	Context string `json:"context,omitempty"`
}

// textControlDTO 是 Responses 文本详细度和结构化输出外层合同。
type textControlDTO struct {
	Verbosity string         `json:"verbosity,omitempty"`
	Format    *textFormatDTO `json:"format,omitempty"`
}

// textFormatDTO 是 JSON Schema 输出合同。
type textFormatDTO struct {
	Type        string          `json:"type"`
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Schema      json.RawMessage `json:"schema"`
	Strict      bool            `json:"strict"`
}

// streamEventDTO 是所有已确认 Responses SSE 事件的有界判别结构。
type streamEventDTO struct {
	Type         string          `json:"type"`
	OutputIndex  *uint32         `json:"output_index"`
	ContentIndex *uint32         `json:"content_index"`
	SummaryIndex *uint32         `json:"summary_index"`
	ItemID       string          `json:"item_id"`
	CallID       string          `json:"call_id"`
	Name         string          `json:"name"`
	Namespace    string          `json:"namespace"`
	Delta        string          `json:"delta"`
	Text         string          `json:"text"`
	Refusal      string          `json:"refusal"`
	Arguments    string          `json:"arguments"`
	Input        string          `json:"input"`
	Part         json.RawMessage `json:"part"`
	Item         json.RawMessage `json:"item"`
	Response     json.RawMessage `json:"response"`
}

// responseDTO 是非流式响应或 SSE 终态中的响应快照。
type responseDTO struct {
	ID                string                `json:"id"`
	Model             string                `json:"model"`
	Status            string                `json:"status"`
	EndTurn           *bool                 `json:"end_turn"`
	Output            []outputItemDTO       `json:"output"`
	Usage             *usageDTO             `json:"usage"`
	Error             json.RawMessage       `json:"error"`
	IncompleteDetails *incompleteDetailsDTO `json:"incomplete_details"`
}

// incompleteDetailsDTO 保存 Responses 可公开映射的未完成原因。
type incompleteDetailsDTO struct {
	Reason string `json:"reason"`
}

// outputItemDTO 是 Responses 完整输出项。
type outputItemDTO struct {
	ID               string                `json:"id"`
	Type             string                `json:"type"`
	Role             string                `json:"role"`
	Status           string                `json:"status"`
	Phase            string                `json:"phase"`
	Content          []outputContentDTO    `json:"content"`
	Name             string                `json:"name"`
	Namespace        string                `json:"namespace"`
	Arguments        string                `json:"arguments"`
	Input            string                `json:"input"`
	CallID           string                `json:"call_id"`
	Summary          []reasoningSummaryDTO `json:"summary"`
	EncryptedContent string                `json:"encrypted_content"`
	Action           *webSearchActionDTO   `json:"action"`
}

// webSearchActionDTO 覆盖 Responses 当前公开的搜索动作联合类型。
type webSearchActionDTO struct {
	Type    string                     `json:"type"`
	Query   string                     `json:"query"`
	Queries []string                   `json:"queries"`
	Sources []webSearchActionSourceDTO `json:"sources"`
	URL     string                     `json:"url"`
	Pattern string                     `json:"pattern"`
}

// webSearchActionSourceDTO 是搜索动作返回的公开 URL 来源。
type webSearchActionSourceDTO struct {
	Type string `json:"type"`
	URL  string `json:"url"`
}

// outputContentDTO 是 Assistant 消息中的完整文本或拒绝块。
type outputContentDTO struct {
	Type    string `json:"type"`
	Text    string `json:"text"`
	Refusal string `json:"refusal"`
}

// usageDTO 是 Responses 返回的累计 token 明细。
type usageDTO struct {
	InputTokens        uint64                 `json:"input_tokens"`
	InputTokenDetails  *inputTokenDetailsDTO  `json:"input_tokens_details"`
	OutputTokens       uint64                 `json:"output_tokens"`
	OutputTokenDetails *outputTokenDetailsDTO `json:"output_tokens_details"`
	TotalTokens        *uint64                `json:"total_tokens"`
}

// inputTokenDetailsDTO 保存缓存命中的输入 token。
type inputTokenDetailsDTO struct {
	CachedTokens uint64 `json:"cached_tokens"`
}

// outputTokenDetailsDTO 保存 reasoning 输出 token。
type outputTokenDetailsDTO struct {
	ReasoningTokens uint64 `json:"reasoning_tokens"`
}
