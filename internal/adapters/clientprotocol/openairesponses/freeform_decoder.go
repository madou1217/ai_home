package openairesponses

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/decodediag"
)

// Codex CLI 0.158 Responses 线协议形状的解码（Responses Lite + 代码模式）。
//
// 来源：Codex CLI 0.158.0-alpha.2.1（ChatGPT.app 捆绑）对 gpt-6-astra 的实测请求，
// 样本见 testdata/codex_0158_*.json：
//   - 工具不在根 tools，而在首个输入项 {"type":"additional_tools","role":"developer","tools":[...]}；
//   - namespace 内可含 {"type":"custom"} freeform 工具（functions.exec，Lark 语法）；
//   - 调用历史 {"type":"custom_tool_call","call_id","name","input"} 不带 namespace，
//     结果历史 {"type":"custom_tool_call_output","call_id","output"}；
//   - reasoning.context / text.verbosity 见 options_decoder.go。

// additionalToolsDTO 是在 input 中下发工具定义的输入项。
type additionalToolsDTO struct {
	Type  string            `json:"type"`
	ID    string            `json:"id"`
	Role  string            `json:"role"`
	Tools []json.RawMessage `json:"tools"`
}

// customToolDTO 是 freeform 工具定义。
type customToolDTO struct {
	Type        string          `json:"type"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Format      json.RawMessage `json:"format"`
}

// customToolFormatDTO 是 freeform 输入约束。
type customToolFormatDTO struct {
	Type       string `json:"type"`
	Syntax     string `json:"syntax"`
	Definition string `json:"definition"`
}

// customToolCallDTO 是历史 freeform 工具调用输入项。
type customToolCallDTO struct {
	Type      string  `json:"type"`
	ID        string  `json:"id"`
	CallID    string  `json:"call_id"`
	Name      string  `json:"name"`
	Namespace string  `json:"namespace"`
	Input     *string `json:"input"`
	Status    string  `json:"status"`
}

// customToolCallOutputDTO 是 freeform 工具结果输入项。
type customToolCallOutputDTO struct {
	Type   string          `json:"type"`
	ID     string          `json:"id"`
	CallID string          `json:"call_id"`
	Output json.RawMessage `json:"output"`
	Status string          `json:"status"`
}

// collectAdditionalTools 预扫 input 数组中的 additional_tools 项并返回其工具定义。
//
// 工具必须先于调用历史解码：custom_tool_call 不带 namespace，要靠已声明的 freeform
// 工具还原身份。additional_tools 项本身不进入 Canonical 消息。
func collectAdditionalTools(raw json.RawMessage) ([]json.RawMessage, error) {
	if !strings.HasPrefix(strings.TrimSpace(string(raw)), "[") {
		return nil, nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, invalidField("input")
	}
	var tools []json.RawMessage
	for index, item := range items {
		field := fmt.Sprintf("input[%d]", index)
		header, err := decodeHeader[inputItemHeaderDTO](item, field)
		if err != nil {
			return nil, err
		}
		if header.Type != "additional_tools" {
			continue
		}
		wire, err := decodeStrict[additionalToolsDTO](item, field)
		if err != nil {
			return nil, err
		}
		if wire.Role != "developer" {
			return nil, invalidField(decodediag.Discriminator(field+".role", wire.Role))
		}
		tools = append(tools, wire.Tools...)
	}
	return tools, nil
}

// decodeRequestTools 合并根 tools 与 additional_tools 中的工具定义。
func decodeRequestTools(
	rootTools []json.RawMessage,
	additionalTools []json.RawMessage,
) ([]inference.ToolDefinition, *inference.WebSearchTool, error) {
	tools, webSearch, err := decodeToolList(rootTools, "tools", nil)
	if err != nil {
		return nil, nil, err
	}
	extra, webSearch, err := decodeToolList(additionalTools, "input.additional_tools", webSearch)
	if err != nil {
		return nil, nil, err
	}
	return append(tools, extra...), webSearch, nil
}

// decodeCustomTool 解码普通或 namespace 内的 freeform 工具定义。
func decodeCustomTool(
	raw json.RawMessage,
	field string,
	namespace string,
	namespaceDescription string,
) (inference.ToolDefinition, error) {
	wireTool, err := decodeStrict[customToolDTO](raw, field)
	if err != nil {
		return inference.ToolDefinition{}, err
	}
	format := inference.NewTextFreeformFormat()
	if hasJSONValue(wireTool.Format) {
		wireFormat, formatErr := decodeStrict[customToolFormatDTO](wireTool.Format, field+".format")
		if formatErr != nil {
			return inference.ToolDefinition{}, formatErr
		}
		switch wireFormat.Type {
		case "text":
			if wireFormat.Syntax != "" || wireFormat.Definition != "" {
				return inference.ToolDefinition{}, invalidField(field + ".format")
			}
		case "grammar":
			format, err = inference.NewGrammarFreeformFormat(wireFormat.Syntax, wireFormat.Definition)
			if err != nil {
				return inference.ToolDefinition{}, unsupportedField(
					decodediag.Discriminator(field+".format.syntax", wireFormat.Syntax),
				)
			}
		default:
			return inference.ToolDefinition{}, unsupportedField(
				decodediag.Discriminator(field+".format.type", wireFormat.Type),
			)
		}
	}
	tool, err := inference.NewFreeformToolDefinition(
		namespace,
		namespaceDescription,
		wireTool.Name,
		wireTool.Description,
		format,
	)
	if err != nil {
		return inference.ToolDefinition{}, invalidField(field)
	}
	return tool, nil
}

// freeformToolIndex 按局部名称还原不带 namespace 的 custom_tool_call 身份。
type freeformToolIndex struct {
	byName    map[string]inference.ToolIdentity
	ambiguous map[string]struct{}
}

// newFreeformToolIndex 从请求工具中建立 freeform 名称索引，跨 namespace 重名标记为歧义。
func newFreeformToolIndex(tools []inference.ToolDefinition) freeformToolIndex {
	index := freeformToolIndex{
		byName:    make(map[string]inference.ToolIdentity),
		ambiguous: make(map[string]struct{}),
	}
	for _, tool := range tools {
		if _, freeform := tool.Freeform(); !freeform {
			continue
		}
		if _, exists := index.byName[tool.Name()]; exists {
			index.ambiguous[tool.Name()] = struct{}{}
			continue
		}
		index.byName[tool.Name()] = tool.Identity()
	}
	return index
}

// resolve 返回调用对应的已声明 freeform 工具身份；未声明或歧义时失败关闭。
func (index freeformToolIndex) resolve(namespace string, name string) (inference.ToolIdentity, bool) {
	if _, ambiguous := index.ambiguous[name]; ambiguous && namespace == "" {
		return inference.ToolIdentity{}, false
	}
	identity, found := index.byName[name]
	if !found {
		return inference.ToolIdentity{}, false
	}
	if declared, _ := identity.Namespace(); namespace != "" && namespace != declared {
		return inference.ToolIdentity{}, false
	}
	return identity, true
}

// decodeCustomToolCall 解析历史 freeform 调用，输入以 {"input":...} 进入 Canonical。
func decodeCustomToolCall(
	raw json.RawMessage,
	field string,
	index freeformToolIndex,
) (inference.Message, string, error) {
	wireCall, err := decodeStrict[customToolCallDTO](raw, field)
	if err != nil {
		return inference.Message{}, "", err
	}
	if wireCall.Type != "custom_tool_call" ||
		wireCall.Input == nil ||
		(wireCall.Status != "" && wireCall.Status != "completed") {
		return inference.Message{}, "", invalidField(field)
	}
	identity, found := index.resolve(wireCall.Namespace, wireCall.Name)
	if !found {
		return inference.Message{}, "", invalidField(field + ".name")
	}
	arguments, err := inference.FreeformToolArguments(*wireCall.Input)
	if err != nil {
		return inference.Message{}, "", invalidField(field + ".input")
	}
	var call inference.ToolCallContent
	if namespace, namespaced := identity.Namespace(); namespaced {
		call, err = inference.NewNamespacedToolCallContent(wireCall.CallID, namespace, identity.Name(), arguments)
	} else {
		call, err = inference.NewToolCallContent(wireCall.CallID, identity.Name(), arguments)
	}
	if err != nil {
		return inference.Message{}, "", invalidField(field)
	}
	message, err := inference.NewMessage(inference.RoleAssistant, call)
	if err != nil {
		return inference.Message{}, "", invalidField(field)
	}
	return message, wireCall.CallID, nil
}

// decodeCustomToolCallOutput 解析 freeform 工具结果；结果形状与函数结果相同。
func decodeCustomToolCallOutput(
	raw json.RawMessage,
	field string,
) (inference.Message, string, error) {
	wireOutput, err := decodeStrict[customToolCallOutputDTO](raw, field)
	if err != nil {
		return inference.Message{}, "", err
	}
	if wireOutput.Type != "custom_tool_call_output" ||
		(wireOutput.Status != "" && wireOutput.Status != "completed") {
		return inference.Message{}, "", invalidField(field)
	}
	contents, err := decodeMessageContents(wireOutput.Output, field+".output")
	if err != nil {
		return inference.Message{}, "", err
	}
	result, err := inference.NewToolResultContent(wireOutput.CallID, false, contents...)
	if err != nil {
		return inference.Message{}, "", invalidField(field)
	}
	message, err := inference.NewMessage(inference.RoleUser, result)
	if err != nil {
		return inference.Message{}, "", invalidField(field)
	}
	return message, wireOutput.CallID, nil
}
