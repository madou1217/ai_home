package inference

import (
	"encoding/base64"
	"io"
	"mime"
	"net/url"
	"strings"
)

// ContentKind 是 Canonical Message 中不会静默丢失的内容类别。
type ContentKind string

const (
	// ContentText 表示普通可见文本。
	ContentText ContentKind = "text"
	// ContentRefusal 表示模型因安全或策略拒绝生成的独立内容。
	ContentRefusal ContentKind = "refusal"
	// ContentImage 表示图片输入。
	ContentImage ContentKind = "image"
	// ContentDocument 表示文档输入。
	ContentDocument ContentKind = "document"
	// ContentToolCall 表示 Assistant 发起的工具调用。
	ContentToolCall ContentKind = "tool_call"
	// ContentToolResult 表示 User 返回的精确工具结果。
	ContentToolResult ContentKind = "tool_result"
	// ContentReasoning 表示 reasoning、thinking 或加密连续性数据。
	ContentReasoning ContentKind = "reasoning"
)

// IsValid 判断内容类别是否已经注册。
func (kind ContentKind) IsValid() bool {
	switch kind {
	case ContentText,
		ContentRefusal,
		ContentImage,
		ContentDocument,
		ContentToolCall,
		ContentToolResult,
		ContentReasoning:
		return true
	default:
		return false
	}
}

// Content 是 Canonical Message 允许持有的封闭内容联合类型。
//
// 未导出的 cloneContent 和 isContent 方法阻止应用层注入未校验实现。
type Content interface {
	// Kind 返回不会依赖 Provider JSON 的稳定内容类别。
	Kind() ContentKind
	cloneContent() Content
	isContent()
}

// TextContent 是经过 UTF-8 和控制字符校验的可见文本值对象。
type TextContent struct {
	text string
}

// NewTextContent 创建非空的普通文本内容。
func NewTextContent(text string) (TextContent, error) {
	if !isNonBlankText(text) {
		return TextContent{}, ErrInvalidContent
	}
	return TextContent{text: text}, nil
}

// Kind 返回普通文本类别。
func (content TextContent) Kind() ContentKind {
	return ContentText
}

// Text 返回不可变的普通文本。
func (content TextContent) Text() string {
	return content.text
}

// IsValid 判断文本内容仍满足构造不变量。
func (content TextContent) IsValid() bool {
	return isNonBlankText(content.text)
}

// cloneContent 返回文本值对象的独立语义快照。
func (content TextContent) cloneContent() Content {
	return content
}

// isContent 将 TextContent 限制在 Canonical Content 联合类型内。
func (TextContent) isContent() {}

// MediaSourceKind 是图片和文档的规范来源类别。
type MediaSourceKind string

const (
	// MediaSourceURL 表示可由 Provider 获取的 HTTP 或 HTTPS 地址。
	MediaSourceURL MediaSourceKind = "url"
	// MediaSourceBase64 表示没有 data URL 前缀的 Base64 数据。
	MediaSourceBase64 MediaSourceKind = "base64"
	// MediaSourceText 表示文档内联的原始文本。
	MediaSourceText MediaSourceKind = "text"
	// MediaSourceFileID 表示 Provider 文件存储中的稳定文件引用。
	MediaSourceFileID MediaSourceKind = "file_id"
)

// MediaSource 是图片或文档的不可变来源。
//
// value 可能含大体积数据或签名 URL，日志层不得直接输出该字段。
type MediaSource struct {
	kind      MediaSourceKind
	mediaType string
	value     string
}

// NewURLMediaSource 创建可跨 Codex 和 Claude Adapter 传输的 URL 来源。
func NewURLMediaSource(rawURL string, mediaType string) (MediaSource, error) {
	parsedURL, err := url.ParseRequestURI(rawURL)
	if err != nil ||
		(parsedURL.Scheme != "http" && parsedURL.Scheme != "https") ||
		parsedURL.Host == "" ||
		!isValidOptionalMediaType(mediaType) {
		return MediaSource{}, ErrInvalidContent
	}
	return MediaSource{
		kind:      MediaSourceURL,
		mediaType: mediaType,
		value:     rawURL,
	}, nil
}

// NewFileIDMediaSource 创建由客户端协议明确提供的 Provider 文件引用。
func NewFileIDMediaSource(fileID string) (MediaSource, error) {
	if !isCanonicalOpaqueID(fileID) {
		return MediaSource{}, ErrInvalidContent
	}
	return MediaSource{
		kind:  MediaSourceFileID,
		value: fileID,
	}, nil
}

// NewBase64MediaSource 创建经过完整解码校验的内联二进制来源。
func NewBase64MediaSource(mediaType string, data string) (MediaSource, error) {
	if !isValidMediaType(mediaType) || data == "" {
		return MediaSource{}, ErrInvalidContent
	}
	decoder := base64.NewDecoder(base64.StdEncoding, strings.NewReader(data))
	if _, err := io.Copy(io.Discard, decoder); err != nil {
		return MediaSource{}, ErrInvalidContent
	}
	return MediaSource{
		kind:      MediaSourceBase64,
		mediaType: mediaType,
		value:     data,
	}, nil
}

// NewTextMediaSource 创建保留文档语义的内联文本来源。
func NewTextMediaSource(mediaType string, text string) (MediaSource, error) {
	if !isValidMediaType(mediaType) || !isNonBlankText(text) {
		return MediaSource{}, ErrInvalidContent
	}
	return MediaSource{
		kind:      MediaSourceText,
		mediaType: mediaType,
		value:     text,
	}, nil
}

// Kind 返回媒体来源类别。
func (source MediaSource) Kind() MediaSourceKind {
	return source.kind
}

// MediaType 返回经过语法校验的 MIME 类型。
func (source MediaSource) MediaType() string {
	return source.mediaType
}

// Value 返回来源原值。
//
// 调用方不得把 Base64 数据或签名 URL 写入普通日志。
func (source MediaSource) Value() string {
	return source.value
}

// IsValid 判断媒体来源仍满足 URL、Base64 或内联文本约束。
func (source MediaSource) IsValid() bool {
	switch source.kind {
	case MediaSourceURL:
		_, err := NewURLMediaSource(source.value, source.mediaType)
		return err == nil
	case MediaSourceBase64:
		_, err := NewBase64MediaSource(source.mediaType, source.value)
		return err == nil
	case MediaSourceText:
		_, err := NewTextMediaSource(source.mediaType, source.value)
		return err == nil
	case MediaSourceFileID:
		_, err := NewFileIDMediaSource(source.value)
		return err == nil && source.mediaType == ""
	default:
		return false
	}
}

// isValidOptionalMediaType 判断可选 MIME 类型为空或满足完整语法。
func isValidOptionalMediaType(value string) bool {
	return value == "" || isValidMediaType(value)
}

// isValidMediaType 判断 MIME 类型语法完整且没有被静默规范化。
func isValidMediaType(value string) bool {
	if value == "" || strings.TrimSpace(value) != value {
		return false
	}
	parsed, parameters, err := mime.ParseMediaType(value)
	return err == nil && parsed == value && len(parameters) == 0
}

// ImageDetail 表示客户端对图片解析精度的明确意图。
type ImageDetail string

const (
	// ImageDetailAuto 表示由上游模型决定图片解析精度。
	ImageDetailAuto ImageDetail = "auto"
	// ImageDetailLow 表示请求低成本图片解析。
	ImageDetailLow ImageDetail = "low"
	// ImageDetailHigh 表示请求高精度图片解析。
	ImageDetailHigh ImageDetail = "high"
	// ImageDetailOriginal 表示请求保留原始图片尺寸和空间细节。
	ImageDetailOriginal ImageDetail = "original"
)

// IsValid 判断图片精度是否可以无歧义映射。
func (detail ImageDetail) IsValid() bool {
	return detail == ImageDetailAuto ||
		detail == ImageDetailLow ||
		detail == ImageDetailHigh ||
		detail == ImageDetailOriginal
}

// ImageContent 是保留来源与解析精度的图片输入值对象。
type ImageContent struct {
	source MediaSource
	detail ImageDetail
}

// NewImageContent 创建图片输入，拒绝把文本文档伪装成图片。
func NewImageContent(source MediaSource, detail ImageDetail) (ImageContent, error) {
	if !source.IsValid() ||
		source.kind == MediaSourceText ||
		(source.mediaType != "" && !strings.HasPrefix(source.mediaType, "image/")) ||
		!detail.IsValid() {
		return ImageContent{}, ErrInvalidContent
	}
	return ImageContent{source: source, detail: detail}, nil
}

// Kind 返回图片内容类别。
func (content ImageContent) Kind() ContentKind {
	return ContentImage
}

// Source 返回图片来源快照。
func (content ImageContent) Source() MediaSource {
	return content.source
}

// Detail 返回图片解析精度意图。
func (content ImageContent) Detail() ImageDetail {
	return content.detail
}

// IsValid 判断图片来源和解析精度仍满足不变量。
func (content ImageContent) IsValid() bool {
	_, err := NewImageContent(content.source, content.detail)
	return err == nil
}

// cloneContent 返回图片值对象的独立语义快照。
func (content ImageContent) cloneContent() Content {
	return content
}

// isContent 将 ImageContent 限制在 Canonical Content 联合类型内。
func (ImageContent) isContent() {}

// DocumentContent 是保留文档边界、来源和可选标题的输入值对象。
type DocumentContent struct {
	source MediaSource
	title  string
	detail DocumentDetail
}

// NewDocumentContent 创建 URL、Base64 或内联文本形式的文档输入。
func NewDocumentContent(source MediaSource, title string) (DocumentContent, error) {
	return NewDetailedDocumentContent(source, title, DocumentDetailAuto)
}

// DocumentDetail 表示客户端对文档解析精度的明确意图。
type DocumentDetail string

const (
	// DocumentDetailAuto 表示由上游决定文档解析精度。
	DocumentDetailAuto DocumentDetail = "auto"
	// DocumentDetailLow 表示请求低成本文档解析。
	DocumentDetailLow DocumentDetail = "low"
	// DocumentDetailHigh 表示请求高精度文档解析。
	DocumentDetailHigh DocumentDetail = "high"
)

// IsValid 判断文档解析精度是否可以无歧义映射。
func (detail DocumentDetail) IsValid() bool {
	return detail == DocumentDetailAuto || detail == DocumentDetailLow || detail == DocumentDetailHigh
}

// NewDetailedDocumentContent 创建保留明确解析精度的文档输入。
func NewDetailedDocumentContent(
	source MediaSource,
	title string,
	detail DocumentDetail,
) (DocumentContent, error) {
	if !source.IsValid() || (title != "" && !isNonBlankText(title)) || !detail.IsValid() {
		return DocumentContent{}, ErrInvalidContent
	}
	return DocumentContent{source: source, title: title, detail: detail}, nil
}

// Kind 返回文档内容类别。
func (content DocumentContent) Kind() ContentKind {
	return ContentDocument
}

// Source 返回文档来源快照。
func (content DocumentContent) Source() MediaSource {
	return content.source
}

// Title 返回文档可选标题。
func (content DocumentContent) Title() string {
	return content.title
}

// Detail 返回文档解析精度意图。
func (content DocumentContent) Detail() DocumentDetail {
	return content.detail
}

// IsValid 判断文档来源与标题仍满足不变量。
func (content DocumentContent) IsValid() bool {
	_, err := NewDetailedDocumentContent(content.source, content.title, content.detail)
	return err == nil
}

// cloneContent 返回文档值对象的独立语义快照。
func (content DocumentContent) cloneContent() Content {
	return content
}

// isContent 将 DocumentContent 限制在 Canonical Content 联合类型内。
func (DocumentContent) isContent() {}

// RefusalContent 是与普通 Assistant 文本严格分离的安全或策略拒绝。
type RefusalContent struct {
	refusal string
}

// NewRefusalContent 创建非空的模型拒绝内容。
func NewRefusalContent(refusal string) (RefusalContent, error) {
	if !isNonBlankText(refusal) {
		return RefusalContent{}, ErrInvalidContent
	}
	return RefusalContent{refusal: refusal}, nil
}

// Kind 返回模型拒绝内容类别。
func (content RefusalContent) Kind() ContentKind {
	return ContentRefusal
}

// Refusal 返回模型提供的拒绝说明。
func (content RefusalContent) Refusal() string {
	return content.refusal
}

// IsValid 判断拒绝说明仍满足构造不变量。
func (content RefusalContent) IsValid() bool {
	return isNonBlankText(content.refusal)
}

// cloneContent 返回拒绝值对象的独立语义快照。
func (content RefusalContent) cloneContent() Content {
	return content
}

// isContent 将 RefusalContent 限制在 Canonical Content 联合类型内。
func (RefusalContent) isContent() {}

// Role 是 Canonical Message 的稳定参与方语义。
type Role string

const (
	// RoleSystem 表示全局系统约束。
	RoleSystem Role = "system"
	// RoleDeveloper 表示 OpenAI/Codex 的开发者约束。
	RoleDeveloper Role = "developer"
	// RoleUser 表示最终用户输入或工具结果。
	RoleUser Role = "user"
	// RoleAssistant 表示模型输出、工具调用或 reasoning 连续性。
	RoleAssistant Role = "assistant"
)

// IsValid 判断消息角色是否已经注册。
func (role Role) IsValid() bool {
	return role == RoleSystem || role == RoleDeveloper || role == RoleUser || role == RoleAssistant
}

// MessagePhase 是 Codex assistant 历史的输出阶段语义。
type MessagePhase string

const (
	// MessagePhaseCommentary 表示中间进度或分析性输出。
	MessagePhaseCommentary MessagePhase = "commentary"
	// MessagePhaseFinalAnswer 表示面向用户的最终回答。
	MessagePhaseFinalAnswer MessagePhase = "final_answer"
)

// IsValid 判断消息阶段是否是当前协议支持的明确值。
func (phase MessagePhase) IsValid() bool {
	return phase == MessagePhaseCommentary || phase == MessagePhaseFinalAnswer
}

// Message 是角色和内容块组成的不可变 Canonical 消息。
type Message struct {
	role     Role
	phase    MessagePhase
	contents []Content
}

// NewMessage 创建角色与内容组合，并持有内容的防御性副本。
func NewMessage(role Role, contents ...Content) (Message, error) {
	return newMessage(role, "", contents)
}

// NewPhasedMessage 创建保留 commentary 或 final_answer 阶段的 Assistant 消息。
func NewPhasedMessage(
	role Role,
	phase MessagePhase,
	contents ...Content,
) (Message, error) {
	return newMessage(role, phase, contents)
}

// newMessage 统一校验消息角色、阶段和内容组合。
func newMessage(role Role, phase MessagePhase, contents []Content) (Message, error) {
	if !role.IsValid() ||
		len(contents) == 0 ||
		(phase != "" && (!phase.IsValid() || role != RoleAssistant)) {
		return Message{}, ErrInvalidMessage
	}
	clonedContents := make([]Content, len(contents))
	for index, content := range contents {
		if !isContentAllowedForRole(role, content) {
			return Message{}, ErrInvalidMessage
		}
		clonedContents[index] = content.cloneContent()
	}
	return Message{role: role, phase: phase, contents: clonedContents}, nil
}

// Role 返回消息参与方语义。
func (message Message) Role() Role {
	return message.role
}

// Phase 返回 Assistant 消息的可选输出阶段。
func (message Message) Phase() MessagePhase {
	return message.phase
}

// Contents 返回不能反向修改消息的内容副本。
func (message Message) Contents() []Content {
	return cloneContents(message.contents)
}

// IsValid 判断消息角色、内容和组合仍满足构造不变量。
func (message Message) IsValid() bool {
	_, err := newMessage(message.role, message.phase, message.contents)
	return err == nil
}

// clone 返回消息及其所有嵌套内容的独立快照。
func (message Message) clone() Message {
	return Message{
		role:     message.role,
		phase:    message.phase,
		contents: cloneContents(message.contents),
	}
}

// cloneContents 返回内容接口切片及每个内容值对象的独立快照。
func cloneContents(contents []Content) []Content {
	cloned := make([]Content, len(contents))
	for index, content := range contents {
		if content != nil {
			cloned[index] = content.cloneContent()
		}
	}
	return cloned
}

// isContentAllowedForRole 校验跨 Codex 和 Claude 都能明确解释的角色组合。
func isContentAllowedForRole(role Role, content Content) bool {
	if content == nil {
		return false
	}
	switch typed := content.(type) {
	case TextContent:
		return typed.IsValid()
	case RefusalContent:
		return role == RoleAssistant && typed.IsValid()
	case ImageContent:
		return role == RoleUser && typed.IsValid()
	case DocumentContent:
		return role == RoleUser && typed.IsValid()
	case ToolCallContent:
		return role == RoleAssistant && typed.IsValid()
	case ToolResultContent:
		return role == RoleUser && typed.IsValid()
	case ReasoningContent:
		return role == RoleAssistant && typed.IsValid()
	default:
		return false
	}
}
