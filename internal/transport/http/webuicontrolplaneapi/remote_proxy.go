package webuicontrolplaneapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	// TargetServerHeader 指定当前 WebUI 请求要透明代理到的远端 AIH Server Profile ID。
	TargetServerHeader = "X-Aih-Server-Id"
	// targetServerQueryParam 兼容 URL 查询参数形式的远端目标标识。
	targetServerQueryParam = "x-aih-server-id"
	// ProxyHopHeader 标记跨 AIH Server 代理跳数，阻断配置环路。
	ProxyHopHeader = "X-Aih-Proxy-Hops"
	// ManagementKeyRotationPath 是远端密钥轮换接口路径；轮换成功后需原子回写本地 profile 凭据。
	ManagementKeyRotationPath = "/v0/webui/server-config/management-key/rotate"

	defaultMaxGetAttempts  = 3
	defaultRetryBaseDelay  = 250 * time.Millisecond
	maxProxyHops           = 2
	maxRotationBodyBytes   = 64 * 1024
)

// RemoteProxyOptions 配置跨控制面节点的透明流式代理。
type RemoteProxyOptions struct {
	AIHomeDir      string
	Transport      http.RoundTripper
	MaxGetAttempts int
	RetryBaseDelay time.Duration
}

// RemoteProxy 将携带 X-Aih-Server-Id 的 /v0/webui/* 请求零缓冲流式转发到对应远端 Server：
//   - 基于共享 profileCache 做 O(1) 内存目标解析；
//   - 请求体、SSE 事件流、二进制附件与 WebSocket 升级全程流式透传（FlushInterval = -1），零整包缓冲；
//   - 远端执行 Management Key 轮换成功后自动把新密钥写回本地 app-state.db 与内存缓存。
type RemoteProxy struct {
	cache          *profileCache
	transport      http.RoundTripper
	maxGetAttempts int
	retryBaseDelay time.Duration
}

type proxyTargetContextKey struct{}

type resolvedProxyTarget struct {
	profile    RemoteProfile
	targetURL  *url.URL
	nextHops   int
	isRotation bool
}

type credentialSyncError struct {
	cause error
}

func (e *credentialSyncError) Error() string {
	if e == nil || e.cause == nil {
		return "server_proxy_credential_sync_failed"
	}
	return e.cause.Error()
}

// NewRemoteProxy 创建独立缓存的远端控制面代理组件。
func NewRemoteProxy(options RemoteProxyOptions) (*RemoteProxy, error) {
	home := strings.TrimSpace(options.AIHomeDir)
	if home == "" {
		return nil, ErrInvalidDependencies
	}
	return newRemoteProxyWithCache(newProfileCache(home), options), nil
}

// NewRemoteProxy 复用当前 Handler 的内存 profileCache 创建远端代理组件，写操作零延迟联动。
func (handler *Handler) NewRemoteProxy(options RemoteProxyOptions) (*RemoteProxy, error) {
	if handler == nil || handler.cache == nil {
		return nil, ErrInvalidDependencies
	}
	return newRemoteProxyWithCache(handler.cache, options), nil
}

func newRemoteProxyWithCache(cache *profileCache, options RemoteProxyOptions) *RemoteProxy {
	maxAttempts := options.MaxGetAttempts
	if maxAttempts <= 0 {
		maxAttempts = defaultMaxGetAttempts
	}
	baseDelay := options.RetryBaseDelay
	if baseDelay <= 0 {
		baseDelay = defaultRetryBaseDelay
	}
	baseTransport := options.Transport
	if baseTransport == nil {
		// 独立连接池：禁止类型断言 http.DefaultTransport（宿主启动期会替换它）。
		baseTransport = &http.Transport{
			Proxy:                 nil,
			DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          128,
			MaxIdleConnsPerHost:   32,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		}
	}
	return &RemoteProxy{
		cache:          cache,
		transport:      &retryingRoundTripper{base: baseTransport, maxGetAttempts: maxAttempts, baseDelay: baseDelay},
		maxGetAttempts: maxAttempts,
		retryBaseDelay: baseDelay,
	}
}

// Wrap 返回正交的 HTTP 中间件：未指定远端节点或命中本机自身时零拷贝放行给本地处理器。
func (proxy *RemoteProxy) Wrap(next http.Handler) http.Handler {
	if next == nil {
		next = http.NotFoundHandler()
	}
	if proxy == nil {
		return next
	}
	reverseProxy := &httputil.ReverseProxy{
		Transport:      proxy.transport,
		FlushInterval:  -1,
		Rewrite:        proxy.rewriteProxyRequest,
		ModifyResponse: proxy.modifyProxyResponse,
		ErrorHandler:   proxy.handleProxyError,
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if isAlwaysLocalControlPlanePath(request.URL.Path) {
			next.ServeHTTP(response, request)
			return
		}
		serverID, err := extractTargetServerID(request)
		if err != nil {
			writeProxyJSON(response, http.StatusBadRequest, map[string]any{
				"ok": false, "error": "server_proxy_invalid_query",
			})
			return
		}
		if serverID == "" {
			next.ServeHTTP(response, request)
			return
		}
		hops := parseProxyHops(request.Header.Get(ProxyHopHeader))
		if hops >= maxProxyHops {
			writeProxyJSON(response, http.StatusLoopDetected, map[string]any{
				"ok":        false,
				"error":     "server_proxy_loop_detected",
				"profileId": serverID,
			})
			return
		}

		profile, found, err := proxy.cache.Lookup(request.Context(), serverID)
		if err != nil {
			writeProxyJSON(response, http.StatusServiceUnavailable, map[string]any{
				"ok":        false,
				"error":     "control_plane_profile_read_failed",
				"profileId": serverID,
			})
			return
		}
		if !found || strings.TrimSpace(profile.Endpoint) == "" {
			writeProxyJSON(response, http.StatusNotFound, map[string]any{
				"ok":        false,
				"error":     "server_proxy_profile_not_found",
				"profileId": serverID,
			})
			return
		}

		targetURL, err := url.Parse(strings.TrimRight(profile.Endpoint, "/"))
		if err != nil || targetURL == nil || targetURL.Host == "" {
			writeProxyJSON(response, http.StatusNotFound, map[string]any{
				"ok":        false,
				"error":     "server_proxy_profile_not_found",
				"profileId": serverID,
			})
			return
		}
		targetOrigin := normalizeCompareOrigin(targetURL)
		if targetOrigin == "" {
			writeProxyJSON(response, http.StatusNotFound, map[string]any{
				"ok": false, "error": "server_proxy_profile_not_found", "profileId": serverID,
			})
			return
		}
		selfOrigin := inferSelfCompareOrigin(request)
		if targetOrigin == selfOrigin {
			localRequest := request.Clone(request.Context())
			localRequest.Header.Del(TargetServerHeader)
			query := localRequest.URL.Query()
			for key := range query {
				if strings.EqualFold(key, targetServerQueryParam) {
					query.Del(key)
				}
			}
			localRequest.URL.RawQuery = query.Encode()
			next.ServeHTTP(response, localRequest)
			return
		}

		resolved := &resolvedProxyTarget{
			profile:    profile,
			targetURL:  targetURL,
			nextHops:   hops + 1,
			isRotation: request.Method == http.MethodPost && request.URL.Path == ManagementKeyRotationPath,
		}
		ctx := context.WithValue(request.Context(), proxyTargetContextKey{}, resolved)
		reverseProxy.ServeHTTP(response, request.WithContext(ctx))
	})
}

func (proxy *RemoteProxy) rewriteProxyRequest(pr *httputil.ProxyRequest) {
	resolved, _ := pr.In.Context().Value(proxyTargetContextKey{}).(*resolvedProxyTarget)
	if resolved == nil {
		return
	}
	if priorXFF := pr.In.Header.Values("X-Forwarded-For"); len(priorXFF) > 0 {
		pr.Out.Header["X-Forwarded-For"] = append([]string(nil), priorXFF...)
	}
	pr.SetXForwarded()
	if strings.TrimSpace(pr.Out.Header.Get("X-Forwarded-For")) == "" {
		if host, _, err := net.SplitHostPort(strings.TrimSpace(pr.In.RemoteAddr)); err == nil && host != "" {
			pr.Out.Header.Set("X-Forwarded-For", host)
		} else if raw := strings.TrimSpace(pr.In.RemoteAddr); raw != "" {
			pr.Out.Header.Set("X-Forwarded-For", raw)
		}
	}

	pr.SetURL(resolved.targetURL)
	pr.Out.Host = resolved.targetURL.Host

	// 剥离目标标识头与查询参数，避免远端再次代理或误判。
	pr.Out.Header.Del(TargetServerHeader)
	pr.Out.Header.Set(ProxyHopHeader, strconv.Itoa(resolved.nextHops))
	if pr.Out.URL.RawQuery != "" {
		query := pr.Out.URL.Query()
		for key := range query {
			if strings.EqualFold(key, targetServerQueryParam) {
				query.Del(key)
			}
		}
		pr.Out.URL.RawQuery = query.Encode()
	}

	if strings.TrimSpace(resolved.profile.ManagementKey) != "" {
		pr.Out.Header.Set("Authorization", "Bearer "+strings.TrimSpace(resolved.profile.ManagementKey))
	} else {
		pr.Out.Header.Del("Authorization")
	}

	if strings.TrimSpace(pr.Out.Header.Get("Accept")) == "" && !isWebSocketUpgrade(pr.In) {
		pr.Out.Header.Set("Accept", "application/json")
	}
	// 密钥轮换响应需要解析 JSON 回写本地凭据，禁用上游压缩以保证解码确定性。
	if resolved.isRotation {
		pr.Out.Header.Del("Accept-Encoding")
	}
}

func (proxy *RemoteProxy) modifyProxyResponse(resp *http.Response) error {
	if resp == nil || resp.Request == nil {
		return nil
	}
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(contentType, "text/event-stream") {
		resp.Header.Set("Cache-Control", "no-cache, no-transform")
		resp.Header.Set("X-Accel-Buffering", "no")
		return nil
	}

	resolved, _ := resp.Request.Context().Value(proxyTargetContextKey{}).(*resolvedProxyTarget)
	if resolved == nil || !resolved.isRotation {
		return nil
	}
	resp.Header.Set("Cache-Control", "no-store")
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxRotationBodyBytes))
	_ = resp.Body.Close()
	if err != nil {
		return &credentialSyncError{cause: err}
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return &credentialSyncError{cause: err}
	}
	rotatedKey := text(payload["managementKey"], 4096)
	if rotatedKey == "" {
		return &credentialSyncError{cause: errors.New("invalid_proxy_management_key_rotation_payload")}
	}
	if err := proxy.syncRotatedCredential(resp.Request.Context(), resolved.profile, rotatedKey); err != nil {
		return &credentialSyncError{cause: err}
	}

	resp.Body = io.NopCloser(bytes.NewReader(raw))
	resp.ContentLength = int64(len(raw))
	resp.Header.Set("Content-Length", strconv.Itoa(len(raw)))
	return nil
}

func (proxy *RemoteProxy) syncRotatedCredential(ctx context.Context, target RemoteProfile, managementKey string) error {
	saveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()

	updatedRaw := cloneMapShallowOrJSON(target.Raw)
	updatedRaw["id"] = target.ID
	updatedRaw["endpoint"] = target.Endpoint
	updatedRaw["managementKey"] = managementKey
	updatedRaw["updatedAt"] = nowMS()

	return proxy.cache.UpdateStore(saveCtx, func(store map[string]any) (map[string]any, error) {
		next, _, err := saveProfileInStore(store, updatedRaw, map[string]any{})
		return next, err
	})
}

func (proxy *RemoteProxy) handleProxyError(response http.ResponseWriter, request *http.Request, err error) {
	if errors.Is(err, context.Canceled) && request.Context().Err() != nil {
		return
	}
	var syncErr *credentialSyncError
	if errors.As(err, &syncErr) {
		writeProxyJSON(response, http.StatusBadGateway, map[string]any{
			"ok":      false,
			"error":   "server_proxy_credential_sync_failed",
			"message": "远程 Server 已轮换 Management Key，但本地代理凭据保存失败。",
		})
		return
	}
	message := "fetch failed"
	if err != nil && strings.TrimSpace(err.Error()) != "" {
		message = err.Error()
	}
	writeProxyJSON(response, http.StatusBadGateway, map[string]any{
		"ok":        false,
		"error":     "server_proxy_upstream_failed",
		"message":   message,
		"retryable": true,
	})
}

// retryingRoundTripper 仅对幂等无请求体的 GET/HEAD 在网络建连失败时做指数/线性退避重试。
type retryingRoundTripper struct {
	base           http.RoundTripper
	maxGetAttempts int
	baseDelay      time.Duration
}

func (rt *retryingRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	isIdempotent := (request.Method == http.MethodGet || request.Method == http.MethodHead) && !isWebSocketUpgrade(request)
	attempts := 1
	if isIdempotent && rt.maxGetAttempts > 1 {
		attempts = rt.maxGetAttempts
	}
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		if err := request.Context().Err(); err != nil {
			return nil, err
		}
		reqAttempt := request
		if attempt > 1 {
			reqAttempt = request.Clone(request.Context())
		}
		resp, err := rt.base.RoundTrip(reqAttempt)
		if err == nil {
			return resp, nil
		}
		lastErr = err
		if attempt >= attempts || request.Context().Err() != nil {
			break
		}
		timer := time.NewTimer(rt.baseDelay * time.Duration(attempt))
		select {
		case <-request.Context().Done():
			timer.Stop()
			return nil, request.Context().Err()
		case <-timer.C:
		}
	}
	return nil, lastErr
}

func extractTargetServerID(request *http.Request) (string, error) {
	if request == nil {
		return "", nil
	}
	var query url.Values
	if request.URL != nil {
		var err error
		query, err = url.ParseQuery(request.URL.RawQuery)
		if err != nil {
			return "", err
		}
	}
	if headerVal := strings.TrimSpace(request.Header.Get(TargetServerHeader)); headerVal != "" {
		return headerVal, nil
	}
	for key, values := range query {
		if strings.EqualFold(key, targetServerQueryParam) && len(values) > 0 {
			if trimmed := strings.TrimSpace(values[0]); trimmed != "" {
				return trimmed, nil
			}
		}
	}
	return "", nil
}

// isAlwaysLocalControlPlanePath 保护入口网关的 profile 目录读写、本机引导与本机窄口回调：
// 即使客户端误带 x-aih-server-id，也绝不能把「切换/删除远端节点」转发给可能已离线的远端节点。
func isAlwaysLocalControlPlanePath(requestPath string) bool {
	switch requestPath {
	case "/v0/webui/control-plane/bootstrap",
		"/v1/management/webui/control-plane/bootstrap",
		"/v0/webui/control-plane/profiles",
		"/v1/management/webui/control-plane/profiles",
		"/v0/webui/internal/approval-request",
		"/v0/webui/internal/remote-tools",
		"/v0/webui/session-events/provider-hook":
		return true
	}
	return strings.HasPrefix(requestPath, "/v0/webui/control-plane/profiles/") ||
		strings.HasPrefix(requestPath, "/v1/management/webui/control-plane/profiles/")
}

func parseProxyHops(raw string) int {
	val, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || val < 0 {
		return 0
	}
	return val
}

func isWebSocketUpgrade(request *http.Request) bool {
	return request != nil && strings.EqualFold(strings.TrimSpace(request.Header.Get("Upgrade")), "websocket")
}

func normalizeCompareOrigin(parsed *url.URL) string {
	if parsed == nil || parsed.Host == "" {
		return ""
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	host := strings.ToLower(strings.Trim(parsed.Hostname(), "[]"))
	if host == "" {
		return ""
	}
	if host == "localhost" || host == "::1" {
		host = "127.0.0.1"
	}
	port := parsed.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return fmt.Sprintf("%s://%s:%s", scheme, host, port)
}

func inferSelfCompareOrigin(request *http.Request) string {
	if request == nil {
		return ""
	}
	// Only the accepted socket can prove a self target; incoming Host and
	// forwarding headers describe caller-controlled routing, not this listener.
	host, port := localSocketHost(request), localSocketPort(request)
	if host == "" || port == 0 {
		return ""
	}
	scheme := "http"
	if request.TLS != nil {
		scheme = "https"
	}
	return normalizeCompareOrigin(&url.URL{
		Scheme: scheme,
		Host:   net.JoinHostPort(host, strconv.Itoa(port)),
	})
}

func writeProxyJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	encoder := json.NewEncoder(response)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(payload)
}
