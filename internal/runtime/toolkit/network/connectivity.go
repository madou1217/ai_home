// Package network 实现 Toolkit 的代理诊断、系统代理/TUN 网络层探测与上游连通性测试。
//
// 对应 Node 侧 proxy-manager.js、proxy-target-plugins/*、system-proxy-plugins/*
// 以及 system-network-manager.js，并在 Go 侧维护各探测项的 SWR 缓存。
package network

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	connectivityTTL         = 60 * time.Second
	defaultConnTimeout      = 5 * time.Second
	minConnTimeout          = 250 * time.Millisecond
	maxConnTimeout          = 15 * time.Second
	maxProxyURLLength       = 2048
)

// ConnectivityTarget 描述一个上游探测目标。
type ConnectivityTarget struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	URL   string `json:"url"`
	Host  string `json:"host"`
	Group string `json:"group"`
}

// ConnectivityTargetResult 描述单个目标的连通性探测结果。
type ConnectivityTargetResult struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	URL        string  `json:"url"`
	Host       string  `json:"host"`
	Group      string  `json:"group"`
	Route      string  `json:"route"`
	ProxyUsed  *string `json:"proxyUsed"`
	Reachable  bool    `json:"reachable"`
	LatencyMs  int64   `json:"latencyMs"`
	StatusCode *int    `json:"statusCode"`
	Error      *string `json:"error"`
}

// ConnectivityConfig 指定连通性测试的路由与本地 HTTP 代理。
type ConnectivityConfig struct {
	Route    string `json:"route"`
	ProxyURL string `json:"proxyUrl"`
}

// ConnectivityResponse 是连通性测试响应（包含网络层探测与缓存状态）。
type ConnectivityResponse struct {
	OK           bool                       `json:"ok"`
	Error        string                     `json:"error,omitempty"`
	TestedAt     int64                      `json:"testedAt,omitempty"`
	Route        string                     `json:"route"`
	ProxyUsed    *string                    `json:"proxyUsed"`
	Results      []ConnectivityTargetResult `json:"results"`
	Cached       bool                       `json:"cached"`
	Stale        bool                       `json:"stale"`
	CachedAt     int64                      `json:"cachedAt"`
	NetworkLayer *NetworkLayerReport        `json:"networkLayer,omitempty"`
}

// ConnectivityRequestAdapter 允许测试替换 HTTP 探测请求。
type ConnectivityRequestAdapter func(ctx context.Context, targetURL string, route string, proxyURL string, timeout time.Duration) (int, error)

// DefaultConnectivityTargets 是内置上游 AI 与开发服务目标。
var DefaultConnectivityTargets = []ConnectivityTarget{
	{ID: "openai", Name: "OpenAI API", URL: "https://api.openai.com/v1/models", Host: "api.openai.com", Group: "ai"},
	{ID: "anthropic", Name: "Anthropic Claude API", URL: "https://api.anthropic.com/v1/messages", Host: "api.anthropic.com", Group: "ai"},
	{ID: "gemini", Name: "Google Gemini API", URL: "https://generativelanguage.googleapis.com/v1beta/models", Host: "generativelanguage.googleapis.com", Group: "ai"},
	{ID: "grok", Name: "xAI Grok API", URL: "https://api.x.ai/v1/models", Host: "api.x.ai", Group: "ai"},
	{ID: "github", Name: "GitHub", URL: "https://api.github.com", Host: "api.github.com", Group: "dev"},
	{ID: "huggingface", Name: "HuggingFace", URL: "https://huggingface.co/api/models", Host: "huggingface.co", Group: "ai"},
	{ID: "npmmirror", Name: "淘宝 npmmirror", URL: "https://registry.npmmirror.com", Host: "registry.npmmirror.com", Group: "cn"},
	{ID: "pypi_tuna", Name: "清华大学 PyPI", URL: "https://pypi.tuna.tsinghua.edu.cn", Host: "pypi.tuna.tsinghua.edu.cn", Group: "cn"},
}

type connectivityCacheEntry struct {
	at    time.Time
	value ConnectivityResponse
}

func connectivityCacheKey(cfg ConnectivityConfig) string {
	route := strings.ToLower(strings.TrimSpace(cfg.Route))
	if route == "" {
		route = "direct"
	}
	return route + "|" + strings.TrimSpace(cfg.ProxyURL)
}

// ClearConnectivityCache 清空连通性诊断缓存。
func (manager *Manager) ClearConnectivityCache() {
	manager.connMu.Lock()
	defer manager.connMu.Unlock()
	manager.connCache = make(map[string]connectivityCacheEntry)
	manager.connInFlight = make(map[string]*connectivityCall)
}

type connectivityCall struct {
	done chan struct{}
	val  ConnectivityResponse
}

// GetConnectivity 获取上游连通性（支持 60s SWR 缓存与强制刷新），并附带网络层状态。
func (manager *Manager) GetConnectivity(ctx context.Context, cfg ConnectivityConfig, forceRefresh bool) ConnectivityResponse {
	var resp ConnectivityResponse
	if forceRefresh {
		resp = manager.refreshConnectivity(ctx, cfg)
		resp.Cached = false
		resp.Stale = false
		resp.CachedAt = 0
	} else {
		key := connectivityCacheKey(cfg)
		manager.connMu.Lock()
		cached, ok := manager.connCache[key]
		if ok {
			stale := manager.now().Sub(cached.at) >= connectivityTTL
			_, alreadyRefreshing := manager.connInFlight[key]
			manager.connMu.Unlock()
			if stale && !alreadyRefreshing {
				go func() {
					bgCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
					defer cancel()
					_ = manager.refreshConnectivity(bgCtx, cfg)
				}()
			}
			resp = cached.value
			resp.Cached = true
			resp.Stale = stale
			resp.CachedAt = cached.at.UnixMilli()
		} else {
			manager.connMu.Unlock()
			resp = manager.refreshConnectivity(ctx, cfg)
			resp.Cached = false
			resp.Stale = false
			resp.CachedAt = 0
		}
	}
	layer := manager.DetectNetworkLayer(ctx, false)
	resp.NetworkLayer = &layer
	return resp
}

func (manager *Manager) refreshConnectivity(ctx context.Context, cfg ConnectivityConfig) ConnectivityResponse {
	key := connectivityCacheKey(cfg)
	manager.connMu.Lock()
	if call, exists := manager.connInFlight[key]; exists {
		manager.connMu.Unlock()
		<-call.done
		return call.val
	}
	call := &connectivityCall{done: make(chan struct{})}
	manager.connInFlight[key] = call
	manager.connMu.Unlock()

	value := manager.TestConnectivity(ctx, cfg)

	manager.connMu.Lock()
	if value.OK {
		manager.connCache[key] = connectivityCacheEntry{at: manager.now(), value: value}
	}
	delete(manager.connInFlight, key)
	call.val = value
	close(call.done)
	manager.connMu.Unlock()
	return value
}

// TestConnectivity 直接并发探测各上游目标的连通性与延迟。
func (manager *Manager) TestConnectivity(ctx context.Context, cfg ConnectivityConfig) ConnectivityResponse {
	route := strings.ToLower(strings.TrimSpace(cfg.Route))
	if route == "" {
		route = "direct"
	}
	if route != "direct" && route != "proxy" {
		return ConnectivityResponse{
			OK:      false,
			Error:   "invalid_route",
			Route:   route,
			Results: []ConnectivityTargetResult{},
		}
	}
	var proxyUsed *string
	var proxyStr string
	if route == "proxy" {
		parsedProxy := ParseProxyURL(cfg.ProxyURL, true)
		if parsedProxy == nil {
			return ConnectivityResponse{
				OK:      false,
				Error:   "invalid_local_http_proxy",
				Route:   route,
				Results: []ConnectivityTargetResult{},
			}
		}
		proxyStr = parsedProxy.String()
		proxyUsed = &proxyStr
	}

	timeout := manager.connTimeout
	if timeout <= 0 {
		timeout = defaultConnTimeout
	}
	if timeout < minConnTimeout {
		timeout = minConnTimeout
	}
	if timeout > maxConnTimeout {
		timeout = maxConnTimeout
	}

	targets := manager.connectivityTargets
	results := make([]ConnectivityTargetResult, len(targets))
	var group sync.WaitGroup
	group.Add(len(targets))
	for index, target := range targets {
		go func(idx int, tgt ConnectivityTarget) {
			defer group.Done()
			startedAt := manager.now()
			reqCtx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			statusCode, err := manager.connAdapter(reqCtx, tgt.URL, route, proxyStr, timeout)
			if err != nil {
				errMsg := err.Error()
				if errors.Is(err, context.DeadlineExceeded) || errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
					errMsg = "timeout"
				}
				results[idx] = ConnectivityTargetResult{
					ID:        tgt.ID,
					Name:      tgt.Name,
					URL:       tgt.URL,
					Host:      tgt.Host,
					Group:     tgt.Group,
					Route:     route,
					ProxyUsed: proxyUsed,
					Reachable: false,
					LatencyMs: -1,
					Error:     &errMsg,
				}
				return
			}
			var codePtr *int
			if statusCode > 0 {
				c := statusCode
				codePtr = &c
			}
			var errPtr *string
			if statusCode == 0 {
				msg := "missing_http_status"
				errPtr = &msg
			}
			results[idx] = ConnectivityTargetResult{
				ID:         tgt.ID,
				Name:       tgt.Name,
				URL:        tgt.URL,
				Host:       tgt.Host,
				Group:      tgt.Group,
				Route:      route,
				ProxyUsed:  proxyUsed,
				Reachable:  statusCode >= 100 && statusCode < 600,
				LatencyMs:  manager.now().Sub(startedAt).Milliseconds(),
				StatusCode: codePtr,
				Error:      errPtr,
			}
		}(index, target)
	}
	group.Wait()

	return ConnectivityResponse{
		OK:        true,
		TestedAt:  manager.now().UnixMilli(),
		Route:     route,
		ProxyUsed: proxyUsed,
		Results:   results,
	}
}

func defaultConnectivityRequest(ctx context.Context, targetURL string, route string, proxyURL string, timeout time.Duration) (int, error) {
	transport := &http.Transport{
		DialContext: (&net.Dialer{Timeout: timeout}).DialContext,
		Proxy:       nil,
		DisableKeepAlives: true,
	}
	if route == "proxy" && proxyURL != "" {
		parsedProxy, err := url.Parse(proxyURL)
		if err != nil {
			return 0, err
		}
		transport.Proxy = http.ProxyURL(parsedProxy)
	}
	defer transport.CloseIdleConnections()

	client := &http.Client{
		Transport: transport,
		Timeout:   timeout,
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, targetURL, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "ai-home-toolkit-connectivity/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	_ = resp.Body.Close()
	return resp.StatusCode, nil
}

// ParseProxyURL 校验并规范化代理地址；当 localHttpOnly 为 true 时仅允许本机 HTTP/HTTPS 代理。
func ParseProxyURL(raw string, localHTTPOnly bool) *url.URL {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > maxProxyURLLength {
		return nil
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.User != nil {
		return nil
	}
	scheme := strings.ToLower(parsed.Scheme)
	if localHTTPOnly {
		if scheme != "http" && scheme != "https" {
			return nil
		}
		host := strings.ToLower(parsed.Hostname())
		if host != "localhost" && host != "127.0.0.1" && host != "::1" {
			return nil
		}
		if parsed.Port() == "" {
			return nil
		}
		if (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil
		}
		return parsed
	}
	switch scheme {
	case "http", "https", "socks", "socks4", "socks5":
		if parsed.Host == "" {
			return nil
		}
		return parsed
	default:
		return nil
	}
}
