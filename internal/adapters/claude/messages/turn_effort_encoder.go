package messages

import "github.com/madou1217/ai_home/core/inference"

// encodeTurnEffort 把 Canonical system 消息的按轮推理强度写回 Messages 线协议的
// 消息级 output_config，并声明 Claude Code 同样声明的 per-turn-control 与 effort beta。
func (encoder *requestEncoder) encodeTurnEffort(effort inference.ReasoningEffort) (*outputConfigDTO, error) {
	if effort == "" {
		return nil, nil
	}
	wireEffort, err := anthropicEffort(effort)
	if err != nil {
		return nil, err
	}
	if wireEffort == "" {
		return nil, nil
	}
	encoder.addBeta(betaPerTurnControl)
	encoder.addBeta(betaEffort)
	return &outputConfigDTO{Effort: wireEffort}, nil
}
