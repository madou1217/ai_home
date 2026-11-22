package aihserver

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
	claudenativerelay "github.com/madou1217/ai_home/internal/transport/http/claudenativerelay"
)

// relayAccountEgress 把账号出口绑定投影到 Claude Native Relay 的上游请求。
//
// Relay 与 Canonical 共用同一份 Manager 解析；区别只在交付形式：Canonical 把
// 代理写进 Context 交给 egress-aware 客户端，Relay 需要直接拿到 HTTP 客户端。
// direct 绑定返回不带 Proxy 的客户端，确保它真的绕开进程环境代理。
type relayAccountEgress struct {
	manager func() *runtimeegress.Manager
	timeout time.Duration

	mu      sync.Mutex
	clients map[string]claudenativerelay.HTTPClient
}

func newRelayAccountEgress(manager func() *runtimeegress.Manager, timeout time.Duration) *relayAccountEgress {
	return &relayAccountEgress{
		manager: manager,
		timeout: timeout,
		clients: make(map[string]claudenativerelay.HTTPClient),
	}
}

// ClientForAccount 返回账号绑定对应的客户端；bound=false 表示未绑定。
func (resolver *relayAccountEgress) ClientForAccount(
	ctx context.Context,
	provider string,
	accountRef string,
) (claudenativerelay.HTTPClient, bool, error) {
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
func (resolver *relayAccountEgress) cachedClient(key, proxyURL string) claudenativerelay.HTTPClient {
	resolver.mu.Lock()
	defer resolver.mu.Unlock()
	if client := resolver.clients[key]; client != nil {
		return client
	}
	if len(resolver.clients) >= 64 {
		for existingKey, existing := range resolver.clients {
			if httpClient, ok := existing.(interface{ CloseIdleConnections() }); ok {
				httpClient.CloseIdleConnections()
			}
			delete(resolver.clients, existingKey)
		}
	}
	client := newOAuthEgressClient(proxyURL, resolver.timeout)
	resolver.clients[key] = client
	return client
}
