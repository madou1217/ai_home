// Package usage 把 Codex 账号额度 HTTP 响应转换为稳定领域快照。
package usage

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"sort"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

const (
	usageEndpoint       = "https://chatgpt.com/backend-api/wham/usage"
	sourceID            = "codex_wham_usage"
	maxResponseBody     = 1 << 20
	codexClientVersion  = "0.146.0"
	codexClientIdentity = "codex_cli_rs"
)

var (
	// ErrInvalidDependencies 表示 Strategy 缺少 HTTP 传输。
	ErrInvalidDependencies = errors.New("Codex 额度 Strategy 依赖无效")
	// ErrInvalidResponse 表示上游状态、大小或 JSON 结构不满足额度合同。
	ErrInvalidResponse = errors.New("Codex 额度响应无效")
)

// HTTPClient 是额度 Strategy 唯一依赖的传输端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Strategy 使用 Codex OAuth 直连低敏额度端点。
type Strategy struct {
	client HTTPClient
}

var _ usageapp.ProviderStrategy = (*Strategy)(nil)

// New 创建不启动 stdio worker 的 Codex 额度 Strategy。
func New(client HTTPClient) (*Strategy, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &Strategy{client: client}, nil
}

// ProviderID 返回当前 Strategy 唯一支持的 Provider。
func (*Strategy) ProviderID() string {
	return codexauth.ProviderID
}

// MatchesModelFamily 返回 false；Codex 当前额度端点没有可信模型族映射。
func (*Strategy) MatchesModelFamily(
	_ string,
	_ runtimecore.ModelID,
) bool {
	return false
}

// FetchUsage 使用 OAuth Bearer 读取完整额度并构造账号级快照。
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
	auth, ok := credential.(*codexauth.OAuthAuth)
	if !ok || auth == nil {
		return usagecore.Snapshot{}, usageapp.ErrUsageUnsupported
	}
	request, err := newRequest(ctx, auth)
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
	entries, err := payload.entries(capturedAt)
	if err != nil || len(entries) == 0 {
		return usagecore.Snapshot{}, errors.Join(
			usageapp.ErrRefreshFailed,
			ErrInvalidResponse,
		)
	}
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: codexauth.ProviderID,
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

// newRequest 复制官方 Codex 客户端所需的最小认证与身份 Header。
func newRequest(
	ctx context.Context,
	auth *codexauth.OAuthAuth,
) (*http.Request, error) {
	if auth == nil || auth.AccessToken() == "" {
		return nil, ErrInvalidResponse
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		usageEndpoint,
		nil,
	)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+auth.AccessToken())
	request.Header.Set("Originator", codexClientIdentity)
	request.Header.Set("User-Agent", codexClientIdentity+"/"+codexClientVersion)
	request.Header.Set("Version", codexClientVersion)
	if accountID := auth.UpstreamAccountID(); accountID != "" {
		request.Header.Set("ChatGPT-Account-ID", accountID)
	}
	if auth.IsFedRAMP() {
		request.Header.Set("X-OpenAI-Fedramp", "true")
	}
	return request, nil
}

// usagePayload 同时接受 wham snake_case 和 app-server camelCase 事实。
type usagePayload struct {
	RateLimit           *directRateLimit             `json:"rate_limit"`
	LegacyRateLimits    *legacyRateLimits            `json:"rate_limits"`
	RateLimits          *rateLimitSnapshot           `json:"rateLimits"`
	RateLimitsByLimitID map[string]rateLimitSnapshot `json:"rateLimitsByLimitId"`
}

type directRateLimit struct {
	PrimaryWindow   *directWindow `json:"primary_window"`
	SecondaryWindow *directWindow `json:"secondary_window"`
	LimitReached    *bool         `json:"limit_reached"`
}

type directWindow struct {
	UsedPercent       *float64 `json:"used_percent"`
	WindowSeconds     *int64   `json:"limit_window_seconds"`
	ResetAtSeconds    *int64   `json:"reset_at"`
	ResetAfterSeconds *int64   `json:"reset_after_seconds"`
}

type legacyRateLimits struct {
	Primary   *legacyWindow `json:"primary"`
	Secondary *legacyWindow `json:"secondary"`
}

type legacyWindow struct {
	UsedPercent  *float64 `json:"used_percent"`
	WindowMins   *int64   `json:"window_minutes"`
	ResetSeconds *int64   `json:"resets_at"`
}

type rateLimitSnapshot struct {
	LimitID              *string         `json:"limitId"`
	LimitName            *string         `json:"limitName"`
	Primary              *officialWindow `json:"primary"`
	Secondary            *officialWindow `json:"secondary"`
	Credits              *credits        `json:"credits"`
	RateLimitReachedType *string         `json:"rateLimitReachedType"`
}

type officialWindow struct {
	UsedPercent        *float64 `json:"usedPercent"`
	WindowDurationMins *int64   `json:"windowDurationMins"`
	ResetsAt           *int64   `json:"resetsAt"`
}

type credits struct {
	HasCredits *bool `json:"hasCredits"`
	Unlimited  *bool `json:"unlimited"`
}

// decodePayload 对响应大小设硬上限并拒绝尾随 JSON。
func decodePayload(body io.Reader) (usagePayload, error) {
	limited := io.LimitReader(body, maxResponseBody+1)
	document, err := io.ReadAll(limited)
	if err != nil || len(document) == 0 || len(document) > maxResponseBody {
		return usagePayload{}, ErrInvalidResponse
	}
	var payload usagePayload
	if err := json.Unmarshal(document, &payload); err != nil {
		return usagePayload{}, ErrInvalidResponse
	}
	return payload, nil
}

// entries 优先使用多 limit 视图，避免重复保存兼容单视图。
func (payload usagePayload) entries(
	capturedAt time.Time,
) ([]usagecore.EntryInput, error) {
	if len(payload.RateLimitsByLimitID) > 0 {
		keys := make([]string, 0, len(payload.RateLimitsByLimitID))
		for key := range payload.RateLimitsByLimitID {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		var entries []usagecore.EntryInput
		for _, key := range keys {
			snapshot := payload.RateLimitsByLimitID[key]
			if snapshot.LimitID == nil {
				snapshot.LimitID = &key
			} else if *snapshot.LimitID != key {
				return nil, ErrInvalidResponse
			}
			current, err := officialEntries(snapshot)
			if err != nil {
				return nil, err
			}
			entries = append(entries, current...)
		}
		return entries, nil
	}
	if payload.RateLimits != nil {
		return officialEntries(*payload.RateLimits)
	}
	if payload.RateLimit != nil {
		return directEntries(*payload.RateLimit, capturedAt)
	}
	if payload.LegacyRateLimits != nil {
		return legacyEntries(*payload.LegacyRateLimits)
	}
	return nil, ErrInvalidResponse
}

// officialEntries 转换 app-server 已规范化的窗口、Credits 和明确阻塞状态。
func officialEntries(snapshot rateLimitSnapshot) ([]usagecore.EntryInput, error) {
	limitID := optionalString(snapshot.LimitID)
	limitName := optionalString(snapshot.LimitName)
	var entries []usagecore.EntryInput
	for _, item := range []struct {
		bucket string
		window *officialWindow
	}{
		{bucket: "primary", window: snapshot.Primary},
		{bucket: "secondary", window: snapshot.Secondary},
	} {
		if item.window == nil {
			continue
		}
		windowSeconds, err := minutesToSeconds(
			item.window.WindowDurationMins,
		)
		if err != nil {
			return nil, err
		}
		entry, err := newWindowEntry(
			limitID,
			limitName,
			item.bucket,
			item.window.UsedPercent,
			windowSeconds,
			unixSeconds(item.window.ResetsAt),
		)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	if snapshot.Credits != nil {
		if snapshot.Credits.HasCredits == nil ||
			snapshot.Credits.Unlimited == nil {
			return nil, ErrInvalidResponse
		}
		availability := usagecore.AvailabilityExhausted
		if *snapshot.Credits.Unlimited {
			availability = usagecore.AvailabilityUnlimited
		} else if *snapshot.Credits.HasCredits {
			availability = usagecore.AvailabilityAvailable
		}
		entries = append(entries, usagecore.EntryInput{
			LimitID:      limitID,
			LimitName:    limitName,
			Bucket:       "credits",
			Kind:         usagecore.KindCredits,
			Scope:        usagecore.ScopeAccount,
			Availability: availability,
		})
	}
	if snapshot.RateLimitReachedType != nil &&
		*snapshot.RateLimitReachedType != "" &&
		!containsExhaustedWindow(entries) {
		entries = append(entries, usagecore.EntryInput{
			LimitID:      limitID,
			LimitName:    limitName,
			Bucket:       "rate_limit_reached",
			Kind:         usagecore.KindWindow,
			Scope:        usagecore.ScopeAccount,
			Availability: usagecore.AvailabilityExhausted,
		})
	}
	return entries, nil
}

// directEntries 转换 /wham/usage 的原始秒级窗口。
func directEntries(
	rateLimit directRateLimit,
	capturedAt time.Time,
) ([]usagecore.EntryInput, error) {
	var entries []usagecore.EntryInput
	for _, item := range []struct {
		bucket string
		window *directWindow
	}{
		{bucket: "primary", window: rateLimit.PrimaryWindow},
		{bucket: "secondary", window: rateLimit.SecondaryWindow},
	} {
		if item.window == nil {
			continue
		}
		resetAt, err := directResetAt(item.window, capturedAt)
		if err != nil {
			return nil, err
		}
		entry, err := newWindowEntry(
			"",
			"",
			item.bucket,
			item.window.UsedPercent,
			item.window.WindowSeconds,
			resetAt,
		)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	if rateLimit.LimitReached != nil &&
		*rateLimit.LimitReached &&
		!containsExhaustedWindow(entries) {
		entries = append(entries, usagecore.EntryInput{
			Bucket:       "rate_limit_reached",
			Kind:         usagecore.KindWindow,
			Scope:        usagecore.ScopeAccount,
			Availability: usagecore.AvailabilityExhausted,
		})
	}
	return entries, nil
}

// legacyEntries 接受已验证旧投影，便于平滑读取合成测试和代理响应。
func legacyEntries(rateLimits legacyRateLimits) ([]usagecore.EntryInput, error) {
	var entries []usagecore.EntryInput
	for _, item := range []struct {
		bucket string
		window *legacyWindow
	}{
		{bucket: "primary", window: rateLimits.Primary},
		{bucket: "secondary", window: rateLimits.Secondary},
	} {
		if item.window == nil {
			continue
		}
		windowSeconds, err := minutesToSeconds(item.window.WindowMins)
		if err != nil {
			return nil, err
		}
		entry, err := newWindowEntry(
			"",
			"",
			item.bucket,
			item.window.UsedPercent,
			windowSeconds,
			unixSeconds(item.window.ResetSeconds),
		)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

// newWindowEntry 把使用百分比转换为整数剩余基点。
func newWindowEntry(
	limitID string,
	limitName string,
	bucket string,
	usedPercent *float64,
	windowSeconds *int64,
	resetAt time.Time,
) (usagecore.EntryInput, error) {
	entry := usagecore.EntryInput{
		LimitID:      limitID,
		LimitName:    limitName,
		Bucket:       bucket,
		Kind:         usagecore.KindWindow,
		Scope:        usagecore.ScopeAccount,
		Availability: usagecore.AvailabilityUnknown,
		ResetAt:      resetAt,
	}
	if windowSeconds != nil {
		if *windowSeconds <= 0 {
			return usagecore.EntryInput{}, ErrInvalidResponse
		}
		entry.WindowSeconds = *windowSeconds
	}
	if usedPercent != nil {
		if math.IsNaN(*usedPercent) ||
			math.IsInf(*usedPercent, 0) ||
			*usedPercent < 0 ||
			*usedPercent > 100 {
			return usagecore.EntryInput{}, ErrInvalidResponse
		}
		remaining := uint16(math.Round((100 - *usedPercent) * 100))
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

// directResetAt 优先使用绝对时间，否则以采集时间计算相对恢复秒数。
func directResetAt(
	window *directWindow,
	capturedAt time.Time,
) (time.Time, error) {
	if window.ResetAtSeconds != nil {
		return unixSeconds(window.ResetAtSeconds), nil
	}
	if window.ResetAfterSeconds == nil {
		return time.Time{}, nil
	}
	if *window.ResetAfterSeconds < 0 ||
		*window.ResetAfterSeconds > math.MaxInt64/int64(time.Second) {
		return time.Time{}, ErrInvalidResponse
	}
	resetAt := capturedAt.Add(time.Duration(*window.ResetAfterSeconds) * time.Second)
	if resetAt.Year() > 9999 {
		return time.Time{}, ErrInvalidResponse
	}
	return resetAt, nil
}

// minutesToSeconds 安全转换官方分钟窗口。
func minutesToSeconds(minutes *int64) (*int64, error) {
	if minutes == nil {
		return nil, nil
	}
	if *minutes <= 0 || *minutes > math.MaxInt64/60 {
		return nil, ErrInvalidResponse
	}
	seconds := *minutes * 60
	return &seconds, nil
}

// unixSeconds 把可选 Unix 秒转换为 UTC 时间。
func unixSeconds(value *int64) time.Time {
	if value == nil {
		return time.Time{}
	}
	return time.Unix(*value, 0).UTC()
}

// optionalString 读取可选 JSON 字符串。
func optionalString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// containsExhaustedWindow 判断显式窗口是否已经表达阻塞。
func containsExhaustedWindow(entries []usagecore.EntryInput) bool {
	for _, entry := range entries {
		if entry.Kind == usagecore.KindWindow &&
			entry.Availability == usagecore.AvailabilityExhausted {
			return true
		}
	}
	return false
}
