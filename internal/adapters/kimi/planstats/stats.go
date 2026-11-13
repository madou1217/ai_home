package planstats

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

// Stats 是 /accounts/kimi/:ref/plan-stats 的 stats 字段（与 Node 同名同形）。
//
// 所有可空对象都用指针表达：proto3 JSON 省略零值，UI 依赖 null 判断「没有该项」，
// 不能用零值对象冒充。
type Stats struct {
	CapturedAtMS int64      `json:"capturedAtMs"`
	Total        *Total     `json:"total"`
	RateLimits   RateLimits `json:"rateLimits"`
	Gifts        []Balance  `json:"gifts"`
	Notice       *Notice    `json:"notice"`
	Overdrawn    bool       `json:"overdrawn"`
	Plan         *Plan      `json:"plan"`
}

// Total 是月度订阅额度总量。
type Total struct {
	UsedRatio     float64 `json:"usedRatio"`
	CodeUsedRatio float64 `json:"codeUsedRatio"`
	ResetAtMS     int64   `json:"resetAtMs"`
}

// RateLimits 是四类限时窗口；缺失时对应字段为 null。
type RateLimits struct {
	Chat5h *RateLimit `json:"chat5h"`
	Code5h *RateLimit `json:"code5h"`
	Chat7d *RateLimit `json:"chat7d"`
	Code7d *RateLimit `json:"code7d"`
}

// RateLimit 是一个限时窗口的状态。
type RateLimit struct {
	UsedRatio float64 `json:"usedRatio"`
	Enabled   bool    `json:"enabled"`
	ResetAtMS int64   `json:"resetAtMs"`
}

// Balance 是一份额度（订阅或 Gift）。
type Balance struct {
	Name          string  `json:"name"`
	Type          string  `json:"type"`
	UsedRatio     float64 `json:"usedRatio"`
	CodeUsedRatio float64 `json:"codeUsedRatio"`
	ExpireAtMS    int64   `json:"expireAtMs"`
}

// Notice 是月度用尽提示。
type Notice struct {
	Tip       string `json:"tip"`
	Content   string `json:"content"`
	ResetAtMS int64  `json:"resetAtMs"`
}

// Plan 是套餐名与有效期（来自 GetSubscription）。
type Plan struct {
	Name         string `json:"name"`
	Level        string `json:"level"`
	Status       string `json:"status"`
	ValidUntilMS int64  `json:"validUntilMs"`
	ResetAtMS    int64  `json:"resetAtMs"`
}

// normalizeSubscriptionStats 把 GetSubscriptionStats 的 proto3 JSON 归一成 UI 形状。
//
// 与 Node normalizeSubscriptionStats 逐字段对齐：ratio 夹到 [0,1]（缺失即 0），
// enabled 只有显式 false 才是 false，时间字段解析失败归 0。
func normalizeSubscriptionStats(payload map[string]any, nowMS int64) Stats {
	subscriptionBalance := objectLike(readField(payload, "subscriptionBalance", "subscription_balance"))
	gifts := make([]Balance, 0)
	for _, rawGift := range arrayField(payload, "giftBalances", "gift_balances") {
		if balance, ok := normalizeBalance(rawGift); ok {
			gifts = append(gifts, balance)
		}
	}
	var notice *Notice
	if rawNotice := objectLike(readField(payload, "notice")); rawNotice != nil {
		notice = &Notice{
			Tip:       stringField(rawNotice, "tip"),
			Content:   stringField(rawNotice, "content"),
			ResetAtMS: readTimeMS(rawNotice, "resetTime", "reset_time"),
		}
	}
	var total *Total
	if subscriptionBalance != nil {
		total = &Total{
			UsedRatio:     readRatio(subscriptionBalance, "amountUsedRatio", "amount_used_ratio"),
			CodeUsedRatio: readRatio(subscriptionBalance, "kimiCodeUsedRatio", "kimi_code_used_ratio"),
			ResetAtMS:     readTimeMS(subscriptionBalance, "expireTime", "expire_time"),
		}
	}
	return Stats{
		CapturedAtMS: nowMS,
		Total:        total,
		RateLimits: RateLimits{
			Chat5h: normalizeRateLimitStat(objectLike(readField(payload, "ratelimit5h", "ratelimit_5h"))),
			Code5h: normalizeRateLimitStat(objectLike(readField(payload, "ratelimitCode5h", "ratelimit_code_5h"))),
			Chat7d: normalizeRateLimitStat(objectLike(readField(payload, "ratelimit7d", "ratelimit_7d"))),
			Code7d: normalizeRateLimitStat(objectLike(readField(payload, "ratelimitCode7d", "ratelimit_code_7d"))),
		},
		Gifts:     gifts,
		Notice:    notice,
		Overdrawn: readField(payload, "overdrawn") == true,
	}
}

// normalizeSubscription 把 GetSubscription 归一成套餐摘要；没有 subscription 返回 nil。
func normalizeSubscription(payload map[string]any) *Plan {
	subscription := objectLike(readField(payload, "subscription"))
	if subscription == nil {
		return nil
	}
	goods := objectLike(readField(subscription, "goods"))
	if goods == nil {
		goods = map[string]any{}
	}
	status := stringField(subscription, "status")
	level := stringField(goods, "membershipLevel", "membership_level")
	// Node: level.replace(/^LEVEL_/i, '').toLowerCase()
	if len(level) >= 6 && strings.EqualFold(level[:6], "LEVEL_") {
		level = level[6:]
	}
	level = strings.ToLower(level)
	planStatus := "active"
	if status == "SUBSCRIPTION_STATUS_CANCEL" {
		planStatus = "canceled"
	}
	return &Plan{
		Name:         stringField(goods, "title"),
		Level:        level,
		Status:       planStatus,
		ValidUntilMS: readTimeMS(subscription, "nextBillingTime", "next_billing_time"),
		ResetAtMS:    readTimeMS(subscription, "currentEndTime", "current_end_time"),
	}
}

// normalizeRateLimitStat 归一一个限时窗口；非对象返回 nil。
func normalizeRateLimitStat(raw map[string]any) *RateLimit {
	if raw == nil {
		return nil
	}
	enabled := true
	if value, exists := raw["enabled"]; exists {
		if boolean, ok := value.(bool); ok && !boolean {
			enabled = false
		}
	}
	return &RateLimit{
		UsedRatio: readRatio(raw, "ratio"),
		Enabled:   enabled,
		ResetAtMS: readTimeMS(raw, "resetTime", "reset_time"),
	}
}

// normalizeBalance 归一一份额度；非对象返回 ok=false。
func normalizeBalance(raw any) (Balance, bool) {
	record := objectLike(raw)
	if record == nil {
		return Balance{}, false
	}
	return Balance{
		Name:          stringField(record, "displayName", "display_name"),
		Type:          stringField(record, "type"),
		UsedRatio:     readRatio(record, "amountUsedRatio", "amount_used_ratio"),
		CodeUsedRatio: readRatio(record, "kimiCodeUsedRatio", "kimi_code_used_ratio"),
		ExpireAtMS:    readTimeMS(record, "expireTime", "expire_time"),
	}, true
}

// readField 依次读取第一个非 null 字段。
func readField(data map[string]any, names ...string) any {
	if data == nil {
		return nil
	}
	for _, name := range names {
		if value, exists := data[name]; exists && value != nil {
			return value
		}
	}
	return nil
}

// objectLike 把 JSON 对象转成 map；数组按空对象处理（Node typeof [] === 'object'）。
func objectLike(value any) map[string]any {
	switch typed := value.(type) {
	case map[string]any:
		return typed
	case []any:
		return map[string]any{}
	default:
		return nil
	}
}

// arrayField 读取数组字段；非数组返回空切片（Node 用 Array.isArray 判断）。
func arrayField(data map[string]any, names ...string) []any {
	value, ok := readField(data, names...).([]any)
	if !ok {
		return nil
	}
	return value
}

// readRatio 读取 0..1 比例；缺失/非数字即 0。
func readRatio(data map[string]any, names ...string) float64 {
	value, ok := toNumber(readField(data, names...))
	if !ok {
		return 0
	}
	return math.Max(0, math.Min(1, value))
}

// toNumber 把 JSON 数字转成 float64。
func toNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return 0, false
		}
		return parsed, true
	case string:
		// Node 用 Number(value) 解析，数字字符串同样算数。
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

// readTimeMS 把 RFC3339 时间字符串转成毫秒；缺失/非法即 0。
func readTimeMS(data map[string]any, names ...string) int64 {
	value, ok := readField(data, names...).(string)
	if !ok || strings.TrimSpace(value) == "" {
		return 0
	}
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return 0
	}
	return parsed.UnixMilli()
}

// stringField 读取字符串字段并 trim。
func stringField(data map[string]any, names ...string) string {
	value, ok := readField(data, names...).(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(value)
}
