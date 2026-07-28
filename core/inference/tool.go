package inference

import (
	"unicode"
	"unicode/utf8"
)

// ToolDefinition 是不携带 Provider 私有字段的函数工具定义。
type ToolDefinition struct {
	name        string
	description string
	inputSchema []byte
}

// NewToolDefinition 创建名称稳定且 Schema 为 JSON Object 的工具定义。
func NewToolDefinition(name string, description string, inputSchema []byte) (ToolDefinition, error) {
	if !isToolName(name) {
		return ToolDefinition{}, ErrInvalidToolName
	}
	if description != "" && !isNonBlankText(description) {
		return ToolDefinition{}, ErrInvalidContent
	}
	if !isJSONObject(inputSchema) {
		return ToolDefinition{}, ErrInvalidJSONObject
	}
	return ToolDefinition{
		name:        name,
		description: description,
		inputSchema: cloneBytes(inputSchema),
	}, nil
}

// Name 返回跨协议使用的精确工具名。
func (definition ToolDefinition) Name() string {
	return definition.name
}

// Description 返回工具的可选说明。
func (definition ToolDefinition) Description() string {
	return definition.description
}

// InputSchema 返回不能修改内部定义的 JSON Schema 副本。
func (definition ToolDefinition) InputSchema() []byte {
	return cloneBytes(definition.inputSchema)
}

// IsValid 判断工具定义仍满足名称和 JSON Schema 不变量。
func (definition ToolDefinition) IsValid() bool {
	_, err := NewToolDefinition(definition.name, definition.description, definition.inputSchema)
	return err == nil
}

// clone 返回工具定义及其 JSON Schema 的独立快照。
func (definition ToolDefinition) clone() ToolDefinition {
	return ToolDefinition{
		name:        definition.name,
		description: definition.description,
		inputSchema: cloneBytes(definition.inputSchema),
	}
}

// ToolCallContent 是 Assistant 发起的完整工具调用。
type ToolCallContent struct {
	callID    string
	name      string
	arguments []byte
}

// NewToolCallContent 创建拥有明确 call ID 和完整 JSON Object 参数的工具调用。
func NewToolCallContent(callID string, name string, arguments []byte) (ToolCallContent, error) {
	if !isCanonicalOpaqueID(callID) {
		return ToolCallContent{}, ErrInvalidToolCallID
	}
	if !isToolName(name) {
		return ToolCallContent{}, ErrInvalidToolName
	}
	if !isJSONObject(arguments) {
		return ToolCallContent{}, ErrInvalidJSONObject
	}
	return ToolCallContent{
		callID:    callID,
		name:      name,
		arguments: cloneBytes(arguments),
	}, nil
}

// Kind 返回工具调用内容类别。
func (content ToolCallContent) Kind() ContentKind {
	return ContentToolCall
}

// CallID 返回工具结果必须精确引用的调用标识。
func (content ToolCallContent) CallID() string {
	return content.callID
}

// Name 返回调用的精确工具名。
func (content ToolCallContent) Name() string {
	return content.name
}

// Arguments 返回不能修改内部调用的 JSON Object 副本。
func (content ToolCallContent) Arguments() []byte {
	return cloneBytes(content.arguments)
}

// IsValid 判断完整工具调用仍满足构造不变量。
func (content ToolCallContent) IsValid() bool {
	_, err := NewToolCallContent(content.callID, content.name, content.arguments)
	return err == nil
}

// cloneContent 返回工具调用及其参数的独立快照。
func (content ToolCallContent) cloneContent() Content {
	return ToolCallContent{
		callID:    content.callID,
		name:      content.name,
		arguments: cloneBytes(content.arguments),
	}
}

// isContent 将 ToolCallContent 限制在 Canonical Content 联合类型内。
func (ToolCallContent) isContent() {}

// ToolResultContent 是 User 返回给明确 call ID 的完整结果。
type ToolResultContent struct {
	callID   string
	isError  bool
	contents []Content
}

// NewToolResultContent 创建只含文本、图片或文档的精确工具结果。
func NewToolResultContent(
	callID string,
	isError bool,
	contents ...Content,
) (ToolResultContent, error) {
	if !isCanonicalOpaqueID(callID) {
		return ToolResultContent{}, ErrInvalidToolCallID
	}
	if len(contents) == 0 {
		return ToolResultContent{}, ErrInvalidToolResult
	}
	clonedContents := make([]Content, len(contents))
	for index, content := range contents {
		if !isToolResultPayload(content) {
			return ToolResultContent{}, ErrInvalidToolResult
		}
		clonedContents[index] = content.cloneContent()
	}
	return ToolResultContent{
		callID:   callID,
		isError:  isError,
		contents: clonedContents,
	}, nil
}

// Kind 返回工具结果内容类别。
func (content ToolResultContent) Kind() ContentKind {
	return ContentToolResult
}

// CallID 返回结果精确引用的历史工具调用标识。
func (content ToolResultContent) CallID() string {
	return content.callID
}

// IsError 返回工具执行是否以业务错误结束。
func (content ToolResultContent) IsError() bool {
	return content.isError
}

// Contents 返回不能反向修改工具结果的内容副本。
func (content ToolResultContent) Contents() []Content {
	return cloneContents(content.contents)
}

// IsValid 判断工具结果仍满足精确 ID 和非递归内容约束。
func (content ToolResultContent) IsValid() bool {
	_, err := NewToolResultContent(content.callID, content.isError, content.contents...)
	return err == nil
}

// cloneContent 返回工具结果及其嵌套内容的独立快照。
func (content ToolResultContent) cloneContent() Content {
	return ToolResultContent{
		callID:   content.callID,
		isError:  content.isError,
		contents: cloneContents(content.contents),
	}
}

// isContent 将 ToolResultContent 限制在 Canonical Content 联合类型内。
func (ToolResultContent) isContent() {}

// isToolName 校验 Codex 与 Claude 共同支持的 ASCII 工具名字符集。
func isToolName(value string) bool {
	if value == "" || len(value) > 128 || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsLetter(character) && character <= unicode.MaxASCII {
			continue
		}
		if unicode.IsDigit(character) || character == '_' || character == '-' {
			continue
		}
		return false
	}
	return true
}

// isToolResultPayload 限制工具结果为 Provider 均可明确表达的内容种类。
func isToolResultPayload(content Content) bool {
	switch typed := content.(type) {
	case TextContent:
		return typed.IsValid()
	case ImageContent:
		return typed.IsValid()
	case DocumentContent:
		return typed.IsValid()
	default:
		return false
	}
}
