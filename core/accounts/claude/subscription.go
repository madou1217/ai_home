package claude

// SubscriptionKind 是 Claude.ai 官方订阅在 Provider 内部的稳定分类。
type SubscriptionKind string

const (
	// SubscriptionKindUnknown 表示官方未提供或当前版本尚不认识的订阅。
	SubscriptionKindUnknown SubscriptionKind = "unknown"
	// SubscriptionKindMax 表示 Claude Max。
	SubscriptionKindMax SubscriptionKind = "max"
	// SubscriptionKindPro 表示 Claude Pro。
	SubscriptionKindPro SubscriptionKind = "pro"
	// SubscriptionKindTeam 表示 Claude Team。
	SubscriptionKindTeam SubscriptionKind = "team"
	// SubscriptionKindEnterprise 表示 Claude Enterprise。
	SubscriptionKindEnterprise SubscriptionKind = "enterprise"
)

// Subscription 同时保留官方原始值和可用于筛选的稳定语义。
type Subscription struct {
	rawType       string
	rateLimitTier string
	kind          SubscriptionKind
}

// NewSubscription 校验公开元数据并创建 Claude Provider 专属订阅值。
//
// 未知订阅和 tier 不会被拒绝，调用方可以在升级代码后重新解释原始值。
func NewSubscription(rawType string, rateLimitTier string) (Subscription, error) {
	normalizedType, err := normalizeMetadata(rawType)
	if err != nil {
		return Subscription{}, err
	}
	normalizedTier, err := normalizeMetadata(rateLimitTier)
	if err != nil {
		return Subscription{}, err
	}
	return Subscription{
		rawType:       normalizedType,
		rateLimitTier: normalizedTier,
		kind:          classifySubscription(normalizedType),
	}, nil
}

// RawType 返回官方 subscriptionType 原始逻辑值。
func (subscription Subscription) RawType() string {
	return subscription.rawType
}

// RateLimitTier 返回官方 rateLimitTier 原始逻辑值。
func (subscription Subscription) RateLimitTier() string {
	return subscription.rateLimitTier
}

// Kind 返回稳定订阅分类；非法零值也按 unknown 处理。
func (subscription Subscription) Kind() SubscriptionKind {
	switch subscription.kind {
	case SubscriptionKindMax,
		SubscriptionKindPro,
		SubscriptionKindTeam,
		SubscriptionKindEnterprise:
		return subscription.kind
	default:
		return SubscriptionKindUnknown
	}
}

// IsKnown 判断当前版本是否认识官方订阅类型。
func (subscription Subscription) IsKnown() bool {
	return subscription.Kind() != SubscriptionKindUnknown
}

// UsageMultiplier 返回明确额度层级对应的倍率以及倍率是否已知。
//
// 倍率只由 rateLimitTier 决定，因为 Team Premium 也可能使用 Max 5x tier。
func (subscription Subscription) UsageMultiplier() (int, bool) {
	switch subscription.rateLimitTier {
	case "default_claude_max_5x":
		return 5, true
	case "default_claude_max_20x":
		return 20, true
	default:
		return 0, false
	}
}

// String 返回稳定订阅分类文本。
func (kind SubscriptionKind) String() string {
	switch kind {
	case SubscriptionKindMax,
		SubscriptionKindPro,
		SubscriptionKindTeam,
		SubscriptionKindEnterprise:
		return string(kind)
	default:
		return string(SubscriptionKindUnknown)
	}
}

// classifySubscription 映射 Claude Code 当前明确支持的官方 subscriptionType。
func classifySubscription(rawType string) SubscriptionKind {
	switch rawType {
	case "max":
		return SubscriptionKindMax
	case "pro":
		return SubscriptionKindPro
	case "team":
		return SubscriptionKindTeam
	case "enterprise":
		return SubscriptionKindEnterprise
	default:
		return SubscriptionKindUnknown
	}
}
