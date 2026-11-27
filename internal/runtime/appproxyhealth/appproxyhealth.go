// Package appproxyhealth checks whether an app instance's proxy endpoint is
// still accepting connections, so the desk can show a clear "代理已断开"
// marker instead of only reporting that the application process is alive.
package appproxyhealth

import (
	"context"
	"errors"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/appsessions"
)

const dialTimeout = 300 * time.Millisecond

// Enrich fills ProxyHealth on proxied instances. Endpoints are probed once per
// unique URL and in parallel; non-proxied instances are left untouched.
func Enrich(ctx context.Context, instances []appsessions.Instance) []appsessions.Instance {
	if len(instances) == 0 {
		return instances
	}
	enriched := make([]appsessions.Instance, len(instances))
	copy(enriched, instances)

	unique := make(map[string]struct{})
	for _, instance := range enriched {
		if instance.Proxied {
			unique[strings.TrimSpace(instance.ProxyURL)] = struct{}{}
		}
	}
	type result struct{ health, detail string }
	results := make(map[string]result, len(unique))
	var mu sync.Mutex
	var wait sync.WaitGroup
	for target := range unique {
		wait.Add(1)
		go func(target string) {
			defer wait.Done()
			health, detail := Check(ctx, target)
			mu.Lock()
			results[target] = result{health: health, detail: detail}
			mu.Unlock()
		}(target)
	}
	wait.Wait()

	for index := range enriched {
		instance := &enriched[index]
		if !instance.Proxied {
			continue
		}
		resolved := results[strings.TrimSpace(instance.ProxyURL)]
		instance.ProxyHealth = resolved.health
		instance.ProxyHealthDetail = resolved.detail
	}
	return enriched
}

// Check returns "ok" when the proxy host:port accepts a TCP connection, or
// "down" with a short reason. It never says "ok" based on configuration alone.
func Check(ctx context.Context, proxyURL string) (health, detail string) {
	proxyURL = strings.TrimSpace(proxyURL)
	if proxyURL == "" {
		return "down", "未配置代理地址"
	}
	endpoint, err := url.Parse(proxyURL)
	if err != nil || endpoint == nil || endpoint.Hostname() == "" {
		return "down", "代理地址无效"
	}
	host := endpoint.Host
	if endpoint.Port() == "" {
		port := "80"
		switch strings.ToLower(endpoint.Scheme) {
		case "https":
			port = "443"
		case "socks", "socks5", "socks5h":
			port = "1080"
		}
		host = net.JoinHostPort(endpoint.Hostname(), port)
	}
	dialer := net.Dialer{Timeout: dialTimeout}
	connection, err := dialer.DialContext(ctx, "tcp", host)
	if err != nil {
		return "down", describe(err)
	}
	_ = connection.Close()
	return "ok", ""
}

func describe(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "连接代理端口超时"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "连接代理端口超时"
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "connection refused") || strings.Contains(message, "connect: connection refused") {
		return "代理端口未监听（连接被拒绝）"
	}
	return "无法连接代理端口"
}