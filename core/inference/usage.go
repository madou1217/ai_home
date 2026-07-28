package inference

import "math"

// UsageInput 是 Provider Decoder 创建统一 token 快照所需的计数。
type UsageInput struct {
	// InputTokens 是当前响应累计消耗的全部输入 token。
	InputTokens uint64
	// OutputTokens 是当前响应累计生成的全部输出 token。
	OutputTokens uint64
	// CachedInputTokens 是 InputTokens 中命中缓存的子集。
	CachedInputTokens uint64
	// CacheWriteInputTokens 是 InputTokens 中写入缓存的子集。
	CacheWriteInputTokens uint64
	// ReasoningTokens 是 OutputTokens 中用于 reasoning 的子集。
	ReasoningTokens uint64
}

// Usage 是 Codex 与 Claude 共有的不可变累计 token 快照。
type Usage struct {
	inputTokens           uint64
	outputTokens          uint64
	cachedInputTokens     uint64
	cacheWriteInputTokens uint64
	reasoningTokens       uint64
	totalTokens           uint64
}

// NewUsage 创建内部一致且不会发生总量溢出的 token 快照。
func NewUsage(input UsageInput) (Usage, error) {
	if input.CachedInputTokens > input.InputTokens ||
		input.CacheWriteInputTokens > input.InputTokens ||
		input.ReasoningTokens > input.OutputTokens ||
		input.OutputTokens > math.MaxUint64-input.InputTokens {
		return Usage{}, ErrInvalidUsage
	}
	return Usage{
		inputTokens:           input.InputTokens,
		outputTokens:          input.OutputTokens,
		cachedInputTokens:     input.CachedInputTokens,
		cacheWriteInputTokens: input.CacheWriteInputTokens,
		reasoningTokens:       input.ReasoningTokens,
		totalTokens:           input.InputTokens + input.OutputTokens,
	}, nil
}

// InputTokens 返回累计输入 token。
func (usage Usage) InputTokens() uint64 {
	return usage.inputTokens
}

// OutputTokens 返回累计输出 token。
func (usage Usage) OutputTokens() uint64 {
	return usage.outputTokens
}

// CachedInputTokens 返回输入 token 中的缓存命中子集。
func (usage Usage) CachedInputTokens() uint64 {
	return usage.cachedInputTokens
}

// CacheWriteInputTokens 返回输入 token 中的缓存写入子集。
func (usage Usage) CacheWriteInputTokens() uint64 {
	return usage.cacheWriteInputTokens
}

// ReasoningTokens 返回输出 token 中的 reasoning 子集。
func (usage Usage) ReasoningTokens() uint64 {
	return usage.reasoningTokens
}

// TotalTokens 返回由输入与输出安全求和得到的累计 token。
func (usage Usage) TotalTokens() uint64 {
	return usage.totalTokens
}

// IsValid 判断 token 子集和预计算总量仍满足构造不变量。
func (usage Usage) IsValid() bool {
	restored, err := NewUsage(UsageInput{
		InputTokens:           usage.inputTokens,
		OutputTokens:          usage.outputTokens,
		CachedInputTokens:     usage.cachedInputTokens,
		CacheWriteInputTokens: usage.cacheWriteInputTokens,
		ReasoningTokens:       usage.reasoningTokens,
	})
	return err == nil && restored.totalTokens == usage.totalTokens
}
