// Package usage 把 agy（Antigravity）的 code-assist 配额转换为额度快照与展示文档。
//
// 协议事实（与 Node lib/server/code-assist-quota.js 同口径）：
//
//	POST {base}/v1internal:loadCodeAssist
//	  {"metadata":{"ideType":"ANTIGRAVITY",...}}  → cloudaicompanionProject + 套餐 tier
//	POST {base}/v1internal:fetchAvailableModels
//	  {"project":...}（403 时回退空对象）→ models[*].quotaInfo.remainingFraction/resetTime
//
// 根地址按 Node DEFAULT_AGY_QUOTA_BASE_URLS 的顺序回退（404/429/5xx 换下一个）。
// agy 的额度是**按模型**的（shape=models），因此每个模型一条 model_family 条目；
// 展示文档与 Node 的 schemaVersion=2 形状一致。
//
// 文件分工：
//
//	strategy.go  采集：请求、窗口推断、快照条目、展示文档
//	modelid.go   模型 ID 规则（Node model-id.js / code-assist-model-registry.js）
//	document.go  读回展示文档：可信/过期判定、可用模型、账号派生事实
//	view.go      账号用量视图（Node agy-account-usage-view.js）
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
	"sort"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/internal/adapters/agy/clientversion"
)

const (
	sourceID     = "agy_fetch_available_models"
	documentKind = "agy_code_assist_quota"
	// 客户端画像与 codeassist 适配器共用 clientversion 探测（Node 的
	// buildAgyCodeAssistUserAgent 同一来源）。
	clientSessionID = "00000000-0000-4000-8000-000000000000"
	maxResponseBody = 8 * 1024 * 1024
	requestTimeout  = 12 * time.Second
	schemaVersion   = 2
)

var (
	// ErrInvalidDependencies 表示 Strategy 缺少 HTTP 传输。
	ErrInvalidDependencies = errors.New("agy 额度 Strategy 依赖无效")
	// ErrInvalidResponse 表示上游状态、大小或 JSON 结构不满足额度合同。
	ErrInvalidResponse = errors.New("agy 额度响应无效")
	// defaultBaseURLs 与 Node code-assist-quota.js 的 DEFAULT_AGY_QUOTA_BASE_URLS 同序：
	// sandbox → daily → 正式。Node 在 404/429/5xx 时按这个顺序换端点重试。
	defaultBaseURLs = []string{
		"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal",
		"https://daily-cloudcode-pa.googleapis.com/v1internal",
		"https://cloudcode-pa.googleapis.com/v1internal",
	}
)

// HTTPClient 是额度 Strategy 唯一依赖的传输端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// ClientResolver 按账号选择额度请求传输（账号级出口）。
//
// 未绑定出口的账号返回基础 client；解析失败必须 fail-closed，不能回落到默认
// 网络策略（与刷新链同口径）。
type ClientResolver func(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (HTTPClient, error)

// Strategy 使用 agy OAuth 凭据读取 code-assist 配额。
type Strategy struct {
	client HTTPClient
	// clientResolver 可选：账号级出口存在时返回专用传输。
	clientResolver ClientResolver
	// baseURLs 是候选根地址；Node resolveAgyQuotaBaseUrls 的默认列表，
	// 由 endpoints() 兜底，测试可替换成单元素切片。
	baseURLs []string
}

var _ usageapp.ProviderStrategy = (*Strategy)(nil)

// New 创建生产端点上的额度策略。
// NewWithEgress 创建带账号级出口解析的额度 Strategy。
func NewWithEgress(client HTTPClient, resolver ClientResolver) (*Strategy, error) {
	strategy, err := New(client)
	if err != nil {
		return nil, err
	}
	if resolver == nil {
		return nil, ErrInvalidDependencies
	}
	strategy.clientResolver = resolver
	return strategy, nil
}

func New(client HTTPClient) (*Strategy, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &Strategy{
		client:   client,
		baseURLs: append([]string(nil), defaultBaseURLs...),
	}, nil
}

// endpoints 返回本轮请求允许尝试的根地址。
func (strategy *Strategy) endpoints() []string {
	if strategy == nil || len(strategy.baseURLs) == 0 {
		return defaultBaseURLs
	}
	return strategy.baseURLs
}

// ProviderID 返回 agy。
func (*Strategy) ProviderID() string { return agy.ProviderID }

// MatchesModelFamily 精确匹配模型 ID（agy 额度按模型计）。
func (*Strategy) MatchesModelFamily(scopeKey string, modelID runtimecore.ModelID) bool {
	return strings.EqualFold(strings.TrimSpace(scopeKey), modelID.String())
}

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
	client := strategy.client
	if strategy.clientResolver != nil {
		resolved, err := strategy.clientResolver(ctx, accountRef)
		if err != nil || resolved == nil {
			return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
		}
		client = resolved
	}
	auth, ok := credential.(*agy.OAuthAuth)
	if !ok || auth == nil || strings.TrimSpace(auth.AccessToken()) == "" {
		return usagecore.Snapshot{}, nil, usageapp.ErrUsageUnsupported
	}
	project, tier := strategy.loadProject(ctx, client, auth)
	payload, err := strategy.fetchModels(ctx, client, auth, project)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	models, ok := parseQuotaModels(payload)
	if !ok || len(models) == 0 {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	entries := make([]usagecore.EntryInput, 0, len(models))
	for _, model := range models {
		// 条目键统一小写：core 的标识符只接受小写，MatchesModelFamily 用 EqualFold 比较，
		// 因此原样大小写的模型名在文档里保留、在快照键里归一。
		entryKey := strings.ToLower(model.id)
		entries = append(entries, usagecore.EntryInput{
			Bucket:               entryKey,
			Kind:                 usagecore.KindWindow,
			Scope:                usagecore.ScopeModelFamily,
			ScopeKey:             entryKey,
			HasRemaining:         true,
			RemainingBasisPoints: model.remainingBasisPoints,
			WindowSeconds:        inferWindowSeconds(model.resetAt, capturedAt),
			ResetAt:              model.resetAt,
			Availability:         model.availability,
		})
	}
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: agy.ProviderID,
		Source:     sourceID,
		PlanType:   snapshotPlanType(tier),
		CapturedAt: capturedAt,
		Entries:    entries,
	})
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	documentPayload, err := buildDocumentPayload(payload, models, auth.Email(), tier, project, capturedAt)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	document, err := usagecore.NewDocument(usagecore.DocumentInput{
		AccountRef: accountRef,
		ProviderID: agy.ProviderID,
		Kind:       documentKind,
		Source:     sourceID,
		CapturedAt: capturedAt,
		Payload:    documentPayload,
	})
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	return snapshot, &document, nil
}

// loadProjectInfo 是 Node fetchAgyCodeAssistProjectInfo 的返回投影。
type loadProjectInfo struct {
	Project string
	Tier    string
}

// loadProject 读取 project 与套餐 tier；失败时返回空值（配额请求可继续）。
//
// Node fetchAgyCodeAssistProjectInfo 在 loadCodeAssist 上同样按 404/429/5xx 换端点；
// 它还有 account 级缓存（codeAssistProject + codeAssistLoadResponse）可跳过请求，
// Go 的 Strategy 没有账号状态，这里每次采集都重新读（差异见文件头的对齐清单）。
func (strategy *Strategy) loadProject(
	ctx context.Context,
	client HTTPClient,
	auth *agy.OAuthAuth,
) (string, string) {
	payload := map[string]any{"metadata": map[string]string{
		"ideType":    "ANTIGRAVITY",
		"platform":   "PLATFORM_UNSPECIFIED",
		"pluginType": "GEMINI",
	}}
	var lastErr error
	for _, baseURL := range strategy.endpoints() {
		document, err := strategy.post(ctx, client, baseURL+":loadCodeAssist", auth, payload)
		if err == nil {
			info := parseLoadResponse(document)
			return info.Project, info.Tier
		}
		lastErr = err
		if !shouldFallbackEndpoint(err) {
			break
		}
	}
	_ = lastErr
	return "", ""
}

// parseLoadResponse 复刻 Node applyProjectResponse + extractSubscriptionTier。
//
// 字段按 RawMessage 读取：Node 对 tier 字段的类型错误是容忍的（某个字段不是对象
// 就当没有），不会因为一个畸形 tier 把整份响应判成不可解析。
func parseLoadResponse(payload []byte) loadProjectInfo {
	document := rawObject(payload)
	if document == nil {
		return loadProjectInfo{}
	}
	return loadProjectInfo{
		Project: readText(firstField(document, "cloudaicompanionProject")),
		Tier:    extractSubscriptionTier(document),
	}
}

// extractSubscriptionTier 复刻 Node extractSubscriptionTier 的优先级：
// paidTier → currentTier（有 ineligibleTiers 时跳过）→ allowedTiers 的默认档（受限时加后缀）。
func extractSubscriptionTier(document map[string]json.RawMessage) string {
	if paid := tierTitle(rawObject(firstField(document, "paidTier", "paid_tier"))); paid != "" {
		return paid
	}
	restricted := len(arrayOf(firstField(document, "ineligibleTiers", "ineligible_tiers"))) > 0
	if !restricted {
		if current := tierTitle(rawObject(firstField(document, "currentTier", "current_tier"))); current != "" {
			return current
		}
	}
	allowed := arrayOf(firstField(document, "allowedTiers", "allowed_tiers"))
	if len(allowed) == 0 {
		return ""
	}
	picked := firstTierWithFlag(allowed, "isDefault")
	if picked < 0 {
		picked = firstTierWithFlag(allowed, "is_default")
	}
	if picked < 0 {
		picked = 0
	}
	name := tierTitle(rawObject(allowed[picked]))
	if name != "" && restricted {
		return name + " (Restricted)"
	}
	return name
}

// tierTitle 复刻 Node pickTierName：name → id → quotaTier → quota_tier，取第一个非空。
func tierTitle(tier map[string]json.RawMessage) string {
	if tier == nil {
		return ""
	}
	return firstNonEmpty(
		readText(firstField(tier, "name")),
		readText(firstField(tier, "id")),
		readText(firstField(tier, "quotaTier")),
		readText(firstField(tier, "quota_tier")),
	)
}

// firstTierWithFlag 返回第一个满足 name === true 的档位下标；没有返回 -1。
func firstTierWithFlag(tiers []json.RawMessage, field string) int {
	for index, raw := range tiers {
		tier := rawObject(raw)
		if tier == nil {
			continue
		}
		if string(bytes.TrimSpace(tier[field])) == "true" {
			return index
		}
	}
	return -1
}

// fetchModels 复刻 Node fetchAgyCodeAssistQuotaSnapshot 的请求顺序：
// 每个端点先带 project、403 时去掉 project 重试一次；端点本身 404/429/5xx 时换下一个。
func (strategy *Strategy) fetchModels(
	ctx context.Context,
	client HTTPClient,
	auth *agy.OAuthAuth,
	project string,
) ([]byte, error) {
	bodies := []map[string]any{{}}
	if project != "" {
		bodies = []map[string]any{{"project": project}, {}}
	}
	var lastErr error
	for _, baseURL := range strategy.endpoints() {
		endpoint := baseURL + ":fetchAvailableModels"
		for index, body := range bodies {
			payload, err := strategy.post(ctx, client, endpoint, auth, body)
			if err == nil {
				return payload, nil
			}
			lastErr = err
			if index == 0 && project != "" && isForbidden(err) {
				continue
			}
			break
		}
		if !shouldFallbackEndpoint(lastErr) {
			break
		}
	}
	if lastErr == nil {
		lastErr = ErrInvalidResponse
	}
	return nil, lastErr
}

type httpStatusError struct {
	status int
}

func (err httpStatusError) Error() string {
	return fmt.Sprintf("agy 额度请求失败: HTTP %d", err.status)
}

func isForbidden(err error) bool {
	var statusErr httpStatusError
	return errors.As(err, &statusErr) && statusErr.status == http.StatusForbidden
}

// shouldFallbackEndpoint 复刻 Node shouldFallbackEndpoint：404 / 429 / 5xx 才换端点。
// 401/403 是凭据或项目问题，换端点没有意义。
func shouldFallbackEndpoint(err error) bool {
	var statusErr httpStatusError
	if !errors.As(err, &statusErr) {
		return false
	}
	return statusErr.status == http.StatusNotFound ||
		statusErr.status == http.StatusTooManyRequests ||
		(statusErr.status >= 500 && statusErr.status < 600)
}

func (strategy *Strategy) post(
	ctx context.Context,
	client HTTPClient,
	endpoint string,
	auth *agy.OAuthAuth,
	body map[string]any,
) ([]byte, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return nil, ErrInvalidResponse
	}
	request.Header.Set("Authorization", "Bearer "+auth.AccessToken())
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Encoding", "identity")
	version := clientversion.Detect()
	request.Header.Set("User-Agent", "antigravity/"+version+" darwin/arm64")
	request.Header.Set("x-client-name", "antigravity")
	request.Header.Set("x-client-version", version)
	request.Header.Set("x-vscode-sessionid", clientSessionID)
	response, err := client.Do(request)
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
		return nil, httpStatusError{status: response.StatusCode}
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBody+1))
	if err != nil || len(payload) == 0 || len(payload) > maxResponseBody {
		return nil, ErrInvalidResponse
	}
	return payload, nil
}

type quotaModel struct {
	id                   string
	remainingBasisPoints uint16
	remainingPct         float64
	resetAt              time.Time
	displayName          string
	supportsThinking     bool
	supportsImages       bool
	maxTokens            *float64
	maxOutputTokens      *float64
	availability         usagecore.Availability
}

// inferWindowSeconds 按「重置时间距今 > 6 小时」区分周窗口与 5h 窗口。
//
// agy 的 quotaInfo 只给 remainingFraction 与 resetTime，没有窗口长度；
// 这与 Node lib/account/quota-reset/agy-strategy.js 的判据一致（> 360 分钟 = 周）。
// 没有这个推断，采样会因 windowSeconds=0 被跳过，agy 的窗口统计永远是空的。
func inferWindowSeconds(resetAt time.Time, capturedAt time.Time) int64 {
	if resetAt.After(capturedAt) && resetAt.Sub(capturedAt) > 6*time.Hour {
		return int64(7 * 24 * 60 * 60)
	}
	return int64(5 * 60 * 60)
}

// snapshotPlanType 与 Node lib/account/quota-reset/agy-strategy.js 同判据：
// 上游档位名带前后缀时按关键字归类，其余原样通过（不维护档位清单）。
// 未知档位只有「不是套餐」的鉴权模式才落空；展示文档的 normalizePlanType
// 会回落成 oauth，那不是套餐，不能写进快照。
func snapshotPlanType(rawTier string) string {
	token := usagecore.NormalizePlanToken(rawTier)
	if !usagecore.IsPlanToken(token) {
		return ""
	}
	switch {
	case strings.Contains(token, "ultra"):
		return "ultra"
	case strings.Contains(token, "pro"):
		return "pro"
	case strings.Contains(token, "starter"),
		strings.Contains(token, "free"),
		strings.Contains(token, "default"):
		return "free"
	default:
		return token
	}
}

// parseQuotaModels 复刻 Node listQuotaModels：
//
//   - models 既可能是对象（键是模型 ID），也可能是数组（条目里带 id/model/modelId）；
//   - 数组形态按 Node 的 descriptor 规则取 ID（先 id 后 model，去 _vertex 后缀）；
//   - 同名模型（大小写不敏感）只留剩余比例最低的那条；
//   - 按模型 ID 升序返回（Node 用 localeCompare；模型 ID 是 ASCII，见文件头对齐清单）。
func parseQuotaModels(payload []byte) ([]quotaModel, bool) {
	document := rawObject(payload)
	if document == nil {
		return nil, false
	}
	modelsRaw := bytes.TrimSpace(document["models"])
	if len(modelsRaw) == 0 || isJSONNull(modelsRaw) {
		return nil, false
	}
	models := make([]quotaModel, 0, 16)
	switch modelsRaw[0] {
	case '{':
		for key, info := range rawObject(modelsRaw) {
			if model, ok := parseQuotaModel(objectModelID(key, rawObject(info)), info); ok {
				models = append(models, model)
			}
		}
	case '[':
		for _, item := range arrayOf(modelsRaw) {
			if model, ok := parseQuotaModel(readPublicModelID(rawObject(item)), item); ok {
				models = append(models, model)
			}
		}
	default:
		return nil, false
	}
	byModel := make(map[string]quotaModel, len(models))
	for _, model := range models {
		key := strings.ToLower(model.id)
		previous, exists := byModel[key]
		if !exists || model.remainingPct < previous.remainingPct {
			byModel[key] = model
		}
	}
	result := make([]quotaModel, 0, len(byModel))
	for _, model := range byModel {
		result = append(result, model)
	}
	sort.Slice(result, func(left, right int) bool { return result[left].id < result[right].id })
	return result, len(result) > 0
}

// parseQuotaModel 复刻 Node normalizeQuotaModel。
//
// 任何可选字段的类型不合预期都只让该字段取默认值，不会丢弃整条模型：
// Node 是逐字段 Number()/Boolean()，一个 maxTokens 字符串不会让模型从列表里消失。
func parseQuotaModel(id string, raw json.RawMessage) (quotaModel, bool) {
	id = strings.TrimSpace(id)
	if !isRealProviderModelID(id) {
		return quotaModel{}, false
	}
	// Go 的额度条目要求 bucket/scopeKey 是 core 的标识符字符集；不满足的 ID 在这里丢掉，
	// 否则一份快照会因为一个奇异模型 ID 整份失败（Node 没有这一层约束）。
	if !validQuotaEntryKey(id) {
		return quotaModel{}, false
	}
	detail := rawObject(raw)
	if detail == nil {
		return quotaModel{}, false
	}
	quota := rawObject(firstField(detail, "quotaInfo", "quota_info"))
	if quota == nil {
		return quotaModel{}, false
	}
	fraction, ok := jsNumber(firstField(quota, "remainingFraction", "remaining_fraction"))
	if !ok || math.IsNaN(fraction) || math.IsInf(fraction, 0) {
		return quotaModel{}, false
	}
	resetAt, ok := parseQuotaResetTime(firstTextField(quota, "resetTime", "reset_time"))
	if !ok {
		return quotaModel{}, false
	}
	pct := math.Max(0, math.Min(100, fraction*100))
	availability := usagecore.AvailabilityAvailable
	if pct <= 0 {
		availability = usagecore.AvailabilityExhausted
	}
	return quotaModel{
		id:                   id,
		remainingBasisPoints: uint16(math.Round(pct * 100)),
		remainingPct:         pct,
		resetAt:              resetAt,
		displayName:          firstTextField(detail, "displayName", "display_name"),
		supportsThinking: jsTruthy(firstField(detail, "supportsThinking")) ||
			jsTruthy(firstField(detail, "supports_thinking")),
		supportsImages: jsTruthy(firstField(detail, "supportsImages")) ||
			jsTruthy(firstField(detail, "supports_images")),
		maxTokens:       nullableJSNumeric(firstField(detail, "maxTokens", "max_tokens")),
		maxOutputTokens: nullableJSNumeric(firstField(detail, "maxOutputTokens", "max_output_tokens")),
		availability:    availability,
	}, true
}

// parseQuotaResetTime 解析上游 ISO 重置时间。
//
// Node 用 Date.parse，接受的范围比 RFC3339 宽。这里支持 RFC3339（含小数秒与时区）
// 与纯日期；故意不同：不带时区的本地时间在 Node 里按本机时区解释，Go 统一按 UTC，
// 否则同一份快照在不同时区机器上会得出不同的 resetIn。
func parseQuotaResetTime(value string) (time.Time, bool) {
	if value == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02"} {
		parsed, err := time.Parse(layout, value)
		if err != nil {
			continue
		}
		if parsed.UnixMilli() <= 0 {
			return time.Time{}, false
		}
		return parsed.UTC(), true
	}
	return time.Time{}, false
}

func buildDocumentPayload(
	payload []byte,
	models []quotaModel,
	email string,
	tier string,
	project string,
	capturedAt time.Time,
) ([]byte, error) {
	documentModels := make([]map[string]any, 0, len(models))
	for _, model := range models {
		resetIn := formatResetIn(model.resetAt, capturedAt)
		entry := map[string]any{
			"model":            model.id,
			"remainingPct":     model.remainingPct,
			"resetIn":          resetIn,
			"resetAtMs":        model.resetAt.UnixMilli(),
			"displayName":      model.displayName,
			"supportsThinking": model.supportsThinking,
			"supportsImages":   model.supportsImages,
			"maxTokens":        optionalNumber(model.maxTokens),
			"maxOutputTokens":  optionalNumber(model.maxOutputTokens),
		}
		documentModels = append(documentModels, entry)
	}
	document := map[string]any{
		"schemaVersion": schemaVersion,
		"kind":          documentKind,
		"source":        sourceID,
		"capturedAt":    capturedAt.UnixMilli(),
		"account": map[string]any{
			"email":            strings.TrimSpace(email),
			"planType":         normalizePlanType(tier),
			"subscriptionTier": strings.TrimSpace(tier),
			"project":          strings.TrimSpace(project),
		},
		"models":               documentModels,
		"modelForwardingRules": forwardingRules(payload),
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	return encoded, nil
}

// forwardingRules 复刻 Node normalizeForwardingRules：
// 只保留「旧模型 ID → 新模型 ID」两端都是真实模型 ID 的转发规则。
//
// 不过滤的话，内部枚举（MODEL_*）与占位值会进 modelForwardingRules，WebUI 会把
// 不可请求的 ID 当成可转发目标。
func forwardingRules(payload []byte) map[string]string {
	document := rawObject(payload)
	if document == nil {
		return map[string]string{}
	}
	raw := rawObject(firstField(document, "deprecatedModelIds", "deprecated_model_ids"))
	rules := make(map[string]string, len(raw))
	for key, value := range raw {
		from := strings.TrimSpace(key)
		to := ""
		if object := rawObject(value); object != nil {
			to = firstTextField(object, "newModelId", "new_model_id")
		} else {
			to = readText(value)
		}
		if !isRealProviderModelID(from) || !isRealProviderModelID(to) {
			continue
		}
		rules[from] = to
	}
	return rules
}

// normalizePlanType 复刻 Node normalizeAgyPlanType(tier, 'oauth') 的取值；
// 完整回落链见 NormalizePlanType（view.go）。
func normalizePlanType(tier string) string {
	return NormalizePlanType(tier, "oauth")
}

func formatResetIn(resetAt time.Time, now time.Time) string {
	diff := resetAt.Sub(now)
	if diff <= 0 {
		return "soon"
	}
	minutes := int(math.Ceil(diff.Minutes()))
	hours := minutes / 60
	minutes = minutes % 60
	switch {
	case hours > 0 && minutes > 0:
		return fmt.Sprintf("%dh %dm", hours, minutes)
	case hours > 0:
		return fmt.Sprintf("%dh", hours)
	case minutes > 0:
		return fmt.Sprintf("%dm", minutes)
	default:
		return "soon"
	}
}

func optionalNumber(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
