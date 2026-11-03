package anthropicmessages

import (
	"encoding/json"
	"fmt"

	"github.com/madou1217/ai_home/core/inference"
)

const (
	// 下列类型名来自 Claude Code 与 Anthropic Beta Messages 的当前线协议。
	clearThinkingType = "clear_thinking_20251015"
	clearToolUsesType = "clear_tool_uses_20250919"
)

// decodeContextManagement 将 Anthropic 上下文编辑转换为 Canonical 值对象。
func decodeContextManagement(raw json.RawMessage) (*inference.ContextManagement, error) {
	if !hasJSONValue(raw) {
		return nil, nil
	}
	wireManagement, err := decodeStrict[contextManagementDTO](
		raw,
		"context_management",
	)
	if err != nil {
		return nil, err
	}
	if len(wireManagement.Edits) == 0 {
		return nil, nil
	}

	edits := make([]inference.ContextEdit, len(wireManagement.Edits))
	for index, rawEdit := range wireManagement.Edits {
		field := fmt.Sprintf("context_management.edits[%d]", index)
		edit, decodeErr := decodeContextEdit(rawEdit, field)
		if decodeErr != nil {
			return nil, decodeErr
		}
		edits[index] = edit
	}
	management, err := inference.NewContextManagement(edits...)
	if err != nil {
		return nil, invalidField("context_management")
	}
	return &management, nil
}

// decodeContextEdit 按判别字段选择当前已建立 Canonical 语义的编辑类型。
func decodeContextEdit(raw json.RawMessage, field string) (inference.ContextEdit, error) {
	header, err := decodeHeader[contextEditHeaderDTO](raw, field)
	if err != nil {
		return inference.ContextEdit{}, err
	}
	switch header.Type {
	case clearThinkingType:
		return decodeClearThinkingEdit(raw, field)
	case clearToolUsesType:
		return decodeClearToolUsesEdit(raw, field)
	default:
		return inference.ContextEdit{}, unsupportedField(field + ".type")
	}
}

// decodeClearThinkingEdit 保留最近 thinking 轮次或保留全部 thinking 的语义。
func decodeClearThinkingEdit(
	raw json.RawMessage,
	field string,
) (inference.ContextEdit, error) {
	wireEdit, err := decodeStrict[clearThinkingEditDTO](raw, field)
	if err != nil {
		return inference.ContextEdit{}, err
	}
	if wireEdit.Type != clearThinkingType {
		return inference.ContextEdit{}, invalidField(field + ".type")
	}
	retention, err := decodeThinkingRetention(wireEdit.Keep, field+".keep")
	if err != nil {
		return inference.ContextEdit{}, err
	}
	edit, err := inference.NewClearThinkingEdit(retention)
	if err != nil {
		return inference.ContextEdit{}, invalidField(field)
	}
	return edit, nil
}

// decodeThinkingRetention 接受 Claude Code 当前的 "all"，同时兼容官方 {type:"all"}。
func decodeThinkingRetention(
	raw json.RawMessage,
	field string,
) (*inference.ThinkingRetention, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if !hasJSONValue(raw) {
		return nil, invalidField(field)
	}
	var scalar string
	if err := json.Unmarshal(raw, &scalar); err == nil {
		if scalar != "all" {
			return nil, invalidField(field)
		}
		retention := inference.NewAllThinkingRetention()
		return &retention, nil
	}

	wireMetric, err := decodeStrict[contextMetricDTO](raw, field)
	if err != nil {
		return nil, err
	}
	switch wireMetric.Type {
	case "all":
		if wireMetric.Value != nil {
			return nil, invalidField(field + ".value")
		}
		retention := inference.NewAllThinkingRetention()
		return &retention, nil
	case string(inference.ContextMetricThinkingTurns):
		if wireMetric.Value == nil {
			return nil, invalidField(field + ".value")
		}
		retention, createErr := inference.NewRecentThinkingRetention(*wireMetric.Value)
		if createErr != nil {
			return nil, invalidField(field + ".value")
		}
		return &retention, nil
	default:
		return nil, invalidField(field + ".type")
	}
}

// decodeClearToolUsesEdit 将每个带单位阈值映射到不可混淆的 Canonical 数量。
func decodeClearToolUsesEdit(
	raw json.RawMessage,
	field string,
) (inference.ContextEdit, error) {
	wireEdit, err := decodeStrict[clearToolUsesEditDTO](raw, field)
	if err != nil {
		return inference.ContextEdit{}, err
	}
	if wireEdit.Type != clearToolUsesType {
		return inference.ContextEdit{}, invalidField(field + ".type")
	}
	trigger, err := decodeOptionalContextMetric(
		wireEdit.Trigger,
		field+".trigger",
		inference.ContextMetricInputTokens,
		inference.ContextMetricToolUses,
	)
	if err != nil {
		return inference.ContextEdit{}, err
	}
	keep, err := decodeOptionalContextMetric(
		wireEdit.Keep,
		field+".keep",
		inference.ContextMetricToolUses,
	)
	if err != nil {
		return inference.ContextEdit{}, err
	}
	clearAtLeast, err := decodeOptionalContextMetric(
		wireEdit.ClearAtLeast,
		field+".clear_at_least",
		inference.ContextMetricInputTokens,
	)
	if err != nil {
		return inference.ContextEdit{}, err
	}
	clearToolInputs, err := decodeToolInputClearPolicy(
		wireEdit.ClearToolInputs,
		field+".clear_tool_inputs",
	)
	if err != nil {
		return inference.ContextEdit{}, err
	}

	edit, err := inference.NewClearToolUsesEdit(inference.ClearToolUsesInput{
		Trigger:         trigger,
		Keep:            keep,
		ClearAtLeast:    clearAtLeast,
		ClearToolInputs: clearToolInputs,
		ExcludeTools:    wireEdit.ExcludeTools,
	})
	if err != nil {
		return inference.ContextEdit{}, invalidField(field)
	}
	return edit, nil
}

// decodeOptionalContextMetric 解析缺省或 null 数量，并约束允许的计量单位。
func decodeOptionalContextMetric(
	raw json.RawMessage,
	field string,
	allowed ...inference.ContextMetricKind,
) (*inference.ContextMetric, error) {
	if !hasJSONValue(raw) {
		return nil, nil
	}
	wireMetric, err := decodeStrict[contextMetricDTO](raw, field)
	if err != nil {
		return nil, err
	}
	if wireMetric.Value == nil {
		return nil, invalidField(field + ".value")
	}
	kind := inference.ContextMetricKind(wireMetric.Type)
	if !containsContextMetricKind(allowed, kind) {
		return nil, invalidField(field + ".type")
	}
	metric, err := inference.NewContextMetric(kind, *wireMetric.Value)
	if err != nil {
		return nil, invalidField(field + ".value")
	}
	return &metric, nil
}

// containsContextMetricKind 判断计量单位是否属于当前字段允许的联合成员。
func containsContextMetricKind(
	values []inference.ContextMetricKind,
	expected inference.ContextMetricKind,
) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

// decodeToolInputClearPolicy 保留 bool 与指定工具名列表两种互斥表达。
func decodeToolInputClearPolicy(
	raw json.RawMessage,
	field string,
) (*inference.ToolInputClearPolicy, error) {
	if !hasJSONValue(raw) {
		return nil, nil
	}
	var enabled bool
	if err := json.Unmarshal(raw, &enabled); err == nil {
		policy := inference.NewBooleanToolInputClear(enabled)
		return &policy, nil
	}
	var tools []string
	if err := json.Unmarshal(raw, &tools); err != nil || tools == nil {
		return nil, invalidField(field)
	}
	policy, err := inference.NewNamedToolInputClear(tools)
	if err != nil {
		return nil, invalidField(field)
	}
	return &policy, nil
}
