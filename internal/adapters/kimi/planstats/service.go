// Package planstats 读取 kimi 套餐配额（kimi.com 订阅控制台「My Quota」的数据面）。
//
// 数据源是桌面端托管扫码拿到的 kimi.com web session（见 desktopsession）；kimi-code
// CLI 的 OAuth token 对这些接口一律 401。走官方 Connect RPC：
//
//	POST {base}/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats
//	POST {base}/kimi.gateway.membership.v2.MembershipService/GetSubscription
//
// GetSubscriptionStats 返回 5h/7d 限时窗口、月度订阅额度（amount_used_ratio 总量 +
// kimi_code_used_ratio 其中 Code 部分）、gift_balances 与 notice/overdrawn。
// GetSubscription 补充套餐名、有效期与重置日。proto3 JSON 省略零值字段：ratio 缺失
// 即 0，对象缺失即未启用——归一化按 Node lib/server/kimi-plan-stats.js 逐字段对齐。
package planstats

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// ProviderID 是本包唯一服务的 Provider。
	ProviderID = "kimi"
	// DefaultBaseURL 与 Node DEFAULT_STATS_BASE_URL 同值。
	DefaultBaseURL = "https://www.kimi.com/apiv2"
	// DefaultTimeout 与 Node DEFAULT_TIMEOUT_MS（10s）一致。
	DefaultTimeout = 10 * time.Second
	// DefaultCacheTTL 与 Node STATS_CACHE_TTL_MS 一致。
	DefaultCacheTTL = 30 * time.Second
	// membershipService 是官方 Connect RPC 服务名。
	membershipService = "kimi.gateway.membership.v2.MembershipService"
	// maxResponseBytes 约束上游响应。
	maxResponseBytes = 1 << 20
)

// ErrInvalidDependencies 表示 Service 缺少 token 源或传输。
var ErrInvalidDependencies = errors.New("kimi 套餐统计依赖无效")

// Error 是带稳定错误码的领域失败（code 与 Node 响应里的 error 字段同值）。
type Error struct {
	Code   string
	Detail string
}

// Error 输出 code 或 code: detail。
func (err *Error) Error() string {
	if err == nil {
		return ""
	}
	if strings.TrimSpace(err.Detail) == "" {
		return err.Code
	}
	return err.Code + ": " + err.Detail
}

// ErrorCode 让上层按稳定错误码分支，不必依赖文案。
func (err *Error) ErrorCode() string {
	if err == nil {
		return ""
	}
	return err.Code
}

// HTTPClient 是 Membership RPC 的唯一传输端口。
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// TransportResolver 按账号解析出口；nil 表示没有绑定（用默认客户端）。
type TransportResolver func(ctx context.Context, accountRef string) (HTTPClient, error)

// TokenSource 提供桌面端 web accessToken（由 desktopsession.Service 实现）。
type TokenSource interface {
	EnsureAccessToken(ctx context.Context, accountRef string) (string, error)
	ForceRefresh(ctx context.Context, accountRef string) (string, error)
}

// Options 是可注入的端点与时钟参数。
type Options struct {
	BaseURL    string
	HTTPClient HTTPClient
	Transport  TransportResolver
	Timeout    time.Duration
	CacheTTL   time.Duration
	Now        func() time.Time
}

// Service 是套餐统计用例层；成功结果按账号短缓存。
type Service struct {
	tokens    TokenSource
	client    HTTPClient
	transport TransportResolver
	baseURL   string
	timeout   time.Duration
	cacheTTL  time.Duration
	now       func() time.Time

	mu    sync.Mutex
	cache map[string]cacheEntry
}

type cacheEntry struct {
	atMS  int64
	stats Stats
}

// Result 是一次读取的结论；Cached=true 表示命中短缓存。
type Result struct {
	Stats  Stats
	Cached bool
}

// New 创建生产可用的 Service。
func New(tokens TokenSource, options Options) (*Service, error) {
	if tokens == nil {
		return nil, ErrInvalidDependencies
	}
	baseURL := strings.TrimRight(strings.TrimSpace(options.BaseURL), "/")
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	cacheTTL := options.CacheTTL
	if cacheTTL <= 0 {
		cacheTTL = DefaultCacheTTL
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Service{
		tokens:    tokens,
		client:    client,
		transport: options.Transport,
		baseURL:   baseURL,
		timeout:   timeout,
		cacheTTL:  cacheTTL,
		now:       now,
		cache:     make(map[string]cacheEntry),
	}, nil
}

// Fetch 读取账号套餐统计；refresh=true 跳过缓存。
func (service *Service) Fetch(ctx context.Context, accountRef string, refresh bool) (Result, error) {
	normalizedRef := strings.TrimSpace(accountRef)
	nowMS := service.now().UnixMilli()
	if !refresh {
		service.mu.Lock()
		entry, found := service.cache[normalizedRef]
		service.mu.Unlock()
		if found && nowMS-entry.atMS < service.cacheTTL.Milliseconds() {
			return Result{Stats: entry.stats, Cached: true}, nil
		}
	}

	token, err := service.tokens.EnsureAccessToken(ctx, normalizedRef)
	if err != nil {
		return Result{}, err
	}

	client, err := service.resolveClient(ctx, normalizedRef)
	if err != nil {
		return Result{}, &Error{
			Code:   "account_egress_unavailable",
			Detail: truncate(err.Error(), 120),
		}
	}

	status, payload, err := service.callMembership(ctx, client, "GetSubscriptionStats", token)
	if err != nil {
		return Result{}, &Error{Code: "plan_stats_exception", Detail: truncate(err.Error(), 120)}
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		refreshed, refreshErr := service.tokens.ForceRefresh(ctx, normalizedRef)
		if refreshErr != nil {
			return Result{}, refreshErr
		}
		token = refreshed
		status, payload, err = service.callMembership(ctx, client, "GetSubscriptionStats", token)
		if err != nil {
			return Result{}, &Error{Code: "plan_stats_exception", Detail: truncate(err.Error(), 120)}
		}
	}
	if status != http.StatusOK || payload == nil {
		return Result{}, &Error{Code: fmt.Sprintf("kimi_plan_stats_http_%s", statusText(status))}
	}
	stats := normalizeSubscriptionStats(payload, nowMS)

	// GetSubscription 只补充套餐名/有效期，失败不影响主数据。
	subStatus, subPayload, subErr := service.callMembership(ctx, client, "GetSubscription", token)
	if subErr == nil && subStatus == http.StatusOK {
		stats.Plan = normalizeSubscription(subPayload)
	} else {
		stats.Plan = nil
	}

	service.mu.Lock()
	service.cache[normalizedRef] = cacheEntry{atMS: nowMS, stats: stats}
	service.mu.Unlock()
	return Result{Stats: stats}, nil
}

// resolveClient 解析账号级出口；未绑定返回默认客户端。
func (service *Service) resolveClient(ctx context.Context, accountRef string) (HTTPClient, error) {
	if service.transport == nil {
		return service.client, nil
	}
	resolved, err := service.transport(ctx, accountRef)
	if err != nil {
		return nil, err
	}
	if resolved == nil {
		return service.client, nil
	}
	return resolved, nil
}

// callMembership 发一次 Membership RPC，返回状态码与解析后的对象。
func (service *Service) callMembership(
	ctx context.Context,
	client HTTPClient,
	method string,
	accessToken string,
) (int, map[string]any, error) {
	requestCtx, cancel := context.WithTimeout(ctx, service.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestCtx,
		http.MethodPost,
		service.baseURL+"/"+membershipService+"/"+method,
		strings.NewReader("{}"),
	)
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("x-msh-platform", "web")
	response, err := client.Do(request)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return 0, nil, ctxErr
		}
		return 0, nil, err
	}
	if response == nil || response.Body == nil {
		return 0, nil, errors.New("empty membership response")
	}
	defer func() {
		_ = response.Body.Close()
	}()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if readErr != nil || len(raw) > maxResponseBytes {
		return response.StatusCode, nil, readErr
	}
	object, ok := decodeObject(raw)
	if !ok {
		return response.StatusCode, nil, nil
	}
	return response.StatusCode, object, nil
}

// decodeObject 解析 JSON 对象；数组按空对象处理（Node typeof [] === 'object'）。
func decodeObject(body []byte) (map[string]any, bool) {
	if len(bytes.TrimSpace(body)) == 0 {
		return nil, false
	}
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return nil, false
	}
	switch typed := value.(type) {
	case map[string]any:
		return typed, true
	case []any:
		return map[string]any{}, true
	default:
		return nil, false
	}
}

// statusText 把状态码归一成 Node 文案片段；0 表示没有响应。
func statusText(status int) string {
	if status <= 0 {
		return "unknown"
	}
	return strconv.Itoa(status)
}

// truncate 截断排查文本。
func truncate(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
