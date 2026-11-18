package sshproxy

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/runtime/managedproxy"
	"net"
)

// Ready means both SSH authentication and a real public HTTPS download route.
// This metadata-only request does not use provider credentials or run inference.
func probeOutlet(ctx context.Context, client *sshremote.Client) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resolver := managedproxy.NewResolver(client.DialTCP)
	transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		literal, err := resolver.Resolve(ctx, address)
		if err != nil {
			return nil, err
		}
		return client.DialTCP(ctx, network, literal)
	}, DisableKeepAlives: true, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 10 * time.Second}
	defer transport.CloseIdleConnections()
	request, _ := http.NewRequestWithContext(ctx, http.MethodHead, "https://registry.npmjs.org/", nil)
	response, err := (&http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(request)
	if err != nil {
		return fmt.Errorf("SSH 已连接，但外网 HTTPS 探测未通过")
	}
	response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 400 {
		return fmt.Errorf("SSH 外网探测返回 HTTP %d", response.StatusCode)
	}
	return nil
}
