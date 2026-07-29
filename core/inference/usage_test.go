package inference

import (
	"errors"
	"testing"
)

// TestUsagePreservesProviderTokenBreakdown 验证缓存和 reasoning token 作为总量子集保留，
// 总 token 由输入输出统一计算。
func TestUsagePreservesProviderTokenBreakdown(t *testing.T) {
	t.Parallel()

	usage, err := NewUsage(UsageInput{
		InputTokens:           100,
		OutputTokens:          40,
		CachedInputTokens:     60,
		CacheWriteInputTokens: 20,
		ReasoningTokens:       10,
	})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	if usage.TotalTokens() != 140 || usage.CachedInputTokens() != 60 || usage.ReasoningTokens() != 10 {
		t.Fatalf("usage = %#v, want complete token breakdown", usage)
	}
}

// TestUsageRejectsImpossibleBreakdownAndOverflow 验证子集不能超过对应总量，
// 输入输出求和也不能溢出。
func TestUsageRejectsImpossibleBreakdownAndOverflow(t *testing.T) {
	t.Parallel()

	invalidInputs := []UsageInput{
		{InputTokens: 1, CachedInputTokens: 2},
		{InputTokens: 1, CacheWriteInputTokens: 2},
		{InputTokens: 3, CachedInputTokens: 2, CacheWriteInputTokens: 2},
		{OutputTokens: 1, ReasoningTokens: 2},
		{InputTokens: ^uint64(0), OutputTokens: 1},
	}
	for _, input := range invalidInputs {
		if _, err := NewUsage(input); !errors.Is(err, ErrInvalidUsage) {
			t.Fatalf("NewUsage(%+v) error = %v, want ErrInvalidUsage", input, err)
		}
	}
}
