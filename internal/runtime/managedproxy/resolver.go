package managedproxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// Resolver performs certificate-verified DoH through the selected network
// outlet. It neither trusts the caller's DNS nor asks sshd to resolve again.
type Resolver struct {
	dial  Dialer
	mu    sync.Mutex
	cache map[string]resolved
}
type resolved struct {
	ips   []net.IPAddr
	until time.Time
}

func NewResolver(dial Dialer) *Resolver { return &Resolver{dial: dial, cache: map[string]resolved{}} }
func (r *Resolver) Resolve(ctx context.Context, address string) (string, error) {
	return publicAddress(ctx, address, r.lookup)
}
func (r *Resolver) lookup(ctx context.Context, host string) ([]net.IPAddr, error) {
	r.mu.Lock()
	hit, ok := r.cache[host]
	r.mu.Unlock()
	if ok && time.Now().Before(hit.until) {
		return hit.ips, nil
	}
	var addresses []net.IPAddr
	for _, queryType := range []string{"A", "AAAA"} {
		values := url.Values{"name": {host}, "type": {queryType}}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://cloudflare-dns.com/dns-query?"+values.Encode(), nil)
		if err != nil {
			return nil, err
		}
		request.Header.Set("Accept", "application/dns-json")
		transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return r.dial(ctx, network, "1.1.1.1:443")
		}, DisableKeepAlives: true, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 10 * time.Second}
		response, err := (&http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(request)
		if err != nil {
			transport.CloseIdleConnections()
			return nil, fmt.Errorf("trusted proxy DNS unavailable")
		}
		var payload struct {
			Status int `json:"Status"`
			Answer []struct {
				Type int    `json:"type"`
				Data string `json:"data"`
			} `json:"Answer"`
		}
		err = json.NewDecoder(http.MaxBytesReader(nil, response.Body, 64*1024)).Decode(&payload)
		response.Body.Close()
		transport.CloseIdleConnections()
		if err != nil || response.StatusCode != 200 || payload.Status != 0 {
			return nil, fmt.Errorf("trusted proxy DNS failed")
		}
		for _, answer := range payload.Answer {
			if answer.Type == 1 || answer.Type == 28 {
				if ip := net.ParseIP(answer.Data); ip != nil {
					addresses = append(addresses, net.IPAddr{IP: ip})
				}
			}
		}
		if len(addresses) > 0 {
			break
		}
	}
	if len(addresses) == 0 {
		return nil, fmt.Errorf("public hostname has no address")
	}
	r.mu.Lock()
	if len(r.cache) > 1024 {
		r.cache = map[string]resolved{}
	}
	r.cache[host] = resolved{ips: addresses, until: time.Now().Add(time.Minute)}
	r.mu.Unlock()
	return addresses, nil
}
