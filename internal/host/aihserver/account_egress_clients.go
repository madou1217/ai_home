package aihserver

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
)

// accountEgressClients 把账号出口绑定解析成可复用的 HTTP 客户端。
//
// Canonical 走 Context 注入代理；需要"直接拿客户端"的调用方（Relay、
// Image Studio）共用这一份解析与连接池，避免各自重写 mode 判断与 direct 语义。
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

// clientForAccount 返回账号绑定对应的客户端；bound=false 表示未绑定。
func (resolver *accountEgressClients) clientForAccount(
	ctx context.Context,
	provider string,
	accountRef string,
) (*http.Client, bool, error) {
	if resolver == nil || resolver.manager == nil {
		return nil, false, nil
	}
	manager := resolver.manager()
	if manager == nil {
		return nil, false, nil
	}
	result, err := manager.ResolveAccountEgress(ctx, runtimeegress.ResolveAccountEgressOptions{
		Provider:   strings.ToLower(strings.TrimSpace(provider)),
		AccountRef: strings.TrimSpace(accountRef),
		SkipProbe:  true,
	})
	if err != nil {
		return nil, true, err
	}
	if !result.Bound {
		return nil, false, nil
	}
	if result.Direct {
		return resolver.cachedClient("direct", ""), true, nil
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
		return nil, true, fmt.Errorf("%s: %s", code, detail)
	}
	proxyURL := strings.TrimSpace(result.ProxyServer)
	if proxyURL == "" {
		return nil, true, errors.New("account_egress_proxy_missing")
	}
	return resolver.cachedClient(proxyURL, proxyURL), true, nil
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
