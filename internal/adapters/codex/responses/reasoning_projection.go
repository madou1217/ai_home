package responses

import "github.com/madou1217/ai_home/core/inference"

// Codex Responses 只有 reasoning.effort 一个强度维度，没有 budget 与 adaptive。
// 但 Canonical 的 budget/adaptive 模式同样携带抽象 effort
// （NewBudgetReasoningWithEffort / NewAdaptiveReasoningWithEffort），Claude 客户端
// 解码时也确实会填它（anthropicmessages/options_decoder.go:263,280）——真实
// Claude Code 发的就是 thinking:{type:"adaptive"} + output_config.effort。
//
// 因此跨协议不需要"猜"强度：effort 在就直接用。只有客户端只给了 budget_tokens
// 而没给 effort 时才需要推导。
const (
	// budgetLowUpperBound 是仍按 low 处理的思考预算上界。
	//
	// 分档依据 Claude Code 的输出上限体系（内部 max_output_tokens 常量：
	// 现代模型默认 32000、上限 64000，feature-flag 压缩档 8000）。budget 相对
	// 这套量级的位置，是客户端表达"想思考多少"的唯一可用信号。
	budgetLowUpperBound uint64 = 8_000
	// budgetMediumUpperBound 是仍按 medium 处理的思考预算上界。
	budgetMediumUpperBound uint64 = 32_000
)

// projectReasoningEffort 把 Canonical reasoning 意图投影为 Codex effort。
//
// 返回空字符串表示不应发送 reasoning 字段。
func projectReasoningEffort(config inference.ReasoningConfig) inference.ReasoningEffort {
	if effort := config.Effort(); effort != "" {
		// 客户端已明确强度，任何模式下都直接沿用，不做二次解释。
		return effort
	}
	switch config.Mode() {
	case inference.ReasoningModeAdaptive:
		// adaptive 表示"由模型自行决定思考量"，Codex 没有等价档位。
		// high 是最接近的表达：它同样让模型充分思考，而不是给死预算。
		return inference.ReasoningEffortHigh
	case inference.ReasoningModeBudget:
		switch budget := config.BudgetTokens(); {
		case budget <= budgetLowUpperBound:
			return inference.ReasoningEffortLow
		case budget <= budgetMediumUpperBound:
			return inference.ReasoningEffortMedium
		default:
			return inference.ReasoningEffortHigh
		}
	default:
		return ""
	}
}
