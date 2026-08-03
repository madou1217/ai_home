package messages

import (
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
)

const (
	// 下列版本类型与当前 Claude Code 的 Beta Messages 请求保持一致。
	clearThinkingType = "clear_thinking_20251015"
	clearToolUsesType = "clear_tool_uses_20250919"
)

// encodeContextManagement 编码请求级上下文编辑并声明对应 Beta Header。
func (encoder *requestEncoder) encodeContextManagement() (*contextManagementDTO, error) {
	management, found := encoder.request.ContextManagement()
	if !found {
		return nil, nil
	}
	edits := management.Edits()
	wireEdits := make([]json.RawMessage, len(edits))
	for index, edit := range edits {
		wireEdit, err := encodeContextEdit(edit)
		if err != nil {
			return nil, err
		}
		wireEdits[index] = wireEdit
	}
	encoder.addBeta(betaContextManagement)
	return &contextManagementDTO{Edits: wireEdits}, nil
}

// encodeContextEdit 按 Canonical 联合类型选择对应的版本化 Anthropic 结构。
func encodeContextEdit(edit inference.ContextEdit) (json.RawMessage, error) {
	switch edit.Kind() {
	case inference.ContextEditClearThinking:
		return encodeClearThinkingEdit(edit)
	case inference.ContextEditClearToolUses:
		return encodeClearToolUsesEdit(edit)
	default:
		return nil, ErrUnsupportedRequest
	}
}

// encodeClearThinkingEdit 保留 Claude Code 当前使用的 "all" 标量表达。
func encodeClearThinkingEdit(edit inference.ContextEdit) (json.RawMessage, error) {
	wireEdit := clearThinkingEditDTO{Type: clearThinkingType}
	if retention, found := edit.ThinkingRetention(); found {
		switch retention.Mode() {
		case inference.ThinkingRetentionAll:
			wireEdit.Keep = json.RawMessage(`"all"`)
		case inference.ThinkingRetentionRecent:
			encoded, err := json.Marshal(contextMetricDTO{
				Type:  string(inference.ContextMetricThinkingTurns),
				Value: retention.Turns(),
			})
			if err != nil {
				return nil, ErrUnsupportedRequest
			}
			wireEdit.Keep = encoded
		default:
			return nil, ErrUnsupportedRequest
		}
	}
	return marshalContextEdit(wireEdit)
}

// encodeClearToolUsesEdit 编码每个可选阈值及工具输入清理联合值。
func encodeClearToolUsesEdit(edit inference.ContextEdit) (json.RawMessage, error) {
	wireEdit := clearToolUsesEditDTO{
		Type:         clearToolUsesType,
		ExcludeTools: edit.ExcludeTools(),
	}
	if metric, found := edit.Trigger(); found {
		wireEdit.Trigger = encodeContextMetric(metric)
	}
	if metric, found := edit.Keep(); found {
		wireEdit.Keep = encodeContextMetric(metric)
	}
	if metric, found := edit.ClearAtLeast(); found {
		wireEdit.ClearAtLeast = encodeContextMetric(metric)
	}
	if policy, found := edit.ClearToolInputs(); found {
		encoded, err := encodeToolInputClearPolicy(policy)
		if err != nil {
			return nil, err
		}
		wireEdit.ClearToolInputs = encoded
	}
	return marshalContextEdit(wireEdit)
}

// encodeContextMetric 将不可混淆的领域数量投影为 Anthropic type/value。
func encodeContextMetric(metric inference.ContextMetric) *contextMetricDTO {
	return &contextMetricDTO{
		Type:  string(metric.Kind()),
		Value: metric.Value(),
	}
}

// encodeToolInputClearPolicy 编码 bool 或工具名列表，不用零值推断联合类型。
func encodeToolInputClearPolicy(
	policy inference.ToolInputClearPolicy,
) (json.RawMessage, error) {
	var value any
	switch policy.Mode() {
	case inference.ToolInputClearBoolean:
		value = policy.Enabled()
	case inference.ToolInputClearNamed:
		value = policy.Tools()
	default:
		return nil, ErrUnsupportedRequest
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, ErrUnsupportedRequest
	}
	return encoded, nil
}

// marshalContextEdit 统一把已验证的版本化编辑结构写入联合数组。
func marshalContextEdit(value any) (json.RawMessage, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, ErrUnsupportedRequest
	}
	return encoded, nil
}
