package accountusage

import (
	"strings"
	"unicode"
)

// NormalizePlanToken 把 Provider 的套餐展示名归一成小写 token：
// 去掉首尾空白，连续空白或连字符折叠成一个下划线（"Pro Plus" → "pro_plus"）。
//
// 这是 Node「已注册配额策略」的口径（base-strategy 的 [\s-]+ → _），
// 适用于 kimi / zcode 这类按词汇表判定档位的 Provider（agy 走子串判据，不用它）。
// 不含任何 Provider 的套餐词汇表 —— 哪些 token 算有效套餐由各 Adapter 自己决定。
// 超过列长度上限的展示名返回空串（未知），不做截断：截断后的 token 可能和另一个套餐撞名。
func NormalizePlanToken(raw string) string {
	lower := strings.ToLower(strings.TrimSpace(raw))
	if lower == "" {
		return ""
	}
	parts := strings.FieldsFunc(lower, func(value rune) bool {
		return unicode.IsSpace(value) || value == '-'
	})
	if len(parts) == 0 {
		return ""
	}
	token := strings.Join(parts, "_")
	if len(token) > maxPlanTypeLength {
		return ""
	}
	return token
}

// NormalizePlanName 是 Node「默认配额策略」的口径：只做小写与去空白，
// 保留套餐名里原有的空格与连字符（"Pro Plus" → "pro plus"）。
//
// 只给仍有 Node 侧采集的 Provider 用（目前是 codebuddy 家族）：同一账号在
// Node app-state.db 与 Go aih.db 里写的是同一个逻辑套餐，两边必须同口径，
// 否则切页时套餐标签会变样。已全量迁到 Go 的 Provider 用 NormalizePlanToken。
// 超长同样返回空串（未知）。
func NormalizePlanName(raw string) string {
	name := strings.ToLower(strings.TrimSpace(raw))
	if len(name) > maxPlanTypeLength {
		return ""
	}
	return name
}
