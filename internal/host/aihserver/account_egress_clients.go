package aihserver

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/accountegress"
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
)

// accountEgressClients 把账号出口绑定解析成可复用的 HTTP 客户端。
//
// Canonical 走 Context 注入代理；需要"直接拿客户端"的调用方（Relay、
// Image Studio、额度/刷新）共用这一份解析与连接池，避免各自重写 mode 判断
// 与 direct 语义。
type accountEgressClients struct {
	manager func() *runtimeegress.Manager
	timeout time.Duration

	mu      sync.Mutex
	clients map[string]*http.Client
}

func newAccountEgressClients(manager func() *runtimeegress.Manager, timeout time.Duration) *accountEgressClients {
	return &accountEgressClients{
		manager: manager,
		timeout: timeout,
		clients: make(map[string]*http.Client),
	}
}

// managerAccountEgress 把 accountEgressClients 暴露成应用层端口。
type managerAccountEgress struct {
	clients *accountEgressClients
}

func (resolver managerAccountEgress) ResolveAccountEgress(
	ctx context.Context,
	provider string,
	accountRef string,
) (accountegress.Decision, error) {
	return resolver.clients.decisionForAccount(ctx, provider, accountRef)
}

// decisionForAccount 返回账号的出口决策；Bound=false 表示未绑定。
func (resolver *accountEgressClients) decisionForAccount(
	ctx context.Context,
	provider string,
	accountRef string,
) (accountegress.Decision, error) {
	if resolver == nil || resolver.manager == nil {
		return accountegress.Decision{}, nil
	}
	manager := resolver.manager()
	if manager == nil {
		return accountegress.Decision{}, nil
	}
	result, err := manager.ResolveAccountEgress(ctx, runtimeegress.ResolveAccountEgressOptions{
		Provider:   strings.ToLower(strings.TrimSpace(provider)),
		AccountRef: strings.TrimSpace(accountRef),
		SkipProbe:  true,
	})
	if err != nil {
		return accountegress.Decision{Bound: true}, err
	}
	if !result.Bound {
		return accountegress.Decision{}, nil
	}
	if result.Direct {
		return accountegress.Decision{Bound: true, Direct: true}, nil
	}
	if !result.OK {
		code := strings.TrimSpace(result.Error)
		if code == "" {
			code = "account_egress_unavailable"
		}
		detail := strings.TrimSpace(result.Reason)
		if detail == "" {
			detail = code
		}
		return accountegress.Decision{Bound: true}, fmt.Errorf("%s: %s", code, detail)
	}
	proxyURL := strings.TrimSpace(result.ProxyServer)
	if proxyURL == "" {
		return accountegress.Decision{Bound: true}, errors.New("account_egress_proxy_missing")
	}
	return accountegress.Decision{Bound: true, ProxyURL: proxyURL}, nil
}

// clientForAccount 返回账号绑定对应的客户端；bound=false 表示未绑定。
func (resolver *accountEgressClients) clientForAccount(
	ctx context.Context,
	provider string,
	accountRef string,
) (*http.Client, bool, error) {
	decision, err := resolver.decisionForAccount(ctx, provider, accountRef)
	if err != nil {
		return nil, decision.Bound, err
	}
	if !decision.Bound {
		return nil, false, nil
	}
	return resolver.clientForDecision(decision), true, nil
}

func (resolver *accountEgressClients) clientForDecision(decision accountegress.Decision) *http.Client {
	if decision.Direct {
		return resolver.cachedClient("direct", "")
	}
	return resolver.cachedClient(decision.ProxyURL, decision.ProxyURL)
}

// cachedClient 按出口复用连接池；池车道地址变化时旧条目会被有界淘汰。
func (resolver *accountEgressClients) cachedClient(key, proxyURL string) *http.Client {
	resolver.mu.Lock()
	defer resolver.mu.Unlock()
	if client := resolver.clients[key]; client != nil {
		return client
	}
	if len(resolver.clients) >= 64 {
		for existingKey, existing := range resolver.clients {
			existing.CloseIdleConnections()
			delete(resolver.clients, existingKey)
		}
	}
	client := newOAuthEgressClient(proxyURL, resolver.timeout)
	resolver.clients[key] = client
	return client
}

// egressContextTransport 让一个 *http.Client 按请求 Context 里的出口决策
// 选择连接池；没有决策时完全沿用原传输（环境代理等）。
type egressContextTransport struct {
	base    http.RoundTripper
	clients *accountEgressClients
}

func (transport *egressContextTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if decision, ok := accountegress.DecisionFromContext(request.Context()); ok && decision.Bound {
		if client := transport.clients.clientForDecision(decision); client != nil {
			if pooled, ok := client.Transport.(*http.Transport); ok {
				return pooled.RoundTrip(request)
			}
		}
	}
	if transport.base == nil {
		return http.DefaultTransport.RoundTrip(request)
	}
	return transport.base.RoundTrip(request)
}

// egressContextClient 让只依赖 Do 的额度客户端按 Context 决策切换出口。
type egressContextClient struct {
	base    UsageHTTPClient
	clients *accountEgressClients
}

func newEgressContextClient(base UsageHTTPClient, clients *accountEgressClients) UsageHTTPClient {
	if base == nil {
		base = http.DefaultClient
	}
	return &egressContextClient{base: base, clients: clients}
}

func (client *egressContextClient) Do(request *http.Request) (*http.Response, error) {
	if decision, ok := accountegress.DecisionFromContext(request.Context()); ok && decision.Bound {
		if egress := client.clients.clientForDecision(decision); egress != nil {
			return egress.Do(request)
		}
	}
	return client.base.Do(request)
}
