package aihserver

import (
	"net/http"
	"testing"
	"time"
)

func egressTransport(t *testing.T, client *http.Client) *http.Transport {
	t.Helper()
	transport, ok := client.Transport.(*http.Transport)
	if !ok || transport == nil {
		t.Fatalf("transport = %T, want *http.Transport", client.Transport)
	}
	return transport
}

func TestOAuthEgressClientDirectBypassesProxy(t *testing.T) {
	client := newOAuthEgressClient("", time.Second)
	if egressTransport(t, client).Proxy != nil {
		t.Fatal("direct transport must not use a proxy")
	}
}

func TestOAuthEgressClientUsesProxyURL(t *testing.T) {
	client := newOAuthEgressClient("socks5://127.0.0.1:1080", time.Second)
	request, err := http.NewRequest(http.MethodPost, "https://oauth2.googleapis.com/token", nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy, err := egressTransport(t, client).Proxy(request)
	if err != nil || proxy == nil || proxy.String() != "socks5://127.0.0.1:1080" {
		t.Fatalf("proxy = %v, %v", proxy, err)
	}
}

func TestOAuthEgressClientRejectsInvalidProxy(t *testing.T) {
	client := newOAuthEgressClient("::not-a-url::", time.Second)
	request, err := http.NewRequest(http.MethodPost, "https://oauth2.googleapis.com/token", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := egressTransport(t, client).Proxy(request); err == nil {
		t.Fatal("invalid proxy must fail instead of falling back to direct")
	}
}

// server 会把 http.DefaultTransport 换成 proxyFallbackTransport；出口客户端
// 如果 clone 默认传输会 panic（真机 2026-11-11 复现：interface conversion
// http.RoundTripper is *aihserver.proxyFallbackTransport, not *http.Transport）。
type stubRoundTripper struct{}

func (stubRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, http.ErrHandlerTimeout
}

func TestOAuthEgressClientDoesNotCloneDefaultTransport(t *testing.T) {
	original := http.DefaultTransport
	http.DefaultTransport = stubRoundTripper{}
	defer func() { http.DefaultTransport = original }()
	client := newOAuthEgressClient("socks5://127.0.0.1:1080", time.Second)
	if _, ok := client.Transport.(*http.Transport); !ok {
		t.Fatalf("transport = %T, want a fresh *http.Transport", client.Transport)
	}
}
