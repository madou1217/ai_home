package usageledger

// QuotaBucketStats 是按额度档位聚合的用量行。
//
// 档位来自调度策略（credits / 5h / 7days …）；空档位表示该 Provider 没有档位语义。
type QuotaBucketStats struct {
	Provider              string `json:"provider"`
	QuotaBucket           string `json:"quota_bucket"`
	Calls                 uint64 `json:"calls"`
	InputTokens           uint64 `json:"input_tokens"`
	OutputTokens          uint64 `json:"output_tokens"`
	CacheReadInputTokens  uint64 `json:"cache_read_input_tokens"`
	CacheWriteInputTokens uint64 `json:"cache_creation_input_tokens"`
	ReasoningOutputTokens uint64 `json:"reasoning_output_tokens"`
	TotalTokens           uint64 `json:"total_tokens"`
}
