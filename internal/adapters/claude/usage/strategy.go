// Package usage 把 Claude OAuth 额度响应转换为稳定领域快照。
package usage

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

const (
	officialBaseURL = "https://api.anthropic.com"
	usagePath       = "/api/oauth/usage"
	profilePath     = "/api/oauth/profile"
	sourceID        = "claude_oauth_usage"
	oauthBeta       = "oauth-2025-04-20"
	claudeUserAgent = "claude-code/2.1.88"
	maxResponseBody = 1 << 20
	// profileTimeout 是补套餐用的 best-effort 请求上限：它失败不能拖慢或拖垮额度采集。
	profileTimeout = 5 * time.Second
	// familyBucketPrefix 是模型族周额度的键前缀（seven_day_opus / seven_day_fable…）。
	familyBucketPrefix = "seven_day_"
)

var (
	// ErrInvalidDependencies 表示 Strategy 缺少 HTTP 传输。
	ErrInvalidDependencies = errors.New("Claude 额度 Strategy 依赖无效")
	// ErrInvalidResponse 表示上游状态、大小或 JSON 结构不满足额度合同。
	ErrInvalidResponse = errors.New("Claude 额度响应无效")
)

// HTTPClient 是额度 Strategy 唯一依赖的传输端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Strategy 使用 Claude Bearer 凭据读取 OAuth usage。
type Strategy struct {
	client HTTPClient
}

var _ usageapp.ProviderStrategy = (*Strategy)(nil)

// New 创建不依赖 Claude Native Relay 的额度 Strategy。
func New(client HTTPClient) (*Strategy, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &Strategy{client: client}, nil
}

// ProviderID 返回当前 Strategy 唯一支持的 Provider。
func (*Strategy) ProviderID() string {
	return claudeauth.ProviderID
}

// nonFamilyBuckets 是同样以 seven_day_ 开头、但不属于模型族的账号级键。
var nonFamilyBuckets = map[string]struct{}{
	"seven_day":            {},
	"seven_day_oauth_apps": {},
}

// MatchesModelFamily 按额度键里的族名做包含匹配，不维护族名清单：
// 上游新增模型族（fable 等）时自动生效，不需要改代码。
func (*Strategy) MatchesModelFamily(
	scopeKey string,
	modelID runtimecore.ModelID,
) bool {
	family := strings.ToLower(strings.TrimSpace(scopeKey))
	if family == "" {
		return false
	}
	return strings.Contains(strings.ToLower(modelID.String()), family)
}

// FetchUsage 使用受支持 Bearer 凭据读取完整 Claude 当前额度。
func (strategy *Strategy) FetchUsage(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	capturedAt time.Time,
) (usagecore.Snapshot, error) {
	if strategy == nil ||
		strategy.client == nil ||
		ctx == nil ||
		!accountRef.IsValid() {
		return usagecore.Snapshot{}, usageapp.ErrInvalidRequest
	}
	baseURL, token, supported := projectBearer(credential)
	if !supported {
		return usagecore.Snapshot{}, usageapp.ErrUsageUnsupported
	}
	request, err := newRequest(ctx, baseURL, token)
	if err != nil {
		return usagecore.Snapshot{}, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	response, err := strategy.client.Do(request)
	if err != nil || response == nil || response.Body == nil {
		return usagecore.Snapshot{}, errors.Join(
			usageapp.ErrRefreshFailed,
			ErrInvalidResponse,
		)
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < http.StatusOK ||
		response.StatusCode >= http.StatusMultipleChoices {
		return usagecore.Snapshot{}, errors.Join(
			usageapp.ErrRefreshFailed,
			ErrInvalidResponse,
		)
	}
	payload, err := decodePayload(response.Body)
	if err != nil {
		return usagecore.Snapshot{}, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	entries, err := payload.entries()
	if err != nil || len(entries) == 0 {
		return usagecore.Snapshot{}, errors.Join(
			usageapp.ErrRefreshFailed,
			ErrInvalidResponse,
		)
	}
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: claudeauth.ProviderID,
		Source:     sourceID,
		PlanType:   strategy.fetchPlanType(ctx, baseURL, token),
		CapturedAt: capturedAt,
		Entries:    entries,
	})
	if err != nil {
		return usagecore.Snapshot{}, errors.Join(
			usageapp.ErrRefreshFailed,
			ErrInvalidResponse,
		)
	}
	return snapshot, nil
}

// projectBearer 只接受已研究的 OAuth、setup-token 和 Auth Token。
func projectBearer(
	credential accountapp.Credential,
) (string, string, bool) {
	switch auth := credential.(type) {
	case *claudeauth.OAuthAuth:
		if auth == nil {
			return "", "", false
		}
		return officialBaseURL, auth.AccessToken(), auth.AccessToken() != ""
	case *claudeauth.OAuthTokenAuth:
		if auth == nil {
			return "", "", false
		}
		return auth.BaseURL(), auth.AccessToken(), auth.AccessToken() != ""
	case *claudeauth.AuthTokenAuth:
		if auth == nil {
			return "", "", false
		}
		return auth.BaseURL(), auth.AuthToken(), auth.AuthToken() != ""
	default:
		return "", "", false
	}
}

// newRequest 创建凭据只存在于 Header 的 GET 请求。
func newRequest(
	ctx context.Context,
	baseURL string,
	token string,
) (*http.Request, error) {
	endpoint, err := oauthEndpoint(baseURL, usagePath)
	if err != nil || token == "" {
		return nil, ErrInvalidResponse
	}
	return newGET(ctx, endpoint, token)
}

// newGET 创建带 OAuth Header 的 GET 请求。
func newGET(
	ctx context.Context,
	endpoint string,
	token string,
) (*http.Request, error) {
	if token == "" {
		return nil, ErrInvalidResponse
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		endpoint,
		nil,
	)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Anthropic-Beta", oauthBeta)
	request.Header.Set("User-Agent", claudeUserAgent)
	return request, nil
}

// oauthEndpoint 在账号规范 Base URL 后精确追加 OAuth 路径。
func oauthEndpoint(baseURL string, path string) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil ||
		parsed.Scheme == "" ||
		parsed.Host == "" ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" {
		return "", ErrInvalidResponse
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + path
	parsed.RawPath = ""
	return parsed.String(), nil
}

// usagePayload 对应 Claude Code services/api/usage.ts 的完整当前字段。
//
// 模型族周额度不写死族名：任何 seven_day_<family> 键都会成为一条 model_family
// 条目，上游新增模型族（fable 等）时不需要改这里。
type usagePayload struct {
	FiveHour          *rateLimit
	SevenDay          *rateLimit
	SevenDayOAuthApps *rateLimit
	ExtraUsage        *extraUsage
	// Families 按族名索引（opus / sonnet / fable …），键已去掉 seven_day_ 前缀。
	Families map[string]*rateLimit
}

// UnmarshalJSON 逐键解码：已知键走固定字段（形状不对就报错），
// 其余 seven_day_<family> 归入 Families（形状不认识只丢这一族，不影响整次采集）。
func (payload *usagePayload) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	var err error
	if payload.FiveHour, err = decodeRateLimit(fields["five_hour"]); err != nil {
		return err
	}
	if payload.SevenDay, err = decodeRateLimit(fields["seven_day"]); err != nil {
		return err
	}
	if payload.SevenDayOAuthApps, err = decodeRateLimit(fields["seven_day_oauth_apps"]); err != nil {
		return err
	}
	if payload.ExtraUsage, err = decodeExtraUsage(fields["extra_usage"]); err != nil {
		return err
	}
	for key, value := range fields {
		family, isFamily := familyFromBucket(key)
		if !isFamily {
			continue
		}
		limit, err := decodeRateLimit(value)
		if err != nil || limit == nil {
			continue
		}
		if payload.Families == nil {
			payload.Families = make(map[string]*rateLimit, 2)
		}
		payload.Families[family] = limit
	}
	return nil
}

// familyFromBucket 从额度键里取出模型族名；账号级键与非法族名返回 false。
//
// 族名必须是 usagecore 允许的 scope_key（小写标识符），否则整条快照会被拒绝：
// 一个上游新增的怪键不应该让整次采集失败，直接忽略它。
func familyFromBucket(bucket string) (string, bool) {
	if _, accountScoped := nonFamilyBuckets[bucket]; accountScoped {
		return "", false
	}
	if !strings.HasPrefix(bucket, familyBucketPrefix) {
		return "", false
	}
	family := strings.TrimPrefix(bucket, familyBucketPrefix)
	if family == "" || len(family) > 128 {
		return "", false
	}
	for _, char := range family {
		switch {
		case char >= 'a' && char <= 'z':
		case char >= '0' && char <= '9':
		case char == '_', char == '.', char == ':', char == '-':
		default:
			return "", false
		}
	}
	return family, true
}

// decodeRateLimit 解析单个额度对象；缺失与 null 按「上游没给」处理。
func decodeRateLimit(data json.RawMessage) (*rateLimit, error) {
	if len(data) == 0 || string(data) == "null" {
		return nil, nil
	}
	var limit rateLimit
	if err := json.Unmarshal(data, &limit); err != nil {
		return nil, ErrInvalidResponse
	}
	return &limit, nil
}

// decodeExtraUsage 解析 extra usage；缺失与 null 按「上游没给」处理。
func decodeExtraUsage(data json.RawMessage) (*extraUsage, error) {
	if len(data) == 0 || string(data) == "null" {
		return nil, nil
	}
	var extra extraUsage
	if err := json.Unmarshal(data, &extra); err != nil {
		return nil, ErrInvalidResponse
	}
	return &extra, nil
}

type rateLimit struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    *string  `json:"resets_at"`
}

type extraUsage struct {
	IsEnabled    *bool    `json:"is_enabled"`
	MonthlyLimit *float64 `json:"monthly_limit"`
	UsedCredits  *float64 `json:"used_credits"`
	Utilization  *float64 `json:"utilization"`
}

// decodePayload 对响应大小设硬上限并解析 JSON。
func decodePayload(body io.Reader) (usagePayload, error) {
	document, err := io.ReadAll(io.LimitReader(body, maxResponseBody+1))
	if err != nil || len(document) == 0 || len(document) > maxResponseBody {
		return usagePayload{}, ErrInvalidResponse
	}
	var payload usagePayload
	if err := json.Unmarshal(document, &payload); err != nil {
		return usagePayload{}, ErrInvalidResponse
	}
	return payload, nil
}

// windowDefinition 是一条待构造的窗口条目。
type windowDefinition struct {
	bucket        string
	limit         *rateLimit
	scope         usagecore.Scope
	scopeKey      string
	windowSeconds int64
}

// entries 按官方字段顺序构造账号级、模型族级和 extra usage 条目。
func (payload usagePayload) entries() ([]usagecore.EntryInput, error) {
	definitions := []windowDefinition{
		{"five_hour", payload.FiveHour, usagecore.ScopeAccount, "", 5 * 60 * 60},
		{"seven_day", payload.SevenDay, usagecore.ScopeAccount, "", 7 * 24 * 60 * 60},
		{"seven_day_oauth_apps", payload.SevenDayOAuthApps, usagecore.ScopeAccount, "", 7 * 24 * 60 * 60},
	}
	// 模型族按族名排序，保证同一份响应每次产出相同顺序。
	for _, family := range sortedFamilies(payload.Families) {
		definitions = append(definitions, windowDefinition{
			familyBucketPrefix + family,
			payload.Families[family],
			usagecore.ScopeModelFamily,
			family,
			7 * 24 * 60 * 60,
		})
	}
	var entries []usagecore.EntryInput
	for _, definition := range definitions {
		if definition.limit == nil {
			continue
		}
		entry, err := newWindowEntry(
			definition.bucket,
			definition.limit,
			definition.scope,
			definition.scopeKey,
			definition.windowSeconds,
		)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	if payload.ExtraUsage != nil {
		entry, err := newExtraUsageEntry(payload.ExtraUsage)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

// profilePayload 是 /api/oauth/profile 里与套餐相关的字段。
type profilePayload struct {
	Account struct {
		HasClaudeMax bool `json:"has_claude_max"`
		HasClaudePro bool `json:"has_claude_pro"`
	} `json:"account"`
	Organization struct {
		OrganizationType string `json:"organization_type"`
	} `json:"organization"`
}

// fetchPlanType 是 best-effort：失败、超时或形状不认识都返回空，不影响额度快照。
func (strategy *Strategy) fetchPlanType(
	ctx context.Context,
	baseURL string,
	token string,
) string {
	endpoint, err := oauthEndpoint(baseURL, profilePath)
	if err != nil {
		return ""
	}
	profileCtx, cancel := context.WithTimeout(ctx, profileTimeout)
	defer cancel()
	request, err := newGET(profileCtx, endpoint, token)
	if err != nil {
		return ""
	}
	response, err := strategy.client.Do(request)
	if err != nil || response == nil || response.Body == nil {
		return ""
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < http.StatusOK ||
		response.StatusCode >= http.StatusMultipleChoices {
		return ""
	}
	document, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBody+1))
	if err != nil || len(document) == 0 || len(document) > maxResponseBody {
		return ""
	}
	var profile profilePayload
	if err := json.Unmarshal(document, &profile); err != nil {
		return ""
	}
	return profilePlanType(profile)
}

// profilePlanType 从 profile 推导套餐。
//
// 不维护套餐清单：organization_type 去掉 claude_ 前缀就是档位名
// （claude_team → team、claude_fable → fable），上游新增档位不需要改代码。
// has_claude_max / has_claude_pro 是上游自己的布尔结论，优先于组织类型。
func profilePlanType(profile profilePayload) string {
	switch {
	case profile.Account.HasClaudeMax:
		return "max"
	case profile.Account.HasClaudePro:
		return "pro"
	}
	organizationType := strings.ToLower(strings.TrimSpace(profile.Organization.OrganizationType))
	organizationType = strings.TrimPrefix(organizationType, "claude_")
	token := usagecore.NormalizePlanToken(organizationType)
	if !usagecore.IsPlanToken(token) {
		return ""
	}
	return token
}

// sortedFamilies 返回排序后的模型族名，保证条目顺序稳定。
func sortedFamilies(families map[string]*rateLimit) []string {
	names := make([]string, 0, len(families))
	for name := range families {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// newWindowEntry 把 Claude 使用率转换为整数剩余基点。
func newWindowEntry(
	bucket string,
	limit *rateLimit,
	scope usagecore.Scope,
	scopeKey string,
	windowSeconds int64,
) (usagecore.EntryInput, error) {
	resetAt, err := parseResetAt(limit.ResetsAt)
	if err != nil {
		return usagecore.EntryInput{}, err
	}
	entry := usagecore.EntryInput{
		Bucket:        bucket,
		Kind:          usagecore.KindWindow,
		Scope:         scope,
		ScopeKey:      scopeKey,
		WindowSeconds: windowSeconds,
		ResetAt:       resetAt,
		Availability:  usagecore.AvailabilityUnknown,
	}
	if limit.Utilization != nil {
		remaining, err := remainingBasisPoints(*limit.Utilization)
		if err != nil {
			return usagecore.EntryInput{}, err
		}
		entry.HasRemaining = true
		entry.RemainingBasisPoints = remaining
		entry.Availability = usagecore.AvailabilityAvailable
		if remaining == 0 {
			entry.Availability = usagecore.AvailabilityExhausted
		}
	}
	if _, err := usagecore.NewEntry(entry); err != nil {
		return usagecore.EntryInput{}, ErrInvalidResponse
	}
	return entry, nil
}

// newExtraUsageEntry 保存 extra usage 的启用状态和可用剩余比例。
func newExtraUsageEntry(extra *extraUsage) (usagecore.EntryInput, error) {
	if extra == nil ||
		extra.IsEnabled == nil ||
		extra.MonthlyLimit != nil &&
			(math.IsNaN(*extra.MonthlyLimit) ||
				math.IsInf(*extra.MonthlyLimit, 0) ||
				*extra.MonthlyLimit < 0) ||
		extra.UsedCredits != nil &&
			(math.IsNaN(*extra.UsedCredits) ||
				math.IsInf(*extra.UsedCredits, 0) ||
				*extra.UsedCredits < 0) {
		return usagecore.EntryInput{}, ErrInvalidResponse
	}
	entry := usagecore.EntryInput{
		Bucket:       "extra_usage",
		Kind:         usagecore.KindCredits,
		Scope:        usagecore.ScopeAccount,
		Availability: usagecore.AvailabilityDisabled,
	}
	switch {
	case !*extra.IsEnabled:
	case extra.MonthlyLimit == nil:
		entry.Availability = usagecore.AvailabilityUnlimited
	case extra.Utilization == nil:
		entry.Availability = usagecore.AvailabilityAvailable
	default:
		remaining, err := remainingBasisPoints(*extra.Utilization)
		if err != nil {
			return usagecore.EntryInput{}, err
		}
		entry.HasRemaining = true
		entry.RemainingBasisPoints = remaining
		entry.Availability = usagecore.AvailabilityAvailable
		if remaining == 0 {
			entry.Availability = usagecore.AvailabilityExhausted
		}
	}
	if _, err := usagecore.NewEntry(entry); err != nil {
		return usagecore.EntryInput{}, ErrInvalidResponse
	}
	return entry, nil
}

// remainingBasisPoints 把 0-100 使用率转换为 0-10000 剩余基点。
func remainingBasisPoints(utilization float64) (uint16, error) {
	if math.IsNaN(utilization) ||
		math.IsInf(utilization, 0) ||
		utilization < 0 ||
		utilization > 100 {
		return 0, ErrInvalidResponse
	}
	return uint16(math.Round((100 - utilization) * 100)), nil
}

// parseResetAt 解析 Claude ISO 8601 恢复时间。
func parseResetAt(value *string) (time.Time, error) {
	if value == nil {
		return time.Time{}, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, *value)
	if err != nil {
		return time.Time{}, ErrInvalidResponse
	}
	return parsed, nil
}
