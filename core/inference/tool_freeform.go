package inference

import (
	"bytes"
	"encoding/json"
	"errors"
	"unicode/utf8"
)

// Freeform（自由格式）工具的输入是一段原始字符串，而不是 JSON 参数对象。
//
// 来源：OpenAI Responses 的 `{"type":"custom"}` 工具与 `custom_tool_call` 输出项。
// 在 Codex CLI 0.158.0-alpha.2.1（ChatGPT.app 捆绑）中实测：apply_patch 与代码模式
// `exec` 都以 freeform 声明（models_cache: apply_patch_tool_type=freeform,
// tool_mode=code_mode_only），调用历史以 custom_tool_call / custom_tool_call_output 回放。
//
// Canonical 把 freeform 输入统一表示为 {"input":"<原始字符串>"}：
//   - 不支持 freeform 的 Provider（Claude、AGY）可把它当作普通单字符串参数工具执行；
//   - Codex 上游解码器早已按同一约定把 custom_tool_call 输入包成该对象；
//   - 支持 freeform 的协议边界（Codex 上游请求、Responses 客户端渲染）再按工具定义解包。
// 调用是否为 freeform 只由请求中的工具定义决定，不在调用内容上重复存储。

// FreeformInputField 是 freeform 输入在 Canonical 参数对象中的唯一字段名。
const FreeformInputField = "input"

// freeformInputSchema 是所有 freeform 工具共享的 Canonical 输入 Schema。
var freeformInputSchema = []byte(`{"type":"object","properties":{"input":{"type":"string"}},"required":["input"],"additionalProperties":false}`)

// ErrInvalidFreeformArguments 表示参数对象不是恰好一个字符串 input 字段。
var ErrInvalidFreeformArguments = errors.New("freeform 工具参数必须是只含字符串 input 的对象")

// FreeformFormatKind 是 freeform 输入约束类别。
type FreeformFormatKind string

const (
	// FreeformFormatText 表示不受语法约束的纯文本输入。
	FreeformFormatText FreeformFormatKind = "text"
	// FreeformFormatGrammar 表示受 Lark 或正则语法约束的输入。
	FreeformFormatGrammar FreeformFormatKind = "grammar"
)

// FreeformFormat 描述 freeform 工具输入的约束。
type FreeformFormat struct {
	kind       FreeformFormatKind
	syntax     string
	definition string
}

// NewTextFreeformFormat 创建无语法约束的 freeform 输入格式。
func NewTextFreeformFormat() FreeformFormat {
	return FreeformFormat{kind: FreeformFormatText}
}

// NewGrammarFreeformFormat 创建受 lark 或 regex 语法约束的 freeform 输入格式。
func NewGrammarFreeformFormat(syntax string, definition string) (FreeformFormat, error) {
	format := FreeformFormat{
		kind:       FreeformFormatGrammar,
		syntax:     syntax,
		definition: definition,
	}
	if !format.IsValid() {
		return FreeformFormat{}, ErrInvalidRequest
	}
	return format, nil
}

// Kind 返回输入约束类别。
func (format FreeformFormat) Kind() FreeformFormatKind {
	return format.kind
}

// Grammar 返回语法类别与定义；非语法格式返回 false。
func (format FreeformFormat) Grammar() (string, string, bool) {
	if format.kind != FreeformFormatGrammar {
		return "", "", false
	}
	return format.syntax, format.definition, true
}

// IsValid 判断格式类别与语法字段组合合法。
func (format FreeformFormat) IsValid() bool {
	switch format.kind {
	case FreeformFormatText:
		return format.syntax == "" && format.definition == ""
	case FreeformFormatGrammar:
		return (format.syntax == "lark" || format.syntax == "regex") &&
			format.definition != "" &&
			utf8.ValidString(format.definition)
	default:
		return false
	}
}

// NewFreeformToolDefinition 创建可选 namespace 的 freeform 工具定义。
func NewFreeformToolDefinition(
	namespace string,
	namespaceDescription string,
	name string,
	description string,
	format FreeformFormat,
) (ToolDefinition, error) {
	options := ToolDefinitionOptions{Freeform: &format}
	if namespace == "" {
		if namespaceDescription != "" {
			return ToolDefinition{}, ErrInvalidRequest
		}
		return NewToolDefinitionWithOptions(name, description, freeformInputSchema, options)
	}
	return NewNamespacedToolDefinitionWithOptions(
		namespace,
		namespaceDescription,
		name,
		description,
		freeformInputSchema,
		options,
	)
}

// Freeform 返回 freeform 输入格式；普通 JSON 参数工具返回 false。
func (definition ToolDefinition) Freeform() (FreeformFormat, bool) {
	if definition.freeform == nil {
		return FreeformFormat{}, false
	}
	return *definition.freeform, true
}

// FreeformToolArguments 把原始字符串输入包成 Canonical 参数对象。
func FreeformToolArguments(input string) ([]byte, error) {
	if !utf8.ValidString(input) {
		return nil, ErrInvalidFreeformArguments
	}
	return json.Marshal(map[string]string{FreeformInputField: input})
}

// FreeformInputFromArguments 从 Canonical 参数对象中取回原始字符串输入。
//
// 形状不是恰好一个字符串 input 字段时失败关闭，调用方不得猜测。
func FreeformInputFromArguments(arguments []byte) (string, error) {
	decoder := json.NewDecoder(bytes.NewReader(arguments))
	decoder.UseNumber()
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || len(fields) != 1 {
		return "", ErrInvalidFreeformArguments
	}
	raw, found := fields[FreeformInputField]
	if !found {
		return "", ErrInvalidFreeformArguments
	}
	var input string
	if err := json.Unmarshal(raw, &input); err != nil {
		return "", ErrInvalidFreeformArguments
	}
	return input, nil
}

// isFreeformInputSchema 判断 Schema 是否为 freeform 专用 Canonical Schema。
func isFreeformInputSchema(schema []byte) bool {
	return bytes.Equal(schema, freeformInputSchema)
}

// cloneFreeformFormat 复制可选 freeform 格式。
func cloneFreeformFormat(format *FreeformFormat) *FreeformFormat {
	if format == nil {
		return nil
	}
	cloned := *format
	return &cloned
}
