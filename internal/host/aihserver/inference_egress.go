package aihserver

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/core/inference"
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
)

// inferenceEgressResolver 把账号出口绑定投影到 Canonical 上游调用。
type inferenceEgressResolver struct {
	manager *runtimeegress.Manager
}

func (resolver inferenceEgressResolver) ResolveAccountProxy(
	ctx context.Context,
	provider inference.ProviderID,
	accountRef string,
) (string, bool, error) {
	if resolver.manager == nil || strings.TrimSpace(accountRef) == "" {
		return "", false, nil
	}
	result, err := resolver.manager.ResolveAccountEgress(ctx, runtimeegress.ResolveAccountEgressOptions{
		Provider:   strings.ToLower(string(provider)),
		AccountRef: strings.TrimSpace(accountRef),
		SkipProbe:  true,
	})
	if err != nil {
		return "", true, err
	}
	if !result.Bound || result.Direct {
		return "", false, nil
	}
	if !result.OK {
		detail := strings.TrimSpace(result.Reason)
		if detail == "" {
			detail = strings.TrimSpace(result.Error)
		}
		if detail == "" {
			detail = "account_egress_unavailable"
		}
		return "", true, fmt.Errorf("%s: %s", result.Error, detail)
	}
	proxyURL := strings.TrimSpace(result.ProxyServer)
	if proxyURL == "" {
		return "", true, errors.New("account_egress_proxy_missing")
	}
	return proxyURL, true, nil
}

// egressAwareInferenceClient 按请求 Context 中的账号出口 URL 选择上游代理。
// 没有出口约束时完全复用原客户端，保持测试注入与连接池语义。
type egressAwareInferenceClient struct {
	base       InferenceHTTPClient
	mu         sync.Mutex
	transports map[string]InferenceHTTPClient
}

func newEgressAwareInferenceClient(base InferenceHTTPClient) InferenceHTTPClient {
	if base == nil {
		return nil
	}
	return &egressAwareInferenceClient{base: base, transports: map[string]InferenceHTTPClient{}}
}

func (client *egressAwareInferenceClient) Do(request *http.Request) (*http.Response, error) {
	proxyURL := inferencegateway.AccountProxyURL(request.Context())
	if proxyURL == "" {
		return client.base.Do(request)
	}
	return client.clientFor(proxyURL).Do(request)
}

func (client *egressAwareInferenceClient) clientFor(proxyURL string) InferenceHTTPClient {
	client.mu.Lock()
	defer client.mu.Unlock()
	if existing := client.transports[proxyURL]; existing != nil {
		return existing
	}
	parsed, err := url.Parse(proxyURL)
	if err != nil {
		// 非法出口 URL 交给 base 处理会绕过代理；这里显式失败关闭。
		client.transports[proxyURL] = failingHTTPClient{err: err}
		return client.transports[proxyURL]
	}
	transport := newUpstreamTransport()
	transport.Proxy = http.ProxyURL(parsed)
	wrapped := &http.Client{
		Transport:     wrapOutboundTransport(transport),
		Timeout:       inferenceHTTPTimeout,
		CheckRedirect: rejectOAuthRedirect,
	}
	client.transports[proxyURL] = wrapped
	return wrapped
}

type failingHTTPClient struct{ err error }

func (client failingHTTPClient) Do(*http.Request) (*http.Response, error) { return nil, client.err }
