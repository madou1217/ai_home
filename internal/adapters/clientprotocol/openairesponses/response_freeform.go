package openairesponses

import (
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
)

// Freeform（custom）工具调用的 Responses 客户端渲染。
//
// 线协议形状对齐 Codex CLI 0.158.0-alpha.2.1 实测消费的 OpenAI Responses 输出：
//   - 输出项 {"type":"custom_tool_call","id","status","call_id","name","input"}，不带 namespace；
//   - 流事件 response.custom_tool_call_input.delta / .done（item_id、output_index、delta|input）。
// Canonical 调用参数是 {"input":"<原始字符串>"}（core/inference/tool_freeform.go），这里解包。
// 调用是否为 freeform 只看请求中的工具定义：Claude/AGY 等上游返回的是普通 tool_use，
// Codex 上游返回的 custom_tool_call 也只携带局部名称。

// customToolCallItemWireDTO 是 Responses custom_tool_call 输出项。
type customToolCallItemWireDTO struct {
	ID     string `json:"id"`
	Type   string `json:"type"`
	Status string `json:"status"`
	CallID string `json:"call_id"`
	Name   string `json:"name"`
	Input  string `json:"input"`
}

// customToolWireDTO 是回显的 freeform 工具定义。
type customToolWireDTO struct {
	Type        string                  `json:"type"`
	Name        string                  `json:"name"`
	Description string                  `json:"description,omitempty"`
	Format      customToolFormatWireDTO `json:"format"`
}

// customToolFormatWireDTO 是回显的 freeform 输入约束。
type customToolFormatWireDTO struct {
	Type       string `json:"type"`
	Syntax     string `json:"syntax,omitempty"`
	Definition string `json:"definition,omitempty"`
}

// isFreeformToolCall 判断调用是否指向请求中声明的 freeform 工具。
//
// 精确身份优先；不带 namespace 的调用（Codex 上游 custom_tool_call）按局部名称在
// freeform 工具中唯一匹配，重名时不猜测。
func isFreeformToolCall(request inference.Request, identity inference.ToolIdentity) bool {
	_, identityNamespaced := identity.Namespace()
	matches := 0
	for _, tool := range request.Tools() {
		if _, freeform := tool.Freeform(); !freeform {
			continue
		}
		if tool.Identity() == identity {
			return true
		}
		if !identityNamespaced && tool.Name() == identity.Name() {
			matches++
		}
	}
	return matches == 1
}

// marshalCustomToolCallItem 编码 freeform 调用快照；完成时解包原始输入，失败关闭。
func marshalCustomToolCallItem(item *outputItemState, status string) (json.RawMessage, error) {
	if !item.toolCallStarted {
		return nil, ErrInvalidEventSequence
	}
	input := ""
	if item.toolCallComplete {
		decoded, err := inference.FreeformInputFromArguments([]byte(item.toolArguments))
		if err != nil {
			return nil, ErrUnsupportedResponseEvent
		}
		input = decoded
	}
	return json.Marshal(customToolCallItemWireDTO{
		ID:     item.id,
		Type:   "custom_tool_call",
		Status: status,
		CallID: item.callID,
		Name:   item.toolIdentity.Name(),
		Input:  input,
	})
}

// renderCustomToolCallCompleted 以一次 input.delta 加 input.done 交付完整原始输入。
//
// Canonical 增量是 {"input":"...} 的 JSON 转义片段，逐片反转义既脆弱又无收益，
// 所以 freeform 调用的增量在完成时一次性交付。
func (renderer *StreamRenderer) renderCustomToolCallCompleted(
	event inference.ToolCallCompletedEvent,
) ([]RenderedEvent, error) {
	item, err := renderer.state.openItem(event.OutputIndex())
	if err != nil {
		return nil, err
	}
	input, err := inference.FreeformInputFromArguments(event.Arguments())
	if err != nil {
		return nil, ErrUnsupportedResponseEvent
	}
	var frames []RenderedEvent
	if input != "" {
		delta, deltaErr := renderer.renderMany(streamEventWireDTO{
			Type:        "response.custom_tool_call_input.delta",
			OutputIndex: uint32Pointer(event.OutputIndex()),
			ItemID:      item.id,
			Delta:       input,
		})
		if deltaErr != nil {
			return nil, deltaErr
		}
		frames = append(frames, delta...)
	}
	done, err := renderer.renderMany(streamEventWireDTO{
		Type:        "response.custom_tool_call_input.done",
		OutputIndex: uint32Pointer(event.OutputIndex()),
		ItemID:      item.id,
		Input:       &input,
	})
	return append(frames, done...), err
}

// newCustomToolWire 回显 freeform 工具定义。
func newCustomToolWire(definition inference.ToolDefinition, format inference.FreeformFormat) customToolWireDTO {
	wire := customToolWireDTO{
		Type:        "custom",
		Name:        definition.Name(),
		Description: definition.Description(),
		Format:      customToolFormatWireDTO{Type: string(format.Kind())},
	}
	if syntax, grammar, ok := format.Grammar(); ok {
		wire.Format.Syntax = syntax
		wire.Format.Definition = grammar
	}
	return wire
}
