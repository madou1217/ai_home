// Package usage 把 CodeBuddy 家族的积分账单转换为额度快照与展示文档。
//
// 协议（与 Node lib/cli/services/usage/codebuddy-quota-probe.js 同口径）：
//
//	POST {发行版域名}/billing/meter/get-user-resource-summary  body {}
//	Authorization: Bearer <Keycloak accessToken>、X-User-Id: <uid>、
//	X-Domain: <auth.domain>、User-Agent: CodeBuddy/1.0 (ai-home)
//	→ { code, data:{ Packages:[{ PackageCode, CycleTotalCapacity, CycleRemainCapacity,
//	     CycleUsedCapacity, CapacityUnit }], TotalCredits, SubscriptionPackageCode, IsPaidUser } }
//
// 家族额度是账号级积分，**没有时间窗/重置时间**。归一化快照只放一条聚合条目
// （sum(remain)/sum(total)）：明细包若也进快照，min(remaining) 会被赠包拖成 0，
// 导致健康账号被判耗尽。展示文档保留每个包的 detail 条目。
package usage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

const (
	resourceSummaryPath = "/billing/meter/get-user-resource-summary"
	sourceID            = "codebuddy_billing_resource_summary_api"
	documentKind        = "codebuddy_credit_balance"
	probeUserAgent      = "CodeBuddy/1.0 (ai-home)"
	maxResponseBytes    = 1 << 20
	requestTimeout      = 10 * time.Second
	schemaVersion       = 2
)

var (
	ErrInvalidDependencies   = errors.New("CodeBuddy 额度 Strategy 依赖无效")
	ErrUnsupportedCredential = errors.New("CodeBuddy 额度 Strategy 凭据形态不支持")
	ErrInvalidResponse       = errors.New("CodeBuddy 额度响应无效")
)

// familyEndpoints 是四个发行版的账单域名。
var familyEndpoints = map[string]string{
	"codebuddy":   "https://www.codebuddy.ai",
	"workbuddy":   "https://www.workbuddy.ai",
	"codebuddycn": "https://copilot.tencent.com",
	"workbuddycn": "https://copilot.tencent.com",
}

// commodityLabels 把 PackageCode 前缀映射成稳定桶名。
var commodityLabels = [][2]string{
	{"TCACA_code_001_", "free"},
	{"TCACA_code_002_", "proMon"},
	{"TCACA_code_003_", "proYear"},
	{"TCACA_code_005_", "proMonPlus"},
	{"TCACA_code_006_", "gift"},
	{"TCACA_code_007_", "activity"},
	{"TCACA_code_008_", "freeMon"},
	{"TCACA_code_009_", "extra"},
	{"TCACA_code_023_", "youth"},
	{"TCACA_code_026_", "advanced"},
	{"TCACA_code_027_", "flagship"},
	{"TCACA_code_028_", "bonus28"},
	{"TCACA_code_029_", "bonus29"},
	{"TCACA_code_030_", "bonus30"},
	{"TCACA_code_035_", "freeMonIntl"},
	{"TCACA_code_036_", "extraIntl"},
	{"TCACA_code_037_", "bonusIntl"},
	{"TCACA_code_038_", "extra38"},
	{"TCACA_code_039_", "proTrialMon"},
	{"TCACA_code_040_", "proTrialYear"},
}

// paidPlanLabels 是「付费档位」映射；试用/体验包刻意不映射。
var paidPlanLabels = [][2]string{
	{"TCACA_code_002_", "Pro"},
	{"TCACA_code_003_", "Pro"},
	{"TCACA_code_005_", "Pro Plus"},
	{"TCACA_code_023_", "Youth"},
	{"TCACA_code_026_", "Advanced"},
	{"TCACA_code_027_", "Flagship"},
}

// HTTPClient 是最小传输端口。
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// Strategy 是一个家族 Provider 的额度策略。
type Strategy struct {
	client     HTTPClient
	providerID string
	endpoint   string
}

var _ usageapp.ProviderStrategy = (*Strategy)(nil)

// New 为指定家族 Provider 创建额度策略。
func New(client HTTPClient, providerID string) (*Strategy, error) {
	endpoint := familyEndpoints[strings.ToLower(strings.TrimSpace(providerID))]
	if client == nil || endpoint == "" {
		return nil, ErrInvalidDependencies
	}
	return &Strategy{client: client, providerID: providerID, endpoint: endpoint}, nil
}

// ProviderID 返回该策略负责的 Provider。
func (strategy *Strategy) ProviderID() string { return strategy.providerID }

// MatchesModelFamily 表示家族额度是账号级积分。
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

// FetchUsageWithDocument 一次采集产出聚合快照与展示文档。
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
	if !ok || native == nil || native.ProviderID() != strategy.providerID {
		return usagecore.Snapshot{}, nil, usageapp.ErrUsageUnsupported
	}
	auth, err := parseFamilyCredential(native.Payload())
	if err != nil {
		return usagecore.Snapshot{}, nil, err
	}
	payload, err := strategy.fetch(ctx, auth)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	summary, err := decodeSummary(payload)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	details := summary.details()
	aggregate := aggregateEntry(details)
	if aggregate == nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	planType := ""
	if summary.Data.IsPaidUser {
		planType = usagecore.NormalizePlanName(
			paidPlanLabel(summary.Data.SubscriptionPackageCode),
		)
	}
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: strategy.providerID,
		Source:     sourceID,
		PlanType:   planType,
		CapturedAt: capturedAt,
		Entries:    []usagecore.EntryInput{*aggregate},
	})
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	view, err := buildDocument(summary, details, aggregate, capturedAt)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	document, err := usagecore.NewDocument(usagecore.DocumentInput{
		AccountRef: accountRef,
		ProviderID: strategy.providerID,
		Kind:       documentKind,
		Source:     sourceID,
		CapturedAt: capturedAt,
		Payload:    view,
	})
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	return snapshot, &document, nil
}

type familyCredential struct {
	accessToken string
	uid         string
	domain      string
}

func parseFamilyCredential(payload []byte) (familyCredential, error) {
	var document struct {
		Credentials struct {
			Auth struct {
				AccessToken string `json:"accessToken"`
				Domain      string `json:"domain"`
			} `json:"auth"`
			Account struct {
				UID string `json:"uid"`
			} `json:"account"`
		} `json:"credentials"`
	}
	if json.Unmarshal(payload, &document) != nil {
		return familyCredential{}, ErrUnsupportedCredential
	}
	auth := familyCredential{
		accessToken: strings.TrimSpace(document.Credentials.Auth.AccessToken),
		uid:         strings.TrimSpace(document.Credentials.Account.UID),
		domain:      strings.TrimSpace(document.Credentials.Auth.Domain),
	}
	if auth.accessToken == "" || auth.uid == "" {
		return familyCredential{}, ErrUnsupportedCredential
	}
	return auth, nil
}

func (strategy *Strategy) fetch(ctx context.Context, auth familyCredential) ([]byte, error) {
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestCtx,
		http.MethodPost,
		strategy.endpoint+resourceSummaryPath,
		strings.NewReader("{}"),
	)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+auth.accessToken)
	request.Header.Set("X-User-Id", auth.uid)
	request.Header.Set("User-Agent", probeUserAgent)
	if auth.domain != "" {
		request.Header.Set("X-Domain", auth.domain)
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
		return nil, fmt.Errorf("CodeBuddy 额度请求失败: HTTP %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(payload) == 0 || len(payload) > maxResponseBytes {
		return nil, ErrInvalidResponse
	}
	return payload, nil
}

type summaryDocument struct {
	Code *json.RawMessage `json:"code"`
	Data struct {
		Packages                []packageRow `json:"Packages"`
		TotalCredits            string       `json:"TotalCredits"`
		SubscriptionPackageCode string       `json:"SubscriptionPackageCode"`
		IsPaidUser              bool         `json:"IsPaidUser"`
	} `json:"data"`
}

type packageRow struct {
	PackageCode         string `json:"PackageCode"`
	CycleTotalCapacity  string `json:"CycleTotalCapacity"`
	CycleRemainCapacity string `json:"CycleRemainCapacity"`
	CycleUsedCapacity   string `json:"CycleUsedCapacity"`
	CapacityUnit        string `json:"CapacityUnit"`
}

func decodeSummary(payload []byte) (summaryDocument, error) {
	var document summaryDocument
	if json.Unmarshal(payload, &document) != nil {
		return summaryDocument{}, ErrInvalidResponse
	}
	if document.Code != nil {
		var code any
		_ = json.Unmarshal(*document.Code, &code)
		switch value := code.(type) {
		case float64:
			if value != 0 && value != 200 {
				return summaryDocument{}, ErrInvalidResponse
			}
		case string:
			if value != "" && value != "0" && value != "200" {
				return summaryDocument{}, ErrInvalidResponse
			}
		}
	}
	return document, nil
}

type packageEntry struct {
	bucket         string
	totalUnits     *float64
	usedUnits      *float64
	remainingUnits *float64
	remainingPct   *float64
	unitType       string
}

func (document summaryDocument) details() []packageEntry {
	entries := make([]packageEntry, 0, len(document.Data.Packages))
	for _, row := range document.Data.Packages {
		total := readCapacity(row.CycleTotalCapacity)
		remain := readCapacity(row.CycleRemainCapacity)
		used := readCapacity(row.CycleUsedCapacity)
		if total == nil && remain == nil && used == nil {
			continue
		}
		unitType := strings.ToLower(strings.TrimSpace(row.CapacityUnit))
		if unitType == "" {
			unitType = "credits"
		}
		entries = append(entries, packageEntry{
			bucket:         commodityLabel(row.PackageCode),
			totalUnits:     total,
			usedUnits:      used,
			remainingUnits: remain,
			remainingPct:   remainingPct(total, remain, used),
			unitType:       unitType,
		})
	}
	if len(entries) == 0 && readCapacity(document.Data.TotalCredits) != nil && *readCapacity(document.Data.TotalCredits) == 0 {
		zero := 0.0
		return []packageEntry{{
			bucket: "credits", totalUnits: &zero, usedUnits: &zero,
			remainingUnits: &zero, remainingPct: &zero, unitType: "credits",
		}}
	}
	return entries
}

// aggregateEntry 汇总所有包；只有全部包都带 total/remaining 时才给出账号级比例。
func aggregateEntry(details []packageEntry) *usagecore.EntryInput {
	if len(details) == 0 {
		return nil
	}
	var total, remaining float64
	complete := true
	credits := true
	for _, detail := range details {
		if detail.totalUnits == nil || detail.remainingUnits == nil {
			complete = false
		} else {
			total += *detail.totalUnits
			remaining += *detail.remainingUnits
		}
		if detail.unitType != "credit" && detail.unitType != "credits" {
			credits = false
		}
	}
	entry := usagecore.EntryInput{
		Bucket:       "credits",
		Kind:         usagecore.KindCredits,
		Scope:        usagecore.ScopeAccount,
		Availability: usagecore.AvailabilityUnknown,
	}
	if complete && credits {
		switch {
		case total > 0:
			pct := math.Max(0, math.Min(100, remaining*100/total))
			entry.HasRemaining = true
			entry.RemainingBasisPoints = uint16(math.Round(pct * 100))
			entry.Availability = usagecore.AvailabilityAvailable
			if pct <= 0 {
				entry.Availability = usagecore.AvailabilityExhausted
			}
		case total == 0 && remaining == 0:
			// 上游明确给出 0 积分（Packages=[]、TotalCredits=0）：这是确定的 0%，
			// 不是「未知」。按 exhausted 落库，界面才不会显示「采集中」。
			entry.HasRemaining = true
			entry.RemainingBasisPoints = 0
			entry.Availability = usagecore.AvailabilityExhausted
		}
	}
	if _, err := usagecore.NewEntry(entry); err != nil {
		return nil
	}
	return &entry
}

func buildDocument(
	document summaryDocument,
	details []packageEntry,
	aggregate *usagecore.EntryInput,
	capturedAt time.Time,
) ([]byte, error) {
	entries := make([]map[string]any, 0, len(details)+1)
	entries = append(entries, map[string]any{
		"bucket":         aggregate.Bucket,
		"windowMinutes":  0,
		"window":         "",
		"remainingPct":   optionalPct(aggregate),
		"totalUnits":     nil,
		"usedUnits":      nil,
		"remainingUnits": nil,
		"unitType":       "credits",
		"resetIn":        "",
		"resetAtMs":      0,
	})
	for _, detail := range details {
		entries = append(entries, map[string]any{
			"bucket":         detail.bucket,
			"windowMinutes":  0,
			"window":         "",
			"remainingPct":   optionalFloat(detail.remainingPct),
			"totalUnits":     optionalFloat(detail.totalUnits),
			"usedUnits":      optionalFloat(detail.usedUnits),
			"remainingUnits": optionalFloat(detail.remainingUnits),
			"unitType":       detail.unitType,
			"resetIn":        "",
			"resetAtMs":      0,
			"category":       "detail",
		})
	}
	payload := map[string]any{
		"schemaVersion": schemaVersion,
		"kind":          documentKind,
		"source":        sourceID,
		"capturedAt":    capturedAt.UnixMilli(),
		"entries":       entries,
	}
	if planType := paidPlanLabel(document.Data.SubscriptionPackageCode); planType != "" && document.Data.IsPaidUser {
		payload["account"] = map[string]any{"planType": planType}
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	return encoded, nil
}

func readCapacity(value string) *float64 {
	text := strings.TrimSpace(value)
	if text == "" {
		return nil
	}
	number, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
		return nil
	}
	return &number
}

func remainingPct(total, remain, used *float64) *float64 {
	if total == nil || *total <= 0 {
		return nil
	}
	value := 0.0
	switch {
	case remain != nil:
		value = *remain
	case used != nil:
		value = *total - *used
	default:
		return nil
	}
	clamped := math.Max(0, math.Min(100, value*100 / *total))
	return &clamped
}

func commodityLabel(packageCode string) string {
	code := strings.TrimSpace(packageCode)
	if code == "" {
		return ""
	}
	for _, pair := range commodityLabels {
		if strings.HasPrefix(code, pair[0]) {
			return pair[1]
		}
	}
	if len(code) >= len("TCACA_code_000") && strings.HasPrefix(code, "TCACA_code_") && len(code) > 15 {
		if _, err := strconv.Atoi(code[11:14]); err == nil {
			return "code_" + code[11:14]
		}
	}
	return code
}

func paidPlanLabel(packageCode string) string {
	code := strings.TrimSpace(packageCode)
	for _, pair := range paidPlanLabels {
		if strings.HasPrefix(code, pair[0]) {
			return pair[1]
		}
	}
	return ""
}

func optionalPct(entry *usagecore.EntryInput) any {
	if entry == nil || !entry.HasRemaining {
		return nil
	}
	return float64(entry.RemainingBasisPoints) / 100
}

func optionalFloat(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}
