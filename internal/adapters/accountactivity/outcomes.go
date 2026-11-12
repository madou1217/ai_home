package accountactivity

// 活动结果的唯一词汇表：状态分类、错误码归一、汇总与文案。
//
// 与 lib/account/activity-claim/outcomes.js 逐条对应 —— job 的 summary / failures /
// errorSummary 与计划任务、CLI 读的是同一套词汇。纪律同样保留：**未知状态 fail-closed
// 计为失败**，宁可让任务变红被发现，也不能静默算成成功。

import (
	"sort"
	"strconv"
	"strings"
)

// 活动结果状态。
const (
	StatusClaimed          = "claimed"
	StatusAlreadyClaimed   = "already_claimed"
	StatusNothingClaimable = "nothing_claimable"
	StatusNotApplicable    = "not_applicable"
	StatusDryRun           = "dry_run"
	StatusSkipped          = "skipped"
	StatusError            = "error"
)

// 未知状态/错误码的归一值。
const (
	UnknownStatusCode = "activity_status_unknown"
	UnknownErrorCode  = "activity_unknown_error"
)

var activityOutcomes = map[string]bool{
	StatusClaimed:          true,
	StatusAlreadyClaimed:   true,
	StatusNothingClaimable: true,
	StatusNotApplicable:    true,
	StatusDryRun:           true,
	StatusSkipped:          true,
	StatusError:            false,
}

// IsSuccessStatus 判断状态是否算正常结束；未知状态返回 false。
func IsSuccessStatus(status string) bool {
	success, known := activityOutcomes[normalizeStatus(status)]
	return known && success
}

// IsFailureResult 判断一个结果是否计入失败（未知状态 fail-closed）。
func IsFailureResult(result map[string]any) bool {
	status := normalizeStatus(textOf(result["status"]))
	success, known := activityOutcomes[status]
	return !known || !success
}

func normalizeStatus(status string) string {
	normalized := strings.ToLower(strings.TrimSpace(status))
	if _, known := activityOutcomes[normalized]; known {
		return normalized
	}
	return StatusError
}

// ErrorCodeOf 返回单个结果的有效错误码；未知状态优先报「状态不认识」。
func ErrorCodeOf(result map[string]any) string {
	rawStatus := strings.ToLower(strings.TrimSpace(textOf(result["status"])))
	if _, known := activityOutcomes[rawStatus]; !known {
		if rawStatus == "" {
			rawStatus = "empty"
		}
		return UnknownStatusCode + ":" + rawStatus
	}
	if IsSuccessStatus(rawStatus) {
		return ""
	}
	code := NormalizeErrorCode(textOf(result["error"]))
	if code == "" {
		return UnknownErrorCode
	}
	return code
}

// NormalizeErrorCode 把错误串归一成头部错误码：冒号后的部分是细节
// （HTTP 状态 / 异常文案），不进汇总键。
func NormalizeErrorCode(value string) string {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return ""
	}
	head := strings.TrimSpace(strings.SplitN(raw, ":", 2)[0])
	if head == "" {
		return UnknownErrorCode
	}
	return head
}

// FailureEntry 是按错误码分组的失败明细。
type FailureEntry struct {
	Code        string   `json:"code"`
	Count       int      `json:"count"`
	AccountRefs []string `json:"accountRefs"`
}

// FailureAccount 是逐账号的失败明细。
type FailureAccount struct {
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef"`
	Code       string `json:"code"`
	Message    string `json:"message"`
}

// Failures 是失败归因块（job.failures 的稳定形状）。
type Failures struct {
	Total     int              `json:"total"`
	ByCode    []FailureEntry   `json:"byCode"`
	ByAccount []FailureAccount `json:"byAccount"`
}

// ClaimGroup 是按 plan 聚合的领取结果。
type ClaimGroup struct {
	PlanID         string `json:"planId"`
	Name           string `json:"name"`
	PlanKind       string `json:"planKind"`
	Claimed        int    `json:"claimed"`
	AlreadyClaimed int    `json:"alreadyClaimed"`
}

// Summary 是结果汇总（job.summary）。
type Summary struct {
	Accounts         int            `json:"accounts"`
	Claimed          int            `json:"claimed"`
	AlreadyClaimed   int            `json:"alreadyClaimed"`
	NothingClaimable int            `json:"nothingClaimable"`
	NotApplicable    int            `json:"notApplicable"`
	Failed           int            `json:"failed"`
	Succeeded        int            `json:"succeeded"`
	Skipped          int            `json:"skipped"`
	ByStatus         map[string]int `json:"byStatus"`
	Failures         Failures       `json:"failures"`
	Claims           []ClaimGroup   `json:"claims"`
	ErrorSummary     string         `json:"errorSummary"`
}

// Summarize 汇总结果；保留历史字段，新增字段只做增量。
func Summarize(results []map[string]any) Summary {
	summary := Summary{
		ByStatus: map[string]int{},
		Failures: Failures{ByCode: []FailureEntry{}, ByAccount: []FailureAccount{}},
		Claims:   []ClaimGroup{},
	}
	byCode := map[string]*FailureEntry{}
	claimsByPlan := map[string]*ClaimGroup{}
	for _, result := range results {
		summary.Accounts++
		rawStatus := strings.ToLower(strings.TrimSpace(textOf(result["status"])))
		bucket := rawStatus
		if _, known := activityOutcomes[bucket]; !known {
			bucket = StatusError
		}
		summary.ByStatus[bucket]++
		switch bucket {
		case StatusClaimed:
			summary.Claimed++
		case StatusAlreadyClaimed:
			summary.AlreadyClaimed++
		case StatusNothingClaimable:
			summary.NothingClaimable++
		case StatusNotApplicable:
			summary.NotApplicable++
		case StatusSkipped:
			summary.Skipped++
		}

		if IsFailureResult(result) {
			summary.Failed++
			code := ErrorCodeOf(result)
			summary.Failures.Total++
			summary.Failures.ByAccount = append(summary.Failures.ByAccount, FailureAccount{
				Provider:   textOf(result["provider"]),
				AccountRef: textOf(result["accountRef"]),
				Code:       code,
				Message:    textOf(result["message"]),
			})
			entry := byCode[code]
			if entry == nil {
				entry = &FailureEntry{Code: code, AccountRefs: []string{}}
				byCode[code] = entry
			}
			entry.Count++
			accountRef := textOf(result["accountRef"])
			if accountRef != "" && !containsString(entry.AccountRefs, accountRef) {
				entry.AccountRefs = append(entry.AccountRefs, accountRef)
			}
		} else {
			summary.Succeeded++
		}

		if plan, ok := planOf(result); ok {
			key := plan.PlanID + "|" + plan.PlanKind
			entry := claimsByPlan[key]
			if entry == nil {
				copied := plan
				entry = &copied
				claimsByPlan[key] = entry
			}
			if bucket == StatusClaimed {
				entry.Claimed++
			} else if bucket == StatusAlreadyClaimed {
				entry.AlreadyClaimed++
			}
		}
	}

	codes := make([]*FailureEntry, 0, len(byCode))
	for _, entry := range byCode {
		codes = append(codes, entry)
	}
	sort.Slice(codes, func(left, right int) bool {
		if codes[left].Count != codes[right].Count {
			return codes[left].Count > codes[right].Count
		}
		return codes[left].Code < codes[right].Code
	})
	for _, entry := range codes {
		sort.Strings(entry.AccountRefs)
		summary.Failures.ByCode = append(summary.Failures.ByCode, *entry)
	}

	claims := make([]ClaimGroup, 0, len(claimsByPlan))
	for _, entry := range claimsByPlan {
		claims = append(claims, *entry)
	}
	sort.Slice(claims, func(left, right int) bool {
		return claims[left].PlanID < claims[right].PlanID
	})
	summary.Claims = claims
	summary.ErrorSummary = FormatErrorSummary(summary)
	return summary
}

func planOf(result map[string]any) (ClaimGroup, bool) {
	plan, ok := result["plan"].(map[string]any)
	if !ok {
		claimed, isList := result["claimed"].([]any)
		if !isList || len(claimed) == 0 {
			return ClaimGroup{}, false
		}
		plan, ok = claimed[0].(map[string]any)
		if !ok {
			return ClaimGroup{}, false
		}
	}
	planID := textOf(plan["planId"])
	if planID == "" {
		return ClaimGroup{}, false
	}
	planKind := textOf(plan["planKind"])
	if planKind == "" {
		planKind = textOf(result["planKind"])
	}
	return ClaimGroup{
		PlanID:   planID,
		Name:     textOf(plan["name"]),
		PlanKind: planKind,
	}, true
}

// FormatFailureCodes 把失败码压成紧凑文案。
func FormatFailureCodes(failures Failures) string {
	if len(failures.ByCode) == 0 {
		return ""
	}
	limit := len(failures.ByCode)
	if limit > 4 {
		limit = 4
	}
	parts := make([]string, 0, limit)
	for _, entry := range failures.ByCode[:limit] {
		parts = append(parts, entry.Code+" ×"+strconv.Itoa(entry.Count))
	}
	return strings.Join(parts, "、")
}

// FormatErrorSummary 生成失败部分的人话摘要。
func FormatErrorSummary(summary Summary) string {
	if summary.Failed <= 0 {
		return ""
	}
	codes := FormatFailureCodes(summary.Failures)
	head := "失败 " + strconv.Itoa(summary.Failed) + " 个账号"
	if summary.Failed >= summary.Accounts && summary.Accounts > 0 {
		head = "全部 " + strconv.Itoa(summary.Accounts) + " 个账号失败"
	}
	if codes != "" {
		return head + "：" + codes
	}
	return head
}

// DominantErrorCode 返回众数错误码（all_accounts_failed 旁边那个「到底为什么」）。
func DominantErrorCode(summary Summary) string {
	if len(summary.Failures.ByCode) == 0 {
		return ""
	}
	return summary.Failures.ByCode[0].Code
}
