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
	sourceID        = "claude_oauth_usage"
	oauthBeta       = "oauth-2025-04-20"
	claudeUserAgent = "claude-code/2.1.88"
	maxResponseBody = 1 << 20
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

// MatchesModelFamily 使用 Claude 官方额度键中的 opus/sonnet 模型族。
func (*Strategy) MatchesModelFamily(
	scopeKey string,
	modelID runtimecore.ModelID,
) bool {
	value := strings.ToLower(modelID.String())
	switch scopeKey {
	case "opus":
		return strings.Contains(value, "opus")
	case "sonnet":
		return strings.Contains(value, "sonnet")
	default:
		return false
	}
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
	endpoint, err := usageEndpoint(baseURL)
	if err != nil || token == "" {
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

// usageEndpoint 在账号规范 Base URL 后精确追加 OAuth usage 路径。
func usageEndpoint(baseURL string) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil ||
		parsed.Scheme == "" ||
		parsed.Host == "" ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" {
		return "", ErrInvalidResponse
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + usagePath
	parsed.RawPath = ""
	return parsed.String(), nil
}

// usagePayload 对应 Claude Code services/api/usage.ts 的完整当前字段。
type usagePayload struct {
	FiveHour          *rateLimit  `json:"five_hour"`
	SevenDay          *rateLimit  `json:"seven_day"`
	SevenDayOAuthApps *rateLimit  `json:"seven_day_oauth_apps"`
	SevenDayOpus      *rateLimit  `json:"seven_day_opus"`
	SevenDaySonnet    *rateLimit  `json:"seven_day_sonnet"`
	ExtraUsage        *extraUsage `json:"extra_usage"`
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

// entries 按官方字段顺序构造账号级、模型族级和 extra usage 条目。
func (payload usagePayload) entries() ([]usagecore.EntryInput, error) {
	definitions := []struct {
		bucket        string
		limit         *rateLimit
		scope         usagecore.Scope
		scopeKey      string
		windowSeconds int64
	}{
		{"five_hour", payload.FiveHour, usagecore.ScopeAccount, "", 5 * 60 * 60},
		{"seven_day", payload.SevenDay, usagecore.ScopeAccount, "", 7 * 24 * 60 * 60},
		{"seven_day_oauth_apps", payload.SevenDayOAuthApps, usagecore.ScopeAccount, "", 7 * 24 * 60 * 60},
		{"seven_day_opus", payload.SevenDayOpus, usagecore.ScopeModelFamily, "opus", 7 * 24 * 60 * 60},
		{"seven_day_sonnet", payload.SevenDaySonnet, usagecore.ScopeModelFamily, "sonnet", 7 * 24 * 60 * 60},
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
