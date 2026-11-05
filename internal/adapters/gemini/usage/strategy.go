// Package usage 把 Gemini Code Assist 的配额桶转换为额度快照与展示文档。
//
// 协议事实（与 Node lib/cli/services/usage/snapshot.js 的 refreshGeminiUsageSnapshot
// 同口径，额度 capability 见 lib/providers/defs/gemini.js）：
//
//	POST {base}:retrieveUserQuota
//	  Authorization: Bearer <oauthCreds.access_token>、Content-Type: application/json
//	  {"project":"{{projectId}}"}   // 登录态个人账号的固定占位项目，Node 侧同值
//	  → { buckets:[{ modelId, remainingFraction, resetTime }] }
//
// 一个模型一条 model_family 条目（gemini 的额度是按模型计的，shape/models）。
// 同一模型出现多个桶时（灰度期会同时下发 gemini-2.5-pro 与 gemini-2.5-pro_vertex）
// 取剩余最低的那条，与 Node parseGeminiQuotaBuckets 的取舍一致：额度门禁只能看到
// 最紧的那个桶，否则同名模型的灰度桶会把真实余量抬高。
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
	"github.com/madou1217/ai_home/core/accounts/gemini"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

const (
	// providerID 与 Node 描述符 id 同值。
	providerID = gemini.ProviderID
	// sourceID 与 Node USAGE_SOURCE_GEMINI 同值。
	sourceID = "gemini_refresh_user_quota"
	// documentKind 与 Node USAGE_SNAPSHOT_KINDS.gemini 同值。
	documentKind = "gemini_oauth_stats"
	// defaultBaseURL 是 code-assist 的默认根；额度与模型目录同域。
	defaultBaseURL = "https://cloudcode-pa.googleapis.com/v1internal"
	// quotaMethod 是 code-assist 的配额读取方法（URL 用冒号拼接，不是路径段）。
	quotaMethod = ":retrieveUserQuota"
	// projectPlaceholder 是登录态个人账号的固定占位项目（Node 侧逐字相同）。
	projectPlaceholder = "{{projectId}}"
	// vertexSuffix 是灰度桶的后缀；Node normalizeGeminiModelId 会去掉它再归并。
	vertexSuffix     = "_vertex"
	maxResponseBytes = 1 << 20
	requestTimeout   = 10 * time.Second
	schemaVersion    = 2
)

var (
	// ErrInvalidDependencies 表示 Strategy 缺少 HTTP 传输。
	ErrInvalidDependencies = errors.New("gemini 额度 Strategy 依赖无效")
	// ErrUnsupportedCredential 表示凭据形态没有 code-assist 配额端点。
	ErrUnsupportedCredential = errors.New("gemini 凭据不适用于额度刷新")
	// ErrInvalidResponse 表示上游状态、大小或 JSON 结构不满足额度合同。
	ErrInvalidResponse = errors.New("gemini 额度响应无效")
	// ErrUnauthorized 表示上游以 401/403 拒绝当前 access token。
	ErrUnauthorized = errors.New("gemini 额度鉴权失败")
	// ErrNoQuotaBuckets 表示响应里没有任何可用的模型额度桶。
	ErrNoQuotaBuckets = errors.New("gemini 额度桶为空")
)

// HTTPClient 是额度 Strategy 唯一依赖的传输端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Strategy 用 Gemini 登录态 OAuth 凭据读取 code-assist 配额。
type Strategy struct {
	client  HTTPClient
	baseURL string
}

var _ usageapp.ProviderSnapshotStrategy = (*Strategy)(nil)

// New 创建生产端点上的额度策略。
func New(client HTTPClient) (*Strategy, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &Strategy{client: client, baseURL: defaultBaseURL}, nil
}

// ProviderID 返回 gemini。
func (*Strategy) ProviderID() string { return providerID }

// MatchesModelFamily 精确匹配模型 ID（gemini 额度按模型计，没有聚合族）。
func (*Strategy) MatchesModelFamily(scopeKey string, modelID runtimecore.ModelID) bool {
	return strings.EqualFold(strings.TrimSpace(scopeKey), modelID.String())
}

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
	models, err := strategy.fetch(ctx, auth)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	entries := make([]usagecore.EntryInput, 0, len(models))
	for _, model := range models {
		availability := usagecore.AvailabilityAvailable
		if model.remainingBasisPoints == 0 {
			availability = usagecore.AvailabilityExhausted
		}
		entries = append(entries, usagecore.EntryInput{
			Bucket:               model.id,
			Kind:                 usagecore.KindWindow,
			Scope:                usagecore.ScopeModelFamily,
			ScopeKey:             model.id,
			HasRemaining:         true,
			RemainingBasisPoints: model.remainingBasisPoints,
			ResetAt:              model.resetAt,
			Availability:         availability,
		})
	}
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: providerID,
		Source:     sourceID,
		CapturedAt: capturedAt,
		Entries:    entries,
	})
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	payload, err := buildDocumentPayload(models, capturedAt)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	document, err := usagecore.NewDocument(usagecore.DocumentInput{
		AccountRef: accountRef,
		ProviderID: providerID,
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

// geminiAuth 是出网所需的最小凭据投影。
type geminiAuth struct {
	accessToken string
}

// projectCredential 只接受 gemini 登录态原生凭据。
//
// API Key / Vertex 占位账号没有 code-assist 配额端点（Node 侧同样拿不到
// oauthCreds.access_token，probe 直接不出快照），因此按「凭据不适用」拒绝，
// 而不是当成刷新失败去记账。
func projectCredential(credential accountapp.Credential) (geminiAuth, error) {
	if credential == nil || credential.ProviderID() != providerID {
		return geminiAuth{}, usageapp.ErrUsageUnsupported
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		return geminiAuth{}, usageapp.ErrUsageUnsupported
	}
	auth, ok := parseGeminiAuth(native.Payload())
	if !ok || auth.accessToken == "" {
		return geminiAuth{}, usageapp.ErrUsageUnsupported
	}
	return auth, nil
}

// parseGeminiAuth 从原生 gemini artifact 的 oauthCreds 里取 access token。
//
// artifact 固定形如 {googleAccounts:{active}, oauthCreds:{access_token,...}}
// （见 nativeaccount.geminiIdentity）；没有 oauthCreds 的账号（API Key/Vertex）
// 不进入登录态额度通道。
func parseGeminiAuth(payload []byte) (geminiAuth, bool) {
	var document map[string]any
	if json.Unmarshal(payload, &document) != nil || document == nil {
		return geminiAuth{}, false
	}
	oauth := object(document["oauthCreds"])
	if oauth == nil {
		oauth = object(document["oauth_creds"])
	}
	if oauth == nil {
		return geminiAuth{}, false
	}
	token := firstText(oauth, "access_token", "accessToken")
	if token == "" {
		return geminiAuth{}, false
	}
	return geminiAuth{accessToken: token}, true
}

// fetch 发一次 retrieveUserQuota，并把桶归并成模型条目。
func (strategy *Strategy) fetch(ctx context.Context, auth geminiAuth) ([]quotaModel, error) {
	payload, err := strategy.post(ctx, auth)
	if err != nil {
		return nil, err
	}
	return parseQuotaBuckets(payload)
}

// post 发一次 code-assist 配额请求；错误里只带状态码，绝不带凭据值。
func (strategy *Strategy) post(ctx context.Context, auth geminiAuth) ([]byte, error) {
	body, err := json.Marshal(map[string]string{"project": projectPlaceholder})
	if err != nil {
		return nil, ErrInvalidResponse
	}
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestCtx,
		http.MethodPost,
		strategy.baseURL+quotaMethod,
		bytes.NewReader(body),
	)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	request.Header.Set("Authorization", "Bearer "+auth.accessToken)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
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
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
			return nil, errors.Join(ErrUnauthorized, fmt.Errorf("%s HTTP %d", quotaMethod, response.StatusCode))
		}
		return nil, fmt.Errorf("%w: %s HTTP %d", ErrInvalidResponse, quotaMethod, response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(payload) == 0 || len(payload) > maxResponseBytes {
		return nil, ErrInvalidResponse
	}
	return payload, nil
}

// quotaModel 是单个模型的权威额度事实（快照条目与展示条目的共同来源）。
type quotaModel struct {
	id                   string
	remainingPct         float64
	remainingBasisPoints uint16
	resetAt              time.Time
	// resetTime 保留上游原始字符串：Node 的归并同分时按字符串比较取更早的重置，
	// 这里保持同一取舍，避免两个桶余量相同时 Go 与 Node 选出不同条目。
	resetTime string
}

// bucketWire 是 buckets[] 的线上形态；字段缺失的条目整条丢弃（与 Node 同口径），
// 不臆造 remainingFraction 或 resetTime。
type bucketWire struct {
	ModelID           string   `json:"modelId"`
	RemainingFraction *float64 `json:"remainingFraction"`
	ResetTime         string   `json:"resetTime"`
}

// parseQuotaBuckets 过滤非 gemini 桶、归一化 _vertex 后缀并按模型归并。
func parseQuotaBuckets(payload []byte) ([]quotaModel, error) {
	var document struct {
		Buckets []json.RawMessage `json:"buckets"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, ErrInvalidResponse
	}
	if len(document.Buckets) == 0 {
		return nil, ErrNoQuotaBuckets
	}
	byModel := make(map[string]quotaModel, len(document.Buckets))
	for _, raw := range document.Buckets {
		var bucket bucketWire
		if json.Unmarshal(raw, &bucket) != nil {
			continue
		}
		if bucket.RemainingFraction == nil || bucket.ResetTime == "" {
			continue
		}
		if math.IsNaN(*bucket.RemainingFraction) || math.IsInf(*bucket.RemainingFraction, 0) {
			continue
		}
		modelID := normalizeModelID(bucket.ModelID)
		if !strings.HasPrefix(modelID, "gemini-") {
			continue
		}
		pct := clampPercent(*bucket.RemainingFraction * 100)
		candidate := quotaModel{
			id:                   modelID,
			remainingPct:         pct,
			remainingBasisPoints: basisPoints(pct),
			resetAt:              parseResetTime(bucket.ResetTime),
			resetTime:            bucket.ResetTime,
		}
		previous, exists := byModel[modelID]
		if !exists ||
			candidate.remainingPct < previous.remainingPct ||
			(candidate.remainingPct == previous.remainingPct && candidate.resetTime < previous.resetTime) {
			byModel[modelID] = candidate
		}
	}
	if len(byModel) == 0 {
		return nil, ErrNoQuotaBuckets
	}
	models := make([]quotaModel, 0, len(byModel))
	for _, model := range byModel {
		models = append(models, model)
	}
	sort.Slice(models, func(left, right int) bool { return models[left].id < models[right].id })
	return models, nil
}

// normalizeModelID 去掉灰度桶的 _vertex 后缀（Node normalizeGeminiModelId 同口径）。
func normalizeModelID(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= len(vertexSuffix) &&
		strings.EqualFold(value[len(value)-len(vertexSuffix):], vertexSuffix) {
		return value[:len(value)-len(vertexSuffix)]
	}
	return value
}

// parseResetTime 解析上游 ISO 时间；解析不出时留零值（按未知处理，不臆造时间）。
func parseResetTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil || parsed.UnixMilli() <= 0 {
		return time.Time{}
	}
	return parsed.UTC()
}

// buildDocumentPayload 生成与 Node gemini 快照同形的展示文档（schemaVersion=2）。
//
// 字段集合严格对齐 Node parseGeminiQuotaBuckets：models[] 只有
// model/remainingPct/resetIn/resetAtMs，多余字段会让 WebUI 的 gemini 视图出现
// Node 从未产出过的语义。
func buildDocumentPayload(models []quotaModel, capturedAt time.Time) ([]byte, error) {
	documentModels := make([]map[string]any, 0, len(models))
	for _, model := range models {
		var resetAtMS any
		if !model.resetAt.IsZero() {
			resetAtMS = model.resetAt.UnixMilli()
		}
		documentModels = append(documentModels, map[string]any{
			"model":        model.id,
			"remainingPct": model.remainingPct,
			"resetIn":      formatResetIn(model.resetAt, capturedAt),
			"resetAtMs":    resetAtMS,
		})
	}
	payload := map[string]any{
		"schemaVersion": schemaVersion,
		"kind":          documentKind,
		"source":        sourceID,
		"capturedAt":    capturedAt.UnixMilli(),
		"models":        documentModels,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	return encoded, nil
}

// formatResetIn 与 Node formatResetInFromIso 同文案：Xh Ym / Xh / Ym / soon。
//
// 时间基准用采集时间（capturedAt）而不是 time.Now()，否则同一份快照在测试和
// 重放里的 resetIn 会漂移。解析不出重置时间时 Node 给 unknown，这里保持一致。
func formatResetIn(resetAt time.Time, capturedAt time.Time) string {
	if resetAt.IsZero() {
		return "unknown"
	}
	diffMS := resetAt.UnixMilli() - capturedAt.UnixMilli()
	if diffMS < 0 {
		diffMS = 0
	}
	totalMinutes := int64(math.Ceil(float64(diffMS) / 60000))
	hours := totalMinutes / 60
	minutes := totalMinutes % 60
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
