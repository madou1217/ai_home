// Package loginprobe 判定登录所需的授权/换码端点在当前网络是否可达。
//
// 判定刻意保守：只有网络层失败或明确的禁止状态（403/451）才算不可达；
// 400/404/405 等“服务器已经应答”的状态一律视为可达——带缺省参数的裸请求
// 返回这些状态是正常现象，不能据此误借出口（AWS 悉尼实测 token 端点为 405）。
package loginprobe

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Result 是一次探测的可读结果。
type Result struct {
	Status    string
	Reachable bool
}

// Check 直接或经代理访问探测地址。
func Check(ctx context.Context, target, proxy string) Result {
	transport := &http.Transport{
		Proxy:                 nil,
		TLSHandshakeTimeout:   6 * time.Second,
		ResponseHeaderTimeout: 6 * time.Second,
	}
	if strings.TrimSpace(proxy) != "" {
		if parsed, err := url.Parse(proxy); err == nil {
			transport.Proxy = http.ProxyURL(parsed)
		}
	}
	client := &http.Client{
		Timeout:   8 * time.Second,
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return Result{Status: "请求无效"}
	}
	response, err := client.Do(request)
	if err != nil {
		return Result{Status: "网络不可达"}
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	status := fmt.Sprintf("HTTP %d", response.StatusCode)
	if response.StatusCode == http.StatusForbidden || response.StatusCode == http.StatusUnavailableForLegalReasons {
		return Result{Status: status, Reachable: false}
	}
	return Result{Status: status, Reachable: true}
}
