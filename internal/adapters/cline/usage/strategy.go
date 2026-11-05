// Package usage 把 Cline Pass 的滚动窗口用量换算为额度快照与展示文档。
//
// 协议事实（与 Node lib/usage/quota/probes/cline.js 同口径，2026-10-14 实测）：
//
//	GET {base}/users/me/plan/usage-limits
//	  Authorization: Bearer <accessToken，保留 workos: 前缀>、Accept: application/json
//	  → {data:{limits:[{type:'five_hour'|'weekly'|'monthly', percentUsed, resetsAt}]}}
//	GET {base}/users/me/plan
//	  → {data:{userId, currentPeriodStart, currentPeriodEnd,
//	       plan:{displayName, entitlements:{cline_pass:{enabled, inferenceCapThreshold:{
//	         last5HoursUsageCostUSDPerUser, last7daysUsageCostUSDPerUser, last30daysUsageCostUSDPerUser}}}}}}
//
// 上限单位是 1e-8 USD（cap / 1e8 = 美元）。**不要**改用 /users/{uid}/usages 逐条累加：
// 该接口按 limit 只回最新一页、nextToken 游标上游实际不生效，任何滚动窗口都会被严重
// 低估（Node 侧实测偏小 3 倍以上）。/plan/usage-limits 直接给服务端算好的 percentUsed
// 与 resetsAt，既准确又只需一次请求。
//
// 额度模型 = 三个滚动窗口（5h / 7d / 30d）的消费上限；remainingPct = 100 - percentUsed。
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
	// clineProviderID 是 Cline 的规范 Provider；本策略只认这一种账号。
	clineProviderID = "cline"
	// clinePassSlotID 是 Cline Pass 订阅写的第二个凭据槽位。
	clinePassSlotID = "cline-pass"
	// sourceID 与 Node USAGE_SOURCE_CLINE 同值。
	sourceID = "cline_plan_usages_api"
	// documentKind 与 Node USAGE_SNAPSHOT_KINDS.cline 同值。
	documentKind = "cline_pass_usage"
	// defaultAPIBase 是 Cline 账号面（推理面同域）的默认根；与
	// clinerelay.DefaultBaseURL / Node CLINE_DEFAULT_BASE_URL 一致。
	defaultAPIBase    = "https://api.cline.bot/api/v1"
	usageLimitsPath   = "/users/me/plan/usage-limits"
	planPath          = "/users/me/plan"
	accessTokenPrefix = "workos:"
	// costUnitPerUSD 是 cap 与 costUsd 的单位：1e-8 USD。
	costUnitPerUSD   = 100_000_000
	maxResponseBytes = 1 << 20
	requestTimeout   = 10 * time.Second
	schemaVersion    = 2
	// coverageSource 说明用量来自服务端权威接口而非本地累加。
	coverageSource = "plan_usage_limits"
)

var (
	// ErrInvalidDependencies 表示 Strategy 缺少 HTTP 传输。
	ErrInvalidDependencies = errors.New("cline 额度 Strategy 依赖无效")
	// ErrUnsupportedCredential 表示凭据形态拿不到 Cline Pass 额度。
	ErrUnsupportedCredential = errors.New("cline 凭据不适用于 Cline Pass 额度")
	// ErrInvalidResponse 表示上游状态、大小或 JSON 结构不满足额度合同。
	ErrInvalidResponse = errors.New("cline 额度响应无效")
	// ErrUnauthorized 表示上游以 401/403 拒绝当前 access token。
	ErrUnauthorized = errors.New("cline 额度鉴权失败")
	// ErrEntitlementMissing 表示套餐里没有启用的 Cline Pass 权益。
	ErrEntitlementMissing = errors.New("cline 套餐缺少 Cline Pass 权益")
	// ErrWindowsMissing 表示没有任何可用的额度窗口。
	ErrWindowsMissing = errors.New("cline 额度窗口数据缺失")
)

// usageWindows 是上游 limits[].type → 展示窗口的固定映射。
//
// 滚动窗口的上界来自 /users/me/plan 的 inferenceCapThreshold，重置时间来自上游
// resetsAt，两处都不自己推算。
type usageWindow struct {
	id      string
	kind    string
	minutes int64
	capKey  string
}

var usageWindows = [...]usageWindow{
	{id: "5h", kind: "five_hour", minutes: 300, capKey: "last5HoursUsageCostUSDPerUser"},
	{id: "7days", kind: "weekly", minutes: 10_080, capKey: "last7daysUsageCostUSDPerUser"},
	{id: "30days", kind: "monthly", minutes: 43_200, capKey: "last30daysUsageCostUSDPerUser"},
}

// HTTPClient 是额度 Strategy 唯一依赖的传输端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Strategy 用 Cline Pass OAuth 凭据读取账号面额度接口。
type Strategy struct {
	client  HTTPClient
	apiBase string
}

var _ usageapp.ProviderSnapshotStrategy = (*Strategy)(nil)

// New 创建额度策略。
//
// 账号级 CLINE_API_BASE_URL 覆盖在 Go 侧不可达（凭据里没有 env），因此固定用
// defaultAPIBase；需要自建站点时再补显式入口。
func New(client HTTPClient) (*Strategy, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &Strategy{client: client, apiBase: defaultAPIBase}, nil
}

// ProviderID 返回 cline。
func (*Strategy) ProviderID() string { return clineProviderID }

// MatchesModelFamily 表示 Cline Pass 额度是账号级滚动窗口，没有模型族维度。
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
	auth, err := projectCredential(credential)
	if err != nil {
		return usagecore.Snapshot{}, nil, err
	}
	probe, err := strategy.fetch(ctx, auth)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	summary := probe.summary(capturedAt)
	if len(summary.entries) == 0 {
		return usagecore.Snapshot{}, nil, errors.Join(
			usageapp.ErrRefreshFailed,
			fmt.Errorf("%w: %s", ErrWindowsMissing, strings.Join(summary.missing, ",")),
		)
	}
	entries := make([]usagecore.EntryInput, 0, len(summary.entries))
	for _, entry := range summary.entries {
		entries = append(entries, entry.input())
	}
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: clineProviderID,
		Source:     sourceID,
		PlanType:   usagecore.NormalizePlanToken(probe.plan.planName),
		CapturedAt: capturedAt,
		Entries:    entries,
	})
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	payload, err := buildDocumentPayload(probe, summary, capturedAt)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	document, err := usagecore.NewDocument(usagecore.DocumentInput{
		AccountRef: accountRef,
		ProviderID: clineProviderID,
		Kind:       documentKind,
		Source:     sourceID,
		CapturedAt: capturedAt,
		Payload:    payload,
	})
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	return snapshot, &document, nil
}

// clineAuth 是出网所需的最小凭据投影。
type clineAuth struct {
	accessToken  string
	refreshToken string
	expiresAtMS  int64
}

// projectCredential 只接受 cline 原生的 Cline Pass OAuth 凭据。
//
// API Key 账号没有 Cline Pass 额度端点（Node 侧同一判定：api_key_mode_not_applicable），
// 因此一律按「凭据不适用」拒绝，而不是当成刷新失败去记账。
func projectCredential(credential accountapp.Credential) (clineAuth, error) {
	if credential == nil || credential.ProviderID() != clineProviderID {
		return clineAuth{}, usageapp.ErrUsageUnsupported
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		return clineAuth{}, usageapp.ErrUsageUnsupported
	}
	auth, ok := parseClineAuth(native.Payload())
	if !ok || auth.accessToken == "" {
		return clineAuth{}, usageapp.ErrUsageUnsupported
	}
	return auth, nil
}

// parseClineAuth 从 providers.json 形态的原生载荷里取 Cline Pass 令牌。
//
// 槽位选择与 Node selectClineOAuthCredential 同口径：cline 与 cline-pass 各有一条
// OAuth 记录，取剩余有效期更长的那条，同有效期按槽位顺序取 cline。任一槽位带
// settings.apiKey 即判为 API Key 账号（额度不适用），此时不再看 OAuth 记录。
func parseClineAuth(payload []byte) (clineAuth, bool) {
	var document map[string]any
	if json.Unmarshal(payload, &document) != nil || document == nil {
		return clineAuth{}, false
	}
	root := document
	if auth := object(document["auth"]); auth != nil {
		root = auth
	}
	providers := object(root["providers"])
	if providers == nil {
		// 也接受「已经收窄到单槽位」的形态：{settings: {auth: {...}}}。
		providers = map[string]any{clineProviderID: root, clinePassSlotID: root}
	}
	selected := clineAuth{}
	found := false
	for _, slotID := range []string{clineProviderID, clinePassSlotID} {
		settings := slotSettings(providers[slotID])
		if settings == nil {
			continue
		}
		if text(settings["apiKey"]) != "" {
			return clineAuth{}, false
		}
		auth := object(settings["auth"])
		if auth == nil {
			continue
		}
		token := ensureAccessTokenPrefix(firstText(auth, "accessToken", "access_token"))
		if token == "" {
			continue
		}
		candidate := clineAuth{
			accessToken:  token,
			refreshToken: firstText(auth, "refreshToken", "refresh_token"),
			expiresAtMS:  normalizeExpiresAtMS(firstValue(auth, "expiresAt", "expires_at")),
		}
		if !found || candidate.expiresAtMS > selected.expiresAtMS {
			selected = candidate
			found = true
		}
	}
	return selected, found
}

// ensureAccessTokenPrefix 补 workos: 标记：裸 JWT 上游会 401，前缀属于 wire 格式。
func ensureAccessTokenPrefix(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if strings.HasPrefix(value, accessTokenPrefix) {
		return value
	}
	return accessTokenPrefix + value
}

// probeResult 是一次采集拿到的两块上游事实。
type probeResult struct {
	usageByType map[string]windowUsage
	plan        planEntitlement
}

// windowUsage 是 /plan/usage-limits 里单个窗口的权威用量。
type windowUsage struct {
	percentUsed float64
	resetsAtMS  int64
}

// planEntitlement 是 /plan 里与 Cline Pass 窗口上限相关的字段。
type planEntitlement struct {
	userID        string
	planName      string
	periodStartMS int64
	periodEndMS   int64
	capsUSD       map[string]float64
}

func (strategy *Strategy) fetch(ctx context.Context, auth clineAuth) (probeResult, error) {
	limitsPayload, err := strategy.get(ctx, auth.accessToken, usageLimitsPath)
	if err != nil {
		return probeResult{}, err
	}
	planPayload, err := strategy.get(ctx, auth.accessToken, planPath)
	if err != nil {
		return probeResult{}, err
	}
	usage, err := decodeUsageLimits(limitsPayload)
	if err != nil {
		return probeResult{}, err
	}
	plan, entitled, err := decodePlan(planPayload)
	if err != nil {
		return probeResult{}, err
	}
	if !entitled {
		return probeResult{}, ErrEntitlementMissing
	}
	return probeResult{usageByType: usage, plan: plan}, nil
}

// get 发一次账号面 GET；错误里只带状态码与路径，绝不带凭据值。
func (strategy *Strategy) get(ctx context.Context, accessToken, path string) ([]byte, error) {
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, strategy.apiBase+path, nil)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("Accept", "application/json")
	response, err := strategy.client.Do(request)
	if err != nil {
		closeResponse(response)
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		return nil, err
	}
	if response == nil || response.Body == nil {
		closeResponse(response)
		return nil, ErrInvalidResponse
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		statusErr := fmt.Errorf("%w: %s HTTP %d", ErrInvalidResponse, path, response.StatusCode)
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
			return nil, errors.Join(ErrUnauthorized, statusErr)
		}
		return nil, statusErr
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(payload) == 0 || len(payload) > maxResponseBytes {
		return nil, ErrInvalidResponse
	}
	return payload, nil
}

// decodeUsageLimits 读 data.limits[] 的 percentUsed / resetsAt。
//
// percentUsed 缺失或不是有限数的窗口直接不写入：宁可判成缺失窗口，也不臆造用量。
func decodeUsageLimits(payload []byte) (map[string]windowUsage, error) {
	var document struct {
		Data struct {
			Limits []struct {
				Type        string `json:"type"`
				PercentUsed any    `json:"percentUsed"`
				ResetsAt    any    `json:"resetsAt"`
			} `json:"limits"`
		} `json:"data"`
	}
	if json.Unmarshal(payload, &document) != nil {
		return nil, ErrInvalidResponse
	}
	usage := make(map[string]windowUsage, len(document.Data.Limits))
	for _, row := range document.Data.Limits {
		kind := strings.TrimSpace(row.Type)
		if kind == "" {
			continue
		}
		percentUsed, ok := readFiniteNumber(row.PercentUsed)
		if !ok {
			continue
		}
		usage[kind] = windowUsage{
			percentUsed: clampPercent(percentUsed),
			resetsAtMS:  parseTimestampMS(row.ResetsAt),
		}
	}
	return usage, nil
}

// decodePlan 读 Cline Pass 的窗口上限（美元）与套餐身份。
//
// 第二个返回值表示套餐是否带有启用的 Cline Pass 权益；没有时调用方按
// ErrEntitlementMissing 处理（Node 的 cline_pass_entitlement_missing）。
func decodePlan(payload []byte) (planEntitlement, bool, error) {
	var document struct {
		Data struct {
			UserID             string `json:"userId"`
			CurrentPeriodStart any    `json:"currentPeriodStart"`
			CurrentPeriodEnd   any    `json:"currentPeriodEnd"`
			Plan               struct {
				DisplayName  string `json:"displayName"`
				Name         string `json:"name"`
				Entitlements struct {
					ClinePass struct {
						Enabled               *bool          `json:"enabled"`
						InferenceCapThreshold map[string]any `json:"inferenceCapThreshold"`
					} `json:"cline_pass"`
				} `json:"entitlements"`
			} `json:"plan"`
		} `json:"data"`
	}
	if json.Unmarshal(payload, &document) != nil {
		return planEntitlement{}, false, ErrInvalidResponse
	}
	pass := document.Data.Plan.Entitlements.ClinePass
	if pass.Enabled == nil || !*pass.Enabled || pass.InferenceCapThreshold == nil {
		return planEntitlement{}, false, nil
	}
	caps := make(map[string]float64, len(usageWindows))
	for _, window := range usageWindows {
		cap, ok := readFiniteNumber(pass.InferenceCapThreshold[window.capKey])
		if !ok || cap <= 0 {
			continue
		}
		caps[window.id] = cap / costUnitPerUSD
	}
	planName := strings.TrimSpace(document.Data.Plan.DisplayName)
	if planName == "" {
		planName = strings.TrimSpace(document.Data.Plan.Name)
	}
	return planEntitlement{
		userID:        strings.TrimSpace(document.Data.UserID),
		planName:      planName,
		periodStartMS: parseTimestampMS(document.Data.CurrentPeriodStart),
		periodEndMS:   parseTimestampMS(document.Data.CurrentPeriodEnd),
		capsUSD:       caps,
	}, true, nil
}

// windowEntry 是单窗口的展示事实（文档条目与快照条目的共同来源）。
type windowEntry struct {
	bucket               string
	label                string
	windowMinutes        int64
	remainingPct         float64
	remainingBasisPoints uint16
	totalUnits           float64
	usedUnits            float64
	remainingUnits       float64
	resetAtMS            int64
	resetIn              string
}

// usageSummary 把上游事实折算成窗口条目；缺上限或缺 percentUsed 的窗口进 missing。
type usageSummary struct {
	entries []windowEntry
	missing []string
}

func (probe probeResult) summary(capturedAt time.Time) usageSummary {
	nowMS := capturedAt.UnixMilli()
	summary := usageSummary{}
	for _, window := range usageWindows {
		usage, hasUsage := probe.usageByType[window.kind]
		capUSD, hasCap := probe.plan.capsUSD[window.id]
		if !hasUsage || !hasCap || capUSD <= 0 {
			summary.missing = append(summary.missing, window.id)
			continue
		}
		remainingPct := clampPercent(100 - usage.percentUsed)
		usedUSD := roundTo(capUSD*usage.percentUsed/100, 4)
		summary.entries = append(summary.entries, windowEntry{
			bucket:               window.id,
			label:                formatWindowLabel(window.minutes),
			windowMinutes:        window.minutes,
			remainingPct:         remainingPct,
			remainingBasisPoints: basisPoints(remainingPct),
			totalUnits:           roundTo(capUSD, 4),
			usedUnits:            usedUSD,
			remainingUnits:       roundTo(math.Max(0, capUSD-usedUSD), 4),
			resetAtMS:            usage.resetsAtMS,
			resetIn:              formatResetIn(usage.resetsAtMS, nowMS),
		})
	}
	return summary
}

// input 把窗口折算成归一化条目：有窗口长度和重置时间，所以是 window 类型。
func (entry windowEntry) input() usagecore.EntryInput {
	availability := usagecore.AvailabilityAvailable
	if entry.remainingBasisPoints == 0 {
		availability = usagecore.AvailabilityExhausted
	}
	resetAt := time.Time{}
	if entry.resetAtMS > 0 {
		resetAt = time.UnixMilli(entry.resetAtMS).UTC()
	}
	return usagecore.EntryInput{
		Bucket:               entry.bucket,
		Kind:                 usagecore.KindWindow,
		Scope:                usagecore.ScopeAccount,
		HasRemaining:         true,
		RemainingBasisPoints: entry.remainingBasisPoints,
		WindowSeconds:        entry.windowMinutes * 60,
		ResetAt:              resetAt,
		Availability:         availability,
	}
}

// buildDocumentPayload 生成与 Node cline 快照同形的展示文档（schemaVersion=2）。
func buildDocumentPayload(
	probe probeResult,
	summary usageSummary,
	capturedAt time.Time,
) ([]byte, error) {
	entries := make([]map[string]any, 0, len(summary.entries))
	for _, entry := range summary.entries {
		entries = append(entries, map[string]any{
			"bucket":         entry.bucket,
			"window":         entry.label,
			"windowMinutes":  entry.windowMinutes,
			"remainingPct":   entry.remainingPct,
			"totalUnits":     entry.totalUnits,
			"usedUnits":      entry.usedUnits,
			"remainingUnits": entry.remainingUnits,
			"unitType":       "usd",
			"resetAtMs":      entry.resetAtMS,
			"resetIn":        entry.resetIn,
		})
	}
	missing := summary.missing
	if missing == nil {
		missing = []string{}
	}
	payload := map[string]any{
		"schemaVersion": schemaVersion,
		"kind":          documentKind,
		"source":        sourceID,
		"capturedAt":    capturedAt.UnixMilli(),
		"account": map[string]any{
			"userId":        probe.plan.userID,
			"planName":      probe.plan.planName,
			"periodStartMs": probe.plan.periodStartMS,
			"periodEndMs":   probe.plan.periodEndMS,
		},
		"entries": entries,
		"coverage": map[string]any{
			"source":         coverageSource,
			"missingWindows": missing,
		},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	return encoded, nil
}

// formatWindowLabel 与 Node 同口径：10080 分钟先折算成 7days，再退到天/时/分。
func formatWindowLabel(minutes int64) string {
	if minutes <= 0 {
		return ""
	}
	if minutes%10_080 == 0 {
		return fmt.Sprintf("%ddays", minutes/10_080*7)
	}
	if minutes%1_440 == 0 {
		return fmt.Sprintf("%ddays", minutes/1_440)
	}
	if minutes%60 == 0 {
		return fmt.Sprintf("%dh", minutes/60)
	}
	return fmt.Sprintf("%dm", minutes)
}

// formatResetIn 把重置时间折算成 Node 的 XdYhZm / XhYm / Xm 文案。
func formatResetIn(resetAtMS, nowMS int64) string {
	if resetAtMS <= 0 {
		return ""
	}
	totalSeconds := (resetAtMS - nowMS) / 1000
	if totalSeconds < 0 {
		totalSeconds = 0
	}
	days := totalSeconds / 86_400
	hours := (totalSeconds % 86_400) / 3_600
	minutes := (totalSeconds % 3_600) / 60
	switch {
	case days > 0:
		return fmt.Sprintf("%dd%dh%dm", days, hours, minutes)
	case hours > 0:
		return fmt.Sprintf("%dh%dm", hours, minutes)
	default:
		return fmt.Sprintf("%dm", minutes)
	}
}

func basisPoints(percent float64) uint16 {
	value := math.Round(clampPercent(percent) * 100)
	if value > 10_000 {
		value = 10_000
	}
	if value < 0 {
		value = 0
	}
	return uint16(value)
}

func clampPercent(value float64) float64 {
	if math.IsNaN(value) {
		return 0
	}
	return math.Max(0, math.Min(100, value))
}

func roundTo(value float64, digits int) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	factor := math.Pow(10, float64(digits))
	return math.Round(value*factor) / factor
}

// readFiniteNumber 与 Node readFiniteNumber 同口径：数字与数字字符串都接受。
func readFiniteNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

// parseTimestampMS 解析 ISO 时间串；上游没给或解析不出时返回 0（按未知处理）。
func parseTimestampMS(value any) int64 {
	raw, ok := value.(string)
	if !ok {
		return 0
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	for _, layout := range [...]string{time.RFC3339Nano, "2006-01-02"} {
		if parsed, err := time.Parse(layout, raw); err == nil {
			return parsed.UnixMilli()
		}
	}
	return 0
}

// normalizeExpiresAtMS 与 Node 同口径：秒级与毫秒级数字、数字串、ISO 串都归一成毫秒。
func normalizeExpiresAtMS(value any) int64 {
	switch typed := value.(type) {
	case float64:
		return normalizeEpochMS(int64(math.Round(typed)))
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0
		}
		if numeric, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
			return normalizeEpochMS(numeric)
		}
		for _, layout := range [...]string{time.RFC3339Nano, "2006-01-02"} {
			if parsed, err := time.Parse(layout, trimmed); err == nil {
				return parsed.UnixMilli()
			}
		}
	}
	return 0
}

func normalizeEpochMS(value int64) int64 {
	if value <= 0 {
		return 0
	}
	if value < 1_000_000_000_000 {
		return value * 1000
	}
	return value
}

// slotSettings 兼容两种落盘形态：{settings:{...}} 与已经收窄的 {auth:{...}}。
func slotSettings(slot any) map[string]any {
	record := object(slot)
	if record == nil {
		return nil
	}
	if settings := object(record["settings"]); settings != nil {
		return settings
	}
	return record
}

func object(value any) map[string]any {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return record
}

func text(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func firstText(record map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := text(record[key]); value != "" {
			return value
		}
	}
	return ""
}

func firstValue(record map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, found := record[key]; found && value != nil {
			return value
		}
	}
	return nil
}

func closeResponse(response *http.Response) {
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
}
