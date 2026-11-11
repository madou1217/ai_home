package webuiaccountsapi

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
)

// 本文件把 account_usage_snapshots.payload_json 的**原始采集文档**归一成前端契约
// （web/src/types/index.ts 的 AccountUsageSnapshot / CodexUsageEntry / GeminiUsageModel）。
//
// 为什么要有这一层：Node 侧 /v0/webui/accounts 下发的是
// lib/server/account-usage-view.js 的 normalizeAccountUsageSnapshot 结果——带 entryShape、
// 每条额度的 label/windowMinutes、旁路标记 category，以及顶层派生字段。
// Go 读模型如果直接透传 payload_json，前端拿到的是探针原始文档：`label` 缺失、窗口形态
// 没有 entryShape、codex 的重置次数仍叫 rateLimitResetCredits.availableCount。
//
// 归一规则与 lib/usage/quota/view.js 的 buildQuotaView 同口径：
//   - 形态只按**快照结构**推断（models[] → models，entries[] → bucket，windows[] → window，
//     顶层 remainingPct → account）。Go 的 provider manifest 没有 entryShape，这里不抄
//     Node 的 kind→shape 表，避免两份名单漂移；前端本来就按结构兜底（quota-scopes.ts
//     resolveShape），两种入口的结果一致。
//   - label 与 CLI 同表：显式 label > models 的 model/displayName > window > bucket 人读名。
//   - category='gift'/'detail' 是旁路信息，排在主额度之后并原样带出（前端据此排除账号级 min）。
//   - 主额度按窗口长度升序（0 = 未声明窗口，排在最后）；models 同窗口时最紧的在前。
//   - 不认识的形状/字段**原样返回**：一行坏快照不能把整页打成 500，也不能凭空造字段。
//
// 纯函数：不修改入参（只做浅拷贝 + 新条目对象），便于单测。
const (
	entryShapeWindow  = "window"
	entryShapeBucket  = "bucket"
	entryShapeModels  = "models"
	entryShapeAccount = "account"

	scopeCategoryGift   = "gift"
	scopeCategoryDetail = "detail"
)

// genericBucketPattern 与 lib/usage/quota/view.js 的 GENERIC_BUCKET_PATTERN 同一张表：
// 只描述额度种类、不携带身份的桶显示窗口标签，具名桶（模型名/套餐名）显示自己的名字。
var genericBucketPattern = newGenericBucketMatcher()

// newGenericBucketMatcher 用固定表 + rolling_<N>m 判断重建同一正则的语义。
// 这里不引 regexp：表很短且模式固定，手写分支比维护第二条正则更直白。
func newGenericBucketMatcher() func(string) bool {
	exact := map[string]bool{
		"primary": true, "secondary": true,
		"credit": true, "credits": true, "balance": true,
		"monthly": true, "monthly_quota": true, "daily": true, "weekly": true, "gift": true,
		"five_hour": true, "five_hour_window": true,
		"seven_day": true, "seven_day_window": true,
	}
	return func(bucket string) bool {
		if exact[bucket] {
			return true
		}
		// rolling_<N>m
		if strings.HasPrefix(bucket, "rolling_") && strings.HasSuffix(bucket, "m") {
			digits := strings.TrimSuffix(strings.TrimPrefix(bucket, "rolling_"), "m")
			if digits != "" && strings.Trim(digits, "0123456789") == "" {
				return true
			}
		}
		return false
	}
}

// bucketLabels 与 lib/usage/quota/view.js 的 BUCKET_LABELS 一字不差。
var bucketLabels = map[string]string{
	"credits":          "Credits",
	"credit":           "Credits",
	"balance":          "Balance",
	"monthly":          "Monthly",
	"monthly_quota":    "Monthly",
	"five_hour":        "5h",
	"five_hour_window": "5h",
	"seven_day":        "7days",
	"seven_day_window": "7days",
	"daily":            "Daily",
	"weekly":           "Weekly",
	"gift":             "Gift",
}

// normalizeUsageSnapshot 把一份原始快照归一成前端契约；无法识别时原样返回。
func normalizeUsageSnapshot(snapshot map[string]any) any {
	if len(snapshot) == 0 {
		return nil
	}
	explicitShape := normalizeEntryShape(snapshot["entryShape"])

	// 结构优先：哪个数组存在就用哪个。显式 entryShape 只能在结构兼容时收窄
	// window/bucket 的差别（前端两者渲染路径相同）。
	source, shape, entryField := resolveSnapshotSource(snapshot, explicitShape)
	if source == nil {
		// 没有条目数组：顶层 remainingPct 是账号级额度（Node 的 account scope）。
		if pct, ok := snapshotPercent(snapshot["remainingPct"]); ok {
			normalized := cloneSnapshotObject(snapshot)
			normalized["entryShape"] = entryShapeAccount
			normalized["entries"] = []map[string]any{accountBalanceEntry(pct)}
			return normalized
		}
		// 未知形状：原样下发，绝不编造 entryShape/条目。
		return snapshot
	}

	entries := normalizeEntryList(source, shape)
	// 条目为空但顶层有剩余额度：Node 的 buildQuotaView 会补一条账号级 Balance。
	// models 形态不补（Node 的 projectModels 会把它过滤掉，payload.models 保持空）。
	if len(entries) == 0 && shape != entryShapeModels {
		if pct, ok := snapshotPercent(snapshot["remainingPct"]); ok {
			entries = append(entries, accountBalanceEntry(pct))
		}
	}
	normalized := cloneSnapshotObject(snapshot)
	normalized["entryShape"] = shape
	normalized[entryField] = entries

	// codex 的重置次数在原始文档里叫 rateLimitResetCredits.availableCount，
	// 前端契约读顶层 resetCreditsAvailableCount。已有顶层值时以它为准。
	if _, exists := snapshot["resetCreditsAvailableCount"]; !exists {
		if count, ok := resetCreditsAvailableCount(snapshot); ok {
			normalized["resetCreditsAvailableCount"] = count
		}
	}
	// 套餐分组的组内条目与顶层同构，用同一个归一器投影。
	if groups, ok := snapshot["planGroups"].([]any); ok && len(groups) > 0 {
		normalized["planGroups"] = normalizePlanGroups(groups, shape)
	}
	return normalized
}

// accountBalanceEntry 是 buildQuotaView 在无条目快照上补的账号级 scope。
func accountBalanceEntry(remainingPct float64) map[string]any {
	return map[string]any{
		"bucket":        "",
		"label":         "Balance",
		"windowMinutes": float64(0),
		"window":        "",
		"remainingPct":  remainingPct,
		"resetIn":       "",
		"resetAtMs":     float64(0),
	}
}

// resolveSnapshotSource 选出承载条目的数组，并给出对应形态与输出字段名。
//
// 返回 nil 表示快照没有可识别的条目数组（调用方决定账号级兜底或原样降级）。
func resolveSnapshotSource(snapshot map[string]any, explicitShape string) ([]any, string, string) {
	if models, ok := snapshot["models"].([]any); ok {
		return models, entryShapeModels, "models"
	}
	if entries, ok := snapshot["entries"].([]any); ok {
		shape := entryShapeBucket
		if explicitShape == entryShapeWindow || explicitShape == entryShapeBucket || explicitShape == entryShapeAccount {
			shape = explicitShape
		}
		return entries, shape, "entries"
	}
	// 有些原始文档用 windows[] 承载窗口条目；前端契约只认 entries/models，
	// 所以收敛到 entries 字段。
	if windows, ok := snapshot["windows"].([]any); ok {
		shape := entryShapeWindow
		if explicitShape == entryShapeWindow || explicitShape == entryShapeBucket {
			shape = explicitShape
		}
		return windows, shape, "entries"
	}
	return nil, "", ""
}

func normalizeEntryShape(value any) string {
	switch strings.ToLower(strings.TrimSpace(snapshotString(value))) {
	case entryShapeWindow:
		return entryShapeWindow
	case entryShapeBucket:
		return entryShapeBucket
	case entryShapeModels:
		return entryShapeModels
	case entryShapeAccount:
		return entryShapeAccount
	default:
		return ""
	}
}

// normalizeEntryList 归一一个条目数组并排序；非对象条目直接跳过。
func normalizeEntryList(source []any, shape string) []map[string]any {
	entries := make([]map[string]any, 0, len(source))
	for _, item := range source {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		var normalized map[string]any
		if shape == entryShapeModels {
			normalized, ok = normalizeModelEntry(record)
		} else {
			normalized, ok = normalizeBucketEntry(record, shape)
		}
		if !ok {
			continue
		}
		entries = append(entries, normalized)
	}
	sortNormalizedEntries(entries, shape)
	return entries
}

// normalizeModelEntry 投影 models[] 条目（agy / gemini）。
func normalizeModelEntry(record map[string]any) (map[string]any, bool) {
	label := resolveScopeLabel(record, entryShapeModels)
	if label == "" {
		return nil, false
	}
	normalized := map[string]any{
		"model":        strings.TrimSpace(snapshotString(record["model"])),
		"label":        label,
		"remainingPct": snapshotPercentOrNil(record["remainingPct"]),
		"resetIn":      strings.TrimSpace(snapshotString(record["resetIn"])),
		"resetAtMs":    snapshotNumberOrZero(record["resetAtMs"]),
	}
	if displayName := strings.TrimSpace(snapshotString(record["displayName"])); displayName != "" {
		normalized["displayName"] = displayName
	}
	// 模型能力字段只在原始文档真的给了时才带出（与 Node projectModels 同规则）。
	for _, field := range []string{"supportsThinking", "supportsImages"} {
		if value, exists := record[field]; exists {
			if flag, ok := value.(bool); ok {
				normalized[field] = flag
			}
		}
	}
	for _, field := range []string{"maxTokens", "maxOutputTokens"} {
		if value, exists := record[field]; exists {
			normalized[field] = snapshotNullableNumber(value)
		}
	}
	return normalized, true
}

// normalizeBucketEntry 投影 entries[]/windows[] 条目（window / bucket 形态）。
func normalizeBucketEntry(record map[string]any, shape string) (map[string]any, bool) {
	label := resolveScopeLabel(record, shape)
	if label == "" {
		return nil, false
	}
	normalized := map[string]any{
		"bucket":        strings.TrimSpace(snapshotString(record["bucket"])),
		"label":         label,
		"windowMinutes": snapshotNumberOrZero(record["windowMinutes"]),
		"window":        strings.TrimSpace(snapshotString(record["window"])),
		"remainingPct":  snapshotPercentOrNil(record["remainingPct"]),
		"resetIn":       strings.TrimSpace(snapshotString(record["resetIn"])),
		"resetAtMs":     snapshotNumberOrZero(record["resetAtMs"]),
	}
	// 旁路标记只在非 primary 时带出（与 Node projectEntries 一致）。
	category := resolveScopeCategory(record)
	if category != "primary" {
		normalized["category"] = category
	}
	// 单位字段只要有一项可用就整组带出，保持前端 tooltip 的取值路径。
	total, hasTotal := snapshotNumber(record["totalUnits"])
	used, hasUsed := snapshotNumber(record["usedUnits"])
	remaining, hasRemaining := snapshotNumber(record["remainingUnits"])
	unitType := strings.TrimSpace(snapshotString(record["unitType"]))
	if hasTotal || hasUsed || hasRemaining || unitType != "" {
		normalized["totalUnits"] = nullableNumber(total, hasTotal)
		normalized["usedUnits"] = nullableNumber(used, hasUsed)
		normalized["remainingUnits"] = nullableNumber(remaining, hasRemaining)
		normalized["unitType"] = unitType
	}
	return normalized, true
}

// resolveScopeLabel 与 lib/usage/quota/view.js 的 resolveScopeLabel 同口径。
func resolveScopeLabel(record map[string]any, shape string) string {
	if label := strings.TrimSpace(snapshotString(record["label"])); label != "" {
		return label
	}
	if shape == entryShapeModels {
		return firstNonEmpty(
			strings.TrimSpace(snapshotString(record["model"])),
			strings.TrimSpace(snapshotString(record["displayName"])),
		)
	}
	rawWindow := strings.TrimSpace(snapshotString(record["window"]))
	windowLabel := humanizeWindow(rawWindow)
	rawBucket := strings.TrimSpace(snapshotString(record["bucket"]))
	bucketLabel := humanizeBucket(rawBucket)
	genericBucket := rawBucket == "" || genericBucketPattern(strings.ToLower(rawBucket))
	if !genericBucket {
		minutesLabel := windowLabel
		if minutesLabel == "" {
			minutesLabel = labelFromWindowMinutes(snapshotNumberOrZero(record["windowMinutes"]))
		}
		if shape == entryShapeBucket && minutesLabel != "" {
			return bucketLabel + " " + minutesLabel
		}
		return bucketLabel
	}
	if windowLabel != "" {
		return windowLabel
	}
	if bucketLabel != "" {
		return bucketLabel
	}
	if minutesLabel := labelFromWindowMinutes(snapshotNumberOrZero(record["windowMinutes"])); minutesLabel != "" {
		return minutesLabel
	}
	return "Balance"
}

func resolveScopeCategory(record map[string]any) string {
	switch strings.ToLower(strings.TrimSpace(snapshotString(record["category"]))) {
	case scopeCategoryGift:
		return scopeCategoryGift
	case scopeCategoryDetail:
		return scopeCategoryDetail
	default:
		return "primary"
	}
}

// sortNormalizedEntries 复刻 buildQuotaView 的排序：主额度在前、窗口短的在前、
// models 同窗口时剩余最少的在前；gift/detail 保持声明顺序排在最后。
func sortNormalizedEntries(entries []map[string]any, shape string) {
	sort.SliceStable(entries, func(left, right int) bool {
		leftCategory := categoryRank(entries[left])
		rightCategory := categoryRank(entries[right])
		if leftCategory != rightCategory {
			return leftCategory < rightCategory
		}
		if leftCategory != 0 {
			return false
		}
		leftWindow := windowSortKey(entries[left])
		rightWindow := windowSortKey(entries[right])
		if leftWindow != rightWindow {
			return leftWindow < rightWindow
		}
		if shape == entryShapeModels {
			leftPct := remainingSortKey(entries[left])
			rightPct := remainingSortKey(entries[right])
			if leftPct != rightPct {
				return leftPct < rightPct
			}
		}
		return false
	})
}

func categoryRank(entry map[string]any) int {
	if _, bypass := entry["category"]; bypass {
		return 1
	}
	return 0
}

func windowSortKey(entry map[string]any) float64 {
	if minutes, ok := snapshotNumber(entry["windowMinutes"]); ok && minutes > 0 {
		return minutes
	}
	return math.Inf(1)
}

func remainingSortKey(entry map[string]any) float64 {
	if pct, ok := snapshotNumber(entry["remainingPct"]); ok {
		return pct
	}
	return math.Inf(1)
}

// normalizePlanGroups 归一 zcode 的套餐分组：组结构原样保留，entries 走同一投影。
func normalizePlanGroups(groups []any, shape string) []any {
	normalized := make([]any, 0, len(groups))
	for _, item := range groups {
		group, ok := item.(map[string]any)
		if !ok {
			continue
		}
		copied := cloneSnapshotObject(group)
		if entries, ok := group["entries"].([]any); ok {
			copied["entries"] = normalizeEntryList(entries, shape)
		}
		normalized = append(normalized, copied)
	}
	return normalized
}

// resetCreditsAvailableCount 从原始 codex 文档里取重置次数（整数、非负）。
func resetCreditsAvailableCount(snapshot map[string]any) (int64, bool) {
	credits, ok := snapshot["rateLimitResetCredits"].(map[string]any)
	if !ok {
		return 0, false
	}
	value, ok := snapshotNumber(credits["availableCount"])
	if !ok || value < 0 || value != math.Trunc(value) {
		return 0, false
	}
	return int64(value), true
}

func humanizeBucket(bucket string) string {
	raw := strings.TrimSpace(bucket)
	if raw == "" {
		return ""
	}
	lower := strings.ToLower(raw)
	if label, ok := bucketLabels[lower]; ok {
		return label
	}
	if strings.HasPrefix(lower, "rolling_") && strings.HasSuffix(lower, "m") {
		digits := strings.TrimSuffix(strings.TrimPrefix(lower, "rolling_"), "m")
		if minutes, err := strconv.Atoi(digits); err == nil && minutes > 0 {
			if minutes%60 == 0 {
				return strconv.Itoa(minutes/60) + "h"
			}
			return strconv.Itoa(minutes) + "m"
		}
	}
	// 'gift:Invite to Earn Credit' 之类的复合桶名只取可读部分。
	for _, prefix := range []string{"gift:", "detail:"} {
		if strings.HasPrefix(raw, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(raw, prefix))
		}
	}
	return raw
}

func humanizeWindow(window string) string {
	raw := strings.TrimSpace(window)
	if minutes, ok := parseMinutesSuffix(raw); ok {
		if label := labelFromWindowMinutes(float64(minutes)); label != "" {
			return label
		}
	}
	return raw
}

func parseMinutesSuffix(value string) (int, bool) {
	if len(value) < 2 || value[len(value)-1] != 'm' {
		return 0, false
	}
	minutes, err := strconv.Atoi(value[:len(value)-1])
	if err != nil || minutes <= 0 {
		return 0, false
	}
	return minutes, true
}

// labelFromWindowMinutes 与 lib/usage/quota/view.js 的 labelFromWindowMinutes 一致。
func labelFromWindowMinutes(minutes float64) string {
	if math.IsNaN(minutes) || math.IsInf(minutes, 0) || minutes <= 0 {
		return ""
	}
	value := int64(math.Round(minutes))
	if value%1440 == 0 {
		return strconv.FormatInt(value/1440, 10) + "days"
	}
	if value%60 == 0 {
		return strconv.FormatInt(value/60, 10) + "h"
	}
	days := value / 1440
	hours := (value % 1440) / 60
	rest := value % 60
	label := ""
	if days > 0 {
		label += strconv.FormatInt(days, 10) + "d"
	}
	if hours > 0 {
		label += strconv.FormatInt(hours, 10) + "h"
	}
	if rest > 0 {
		label += strconv.FormatInt(rest, 10) + "m"
	}
	if label == "" {
		return strconv.FormatInt(value, 10) + "m"
	}
	return label
}

func cloneSnapshotObject(source map[string]any) map[string]any {
	clone := make(map[string]any, len(source)+2)
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

// snapshotPercentOrNil 总是返回值（契约里 remainingPct 键必须存在，未知时为 null）。
func snapshotPercentOrNil(value any) any {
	if pct, ok := snapshotPercent(value); ok {
		return pct
	}
	return nil
}

func snapshotPercent(value any) (float64, bool) {
	numeric, ok := snapshotNumber(value)
	if !ok {
		return 0, false
	}
	return math.Max(0, math.Min(100, numeric)), true
}

func snapshotNumberOrZero(value any) float64 {
	if numeric, ok := snapshotNumber(value); ok {
		return numeric
	}
	return 0
}

func snapshotNullableNumber(value any) any {
	if numeric, ok := snapshotNumber(value); ok {
		return numeric
	}
	return nil
}

func nullableNumber(value float64, ok bool) any {
	if !ok {
		return nil
	}
	return value
}

// snapshotNumber 与 JS Number() 的宽松口径一致：数字、数字串、json.Number 都接受。
func snapshotNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case nil:
		return 0, false
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case float32:
		return snapshotNumber(float64(typed))
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case uint16:
		return float64(typed), true
	case uint:
		return float64(typed), true
	case uint64:
		return float64(typed), true
	case json.Number:
		return snapshotNumber(typed.String())
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, false
		}
		numeric, err := strconv.ParseFloat(trimmed, 64)
		if err != nil || math.IsNaN(numeric) || math.IsInf(numeric, 0) {
			return 0, false
		}
		return numeric, true
	default:
		return 0, false
	}
}

func snapshotString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	default:
		return ""
	}
}
