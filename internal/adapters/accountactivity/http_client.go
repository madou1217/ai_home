package accountactivity

// 账号活动/福利领取的共享 HTTP 与账号级出口代理构建器。
//
// 严格执行 fail-closed：当账号绑定了 url / system / tun / pool / direct 出口
// 且解析失败时返回 `account_egress_unavailable:<reason>`，绝不静默回落直连。
// 响应体读取带上下文硬截止，防止上游回完响应头后流卡死拖垮整批任务。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
)

const maxClaimResponseBytes = 2 * 1024 * 1024

// HTTPDoer 抽象一次 HTTP 请求执行（便于单测替换）。
type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// ClaimHTTPResponse 表示一次单步请求的结构化结果（不抛 Go error）。
type ClaimHTTPResponse struct {
	Status  int
	OK      bool
	JSON    map[string]any
	RawText string
	Error   string
}

// ResolveClaimHTTPClient 按账号出口绑定构造 HTTPDoer；失败返回 `account_egress_unavailable:<reason>`。
func ResolveClaimHTTPClient(
	ctx context.Context,
	aiHomeDir string,
	resolver *agyegress.Resolver,
	override func(ctx context.Context, provider, accountRef string) (HTTPDoer, error),
	provider string,
	accountRef string,
	timeout time.Duration,
) (HTTPDoer, string) {
	if override != nil {
		client, err := override(ctx, provider, accountRef)
		if err != nil {
			return nil, "account_egress_unavailable:" + errorMessageOrUnknown(err)
		}
		if client == nil {
			return nil, "account_egress_unavailable:client_nil"
		}
		return client, ""
	}

	if resolver == nil && strings.TrimSpace(aiHomeDir) != "" {
		resolver = agyegress.NewResolver(agyegress.Options{AIHomeDir: aiHomeDir})
	}
	if resolver != nil {
		ref, parseErr := accountcore.ParseAccountRef(strings.TrimSpace(accountRef))
		if parseErr != nil {
			return nil, "account_egress_unavailable:invalid_account_ref"
		}
		decision, err := resolver.Resolve(ctx, ref)
		if err != nil {
			return nil, "account_egress_unavailable:" + formatEgressResolveError(err)
		}
		if decision.Bound {
			proxyURL := ""
			if !decision.Target.Direct {
				proxyURL = strings.TrimSpace(decision.Target.ProxyURL)
			}
			client, buildErr := buildClaimHTTPClient(proxyURL, true, timeout)
			if buildErr != nil {
				return nil, "account_egress_unavailable:" + errorMessageOrUnknown(buildErr)
			}
			return client, ""
		}
	}

	// 未绑定账号出口：按服务端代理环境变量（AIH_SERVER_PROXY_URL → HTTPS_PROXY/HTTP_PROXY）。
	serverProxy := firstNonEmptyString(
		os.Getenv("AIH_SERVER_PROXY_URL"),
		os.Getenv("HTTPS_PROXY"),
		os.Getenv("https_proxy"),
		os.Getenv("HTTP_PROXY"),
		os.Getenv("http_proxy"),
		os.Getenv("ALL_PROXY"),
		os.Getenv("all_proxy"),
	)
	client, err := buildClaimHTTPClient(serverProxy, false, timeout)
	if err != nil {
		return nil, "account_egress_unavailable:" + errorMessageOrUnknown(err)
	}
	return client, ""
}

func formatEgressResolveError(err error) string {
	var egressErr *agyegress.Error
	if errors.As(err, &egressErr) && egressErr != nil {
		if strings.TrimSpace(egressErr.Code) != "" {
			return strings.TrimSpace(egressErr.Code)
		}
	}
	return errorMessageOrUnknown(err)
}

func errorMessageOrUnknown(err error) string {
	if err == nil {
		return "unknown"
	}
	if s := strings.TrimSpace(err.Error()); s != "" {
		return s
	}
	return "unknown"
}

func buildClaimHTTPClient(proxyURL string, explicitDirectIfEmpty bool, timeout time.Duration) (*http.Client, error) {
	var proxyFunc func(*http.Request) (*url.URL, error)
	trimmed := strings.TrimSpace(proxyURL)
	if trimmed == "" {
		if !explicitDirectIfEmpty {
			proxyFunc = http.ProxyFromEnvironment
		}
	} else {
		parsed, err := url.Parse(trimmed)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return nil, fmt.Errorf("invalid_proxy_url")
		}
		proxyFunc = http.ProxyURL(parsed)
	}
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	transport := &http.Transport{
		Proxy:                 proxyFunc,
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          16,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
	}, nil
}

// FetchClaimJSON 执行一次请求并在硬超时内读取 JSON 响应，所有传输与解析异常均收口进 Error 字段。
func FetchClaimJSON(
	ctx context.Context,
	client HTTPDoer,
	method string,
	endpoint string,
	headers map[string]string,
	body []byte,
	timeout time.Duration,
) ClaimHTTPResponse {
	if client == nil {
		return ClaimHTTPResponse{Error: "fetch_unavailable"}
	}
	if timeout < time.Second {
		timeout = time.Second
	}
	if ctx == nil {
		ctx = context.Background()
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var reader io.Reader
	if len(body) > 0 {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(reqCtx, method, endpoint, reader)
	if err != nil {
		return ClaimHTTPResponse{Error: "request_failed:" + errorMessageOrUnknown(err)}
	}
	for k, v := range headers {
		if strings.TrimSpace(k) != "" && v != "" {
			req.Header.Set(k, v)
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
			return ClaimHTTPResponse{Error: fmt.Sprintf("request_failed:fetch_body_timeout:%d", timeout.Milliseconds())}
		}
		return ClaimHTTPResponse{Error: "request_failed:" + errorMessageOrUnknown(err)}
	}
	defer func() { _ = resp.Body.Close() }()

	rawBody, readErr := io.ReadAll(io.LimitReader(resp.Body, maxClaimResponseBytes))
	if readErr != nil {
		if errors.Is(readErr, context.DeadlineExceeded) || errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
			return ClaimHTTPResponse{Error: fmt.Sprintf("request_failed:fetch_body_timeout:%d", timeout.Milliseconds())}
		}
		return ClaimHTTPResponse{Error: "request_failed:" + errorMessageOrUnknown(readErr)}
	}

	var parsed map[string]any
	if json.Unmarshal(rawBody, &parsed) != nil {
		parsed = nil
	}
	return ClaimHTTPResponse{
		Status:  resp.StatusCode,
		OK:      resp.StatusCode >= 200 && resp.StatusCode < 300,
		JSON:    parsed,
		RawText: string(rawBody),
	}
}

// ReadEnvelopeMessage 从上游业务信封读取可读错误信息。
func ReadEnvelopeMessage(payload map[string]any) string {
	if len(payload) == 0 {
		return ""
	}
	if msg := textOf(payload["msg"]); msg != "" {
		return msg
	}
	if msg := textOf(payload["message"]); msg != "" {
		return msg
	}
	if data, ok := payload["data"].(map[string]any); ok && data != nil {
		if msg := textOf(data["message"]); msg != "" {
			return msg
		}
	}
	if msg := textOf(payload["error_description"]); msg != "" {
		return msg
	}
	return textOf(payload["error"])
}

func firstNonEmptyString(values ...string) string {
	for _, v := range values {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}
