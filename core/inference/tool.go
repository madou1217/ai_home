package inference

import (
	"unicode"
	"unicode/utf8"
)

// ToolCaller 是允许触发客户端工具的上游调用来源。
type ToolCaller string

const (
	// ToolCallerDirect 表示模型直接调用工具。
	ToolCallerDirect ToolCaller = "direct"
	// ToolCallerCodeExecution20250825 表示 2025-08-25 代码执行工具调用。
	ToolCallerCodeExecution20250825 ToolCaller = "code_execution_20250825"
	// ToolCallerCodeExecution20260120 表示 2026-01-20 代码执行工具调用。
	ToolCallerCodeExecution20260120 ToolCaller = "code_execution_20260120"
)

// IsValid 判断工具调用来源是否已经注册。
func (caller ToolCaller) IsValid() bool {
	return caller == ToolCallerDirect ||
		caller == ToolCallerCodeExecution20250825 ||
		caller == ToolCallerCodeExecution20260120
}

// ToolDefinitionOptions 保存不改变函数 Schema 的可选执行提示。
type ToolDefinitionOptions struct {
	// Strict 区分缺省与显式 false。
	Strict *bool
	// AllowedCallers 限制允许触发工具的调用来源。
	AllowedCallers []ToolCaller
	// DeferLoading 表示工具是否延迟到工具搜索命中后加载。
	DeferLoading *bool
	// EagerInputStreaming 表示是否启用细粒度参数流。
	EagerInputStreaming *bool
	// InputExamples 是工具参数 JSON Object 示例。
	InputExamples [][]byte
}

// ToolDefinition 是不携带 Provider 私有字段的函数工具定义。
type ToolDefinition struct {
	identity             ToolIdentity
	namespaceDescription string
	description          string
	inputSchema          []byte
	strict               bool
	strictSpecified      bool
	allowedCallers       []ToolCaller
	deferLoading         *bool
	eagerInputStreaming  *bool
	inputExamples        [][]byte
}

// NewToolDefinition 创建名称稳定且 Schema 为 JSON Object 的工具定义。
func NewToolDefinition(name string, description string, inputSchema []byte) (ToolDefinition, error) {
	return NewToolDefinitionWithOptions(
		name,
		description,
		inputSchema,
		ToolDefinitionOptions{},
	)
}

// NewToolDefinitionWithStrict 创建保留显式 strict 值的工具定义。
func NewToolDefinitionWithStrict(
	name string,
	description string,
	inputSchema []byte,
	strict bool,
) (ToolDefinition, error) {
	return NewToolDefinitionWithOptions(
		name,
		description,
		inputSchema,
		ToolDefinitionOptions{Strict: &strict},
	)
}

// NewToolDefinitionWithOptions 创建保留执行提示的不可变工具定义。
func NewToolDefinitionWithOptions(
	name string,
	description string,
	inputSchema []byte,
	options ToolDefinitionOptions,
) (ToolDefinition, error) {
	identity, err := NewToolIdentity(name)
	if err != nil {
		return ToolDefinition{}, err
	}
	return newToolDefinition(
		identity,
		"",
		description,
		inputSchema,
		options,
	)
}

// NewNamespacedToolDefinitionWithOptions 创建保留 namespace 身份和说明的工具定义。
func NewNamespacedToolDefinitionWithOptions(
	namespace string,
	namespaceDescription string,
	name string,
	description string,
	inputSchema []byte,
	options ToolDefinitionOptions,
) (ToolDefinition, error) {
	identity, err := NewNamespacedToolIdentity(namespace, name)
	if err != nil {
		return ToolDefinition{}, err
	}
	return newToolDefinition(
		identity,
		namespaceDescription,
		description,
		inputSchema,
		options,
	)
}

// newToolDefinition 统一校验普通和 namespaced 函数工具定义。
func newToolDefinition(
	identity ToolIdentity,
	namespaceDescription string,
	description string,
	inputSchema []byte,
	options ToolDefinitionOptions,
) (ToolDefinition, error) {
	if !identity.IsValid() {
		return ToolDefinition{}, ErrInvalidToolName
	}
	if namespaceDescription != "" && !isNonBlankText(namespaceDescription) {
		return ToolDefinition{}, ErrInvalidContent
	}
	if description != "" && !isNonBlankText(description) {
		return ToolDefinition{}, ErrInvalidContent
	}
	if !isJSONObject(inputSchema) {
		return ToolDefinition{}, ErrInvalidJSONObject
	}
	if !areValidToolOptions(options) {
		return ToolDefinition{}, ErrInvalidRequest
	}
	definition := ToolDefinition{
		identity:             identity,
		namespaceDescription: namespaceDescription,
		description:          description,
		inputSchema:          cloneBytes(inputSchema),
		allowedCallers:       append([]ToolCaller(nil), options.AllowedCallers...),
		deferLoading:         cloneBool(options.DeferLoading),
		eagerInputStreaming:  cloneBool(options.EagerInputStreaming),
		inputExamples:        cloneByteSlices(options.InputExamples),
	}
	if options.Strict != nil {
		definition.strict = *options.Strict
		definition.strictSpecified = true
	}
	return definition, nil
}

// areValidToolOptions 校验调用来源不重复且输入示例均为 JSON Object。
func areValidToolOptions(options ToolDefinitionOptions) bool {
	seenCallers := make(map[ToolCaller]struct{}, len(options.AllowedCallers))
	for _, caller := range options.AllowedCallers {
		if !caller.IsValid() {
			return false
		}
		if _, exists := seenCallers[caller]; exists {
			return false
		}
		seenCallers[caller] = struct{}{}
	}
	for _, example := range options.InputExamples {
		if !isJSONObject(example) {
			return false
		}
	}
	return true
}

// Name 返回跨协议使用的精确工具名。
func (definition ToolDefinition) Name() string {
	return definition.identity.Name()
}

// Identity 返回 namespace 与局部名称组成的稳定工具身份。
func (definition ToolDefinition) Identity() ToolIdentity {
	return definition.identity
}

// Namespace 返回可选 namespace 及其是否存在。
func (definition ToolDefinition) Namespace() (string, bool) {
	return definition.identity.Namespace()
}

// NamespaceDescription 返回 namespace 的可选说明。
func (definition ToolDefinition) NamespaceDescription() string {
	return definition.namespaceDescription
}

// Description 返回工具的可选说明。
func (definition ToolDefinition) Description() string {
	return definition.description
}

// InputSchema 返回不能修改内部定义的 JSON Schema 副本。
func (definition ToolDefinition) InputSchema() []byte {
	return cloneBytes(definition.inputSchema)
}

// Strict 返回 strict 的显式值和客户端是否提供了该字段。
func (definition ToolDefinition) Strict() (bool, bool) {
	return definition.strict, definition.strictSpecified
}

// AllowedCallers 返回允许触发工具的调用来源副本。
func (definition ToolDefinition) AllowedCallers() []ToolCaller {
	return append([]ToolCaller(nil), definition.allowedCallers...)
}

// DeferLoading 返回延迟加载的显式值和是否提供该字段。
func (definition ToolDefinition) DeferLoading() (bool, bool) {
	if definition.deferLoading == nil {
		return false, false
	}
	return *definition.deferLoading, true
}

// EagerInputStreaming 返回细粒度参数流的显式值和是否提供该字段。
func (definition ToolDefinition) EagerInputStreaming() (bool, bool) {
	if definition.eagerInputStreaming == nil {
		return false, false
	}
	return *definition.eagerInputStreaming, true
}

// InputExamples 返回工具输入 JSON Object 示例的深拷贝。
func (definition ToolDefinition) InputExamples() [][]byte {
	return cloneByteSlices(definition.inputExamples)
}

// IsValid 判断工具定义仍满足名称和 JSON Schema 不变量。
func (definition ToolDefinition) IsValid() bool {
	var strict *bool
	if definition.strictSpecified {
		value := definition.strict
		strict = &value
	}
	_, err := newToolDefinition(
		definition.identity,
		definition.namespaceDescription,
		definition.description,
		definition.inputSchema,
		ToolDefinitionOptions{
			Strict:              strict,
			AllowedCallers:      definition.allowedCallers,
			DeferLoading:        definition.deferLoading,
			EagerInputStreaming: definition.eagerInputStreaming,
			InputExamples:       definition.inputExamples,
		},
	)
	return err == nil && (definition.strictSpecified || !definition.strict)
}

// clone 返回工具定义及其 JSON Schema 的独立快照。
func (definition ToolDefinition) clone() ToolDefinition {
	return ToolDefinition{
		identity:             definition.identity,
		namespaceDescription: definition.namespaceDescription,
		description:          definition.description,
		inputSchema:          cloneBytes(definition.inputSchema),
		strict:               definition.strict,
		strictSpecified:      definition.strictSpecified,
		allowedCallers:       append([]ToolCaller(nil), definition.allowedCallers...),
		deferLoading:         cloneBool(definition.deferLoading),
		eagerInputStreaming:  cloneBool(definition.eagerInputStreaming),
		inputExamples:        cloneByteSlices(definition.inputExamples),
	}
}

// cloneByteSlices 深拷贝二维字节切片。
func cloneByteSlices(values [][]byte) [][]byte {
	cloned := make([][]byte, len(values))
	for index, value := range values {
		cloned[index] = cloneBytes(value)
	}
	return cloned
}

// ToolCallContent 是 Assistant 发起的完整工具调用。
type ToolCallContent struct {
	callID    string
	identity  ToolIdentity
	arguments []byte
}

// NewToolCallContent 创建拥有明确 call ID 和完整 JSON Object 参数的工具调用。
func NewToolCallContent(callID string, name string, arguments []byte) (ToolCallContent, error) {
	identity, err := NewToolIdentity(name)
	if err != nil {
		return ToolCallContent{}, err
	}
	return newToolCallContent(callID, identity, arguments)
}

// NewNamespacedToolCallContent 创建保留 namespace 的完整工具调用。
func NewNamespacedToolCallContent(
	callID string,
	namespace string,
	name string,
	arguments []byte,
) (ToolCallContent, error) {
	identity, err := NewNamespacedToolIdentity(namespace, name)
	if err != nil {
		return ToolCallContent{}, err
	}
	return newToolCallContent(callID, identity, arguments)
}

// newToolCallContent 统一校验普通与 namespaced 历史工具调用。
func newToolCallContent(
	callID string,
	identity ToolIdentity,
	arguments []byte,
) (ToolCallContent, error) {
	if !isCanonicalOpaqueID(callID) {
		return ToolCallContent{}, ErrInvalidToolCallID
	}
	if !identity.IsValid() {
		return ToolCallContent{}, ErrInvalidToolName
	}
	if !isJSONObject(arguments) {
		return ToolCallContent{}, ErrInvalidJSONObject
	}
	return ToolCallContent{
		callID:    callID,
		identity:  identity,
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
	return content.identity.Name()
}

// Identity 返回工具调用的稳定身份。
func (content ToolCallContent) Identity() ToolIdentity {
	return content.identity
}

// Namespace 返回可选 namespace 及其是否存在。
func (content ToolCallContent) Namespace() (string, bool) {
	return content.identity.Namespace()
}

// Arguments 返回不能修改内部调用的 JSON Object 副本。
func (content ToolCallContent) Arguments() []byte {
	return cloneBytes(content.arguments)
}

// IsValid 判断完整工具调用仍满足构造不变量。
func (content ToolCallContent) IsValid() bool {
	_, err := newToolCallContent(content.callID, content.identity, content.arguments)
	return err == nil
}

// cloneContent 返回工具调用及其参数的独立快照。
func (content ToolCallContent) cloneContent() Content {
	return ToolCallContent{
		callID:    content.callID,
		identity:  content.identity,
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
//
// contents 可以为空，用于保留 Anthropic content 缺省或空数组的合法工具结果。
func NewToolResultContent(
	callID string,
	isError bool,
	contents ...Content,
) (ToolResultContent, error) {
	if !isCanonicalOpaqueID(callID) {
		return ToolResultContent{}, ErrInvalidToolCallID
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
