package usage

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"strings"
)

// 本文件移植 Node lib/account/quota-reset/agy-strategy.js 的 extractObservations：
// 把一份 agy 展示文档投影成额度桶观测。
//
// agy 的额度不是「每个模型一个桶」：上游把模型分成两个模型池——
// Gemini 与 Claude & GPT——每个池各有 5h 与 Weekly 两个滑动窗口，
// 所以统计维度固定是 4 个：
//
//	rate_limit:gemini_5h        rate_limit:gemini_week
//	rate_limit:claude_gpt_5h    rate_limit:claude_gpt_week
//
// 不这样聚合的话，同一个池里的十几个模型会变成十几条互不相干的曲线，
// 窗口统计既对不上号，也没法回答「这个池这周还剩多少」。
//
// 窗口类型判据（与 Node 同序）：
//  1. resetAtMs > capturedAt：按 ceil((reset-captured)/60000) > 360 判周窗口，否则 5h；
//  2. 否则看 resetIn 文本里是否有 day / days / 单独的 d，有则周窗口；
//  3. 都没有时按 5h。
//
// 故意不同：Node 在 snapshot.models 不是数组时会退回 entries[] 的通用分支；
// agy 文档只产出 models[]（docs: parseAgyCodeAssistQuotaSnapshot），entries 分支
// 属于时间窗型 Provider，各自适配器已有实现，这里不再复制一份。

const (
	// agyFiveHourWindowMinutes / agyWeeklyWindowMinutes 与 Node 的 windowMinutes 同值。
	agyFiveHourWindowMinutes = int64(300)
	agyWeeklyWindowMinutes   = int64(10080)
	// agyWeeklyThresholdMinutes 是 Node 的周窗口判据（> 360 分钟）。
	agyWeeklyThresholdMinutes = int64(360)
)

// agyWeeklyResetInPattern 对应 Node 的 /days?|\bd\b/i。
var agyWeeklyResetInPattern = regexp.MustCompile(`(?i)days?|\bd\b`)

// QuotaObservation 是一个 (模型池, 窗口) 额度桶的观测，字段与 Node 同名。
type QuotaObservation struct {
	QuotaKey          string
	WindowLabel       string
	WindowMinutes     int64
	RemainingPct      *float64
	ExpectedResetAtMS int64
	PlanType          string
	CapturedAtMS      int64
}

// quotaObservationBucket 是聚合中的桶（Node agyBuckets 的 value）。
type quotaObservationBucket struct {
	quotaKey          string
	windowLabel       string
	windowMinutes     int64
	remainingPct      *float64
	expectedResetAtMS int64
}

// BuildQuotaObservations 复刻 Node AgyQuotaResetStrategy.extractObservations。
//
// capturedAtMS 是本次采集时刻；它决定窗口类型，也写进每条观测。传 0 时行为与
// Node 用 0 一致（resetAt > 0 会被判成周窗口），调用方应传文档的 capturedAt。
func BuildQuotaObservations(payload []byte, capturedAtMS int64) []QuotaObservation {
	document, ok := parseUsageDocument(payload)
	if !ok {
		return nil
	}
	planType := snapshotPlanType(firstNonEmpty(
		readText(firstField(document.account, "subscriptionTier")),
		readText(firstField(document.account, "planType")),
		readText(firstField(document.object, "subscriptionTier")),
		readText(firstField(document.object, "planType")),
	))
	buckets := make(map[string]*quotaObservationBucket, 4)
	order := make([]string, 0, 4)
	for _, raw := range document.models {
		model := rawObject(raw)
		if model == nil {
			continue
		}
		modelID := strings.ToLower(readText(firstField(model, "model")))
		if modelID == "" {
			continue
		}
		isClaudeOrGPT := strings.HasPrefix(modelID, "claude") || strings.HasPrefix(modelID, "gpt")
		groupBase := "gemini"
		groupTitle := "Gemini 模型池"
		if isClaudeOrGPT {
			groupBase = "claude_gpt"
			groupTitle = "Claude & GPT 模型池"
		}
		// Node 只认真正的 JSON number：字符串形式的 remainingPct 在这条路径里是「未知」，
		// 与文档读取路径（Number() 强转）刻意不同。
		remainingPct := strictJSONNumber(firstField(model, "remainingPct"))
		if remainingPct != nil {
			clamped := math.Max(0, math.Min(100, *remainingPct))
			remainingPct = &clamped
		}
		expectedResetAtMS := int64(0)
		if value, ok := jsNumber(firstField(model, "resetAtMs")); ok && value > 0 {
			expectedResetAtMS = int64(math.Trunc(value))
		}
		isWeekly := false
		if expectedResetAtMS > 0 && expectedResetAtMS > capturedAtMS {
			diffMinutes := int64(math.Ceil(float64(expectedResetAtMS-capturedAtMS) / 60000))
			isWeekly = diffMinutes > agyWeeklyThresholdMinutes
		} else if resetIn := readText(firstField(model, "resetIn")); resetIn != "" &&
			agyWeeklyResetInPattern.MatchString(resetIn) {
			isWeekly = true
		}
		windowMinutes := agyFiveHourWindowMinutes
		windowKey := "5h"
		windowLabel := groupTitle + " (5h)"
		if isWeekly {
			windowMinutes = agyWeeklyWindowMinutes
			windowKey = "week"
			windowLabel = groupTitle + " (Weekly)"
		}
		quotaKey := "rate_limit:" + groupBase + "_" + windowKey
		bucket := buckets[quotaKey]
		if bucket == nil {
			bucket = &quotaObservationBucket{
				quotaKey:      quotaKey,
				windowLabel:   windowLabel,
				windowMinutes: windowMinutes,
			}
			buckets[quotaKey] = bucket
			order = append(order, quotaKey)
		}
		// 同一个池同一个窗口：取最低剩余与最晚重置（Node 的 merge 规则）。
		if remainingPct != nil && (bucket.remainingPct == nil || *remainingPct < *bucket.remainingPct) {
			copied := *remainingPct
			bucket.remainingPct = &copied
		}
		if expectedResetAtMS > 0 && expectedResetAtMS > bucket.expectedResetAtMS {
			bucket.expectedResetAtMS = expectedResetAtMS
		}
	}
	observations := make([]QuotaObservation, 0, len(order))
	for _, key := range order {
		bucket := buckets[key]
		if bucket.remainingPct == nil && bucket.expectedResetAtMS == 0 {
			continue
		}
		observations = append(observations, QuotaObservation{
			QuotaKey:          bucket.quotaKey,
			WindowLabel:       bucket.windowLabel,
			WindowMinutes:     bucket.windowMinutes,
			RemainingPct:      bucket.remainingPct,
			ExpectedResetAtMS: bucket.expectedResetAtMS,
			PlanType:          planType,
			CapturedAtMS:      capturedAtMS,
		})
	}
	return observations
}

// strictJSONNumber 只在字段是 JSON number 时返回数值（Node typeof === 'number'）。
func strictJSONNumber(payload json.RawMessage) *float64 {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 || trimmed[0] == '"' || trimmed[0] == '{' || trimmed[0] == '[' {
		return nil
	}
	value, ok := jsNumber(trimmed)
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	return &value
}
