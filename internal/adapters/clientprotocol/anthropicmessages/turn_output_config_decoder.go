package anthropicmessages

import (
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
)

// turnOutputConfigDTO 是对话中途 system 消息上的按轮控制（per-turn-control-2026-07-01）。
//
// Claude Code 用它切换从该轮起的推理强度，例如
// {"role":"system","content":[…],"output_config":{"effort":"medium"}}。
// 只建模已确认的 effort；其它子字段（如 timing）按未知字段拒收，由 Node 原样透传，
// 不在 Canonical 里静默丢掉。
type turnOutputConfigDTO struct {
	Effort *string `json:"effort"`
}

// applyTurnOutputConfig 把消息级 output_config 解码为按轮推理强度；没有该字段时原样返回。
func applyTurnOutputConfig(message inference.Message, raw json.RawMessage, field string) (inference.Message, error) {
	if !hasJSONValue(raw) {
		return message, nil
	}
	if message.Role() != inference.RoleSystem {
		return inference.Message{}, unsupportedField(field)
	}
	wire, err := decodeStrict[turnOutputConfigDTO](raw, field)
	if err != nil {
		return inference.Message{}, err
	}
	if wire.Effort == nil {
		return inference.Message{}, invalidField(field)
	}
	effort, err := decodeEffort(*wire.Effort, field+".effort")
	if err != nil {
		return inference.Message{}, err
	}
	withEffort, err := message.WithTurnEffort(effort)
	if err != nil {
		return inference.Message{}, invalidField(field + ".effort")
	}
	return withEffort, nil
}
