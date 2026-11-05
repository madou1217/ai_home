// Package usage 把 Qoder / Qoder CN 的账号面额度接口换算为额度快照与展示文档。
//
// 协议事实（与 Node lib/usage/quota/probes/qoder-family.js 同口径，2026-10-16 真机取证）：
//
//	GET {base}/api/v2/quota/usage
//	  → {usageType, totalUsagePercentage, isQuotaExceeded, expiresAt,
//	     userQuota:{total, used, remaining, percentage, unit}}
//	GET {base}/api/v2/user/plan
//	  → {plan_tier_name, is_paid_plan, start_date, end_date}
//	GET {base}/api/v3/user/status
//	  → {id, name, email, userType, isQuotaExceeded, plan, userTag, nextResetAt}
//	Authorization: Bearer <token>、Accept: application/json
//	base：qoder https://openapi.qoder.sh / qodercn https://openapi.qoder.com.cn
//	（取自 CLI 内嵌主机表；api.qoder.com 只认 apikey，qoder.com 未认证，都不是这条面。）
//
// 额度模型 = 一个 credits 池 + 到期时间，没有模型族维度。三个接口里只有 quota 是额度结论的
// 来源，plan/status 只补展示身份，因此后两者失败不判整次采集失败（Node 用 {} 兜底）。
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
	"sync"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/internal/adapters/accounts/qodercred"
)

const (
	quotaPath  = "/api/v2/quota/usage"
	planPath   = "/api/v2/user/plan"
	statusPath = "/api/v3/user/status"
	// sourceID 与 Node USAGE_SOURCE_QODER 同值。
	sourceID = "qoder_quota_usage_api"
	// documentKind 与 Node USAGE_SNAPSHOT_KINDS.qoder/qodercn 同值（两个区域共用一种 kind）。
	documentKind = "qoder_credit_usage"
	// coverageSource 说明额度来自服务端权威接口，而不是本地推断。
	coverageSource = "qoder_quota_usage_api"
	// creditsBucket/creditsWindow 是单池模型在展示层的固定标识，与 Node 条目同值。
	creditsBucket = "credits"
	creditsWindow = "Credits"
	// defaultUnitType 是上游没给 unit 时的兜底单位。
	defaultUnitType = "credits"
	// noConsumableCreditsReason 与 Node notApplicable 的 reason 同值。
	noConsumableCreditsReason = "qoder_no_consumable_credits"
	// resetSentinelMS 是 9999-12-31：无限期档位用它占位，直接展示会变成「291 万天后」。
	resetSentinelMS  = int64(4_102_444_800_000)
	maxResponseBytes = 1 << 20
	requestTimeout   = 10 * time.Second
	schemaVersion    = 2
)

// accountBases 是 Qoder 家族的区域账号面根。主机与路径的版本化事实源在
// lib/runtime/qoder-client-layouts.js；这里只做消费，不按区域写 if。
var accountBases = map[string]string{
	"qoder":   "https://openapi.qoder.sh",
	"qodercn": "https://openapi.qoder.com.cn",
}

var (
	// ErrInvalidDependencies 表示 Strategy 缺少 HTTP 传输或 Provider 未登记。
	ErrInvalidDependencies = errors.New("qoder 额度 Strategy 依赖无效")
	// ErrUnsupportedCredential 表示原生凭据里取不到账号面令牌。
	ErrUnsupportedCredential = errors.New("qoder 额度 Strategy 凭据形态不支持")
	// ErrInvalidResponse 表示上游状态、大小或 JSON 结构不满足额度合同。
	ErrInvalidResponse = errors.New("qoder 额度响应无效")
	// ErrUnauthorized 表示上游以 401/403 拒绝当前令牌。
	ErrUnauthorized = errors.New("qoder 额度鉴权失败")
)

// decryptNative 是 CLI opaque 凭据的解密入口。抽成变量是为了让测试能注入确定性结果：
// 真实解密要读本机 qodercli 内嵌的 WASM，测试机不一定装（Node 侧同样是注入点）。
var decryptNative = func(provider string, native map[string]any) (qodercred.Identity, bool) {
	return qodercred.DecryptNative(provider, native, qodercred.Options{})
}

// HTTPClient 是额度 Strategy 唯一依赖的传输端口。
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// Strategy 是一个 Qoder 家族 Provider 的额度策略。
type Strategy struct {
	client     HTTPClient
	providerID string
	apiBase    string
}

var _ usageapp.ProviderSnapshotStrategy = (*Strategy)(nil)

// New 为指定家族 Provider 创建额度策略。
func New(client HTTPClient, providerID string) (*Strategy, error) {
	apiBase := accountBases[strings.ToLower(strings.TrimSpace(providerID))]
	if client == nil || apiBase == "" {
		return nil, ErrInvalidDependencies
	}
	return &Strategy{client: client, providerID: providerID, apiBase: apiBase}, nil
}

// ProviderID 返回构造时登记的 Provider。
func (strategy *Strategy) ProviderID() string { return strategy.providerID }

// MatchesModelFamily 表示 credits 池是账号级额度，没有模型族维度。
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
	if strategy == nil || strategy.client == nil || ctx == nil || !accountRef.IsValid() {
		return usagecore.Snapshot{}, nil, usageapp.ErrInvalidRequest
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != strategy.providerID {
		return usagecore.Snapshot{}, nil, usageapp.ErrUsageUnsupported
	}
	var payload map[string]any
	if json.Unmarshal(native.Payload(), &payload) != nil || payload == nil {
		return usagecore.Snapshot{}, nil, ErrUnsupportedCredential
	}
	token, tokenSource := resolveAccessToken(strategy.providerID, payload)
	if token == "" {
		return usagecore.Snapshot{}, nil, ErrUnsupportedCredential
	}
	probe, err := strategy.fetch(ctx, token)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	probe.tokenSource = tokenSource
	summary, err := probe.summarize(capturedAt.UnixMilli())
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	entries := make([]usagecore.EntryInput, 0, len(summary.entries))
	if summary.notApplicable {
		entries = append(entries, unknownCreditsEntry())
	}
	for _, entry := range summary.entries {
		entries = append(entries, entry.input())
	}
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: strategy.providerID,
		Source:     sourceID,
		PlanType:   usagecore.NormalizePlanToken(probe.plan.PlanTierName),
		CapturedAt: capturedAt,
		Entries:    entries,
	})
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	view, err := buildDocument(probe, summary, capturedAt)
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

// resolveAccessToken 按 Node resolveQoderAccessToken 的可用性顺序取账号面令牌：
// PAT（native 顶层或 userInfo）→ 可读登录态 → CLI opaque 凭据解密。
//
// tokenSource 会写进展示文档的 coverage，用来区分「读到了 PAT」和「只能靠 WASM 解密」；
// Go 没有 Node 的 env 投影，PAT 本身就落在原生载荷里，因此记成 native_pat。
func resolveAccessToken(providerID string, native map[string]any) (string, string) {
	if payload := object(native["userInfo"]); payload != nil {
		if pat := firstText(payload, "personal_access_token", "pat"); pat != "" {
			return pat, "native_pat"
		}
		if token := firstText(payload, "security_oauth_token", "access_token", "token"); token != "" {
			return token, "native_auth"
		}
	}
	if pat := firstText(native, "personal_access_token", "pat"); pat != "" {
		return pat, "native_pat"
	}
	if token := firstText(native, "security_oauth_token", "access_token", "token"); token != "" {
		return token, "native_auth"
	}
	if identity, ok := decryptNative(providerID, native); ok && strings.TrimSpace(identity.Token) != "" {
		return strings.TrimSpace(identity.Token), "cli_wasm"
	}
	return "", ""
}

// probeResult 是一次采集拿到的三块上游事实。
type probeResult struct {
	usage       quotaResponse
	plan        planResponse
	status      statusResponse
	tokenSource string
}

// quotaResponse 只声明额度结论用到的字段；数值用 any 承接，因为上游对同一个
// 字段时而给数字时而给数字串（Node readFiniteNumber 同口径）。
type quotaResponse struct {
	UserID               any `json:"userId"`
	UserType             any `json:"userType"`
	TotalUsagePercentage any `json:"totalUsagePercentage"`
	IsQuotaExceeded      any `json:"isQuotaExceeded"`
	ExpiresAt            any `json:"expiresAt"`
	UserQuota            struct {
		Total      any    `json:"total"`
		Used       any    `json:"used"`
		Remaining  any    `json:"remaining"`
		Percentage any    `json:"percentage"`
		Unit       string `json:"unit"`
	} `json:"userQuota"`
}

type planResponse struct {
	PlanTierName string `json:"plan_tier_name"`
	IsPaidPlan   any    `json:"is_paid_plan"`
	StartDate    any    `json:"start_date"`
	EndDate      any    `json:"end_date"`
}

type statusResponse struct {
	ID              any    `json:"id"`
	Name            string `json:"name"`
	Email           string `json:"email"`
	UserType        string `json:"userType"`
	Plan            string `json:"plan"`
	UserTag         string `json:"userTag"`
	NextResetAt     any    `json:"nextResetAt"`
	IsQuotaExceeded any    `json:"isQuotaExceeded"`
}

func (strategy *Strategy) fetch(ctx context.Context, token string) (probeResult, error) {
	usagePayload, err := strategy.get(ctx, token, quotaPath)
	if err != nil {
		return probeResult{}, err
	}
	usage, err := decodeQuota(usagePayload)
	if err != nil {
		return probeResult{}, err
	}
	// plan/status 只补展示身份：Node 用 Promise.all 并发拉取，任一失败都按 {} 处理。
	// 这里同样并发且吞掉单个失败，避免这两条辅助请求把一次成功采集变成刷新失败。
	var (
		planPayload   []byte
		statusPayload []byte
		waitGroup     sync.WaitGroup
	)
	waitGroup.Add(2)
	go func() {
		defer waitGroup.Done()
		planPayload, _ = strategy.get(ctx, token, planPath)
	}()
	go func() {
		defer waitGroup.Done()
		statusPayload, _ = strategy.get(ctx, token, statusPath)
	}()
	waitGroup.Wait()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return probeResult{}, ctxErr
	}
	return probeResult{
		usage:  usage,
		plan:   decodePlan(planPayload),
		status: decodeStatus(statusPayload),
	}, nil
}

// decodeQuota 先确认顶层是 JSON 对象再解字段：json.Unmarshal 会把 null 静默解成
// 零值结构，那样「上游返回 null」就会伪装成「userQuota 缺失」。
func decodeQuota(payload []byte) (quotaResponse, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(payload, &fields) != nil || fields == nil {
		return quotaResponse{}, ErrInvalidResponse
	}
	var quota quotaResponse
	if json.Unmarshal(payload, &quota) != nil {
		return quotaResponse{}, ErrInvalidResponse
	}
	return quota, nil
}

// decodePlan 与 decodeStatus 对无效 JSON 返回零值：两条接口只补展示字段，
// 与 Node 的 {} 兜底同语义，不要把辅助字段的缺失升级成采集失败。
func decodePlan(payload []byte) planResponse {
	var plan planResponse
	if len(payload) == 0 {
		return plan
	}
	if json.Unmarshal(payload, &plan) != nil {
		return planResponse{}
	}
	return plan
}

func decodeStatus(payload []byte) statusResponse {
	var status statusResponse
	if len(payload) == 0 {
		return status
	}
	if json.Unmarshal(payload, &status) != nil {
		return statusResponse{}
	}
	return status
}

// get 发一次账号面 GET；错误里只带状态码与路径，绝不带凭据值。
func (strategy *Strategy) get(ctx context.Context, token, path string) ([]byte, error) {
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, strategy.apiBase+path, nil)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	request.Header.Set("Authorization", "Bearer "+token)
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

// quotaEntry 是 credits 池的展示事实（文档条目与快照条目的共同来源）。
type quotaEntry struct {
	windowMinutes  int64
	remainingPct   float64
	totalUnits     float64
	usedUnits      float64
	remainingUnits float64
	unitType       string
	quotaExceeded  bool
	resetAtMS      int64
	resetIn        string
}

// probeSummary 是一次采集的额度结论：要么一个 credits 池，要么「没有可消耗的池」。
type probeSummary struct {
	entries       []quotaEntry
	notApplicable bool
}

// summarize 把三个响应折算成快照条目，与 Node buildQoderQuotaEntries 逐条同口径。
//
// 没有可消耗的额度池（Free 档 total=0）是**结论**而不是失败：Node 返回 notApplicable，
// Go 侧落成 HasRemaining=false 的未知条目。绝不能折算成 0 剩余 —— 账号可用性判定会把
// ≤0 的账号判成 quota_exhausted 并从路由里摘掉，而 Free 档其实还能跑免费模型。
func (probe probeResult) summarize(nowMS int64) (probeSummary, error) {
	quota := probe.usage.UserQuota
	total, hasTotal := readFiniteNumber(quota.Total)
	if !hasTotal {
		// total 缺失说明上游形状变了，属于字段缺失；不能当成「没有额度池」。
		return probeSummary{}, ErrInvalidResponse
	}
	if total <= 0 {
		return probeSummary{notApplicable: true}, nil
	}
	used, hasUsed := readFiniteNumber(quota.Used)
	remaining, hasRemaining := readFiniteNumber(quota.Remaining)
	percentage, hasPercentage := readFiniteNumber(quota.Percentage)
	totalPercentage, hasTotalPercentage := readFiniteNumber(probe.usage.TotalUsagePercentage)
	usedPercentage, hasUsedPercentage := percentage, hasPercentage
	if !hasUsedPercentage {
		usedPercentage, hasUsedPercentage = totalPercentage, hasTotalPercentage
	}
	remainingPct := 0.0
	switch {
	case hasUsedPercentage:
		remainingPct = clampPercent(100 - usedPercentage)
	case hasRemaining:
		remainingPct = clampPercent(remaining / total * 100)
	default:
		// 既没有比例也没有 remaining：无法给出结论，按字段缺失处理（Node 同）。
		return probeSummary{}, ErrInvalidResponse
	}
	// 上游显式说超了就以 0 计（例如已用满的付费档）。
	if isTrue(probe.usage.IsQuotaExceeded) {
		remainingPct = 0
	}
	// expiresAt 对无限期档位是远期哨兵，别显示成「291 万天后」；哨兵不回落 status。
	resetAtMS := int64(0)
	if value, ok := readFiniteNumber(probe.usage.ExpiresAt); ok && value != 0 {
		resetAtMS = int64(math.Round(value))
	} else if value, ok := readFiniteNumber(probe.status.NextResetAt); ok && value != 0 {
		resetAtMS = int64(math.Round(value))
	}
	if resetAtMS <= 0 || resetAtMS >= resetSentinelMS {
		resetAtMS = 0
	}
	windowMinutes := int64(0)
	resetIn := ""
	if resetAtMS > nowMS {
		windowMinutes = int64(math.Round(float64(resetAtMS-nowMS) / 60_000))
		resetIn = formatResetIn(resetAtMS - nowMS)
	}
	unit := strings.TrimSpace(quota.Unit)
	if unit == "" {
		unit = defaultUnitType
	}
	usedUnits := 0.0
	if hasUsed {
		usedUnits = roundTo(used, 2)
	}
	remainingUnits := 0.0
	if hasRemaining {
		remainingUnits = roundTo(remaining, 2)
	}
	return probeSummary{entries: []quotaEntry{{
		windowMinutes:  windowMinutes,
		remainingPct:   roundTo(remainingPct, 2),
		totalUnits:     roundTo(total, 2),
		usedUnits:      usedUnits,
		remainingUnits: remainingUnits,
		unitType:       unit,
		quotaExceeded:  isTrue(probe.usage.IsQuotaExceeded) || isTrue(probe.status.IsQuotaExceeded),
		resetAtMS:      resetAtMS,
		resetIn:        resetIn,
	}}}, nil
}

// input 把 credits 池折算成归一化条目：额度可消耗但到期时间不是窗口长度，
// 因此按 Credits 类型落库，WindowSeconds 只在有重置时间时给出剩余时长。
func (entry quotaEntry) input() usagecore.EntryInput {
	basisPoints := basisPoints(entry.remainingPct)
	availability := usagecore.AvailabilityAvailable
	if basisPoints == 0 {
		availability = usagecore.AvailabilityExhausted
	}
	resetAt := time.Time{}
	if entry.resetAtMS > 0 {
		resetAt = time.UnixMilli(entry.resetAtMS).UTC()
	}
	return usagecore.EntryInput{
		Bucket:               creditsBucket,
		Kind:                 usagecore.KindCredits,
		Scope:                usagecore.ScopeAccount,
		HasRemaining:         true,
		RemainingBasisPoints: basisPoints,
		WindowSeconds:        entry.windowMinutes * 60,
		ResetAt:              resetAt,
		Availability:         availability,
	}
}

// unknownCreditsEntry 是「没有可消耗额度池」的归一化表达：比例未知而非零。
//
// HasRemaining=false 让 MinRemaining 跳过该条目，账号状态落成 pending/not_applicable，
// 不会被判成 exhausted 而摘出路由。
func unknownCreditsEntry() usagecore.EntryInput {
	return usagecore.EntryInput{
		Bucket:       creditsBucket,
		Kind:         usagecore.KindCredits,
		Scope:        usagecore.ScopeAccount,
		Availability: usagecore.AvailabilityUnknown,
	}
}

// buildDocument 生成与 Node qoder 快照同形的展示文档（schemaVersion=2）。
func buildDocument(probe probeResult, summary probeSummary, capturedAt time.Time) ([]byte, error) {
	entries := make([]map[string]any, 0, len(summary.entries))
	for _, entry := range summary.entries {
		entries = append(entries, map[string]any{
			"bucket":         creditsBucket,
			"window":         creditsWindow,
			"windowMinutes":  entry.windowMinutes,
			"remainingPct":   entry.remainingPct,
			"totalUnits":     entry.totalUnits,
			"usedUnits":      entry.usedUnits,
			"remainingUnits": entry.remainingUnits,
			"unitType":       entry.unitType,
			"quotaExceeded":  entry.quotaExceeded,
			"resetAtMs":      entry.resetAtMS,
			"resetIn":        entry.resetIn,
		})
	}
	payload := map[string]any{
		"schemaVersion": schemaVersion,
		"kind":          documentKind,
		"source":        sourceID,
		"capturedAt":    capturedAt.UnixMilli(),
		"account":       probe.accountPayload(),
		"entries":       entries,
		"coverage": map[string]any{
			"source":      coverageSource,
			"tokenSource": probe.tokenSource,
		},
	}
	// 结论要显式带出去：WebUI 据此显示「额度不适用」，而不是把空 entries 当采集中。
	if summary.notApplicable {
		payload["notApplicable"] = true
		payload["reason"] = noConsumableCreditsReason
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	return encoded, nil
}

// accountPayload 与 Node 的 account 字段一一对应：三个接口谁有值就用谁，缺失留空。
func (probe probeResult) accountPayload() map[string]any {
	return map[string]any{
		"userId":        firstNonEmpty(normalizeText(probe.usage.UserID), normalizeText(probe.status.ID)),
		"email":         strings.TrimSpace(probe.status.Email),
		"name":          strings.TrimSpace(probe.status.Name),
		"userType":      firstNonEmpty(normalizeText(probe.usage.UserType), strings.TrimSpace(probe.status.UserType)),
		"planName":      firstNonEmpty(strings.TrimSpace(probe.plan.PlanTierName), strings.TrimSpace(probe.status.UserTag)),
		"planTier":      strings.TrimSpace(probe.status.Plan),
		"isPaidPlan":    isTrue(probe.plan.IsPaidPlan),
		"periodStartMs": numberOrZero(probe.plan.StartDate),
		"periodEndMs":   numberOrZero(probe.plan.EndDate),
	}
}

// formatResetIn 与 Node formatResetIn 同文案（中文），文档里的 resetIn 由 WebUI 直接渲染。
func formatResetIn(ms int64) string {
	if ms <= 0 {
		return ""
	}
	minutes := ms / 60_000
	if minutes < 60 {
		return fmt.Sprintf("%d 分钟后", maxInt64(1, minutes))
	}
	hours := minutes / 60
	if hours < 48 {
		return fmt.Sprintf("%d 小时后", hours)
	}
	return fmt.Sprintf("%d 天后", hours/24)
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

// numberOrZero 只用于展示时间戳：拿不到就是 0，调用方按「未知」渲染。
func numberOrZero(value any) int64 {
	number, ok := readFiniteNumber(value)
	if !ok || number <= 0 {
		return 0
	}
	return int64(math.Round(number))
}

// isTrue 对应 Node 的 x === true：只有布尔 true 算命中，字符串 "true" 不算。
func isTrue(value any) bool {
	result, ok := value.(bool)
	return ok && result
}

// normalizeText 对应 Node normalizeText(String(value).trim())，数字身份也能落成文本。
func normalizeText(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return ""
	}
}

func object(value any) map[string]any {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return record
}

func firstText(record map[string]any, keys ...string) string {
	if record == nil {
		return ""
	}
	for _, key := range keys {
		if value := normalizeText(record[key]); value != "" {
			return value
		}
	}
	return ""
}

func firstNonEmpty(primary, fallback string) string {
	if primary != "" {
		return primary
	}
	return fallback
}

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

func closeResponse(response *http.Response) {
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
}
