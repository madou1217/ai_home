// Package usage 把 kiro 的 GetUsageLimits 响应转换为稳定额度快照与展示文档。
//
// 协议事实（Node lib/account/kiro-usage-client.js 同口径）：
//
//	POST https://codewhisperer.<region>.amazonaws.com/
//	  ?origin=CLI&resourceType=AGENTIC_REQUEST&isEmailRequired=true[&profileArn=...]
//	headers: Authorization: Bearer <access_token>, content-type: application/x-amz-json-1.0,
//	         x-amz-target: AmazonCodeWhispererService.GetUsageLimits
//	body: 同一份 JSON（origin/resourceType/isEmailRequired/profileArn）
//
// 响应里 usageBreakdownList 的 CREDIT 资源是账号额度；window/credits 统一折算成
// 剩余基点，展示文档保留 total/used/remaining 原始单位。
package usage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/kiro"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

const (
	sourceID        = "kiro_get_usage_limits_api"
	documentKind    = "kiro_credit_usage"
	creditBucket    = "credits"
	usageTarget     = "AmazonCodeWhispererService.GetUsageLimits"
	maxResponseBody = 1 << 20
	requestTimeout  = 10 * time.Second
	schemaVersion   = 2
)

var (
	// ErrInvalidDependencies 表示 Strategy 缺少 HTTP 传输。
	ErrInvalidDependencies = errors.New("kiro 额度 Strategy 依赖无效")
	// ErrInvalidResponse 表示上游状态、大小或 JSON 结构不满足额度合同。
	ErrInvalidResponse = errors.New("kiro 额度响应无效")
)

// HTTPClient 是额度 Strategy 唯一依赖的传输端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Strategy 使用 kiro 原生凭据读取 GetUsageLimits。
type Strategy struct {
	client   HTTPClient
	endpoint func(region string) (string, error)
}

var _ usageapp.ProviderStrategy = (*Strategy)(nil)

// New 创建额度策略。
func New(client HTTPClient) (*Strategy, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &Strategy{client: client, endpoint: usageEndpoint}, nil
}

// ProviderID 返回 kiro。
func (*Strategy) ProviderID() string { return kiro.ProviderID }

// MatchesModelFamily 表示 kiro 的额度是账号级 credits，没有模型族维度。
func (*Strategy) MatchesModelFamily(string, runtimecore.ModelID) bool { return false }

// FetchUsage 只返回归一化快照（实现通用端口）。
func (strategy *Strategy) FetchUsage(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	capturedAt time.Time,
) (usagecore.Snapshot, error) {
	snapshot, _, err := strategy.FetchUsageWithDocument(ctx, accountRef, credential, capturedAt)
	return snapshot, err
}

// FetchUsageWithDocument 一次采集同时产出归一化快照与 WebUI 展示文档。
func (strategy *Strategy) FetchUsageWithDocument(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	capturedAt time.Time,
) (usagecore.Snapshot, *usagecore.Document, error) {
	if strategy == nil ||
		strategy.client == nil ||
		ctx == nil ||
		!accountRef.IsValid() {
		return usagecore.Snapshot{}, nil, usageapp.ErrInvalidRequest
	}
	parsed, supported := projectCredential(credential)
	if !supported {
		return usagecore.Snapshot{}, nil, usageapp.ErrUsageUnsupported
	}
	document, err := strategy.fetch(ctx, parsed)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	credit, ok := document.credit()
	if !ok {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	entry, remainingPct, err := credit.entry(credit.resetAt)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: kiro.ProviderID,
		Source:     sourceID,
		PlanType:   documentPlanType(document),
		CapturedAt: capturedAt,
		Entries:    []usagecore.EntryInput{entry},
	})
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	payload, err := buildDocumentPayload(document, credit, remainingPct, capturedAt)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	view, err := usagecore.NewDocument(usagecore.DocumentInput{
		AccountRef: accountRef,
		ProviderID: kiro.ProviderID,
		Kind:       documentKind,
		Source:     sourceID,
		CapturedAt: capturedAt,
		Payload:    payload,
	})
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	return snapshot, &view, nil
}

// projectCredential 只接受 kiro 原生凭据。
func projectCredential(credential accountapp.Credential) (kiro.Credential, bool) {
	if credential == nil || credential.ProviderID() != kiro.ProviderID {
		return kiro.Credential{}, false
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		return kiro.Credential{}, false
	}
	parsed, err := kiro.ParseCredential(native.Payload())
	if err != nil || parsed.AccessToken() == "" {
		return kiro.Credential{}, false
	}
	return parsed, true
}

type usageDocument struct {
	UsageBreakdownList []struct {
		ResourceType              string   `json:"resourceType"`
		CurrentUsage              *float64 `json:"currentUsage"`
		CurrentUsageWithPrecision *float64 `json:"currentUsageWithPrecision"`
		UsageLimit                *float64 `json:"usageLimit"`
		UsageLimitWithPrecision   *float64 `json:"usageLimitWithPrecision"`
		NextDateReset             *float64 `json:"nextDateReset"`
	} `json:"usageBreakdownList"`
	NextDateReset    *float64 `json:"nextDateReset"`
	SubscriptionInfo struct {
		SubscriptionTitle string `json:"subscriptionTitle"`
		Type              string `json:"type"`
	} `json:"subscriptionInfo"`
	UserInfo struct {
		Email string `json:"email"`
	} `json:"userInfo"`
}

type creditBreakdown struct {
	usedUnits  float64
	totalUnits float64
	resetAt    time.Time
}

func (document usageDocument) credit() (creditBreakdown, bool) {
	for _, row := range document.UsageBreakdownList {
		if strings.TrimSpace(row.ResourceType) != "CREDIT" {
			continue
		}
		used := firstAmount(row.CurrentUsageWithPrecision, row.CurrentUsage)
		total := firstAmount(row.UsageLimitWithPrecision, row.UsageLimit)
		if used == nil || total == nil || *total <= 0 {
			return creditBreakdown{}, false
		}
		resetAt := time.Time{}
		if reset := firstAmount(row.NextDateReset, document.NextDateReset); reset != nil && *reset > 0 {
			resetAt = time.Unix(int64(*reset), 0).UTC()
		}
		return creditBreakdown{usedUnits: *used, totalUnits: *total, resetAt: resetAt}, true
	}
	return creditBreakdown{}, false
}

func firstAmount(values ...*float64) *float64 {
	for _, value := range values {
		if value != nil && !math.IsNaN(*value) && !math.IsInf(*value, 0) && *value >= 0 {
			return value
		}
	}
	return nil
}

// entry 把 CREDIT 资源折算成剩余基点条目。
func (credit creditBreakdown) entry(resetAt time.Time) (usagecore.EntryInput, float64, error) {
	remaining := math.Max(0, credit.totalUnits-credit.usedUnits)
	pct := remaining / credit.totalUnits * 100
	if math.IsNaN(pct) || math.IsInf(pct, 0) || pct < 0 || pct > 100 {
		return usagecore.EntryInput{}, 0, ErrInvalidResponse
	}
	availability := usagecore.AvailabilityAvailable
	if remaining <= 0 {
		availability = usagecore.AvailabilityExhausted
	}
	entry := usagecore.EntryInput{
		Bucket:               creditBucket,
		Kind:                 usagecore.KindCredits,
		Scope:                usagecore.ScopeAccount,
		HasRemaining:         true,
		RemainingBasisPoints: uint16(math.Round(pct * 100)),
		ResetAt:              resetAt,
		Availability:         availability,
	}
	if _, err := usagecore.NewEntry(entry); err != nil {
		return usagecore.EntryInput{}, 0, ErrInvalidResponse
	}
	return entry, pct, nil
}

// documentPlanType 把 Kiro 的订阅枚举（Q_DEVELOPER_STANDALONE_PRO）归一成 pro。
// 快照与展示文档共用同一份推导，避免两处口径分叉。
func documentPlanType(document usageDocument) string {
	return usagecore.NormalizePlanToken(strings.TrimPrefix(
		strings.TrimSpace(document.SubscriptionInfo.Type),
		"Q_DEVELOPER_STANDALONE_",
	))
}

// buildDocumentPayload 生成与 Node kiro 快照同形的展示文档（schemaVersion=2）。
func buildDocumentPayload(
	document usageDocument,
	credit creditBreakdown,
	remainingPct float64,
	capturedAt time.Time,
) ([]byte, error) {
	remaining := math.Max(0, credit.totalUnits-credit.usedUnits)
	resetAtMS := int64(0)
	if !credit.resetAt.IsZero() {
		resetAtMS = credit.resetAt.UnixMilli()
	}
	planType := documentPlanType(document)
	payload := map[string]any{
		"schemaVersion": schemaVersion,
		"kind":          documentKind,
		"capturedAt":    capturedAt.UnixMilli(),
		"source":        sourceID,
		"account": map[string]any{
			"email":    strings.TrimSpace(document.UserInfo.Email),
			"planName": strings.TrimSpace(document.SubscriptionInfo.SubscriptionTitle),
			"planType": planType,
		},
		"entries": []map[string]any{{
			"bucket":         creditBucket,
			"totalUnits":     credit.totalUnits,
			"usedUnits":      credit.usedUnits,
			"remainingUnits": remaining,
			"unitType":       "credits",
			"remainingPct":   remainingPct,
			"windowMinutes":  0,
			"window":         "",
			"resetIn":        "",
			"resetAtMs":      resetAtMS,
		}},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	return encoded, nil
}

func (strategy *Strategy) fetch(ctx context.Context, credential kiro.Credential) (usageDocument, error) {
	endpoint, err := strategy.endpoint(credential.Region())
	if err != nil {
		return usageDocument{}, err
	}
	input := map[string]string{
		"origin":          "CLI",
		"resourceType":    "AGENTIC_REQUEST",
		"isEmailRequired": "true",
	}
	if profile := strings.TrimSpace(credential.ProfileARN()); profile != "" {
		input["profileArn"] = profile
	}
	query := url.Values{}
	for key, value := range input {
		query.Set(key, value)
	}
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return usageDocument{}, ErrInvalidResponse
	}
	parsed.RawQuery = query.Encode()
	body, err := json.Marshal(input)
	if err != nil {
		return usageDocument{}, ErrInvalidResponse
	}
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, parsed.String(), bytes.NewReader(body))
	if err != nil {
		return usageDocument{}, ErrInvalidResponse
	}
	request.Header.Set("Authorization", "Bearer "+credential.AccessToken())
	request.Header.Set("Content-Type", "application/x-amz-json-1.0")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("x-amz-target", usageTarget)
	response, err := strategy.client.Do(request)
	if err != nil {
		closeResponse(response)
		if ctxErr := ctx.Err(); ctxErr != nil {
			return usageDocument{}, ctxErr
		}
		return usageDocument{}, ErrInvalidResponse
	}
	if response == nil || response.Body == nil {
		closeResponse(response)
		return usageDocument{}, ErrInvalidResponse
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode != http.StatusOK {
		return usageDocument{}, fmt.Errorf("%w: HTTP %d", ErrInvalidResponse, response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBody+1))
	if err != nil || len(payload) == 0 || len(payload) > maxResponseBody {
		return usageDocument{}, ErrInvalidResponse
	}
	var document usageDocument
	if json.Unmarshal(payload, &document) != nil {
		return usageDocument{}, ErrInvalidResponse
	}
	return document, nil
}

func usageEndpoint(region string) (string, error) {
	region = strings.TrimSpace(region)
	if region == "" {
		region = kiro.DefaultRegion
	}
	// 与 Node 的 /^[a-z]{2}-[a-z]+-\d$/ 同口径：region 只能拼进固定主机名。
	if !validRegion(region) {
		return "", ErrInvalidResponse
	}
	parsed, err := url.Parse("https://codewhisperer." + region + ".amazonaws.com/")
	if err != nil || parsed.Host == "" {
		return "", ErrInvalidResponse
	}
	return parsed.String(), nil
}

func validRegion(region string) bool {
	parts := strings.Split(region, "-")
	if len(parts) != 3 || len(parts[0]) != 2 || len(parts[1]) == 0 {
		return false
	}
	for _, part := range parts[:2] {
		for _, character := range part {
			if character < 'a' || character > 'z' {
				return false
			}
		}
	}
	for _, character := range parts[2] {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func closeResponse(response *http.Response) {
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
}
