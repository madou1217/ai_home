package inference

// ReasoningKind 区分可读摘要和各 Provider 不可互换的 reasoning 连续性。
type ReasoningKind string

const (
	// ReasoningSummary 表示可安全展示的 reasoning 摘要。
	ReasoningSummary ReasoningKind = "summary"
	// ReasoningThinking 表示必须连同签名保留的 Claude thinking。
	ReasoningThinking ReasoningKind = "thinking"
	// ReasoningEncrypted 表示 Responses encrypted_content 连续性。
	ReasoningEncrypted ReasoningKind = "encrypted"
	// ReasoningRedacted 表示 Claude 原生 redacted_thinking 连续性。
	ReasoningRedacted ReasoningKind = "redacted"
)

// ReasoningContent 是与普通文本严格分离的历史 reasoning 内容。
type ReasoningContent struct {
	kind          ReasoningKind
	text          string
	signature     string
	encryptedData string
	redactedData  string
}

// NewReasoningSummaryContent 创建可见的 reasoning 摘要内容。
func NewReasoningSummaryContent(text string) (ReasoningContent, error) {
	if !isNonBlankText(text) {
		return ReasoningContent{}, ErrInvalidReasoning
	}
	return ReasoningContent{
		kind: ReasoningSummary,
		text: text,
	}, nil
}

// NewThinkingContent 创建必须原样回传文本和签名的 thinking 内容。
func NewThinkingContent(text string, signature string) (ReasoningContent, error) {
	if !isNonBlankText(text) || !isOpaqueContinuityData(signature) {
		return ReasoningContent{}, ErrInvalidReasoning
	}
	return ReasoningContent{
		kind:      ReasoningThinking,
		text:      text,
		signature: signature,
	}, nil
}

// NewEncryptedReasoningContent 创建必须保真的 Responses encrypted_content。
func NewEncryptedReasoningContent(data string) (ReasoningContent, error) {
	if !isOpaqueContinuityData(data) {
		return ReasoningContent{}, ErrInvalidReasoning
	}
	return ReasoningContent{
		kind:          ReasoningEncrypted,
		encryptedData: data,
	}, nil
}

// NewRedactedReasoningContent 创建 Claude 不可读但可原样回放的连续性内容。
func NewRedactedReasoningContent(data string) (ReasoningContent, error) {
	if !isOpaqueContinuityData(data) {
		return ReasoningContent{}, ErrInvalidReasoning
	}
	return ReasoningContent{
		kind:         ReasoningRedacted,
		redactedData: data,
	}, nil
}

// Kind 返回 reasoning 内容类别。
func (content ReasoningContent) Kind() ContentKind {
	return ContentReasoning
}

// ReasoningKind 返回 reasoning 的具体连续性类别。
func (content ReasoningContent) ReasoningKind() ReasoningKind {
	return content.kind
}

// Text 返回摘要或 thinking 文本，不可读连续性返回空字符串。
func (content ReasoningContent) Text() string {
	return content.text
}

// Signature 返回 thinking 的 Provider 签名，其他类别返回空字符串。
func (content ReasoningContent) Signature() string {
	return content.signature
}

// EncryptedData 返回 Responses encrypted_content 原值，其他类别返回空字符串。
func (content ReasoningContent) EncryptedData() string {
	return content.encryptedData
}

// RedactedData 返回 Claude redacted_thinking 原值，其他类别返回空字符串。
func (content ReasoningContent) RedactedData() string {
	return content.redactedData
}

// IsValid 判断 reasoning 类别所需字段完整且没有混入其他类别字段。
func (content ReasoningContent) IsValid() bool {
	switch content.kind {
	case ReasoningSummary:
		return isNonBlankText(content.text) &&
			content.signature == "" &&
			content.encryptedData == "" &&
			content.redactedData == ""
	case ReasoningThinking:
		return isNonBlankText(content.text) &&
			isOpaqueContinuityData(content.signature) &&
			content.encryptedData == "" &&
			content.redactedData == ""
	case ReasoningEncrypted:
		return content.text == "" &&
			content.signature == "" &&
			isOpaqueContinuityData(content.encryptedData) &&
			content.redactedData == ""
	case ReasoningRedacted:
		return content.text == "" &&
			content.signature == "" &&
			content.encryptedData == "" &&
			isOpaqueContinuityData(content.redactedData)
	default:
		return false
	}
}

// cloneContent 返回 reasoning 连续性值对象的独立语义快照。
func (content ReasoningContent) cloneContent() Content {
	return content
}

// isContent 将 ReasoningContent 限制在 Canonical Content 联合类型内。
func (ReasoningContent) isContent() {}
