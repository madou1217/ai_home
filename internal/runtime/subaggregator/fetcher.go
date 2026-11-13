package subaggregator

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultMaxResponseBytes = 10 * 1024 * 1024
	DefaultFetchTimeout     = 20 * time.Second
	DefaultMaxRedirects     = 5
)

// FetchResult 表示远端订阅拉取的文本内容与流量头。
type FetchResult struct {
	Content   string
	FinalURL  string
	UserInfo  *SubscriptionUserInfo
	UserAgent string
}

// Fetcher 执行带 SSRF 防护、重定向检查与响应体限制的 HTTP 拉取。
type Fetcher struct {
	MaxResponseBytes int64
	Timeout          time.Duration
	MaxRedirects     int
	AllowPrivateNet  bool
	Resolver         func(ctx context.Context, host string) ([]netip.Addr, error)
	Transport        http.RoundTripper
}

func NewFetcher() *Fetcher {
	return &Fetcher{
		MaxResponseBytes: DefaultMaxResponseBytes,
		Timeout:          DefaultFetchTimeout,
		MaxRedirects:     DefaultMaxRedirects,
	}
}

// IsBlockedIP 判断 IPv4/IPv6 地址是否属于内网、回环、链路本地、多播或保留网段（Fail-Closed）。
// IsFakeIPAddr 判断 IP 是否属于 Clash/Mihomo 常用 Fake-IP 网段（198.18.0.0/15）。
func IsFakeIPAddr(addr netip.Addr) bool {
	if !addr.IsValid() {
		return false
	}
	addr = addr.Unmap()
	if !addr.Is4() {
		return false
	}
	b := addr.As4()
	return b[0] == 198 && (b[1] == 18 || b[1] == 19)
}

func IsBlockedIP(addr netip.Addr) bool {
	if !addr.IsValid() {
		return true
	}
	addr = addr.Unmap()
	if addr.IsLoopback() ||
		addr.IsPrivate() ||
		addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() ||
		addr.IsMulticast() ||
		addr.IsUnspecified() ||
		addr.IsInterfaceLocalMulticast() {
		return true
	}
	if addr.Is4() {
		b := addr.As4()
		if b[0] == 0 {
			return true
		}
		if b[0] == 100 && b[1] >= 64 && b[1] <= 127 {
			return true
		}
		if b[0] == 198 && (b[1] == 18 || b[1] == 19) {
			return true
		}
	}
	return false
}

func isBlockedHostnameLiteral(host string) bool {
	h := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	return h == "" || h == "localhost" || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".internal")
}

func (f *Fetcher) resolveAndValidateHost(ctx context.Context, rawURL string) (*url.URL, netip.Addr, string, error) {
	u, err := ValidateSubscriptionURL(rawURL)
	if err != nil {
		return nil, netip.Addr{}, "", err
	}
	if u.Port() != "" {
		portNum, pErr := strconv.Atoi(u.Port())
		if pErr != nil || !isValidPort(portNum) {
			return nil, netip.Addr{}, "", errInvalid("subscription_url_port_blocked")
		}
		if !f.AllowPrivateNet {
			switch portNum {
			case 80, 443, 8080, 8443:
			default:
				if portNum < 80 || portNum == 22 || portNum == 25 || portNum == 110 || portNum == 143 || portNum == 3306 || portNum == 5432 || portNum == 6379 {
					return nil, netip.Addr{}, "", errInvalid("subscription_url_port_blocked")
				}
			}
		}
	}
	portStr := u.Port()
	if portStr == "" {
		if u.Scheme == "https" {
			portStr = "443"
		} else {
			portStr = "80"
		}
	}
	host := u.Hostname()
	if !f.AllowPrivateNet && isBlockedHostnameLiteral(host) {
		return nil, netip.Addr{}, "", errInvalid("subscription_url_host_blocked")
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		if !f.AllowPrivateNet && IsBlockedIP(ip) {
			return nil, netip.Addr{}, "", errInvalid("subscription_url_host_blocked")
		}
		return u, ip, portStr, nil
	}
	var addrs []netip.Addr
	if f.Resolver != nil {
		addrs, err = f.Resolver(ctx, host)
	} else {
		ips, rErr := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		err = rErr
		addrs = ips
	}
	if err != nil || len(addrs) == 0 {
		return nil, netip.Addr{}, "", errInvalid("subscription_host_resolution_failed")
	}
	for _, addr := range addrs {
		if !f.AllowPrivateNet && IsBlockedIP(addr) {
			return nil, netip.Addr{}, "", errInvalid("subscription_url_host_blocked")
		}
	}
	return u, addrs[0], portStr, nil
}

// Fetch 拉取远端订阅，逐跳检查重定向并钉住解析 IP 防御 DNS Rebinding。
func (f *Fetcher) Fetch(ctx context.Context, rawURL string, userAgent string) (FetchResult, error) {
	ua := strings.TrimSpace(userAgent)
	if ua == "" {
		ua = DefaultUserAgent
	}
	maxBytes := f.MaxResponseBytes
	if maxBytes <= 0 {
		maxBytes = DefaultMaxResponseBytes
	}
	timeout := f.Timeout
	if timeout <= 0 {
		timeout = DefaultFetchTimeout
	}
	maxRedir := f.MaxRedirects
	if maxRedir <= 0 {
		maxRedir = DefaultMaxRedirects
	}

	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	currentURL := rawURL
	for hops := 0; hops <= maxRedir; hops++ {
		parsedURL, pinnedIP, portStr, err := f.resolveAndValidateHost(reqCtx, currentURL)
		if err != nil {
			return FetchResult{}, err
		}
		client := f.buildClient(pinnedIP, portStr, timeout)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, parsedURL.String(), nil)
		if err != nil {
			return FetchResult{}, errInvalid("invalid_subscription_url")
		}
		req.Header.Set("User-Agent", ua)
		req.Header.Set("Accept", "*/*")

		resp, err := client.Do(req)
		if err != nil {
			if reqCtx.Err() == context.DeadlineExceeded {
				return FetchResult{}, errInvalid("subscription_fetch_timeout")
			}
			return FetchResult{}, errInvalid("subscription_fetch_failed")
		}
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			loc := strings.TrimSpace(resp.Header.Get("Location"))
			_ = resp.Body.Close()
			if loc == "" {
				return FetchResult{}, errInvalid("subscription_redirect_missing_location")
			}
			if hops == maxRedir {
				return FetchResult{}, errInvalid("subscription_redirect_limit_exceeded")
			}
			nextURL, err := parsedURL.Parse(loc)
			if err != nil {
				return FetchResult{}, errInvalid("invalid_subscription_url")
			}
			currentURL = nextURL.String()
			continue
		}

		bodyBytes, readErr := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
		_ = resp.Body.Close()
		if readErr != nil {
			return FetchResult{}, errInvalid("subscription_fetch_failed")
		}
		if int64(len(bodyBytes)) > maxBytes {
			return FetchResult{}, errInvalid("subscription_response_too_large")
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return FetchResult{}, errInvalid("subscription_http_error", fmt.Sprintf("HTTP %d", resp.StatusCode))
		}
		ui := ParseSubscriptionUserInfo(resp.Header.Get("Subscription-Userinfo"))
		return FetchResult{
			Content:   string(bodyBytes),
			FinalURL:  parsedURL.String(),
			UserInfo:  ui,
			UserAgent: ua,
		}, nil
	}
	return FetchResult{}, errInvalid("subscription_redirect_limit_exceeded")
}

func (f *Fetcher) buildClient(pinnedIP netip.Addr, portStr string, timeout time.Duration) *http.Client {
	rt := f.Transport
	if rt == nil {
		dialer := &net.Dialer{Timeout: 8 * time.Second}
		targetAddr := net.JoinHostPort(pinnedIP.Unmap().String(), portStr)
		rt = &http.Transport{
			Proxy: nil,
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return dialer.DialContext(ctx, network, targetAddr)
			},
		}
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: rt,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}
