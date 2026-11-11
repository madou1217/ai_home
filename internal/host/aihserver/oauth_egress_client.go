package aihserver

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"
)

// newOAuthEgressClient 按账号出口绑定创建 OAuth 刷新传输。
//
// proxyURL 为空表示 direct：显式把 Proxy 置空，绕过 HTTP(S)_PROXY；非空时
// 使用该代理。地址非法时让请求本身报错，而不是静默回落到直连/环境代理。
//
// 必须新建 Transport，不能 clone http.DefaultTransport：server 会把默认传输
// 换成 proxyFallbackTransport（非 *http.Transport），类型断言会 panic，且
// 账号级出口本来就不允许「代理失败就直连」的兜底语义。
func newOAuthEgressClient(proxyURL string, timeout time.Duration) *http.Client {
	proxy := http.ProxyFromEnvironment
	if proxyURL == "" {
		proxy = nil
	} else if parsed, err := url.Parse(proxyURL); err == nil &&
		parsed.Scheme != "" && parsed.Host != "" {
		proxy = http.ProxyURL(parsed)
	} else {
		proxy = func(*http.Request) (*url.URL, error) {
			return nil, fmt.Errorf("账号出口代理地址无效")
		}
	}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:                 proxy,
			DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          16,
			MaxIdleConnsPerHost:   4,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
		CheckRedirect: rejectOAuthRedirect,
	}
}
