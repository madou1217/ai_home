// Package usage 把 agy（Antigravity）的 code-assist 配额转换为额度快照与展示文档。
//
// 协议事实（与 Node lib/server/code-assist-quota.js 同口径）：
//
//	POST {base}/v1internal:loadCodeAssist
//	  {"metadata":{"ideType":"ANTIGRAVITY"}}  → cloudaicompanionProject + 套餐 tier
//	POST {base}/v1internal:fetchAvailableModels
//	  {"project":...}（403 时回退空对象）→ models[*].quotaInfo.remainingFraction/resetTime
//
// agy 的额度是**按模型**的（shape=models），因此每个模型一条 model_family 条目；
// 展示文档与 Node 的 schemaVersion=2 形状一致。
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
)

const (
	sourceID        = "agy_fetch_available_models"
	documentKind    = "agy_code_assist_quota"
	defaultBaseURL  = "https://daily-cloudcode-pa.googleapis.com/v1internal"
	clientVersion   = "1.15.8"
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
)

// HTTPClient 是额度 Strategy 唯一依赖的传输端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Strategy 使用 agy OAuth 凭据读取 code-assist 配额。
type Strategy struct {
	client  HTTPClient
	baseURL string
}

var _ usageapp.ProviderStrategy = (*Strategy)(nil)

// New 创建生产端点上的额度策略。
func New(client HTTPClient) (*Strategy, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &Strategy{client: client, baseURL: defaultBaseURL}, nil
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
	auth, ok := credential.(*agy.OAuthAuth)
	if !ok || auth == nil || strings.TrimSpace(auth.AccessToken()) == "" {
		return usagecore.Snapshot{}, nil, usageapp.ErrUsageUnsupported
	}
	project, tier := strategy.loadProject(ctx, auth)
	payload, err := strategy.fetchModels(ctx, auth, project)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	models, ok := parseQuotaModels(payload)
	if !ok || len(models) == 0 {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	entries := make([]usagecore.EntryInput, 0, len(models))
	for _, model := range models {
		entries = append(entries, usagecore.EntryInput{
			Bucket:               model.id,
			Kind:                 usagecore.KindWindow,
			Scope:                usagecore.ScopeModelFamily,
			ScopeKey:             model.id,
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

type loadResponse struct {
	Project         string            `json:"cloudaicompanionProject"`
	PaidTier        *tierInfo         `json:"paidTier"`
	CurrentTier     *tierInfo         `json:"currentTier"`
	IneligibleTiers []json.RawMessage `json:"ineligibleTiers"`
	AllowedTiers    []tierInfo        `json:"allowedTiers"`
}

type tierInfo struct {
	Name      string `json:"name"`
	ID        string `json:"id"`
	QuotaTier string `json:"quotaTier"`
	IsDefault bool   `json:"isDefault"`
}

func (tier tierInfo) title() string {
	for _, value := range []string{tier.Name, tier.ID, tier.QuotaTier} {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

// loadProject 读取 project 与套餐 tier；失败时返回空值（配额请求可继续）。
func (strategy *Strategy) loadProject(ctx context.Context, auth *agy.OAuthAuth) (string, string) {
	payload := map[string]any{"metadata": map[string]string{
		"ideType":    "ANTIGRAVITY",
		"platform":   "PLATFORM_UNSPECIFIED",
		"pluginType": "GEMINI",
	}}
	document, err := strategy.post(ctx, strategy.baseURL+":loadCodeAssist", auth, payload)
	if err != nil {
		return "", ""
	}
	var parsed loadResponse
	if json.Unmarshal(document, &parsed) != nil {
		return "", ""
	}
	return strings.TrimSpace(parsed.Project), extractTier(parsed)
}

func extractTier(document loadResponse) string {
	if document.PaidTier != nil {
		if name := document.PaidTier.title(); name != "" {
			return name
		}
	}
	restricted := len(document.IneligibleTiers) > 0
	if !restricted && document.CurrentTier != nil {
		if name := document.CurrentTier.title(); name != "" {
			return name
		}
	}
	if len(document.AllowedTiers) > 0 {
		picked := document.AllowedTiers[0]
		for _, tier := range document.AllowedTiers {
			if tier.IsDefault {
				picked = tier
				break
			}
		}
		if name := picked.title(); name != "" {
			if restricted {
				return name + " (Restricted)"
			}
			return name
		}
	}
	return ""
}

func (strategy *Strategy) fetchModels(ctx context.Context, auth *agy.OAuthAuth, project string) ([]byte, error) {
	bodies := []map[string]any{{}}
	if project != "" {
		bodies = []map[string]any{{"project": project}, {}}
	}
	var lastErr error
	for index, body := range bodies {
		payload, err := strategy.post(ctx, strategy.baseURL+":fetchAvailableModels", auth, body)
		if err == nil {
			return payload, nil
		}
		lastErr = err
		if index == 0 && project != "" && isForbidden(err) {
			continue
		}
		break
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

func (strategy *Strategy) post(
	ctx context.Context,
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
	request.Header.Set("User-Agent", "antigravity/"+clientVersion+" darwin/arm64")
	request.Header.Set("x-client-name", "antigravity")
	request.Header.Set("x-client-version", clientVersion)
	request.Header.Set("x-vscode-sessionid", clientSessionID)
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
// 只认 ultra / pro / free 三档，未知返回空（展示文档的 normalizePlanType
// 会回落成 oauth，那不是套餐，不能写进快照）。
func snapshotPlanType(rawTier string) string {
	lower := strings.ToLower(strings.TrimSpace(rawTier))
	switch {
	case lower == "":
		return ""
	case strings.Contains(lower, "ultra"):
		return "ultra"
	case strings.Contains(lower, "pro"):
		return "pro"
	case strings.Contains(lower, "starter"),
		strings.Contains(lower, "free"),
		strings.Contains(lower, "default"):
		return "free"
	default:
		return ""
	}
}

func parseQuotaModels(payload []byte) ([]quotaModel, bool) {
	var document struct {
		Models json.RawMessage `json:"models"`
	}
	if json.Unmarshal(payload, &document) != nil || len(document.Models) == 0 {
		return nil, false
	}
	type entry struct {
		id   string
		info json.RawMessage
	}
	entries := make([]entry, 0, 16)
	trimmed := bytes.TrimSpace(document.Models)
	switch {
	case len(trimmed) > 0 && trimmed[0] == '{':
		var byID map[string]json.RawMessage
		if json.Unmarshal(trimmed, &byID) != nil {
			return nil, false
		}
		for id, info := range byID {
			entries = append(entries, entry{id: id, info: info})
		}
	case len(trimmed) > 0 && trimmed[0] == '[':
		var list []json.RawMessage
		if json.Unmarshal(trimmed, &list) != nil {
			return nil, false
		}
		for _, raw := range list {
			var header struct {
				Model      string `json:"model"`
				ID         string `json:"id"`
				ModelID    string `json:"modelId"`
				ModelSnake string `json:"model_id"`
			}
			if json.Unmarshal(raw, &header) != nil {
				return nil, false
			}
			id := firstNonEmpty(header.Model, header.ID, header.ModelID, header.ModelSnake)
			if id != "" {
				entries = append(entries, entry{id: id, info: raw})
			}
		}
	default:
		return nil, false
	}
	byModel := make(map[string]quotaModel, len(entries))
	for _, item := range entries {
		model, ok := parseQuotaModel(item.id, item.info)
		if !ok {
			continue
		}
		key := strings.ToLower(model.id)
		previous, exists := byModel[key]
		if !exists || model.remainingPct < previous.remainingPct {
			byModel[key] = model
		}
	}
	models := make([]quotaModel, 0, len(byModel))
	for _, model := range byModel {
		models = append(models, model)
	}
	sort.Slice(models, func(left, right int) bool { return models[left].id < models[right].id })
	return models, len(models) > 0
}

func parseQuotaModel(id string, raw json.RawMessage) (quotaModel, bool) {
	id = strings.TrimSpace(id)
	if !validQuotaModelID(id) {
		return quotaModel{}, false
	}
	var detail struct {
		QuotaInfo *struct {
			RemainingFraction *float64 `json:"remainingFraction"`
			RemainingSnake    *float64 `json:"remaining_fraction"`
			ResetTime         string   `json:"resetTime"`
			ResetTimeSnake    string   `json:"reset_time"`
		} `json:"quotaInfo"`
		QuotaInfoSnake *struct {
			RemainingFraction *float64 `json:"remainingFraction"`
			RemainingSnake    *float64 `json:"remaining_fraction"`
			ResetTime         string   `json:"resetTime"`
			ResetTimeSnake    string   `json:"reset_time"`
		} `json:"quota_info"`
		DisplayName    string   `json:"displayName"`
		DisplaySnake   string   `json:"display_name"`
		SupportsThink  bool     `json:"supportsThinking"`
		SupportsThinkS bool     `json:"supports_thinking"`
		SupportsImage  bool     `json:"supportsImages"`
		SupportsImageS bool     `json:"supports_images"`
		MaxTokens      *float64 `json:"maxTokens"`
		MaxTokensSnake *float64 `json:"max_tokens"`
		MaxOutput      *float64 `json:"maxOutputTokens"`
		MaxOutputSnake *float64 `json:"max_output_tokens"`
	}
	if json.Unmarshal(raw, &detail) != nil {
		return quotaModel{}, false
	}
	quota := detail.QuotaInfo
	if quota == nil {
		quota = detail.QuotaInfoSnake
	}
	if quota == nil {
		return quotaModel{}, false
	}
	fraction := quota.RemainingFraction
	if fraction == nil {
		fraction = quota.RemainingSnake
	}
	if fraction == nil || math.IsNaN(*fraction) || math.IsInf(*fraction, 0) {
		return quotaModel{}, false
	}
	resetValue := firstNonEmpty(quota.ResetTime, quota.ResetTimeSnake)
	resetAt, err := time.Parse(time.RFC3339Nano, resetValue)
	if err != nil || resetAt.UnixMilli() <= 0 {
		return quotaModel{}, false
	}
	pct := math.Max(0, math.Min(100, *fraction*100))
	availability := usagecore.AvailabilityAvailable
	if pct <= 0 {
		availability = usagecore.AvailabilityExhausted
	}
	return quotaModel{
		id:                   id,
		remainingBasisPoints: uint16(math.Round(pct * 100)),
		remainingPct:         pct,
		resetAt:              resetAt.UTC(),
		displayName:          strings.TrimSpace(firstNonEmpty(detail.DisplayName, detail.DisplaySnake)),
		supportsThinking:     detail.SupportsThink || detail.SupportsThinkS,
		supportsImages:       detail.SupportsImage || detail.SupportsImageS,
		maxTokens:            firstAmount(detail.MaxTokens, detail.MaxTokensSnake),
		maxOutputTokens:      firstAmount(detail.MaxOutput, detail.MaxOutputSnake),
		availability:         availability,
	}, true
}

func validQuotaModelID(value string) bool {
	if _, err := runtimecore.NewModelID(value); err != nil || strings.Contains(value, "*") {
		return false
	}
	normalized := strings.ToLower(value)
	return !strings.HasPrefix(value, "MODEL_") &&
		!strings.HasPrefix(normalized, "chat_") &&
		!strings.HasPrefix(normalized, "tab_") &&
		!strings.HasPrefix(normalized, "models/") &&
		!strings.Contains(normalized, "placeholder") &&
		!strings.Contains(normalized, "proactive-observer")
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

func forwardingRules(payload []byte) map[string]string {
	var document struct {
		Deprecated  map[string]json.RawMessage `json:"deprecatedModelIds"`
		DeprecatedS map[string]json.RawMessage `json:"deprecated_model_ids"`
	}
	if json.Unmarshal(payload, &document) != nil {
		return map[string]string{}
	}
	raw := document.Deprecated
	if len(raw) == 0 {
		raw = document.DeprecatedS
	}
	rules := make(map[string]string, len(raw))
	for from, value := range raw {
		var direct string
		if json.Unmarshal(value, &direct) == nil && direct != "" {
			rules[from] = direct
			continue
		}
		var detail struct {
			NewModelID string `json:"newModelId"`
			NewSnake   string `json:"new_model_id"`
		}
		if json.Unmarshal(value, &detail) == nil {
			if to := firstNonEmpty(detail.NewModelID, detail.NewSnake); to != "" {
				rules[from] = to
			}
		}
	}
	return rules
}

func normalizePlanType(tier string) string {
	value := strings.ToLower(strings.TrimSpace(tier))
	switch {
	case strings.Contains(value, "ultra"):
		return "ultra"
	case strings.Contains(value, "pro"):
		return "pro"
	case strings.Contains(value, "starter"), strings.Contains(value, "free"), strings.Contains(value, "default"):
		return "free"
	default:
		return "oauth"
	}
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

func firstAmount(values ...*float64) *float64 {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
