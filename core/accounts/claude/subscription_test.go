package claude

import "testing"

// TestNewSubscriptionClassifiesOfficialTypes 验证 Claude 官方订阅值只映射为 Provider 内部语义。
func TestNewSubscriptionClassifiesOfficialTypes(t *testing.T) {
	tests := []struct {
		raw  string
		kind SubscriptionKind
	}{
		{raw: "max", kind: SubscriptionKindMax},
		{raw: "pro", kind: SubscriptionKindPro},
		{raw: "team", kind: SubscriptionKindTeam},
		{raw: "enterprise", kind: SubscriptionKindEnterprise},
	}

	for _, test := range tests {
		t.Run(test.raw, func(t *testing.T) {
			subscription, err := NewSubscription(test.raw, "")
			if err != nil {
				t.Fatalf("创建订阅值失败: %v", err)
			}
			if subscription.RawType() != test.raw || subscription.Kind() != test.kind {
				t.Fatalf("订阅映射错误: raw=%q kind=%q", subscription.RawType(), subscription.Kind())
			}
			if !subscription.IsKnown() {
				t.Fatal("官方订阅类型不应标记为未知")
			}
		})
	}
}

// TestNewSubscriptionPreservesUnknownValues 验证未来订阅和额度层级不会被本地枚举拒绝。
func TestNewSubscriptionPreservesUnknownValues(t *testing.T) {
	subscription, err := NewSubscription("future_plan", "future_tier_42x")
	if err != nil {
		t.Fatalf("未来订阅值不应被拒绝: %v", err)
	}
	if subscription.RawType() != "future_plan" || subscription.RateLimitTier() != "future_tier_42x" {
		t.Fatalf("未来上游值丢失: %+v", subscription)
	}
	if subscription.Kind() != SubscriptionKindUnknown || subscription.IsKnown() {
		t.Fatalf("未来订阅分类错误: %q", subscription.Kind())
	}
	if _, known := subscription.UsageMultiplier(); known {
		t.Fatal("未知额度层级不应伪造倍率")
	}
}

// TestSubscriptionDerivesKnownUsageMultiplier 验证额度倍率只从明确的官方 tier 派生。
func TestSubscriptionDerivesKnownUsageMultiplier(t *testing.T) {
	tests := []struct {
		tier       string
		multiplier int
	}{
		{tier: "default_claude_max_5x", multiplier: 5},
		{tier: "default_claude_max_20x", multiplier: 20},
	}

	for _, test := range tests {
		t.Run(test.tier, func(t *testing.T) {
			subscription, err := NewSubscription("team", test.tier)
			if err != nil {
				t.Fatalf("创建订阅值失败: %v", err)
			}
			multiplier, known := subscription.UsageMultiplier()
			if !known || multiplier != test.multiplier {
				t.Fatalf("额度倍率错误: got=%d known=%t want=%d", multiplier, known, test.multiplier)
			}
		})
	}
}

// TestNewSubscriptionRejectsUnsafeMetadata 验证控制字符和异常长度仍受领域约束。
func TestNewSubscriptionRejectsUnsafeMetadata(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		tier string
	}{
		{name: "套餐控制字符", raw: "max\nforged"},
		{name: "额度控制字符", raw: "max", tier: "tier\rforged"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NewSubscription(test.raw, test.tier); err == nil {
				t.Fatal("不安全订阅元数据应被拒绝")
			}
		})
	}
}
