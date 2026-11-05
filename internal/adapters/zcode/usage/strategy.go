// Package usage 把 zcode 的 plan 余额转换为额度快照与展示文档。
//
// 端点（与 Node lib/cli/services/usage/zcode-quota-probe.js 同口径）：
//
//	GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=<ver>
//	Authorization: Bearer <zcodeJwtToken>
//	→ { code, success, data:{ plans:[], balances:[{ show_name, capabilities,
//	    unit_type, total_units, used_units, remaining_units, period_start, period_end }] } }
//
// 三类结论都要区分：
//   - balances 非空 → 正常额度条目；
//   - plans 与 balances 都是显式空数组 → 「没有套餐」（不是失败，要覆盖旧快照）；
//   - plans 非空、balances 为空 → 「套餐已领取但未生效」。
//
// 归一化 Snapshot 至少需要一条条目，因此两类「无额度」结论写一条 remaining 未知的
// window 条目（清掉额度权重），展示文档保留 plans 事实。
package usage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	zcodemodelcatalog "github.com/madou1217/ai_home/internal/adapters/zcode/modelcatalog"
)

const (
	providerID       = "zcode"
	balanceURL       = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance"
	sourceID         = "zcode_plan_balance_api"
	documentKind     = "zcode_plan_balance"
	maxResponseBytes = 1 << 20
	requestTimeout   = 10 * time.Second
	schemaVersion    = 2
)

var (
	ErrInvalidDependencies   = errors.New("zcode 额度 Strategy 依赖无效")
	ErrUnsupportedCredential = errors.New("zcode 额度 Strategy 凭据形态不支持")
	ErrInvalidResponse       = errors.New("zcode 额度响应无效")
)

// HTTPClient 是最小传输端口。
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// Strategy 是 zcode 的额度策略。
type Strategy struct {
	client     HTTPClient
	balanceURL string
}

var _ usageapp.ProviderStrategy = (*Strategy)(nil)

// New 创建生产端点上的额度策略。
func New(client HTTPClient) (*Strategy, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &Strategy{client: client, balanceURL: balanceURL}, nil
}

// ProviderID 返回 zcode。
func (*Strategy) ProviderID() string { return providerID }

// MatchesModelFamily 表示 zcode 的余额是账号级，没有模型族维度。
func (*Strategy) MatchesModelFamily(string, runtimecore.ModelID) bool { return false }

// FetchUsage 只返回归一化快照。
func (strategy *Strategy) FetchUsage(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	capturedAt time.Time,
) (usagecore.Snapshot, error) {
	snapshot, _, err := strategy.FetchUsageWithDocument(ctx, accountRef, credential, capturedAt)
	return snapshot, err
}

// FetchUsageWithDocument 一次采集同时产出快照与展示文档。
func (strategy *Strategy) FetchUsageWithDocument(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	capturedAt time.Time,
) (usagecore.Snapshot, *usagecore.Document, error) {
	if strategy == nil || strategy.client == nil || ctx == nil || !accountRef.IsValid() {
		return usagecore.Snapshot{}, nil, usageapp.ErrInvalidRequest
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != providerID {
		return usagecore.Snapshot{}, nil, usageapp.ErrUsageUnsupported
	}
	token, err := zcodemodelcatalog.JWTFromPayload(native.Payload())
	if err != nil || token == "" {
		return usagecore.Snapshot{}, nil, ErrUnsupportedCredential
	}
	payload, err := strategy.fetch(ctx, native.IdentitySeed(), token)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	document, err := decodeDocument(payload)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	entries := document.entries(capturedAt)
	if len(entries) == 0 {
		// 无套餐 / 套餐未生效：写一条「剩余未知」的账号级条目，清掉旧额度权重。
		entries = []usagecore.EntryInput{{
			Bucket:       "plan",
			Kind:         usagecore.KindWindow,
			Scope:        usagecore.ScopeAccount,
			Availability: usagecore.AvailabilityUnknown,
		}}
	}
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: providerID,
		Source:     sourceID,
		PlanType:   document.planType(),
		CapturedAt: capturedAt,
		Entries:    entries,
	})
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	view, err := buildDocument(document, capturedAt)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	typed, err := usagecore.NewDocument(usagecore.DocumentInput{
		AccountRef: accountRef,
		ProviderID: providerID,
		Kind:       documentKind,
		Source:     sourceID,
		CapturedAt: capturedAt,
		Payload:    view,
	})
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	return snapshot, &typed, nil
}

func (strategy *Strategy) fetch(ctx context.Context, identitySeed string, token string) ([]byte, error) {
	endpoint := strategy.balanceURL
	parsedEndpoint, err := url.Parse(endpoint)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	query := parsedEndpoint.Query()
	query.Set("app_version", zcodemodelcatalog.SeedAppVersion)
	parsedEndpoint.RawQuery = query.Encode()
	endpoint = parsedEndpoint.String()
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	request.Header.Set("Accept", "application/json")
	for key, value := range zcodemodelcatalog.ClientHeaders(identitySeed, token) {
		request.Header.Set(key, value)
	}
	response, err := strategy.client.Do(request)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		return nil, err
	}
	if response == nil || response.Body == nil {
		return nil, ErrInvalidResponse
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return nil, fmt.Errorf("zcode 额度请求失败: HTTP %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(payload) == 0 || len(payload) > maxResponseBytes {
		return nil, ErrInvalidResponse
	}
	return payload, nil
}

type balanceDocument struct {
	Code *int `json:"code"`
	Data struct {
		Plans    []planRow    `json:"plans"`
		Balances []balanceRow `json:"balances"`
	} `json:"data"`
}

type planRow struct {
	PlanID       string  `json:"plan_id"`
	UserPlanID   string  `json:"user_plan_id"`
	Name         string  `json:"name"`
	Status       string  `json:"status"`
	EndsAt       float64 `json:"ends_at"`
	Entitlements []struct {
		EffectiveAt float64 `json:"effective_at"`
	} `json:"entitlements"`
}

type balanceRow struct {
	ShowName       string   `json:"show_name"`
	Capabilities   []string `json:"capabilities"`
	UnitType       string   `json:"unit_type"`
	TotalUnits     *float64 `json:"total_units"`
	UsedUnits      *float64 `json:"used_units"`
	RemainingUnits *float64 `json:"remaining_units"`
	Period         string   `json:"period"`
	PeriodStart    *float64 `json:"period_start"`
	PeriodEnd      *float64 `json:"period_end"`
	PlanID         string   `json:"plan_id"`
	UserPlanID     string   `json:"user_plan_id"`
}

func decodeDocument(payload []byte) (balanceDocument, error) {
	var document balanceDocument
	if json.Unmarshal(payload, &document) != nil {
		return balanceDocument{}, ErrInvalidResponse
	}
	if document.Code != nil && *document.Code != 0 {
		return balanceDocument{}, ErrInvalidResponse
	}
	return document, nil
}

// planType 取第一个非空套餐名并归一。
//
// 不维护档位清单：上游新增套餐原样通过，只排除明确不是套餐的
// 鉴权模式与占位值；未知档位不该被静默丢掉。
func (document balanceDocument) planType() string {
	for _, plan := range document.Data.Plans {
		token := usagecore.NormalizePlanToken(plan.Name)
		if token == "" {
			continue
		}
		if !usagecore.IsPlanToken(token) {
			return ""
		}
		return token
	}
	return ""
}

func (document balanceDocument) entries(capturedAt time.Time) []usagecore.EntryInput {
	plansByUser := make(map[string]planRow, len(document.Data.Plans))
	plansByID := make(map[string]planRow, len(document.Data.Plans))
	for _, plan := range document.Data.Plans {
		if user := strings.TrimSpace(plan.UserPlanID); user != "" {
			plansByUser[user] = plan
		}
		if id := strings.TrimSpace(plan.PlanID); id != "" {
			plansByID[id] = plan
		}
	}
	entries := make([]usagecore.EntryInput, 0, len(document.Data.Balances))
	for _, balance := range document.Data.Balances {
		plan := plansByUser[strings.TrimSpace(balance.UserPlanID)]
		if plan.PlanID == "" {
			plan = plansByID[strings.TrimSpace(balance.PlanID)]
		}
		entry, ok := balance.toEntry(capturedAt, plan)
		if ok {
			entries = append(entries, entry)
		}
	}
	return entries
}

func (balance balanceRow) toEntry(capturedAt time.Time, plan planRow) (usagecore.EntryInput, bool) {
	total := valueOrNil(balance.TotalUnits)
	used := valueOrNil(balance.UsedUnits)
	remaining := valueOrNil(balance.RemainingUnits)
	if total == nil && used == nil && remaining == nil {
		return usagecore.EntryInput{}, false
	}
	var pct *float64
	if total != nil && *total > 0 {
		value := 0.0
		if remaining != nil {
			value = *remaining
		} else if used != nil {
			value = *total - *used
		}
		clamped := math.Max(0, math.Min(100, value*100 / *total))
		pct = &clamped
	}
	windowMinutes := 0
	switch strings.ToLower(strings.TrimSpace(balance.Period)) {
	case "daily":
		windowMinutes = 1440
	case "weekly":
		windowMinutes = 10080
	case "monthly":
		windowMinutes = 43200
	}
	start := valueOrNil(balance.PeriodStart)
	end := valueOrNil(balance.PeriodEnd)
	if windowMinutes == 0 && start != nil && end != nil && *end > *start {
		windowMinutes = int(math.Round((*end - *start) / 60))
	}
	resetAt := time.Time{}
	if end != nil && *end > 0 {
		resetAt = time.Unix(int64(*end), 0).UTC()
	}
	entry := usagecore.EntryInput{
		Bucket:        balanceBucket(balance, windowMinutes),
		Kind:          usagecore.KindWindow,
		Scope:         usagecore.ScopeAccount,
		WindowSeconds: int64(windowMinutes) * 60,
		ResetAt:       resetAt,
		Availability:  usagecore.AvailabilityUnknown,
	}
	if pct != nil {
		entry.HasRemaining = true
		entry.RemainingBasisPoints = uint16(math.Round(*pct * 100))
		entry.Availability = usagecore.AvailabilityAvailable
		if *pct <= 0 {
			entry.Availability = usagecore.AvailabilityExhausted
		}
	}
	if _, err := usagecore.NewEntry(entry); err != nil {
		return usagecore.EntryInput{}, false
	}
	return entry, true
}

func balanceBucket(balance balanceRow, windowMinutes int) string {
	for _, capability := range balance.Capabilities {
		value := strings.TrimSpace(capability)
		if !strings.HasPrefix(strings.ToLower(value), "model:") {
			continue
		}
		if id := strings.TrimSpace(value[len("model:"):]); id != "" {
			return id
		}
	}
	if name := strings.TrimSpace(balance.ShowName); name != "" {
		return name
	}
	if windowMinutes > 0 {
		return "rolling_" + strconv.Itoa(windowMinutes) + "m"
	}
	return "plan"
}

func valueOrNil(value *float64) *float64 {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return nil
	}
	return value
}

func buildDocument(document balanceDocument, capturedAt time.Time) ([]byte, error) {
	entries := document.entries(capturedAt)
	planNames := make([]string, 0, len(document.Data.Plans))
	planIDs := make([]string, 0, len(document.Data.Plans))
	for _, plan := range document.Data.Plans {
		if name := strings.TrimSpace(plan.Name); name != "" {
			planNames = append(planNames, name)
		}
		if id := strings.TrimSpace(plan.PlanID); id != "" {
			planIDs = append(planIDs, id)
		}
	}
	account := map[string]any{}
	if len(planNames) > 0 {
		account["planType"] = planNames[0]
		account["planNames"] = planNames
	}
	if len(planIDs) > 0 {
		account["planIds"] = planIDs
	}
	documentEntries := make([]map[string]any, 0, len(entries))
	plansByUser := make(map[string]planRow, len(document.Data.Plans))
	plansByID := make(map[string]planRow, len(document.Data.Plans))
	for _, plan := range document.Data.Plans {
		if user := strings.TrimSpace(plan.UserPlanID); user != "" {
			plansByUser[user] = plan
		}
		if id := strings.TrimSpace(plan.PlanID); id != "" {
			plansByID[id] = plan
		}
	}
	for _, balance := range document.Data.Balances {
		plan := plansByUser[strings.TrimSpace(balance.UserPlanID)]
		if plan.PlanID == "" {
			plan = plansByID[strings.TrimSpace(balance.PlanID)]
		}
		entry, ok := balance.toEntry(capturedAt, plan)
		if !ok {
			continue
		}
		windowMinutes := int(entry.WindowSeconds / 60)
		documentEntries = append(documentEntries, map[string]any{
			"bucket":         entry.Bucket,
			"windowMinutes":  windowMinutes,
			"window":         windowLabel(windowMinutes),
			"remainingPct":   float64(entry.RemainingBasisPoints) / 100,
			"totalUnits":     optionalNumber(balance.TotalUnits),
			"usedUnits":      optionalNumber(balance.UsedUnits),
			"remainingUnits": optionalNumber(balance.RemainingUnits),
			"unitType":       strings.ToLower(strings.TrimSpace(balance.UnitType)),
			"resetIn":        resetIn(entry.ResetAt, capturedAt),
			"resetAtMs":      resetAtMS(entry.ResetAt),
			"planId":         strings.TrimSpace(balance.PlanID),
			"planGroupId":    strings.TrimSpace(balance.UserPlanID),
			"planName":       strings.TrimSpace(plan.Name),
			"planStatus":     strings.TrimSpace(plan.Status),
			"planEndsAt":     int64(plan.EndsAt) * 1000,
		})
	}
	payload := map[string]any{
		"schemaVersion": schemaVersion,
		"kind":          documentKind,
		"source":        sourceID,
		"capturedAt":    capturedAt.UnixMilli(),
		"entries":       documentEntries,
		"account":       account,
	}
	// 套餐已领取、余额桶还没生效：把最早生效时间带出去，界面据此显示「未生效」。
	if len(document.Data.Plans) > 0 && len(document.Data.Balances) == 0 {
		if effectiveAt := earliestEffectiveAtMS(document.Data.Plans); effectiveAt > 0 {
			payload["pendingEffectiveAtMs"] = effectiveAt
		}
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	return encoded, nil
}

func earliestEffectiveAtMS(plans []planRow) int64 {
	earliest := int64(0)
	for _, plan := range plans {
		for _, entitlement := range plan.Entitlements {
			if entitlement.EffectiveAt <= 0 {
				continue
			}
			atMS := int64(entitlement.EffectiveAt) * 1000
			if earliest == 0 || atMS < earliest {
				earliest = atMS
			}
		}
	}
	return earliest
}

func windowLabel(minutes int) string {
	switch {
	case minutes <= 0:
		return ""
	case minutes%10080 == 0:
		return strconv.Itoa(minutes/10080*7) + "days"
	case minutes%1440 == 0:
		return strconv.Itoa(minutes/1440) + "days"
	case minutes%60 == 0:
		return strconv.Itoa(minutes/60) + "h"
	default:
		return strconv.Itoa(minutes) + "m"
	}
}

func resetIn(resetAt time.Time, now time.Time) string {
	if resetAt.IsZero() {
		return ""
	}
	seconds := int64(resetAt.Sub(now).Seconds())
	if seconds < 0 {
		seconds = 0
	}
	days := seconds / 86400
	hours := (seconds % 86400) / 3600
	minutes := (seconds % 3600) / 60
	switch {
	case days > 0:
		return fmt.Sprintf("%dd%dh%dm", days, hours, minutes)
	case hours > 0:
		return fmt.Sprintf("%dh%dm", hours, minutes)
	default:
		return fmt.Sprintf("%dm", minutes)
	}
}

func resetAtMS(resetAt time.Time) int64 {
	if resetAt.IsZero() {
		return 0
	}
	return resetAt.UnixMilli()
}

func optionalNumber(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}
