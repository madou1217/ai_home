package responses

import "github.com/madou1217/ai_home/core/inference"

// Freeform（OpenAI Responses custom）工具的 Codex 上游编码。
//
// 线协议形状来自 Codex CLI 0.158.0-alpha.2.1（ChatGPT.app 捆绑）的实测请求：
//   - 工具定义：{"type":"custom","name","description","format":{"type":"grammar","syntax":"lark","definition"}}，
//     可出现在 namespace 的 tools 里（代码模式 functions.exec）；
//   - 调用历史：{"type":"custom_tool_call","call_id","name","input":"<原始字符串>"}，不带 namespace；
//   - 结果历史：{"type":"custom_tool_call_output","call_id","output"}。
// Canonical 用 {"input":"<原始字符串>"} 携带 freeform 输入（见 core/inference/tool_freeform.go），
// 这里按请求中的工具定义把调用与结果还原为 custom 项。

// customToolDTO 是 Codex freeform 工具定义。
type customToolDTO struct {
	Type        string               `json:"type"`
	Name        string               `json:"name"`
	Description string               `json:"description"`
	Format      *customToolFormatDTO `json:"format,omitempty"`
}

// customToolFormatDTO 是 freeform 输入约束。
type customToolFormatDTO struct {
	Type       string `json:"type"`
	Syntax     string `json:"syntax,omitempty"`
	Definition string `json:"definition,omitempty"`
}

// freeformIdentities 返回请求中声明为 freeform 的工具身份集合。
func freeformIdentities(request inference.Request) map[inference.ToolIdentity]struct{} {
	identities := make(map[inference.ToolIdentity]struct{})
	for _, definition := range request.Tools() {
		if _, freeform := definition.Freeform(); freeform {
			identities[definition.Identity()] = struct{}{}
		}
	}
	return identities
}

// encodeFreeformTool 把 Canonical freeform 工具还原为 custom 定义。
func encodeFreeformTool(
	definition inference.ToolDefinition,
	format inference.FreeformFormat,
) (customToolDTO, error) {
	if len(definition.AllowedCallers()) != 0 {
		return customToolDTO{}, unsupported("tools.allowed_callers")
	}
	if _, found := definition.EagerInputStreaming(); found {
		return customToolDTO{}, unsupported("tools.eager_input_streaming")
	}
	if len(definition.InputExamples()) != 0 {
		return customToolDTO{}, unsupported("tools.input_examples")
	}
	if _, found := definition.DeferLoading(); found {
		return customToolDTO{}, unsupported("tools.defer_loading")
	}
	wireFormat := &customToolFormatDTO{Type: string(format.Kind())}
	if syntax, grammarDefinition, grammar := format.Grammar(); grammar {
		wireFormat.Syntax = syntax
		wireFormat.Definition = grammarDefinition
	}
	return customToolDTO{
		Type:        "custom",
		Name:        definition.Name(),
		Description: definition.Description(),
		Format:      wireFormat,
	}, nil
}

// encodeFreeformCall 把 Canonical freeform 调用还原为 custom_tool_call。
func encodeFreeformCall(content inference.ToolCallContent) (inputItemDTO, error) {
	input, err := inference.FreeformInputFromArguments(content.Arguments())
	if err != nil {
		return inputItemDTO{}, unsupported("messages.tool_call.input")
	}
	return inputItemDTO{
		Type:   "custom_tool_call",
		Name:   content.Name(),
		CallID: content.CallID(),
		Input:  &input,
	}, nil
}
