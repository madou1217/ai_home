package codexresponsesws

import (
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
)

// completedUsageDTO 只读取 response.completed 帧里的 response.usage（Responses API 形状）。
type completedUsageDTO struct {
	Response struct {
		Usage *struct {
			InputTokens        uint64 `json:"input_tokens"`
			InputTokensDetails *struct {
				CachedTokens     uint64 `json:"cached_tokens"`
				CacheWriteTokens uint64 `json:"cache_write_tokens"`
			} `json:"input_tokens_details"`
			OutputTokens        uint64 `json:"output_tokens"`
			OutputTokensDetails *struct {
				ReasoningTokens uint64 `json:"reasoning_tokens"`
			} `json:"output_tokens_details"`
		} `json:"usage"`
	} `json:"response"`
}

// decodeCompletedUsage 从透传的完成帧旁路读出本轮 token 用量（账号页 Token 用量）；
// 缺失或不一致时返回 false，绝不影响帧透传与运行态记账。
func decodeCompletedUsage(payload []byte) (inference.Usage, bool) {
	var wire completedUsageDTO
	if json.Unmarshal(payload, &wire) != nil || wire.Response.Usage == nil {
		return inference.Usage{}, false
	}
	raw := wire.Response.Usage
	input := inference.UsageInput{InputTokens: raw.InputTokens, OutputTokens: raw.OutputTokens}
	if raw.InputTokensDetails != nil {
		input.CachedInputTokens = raw.InputTokensDetails.CachedTokens
		input.CacheWriteInputTokens = raw.InputTokensDetails.CacheWriteTokens
	}
	if raw.OutputTokensDetails != nil {
		input.ReasoningTokens = raw.OutputTokensDetails.ReasoningTokens
	}
	usage, err := inference.NewUsage(input)
	if err != nil || usage.TotalTokens() == 0 {
		return inference.Usage{}, false
	}
	return usage, true
}
