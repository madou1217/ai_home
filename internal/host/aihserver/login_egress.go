package aihserver

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/sshproxy"
)

// loginEgress 在 OAuth 换码前预检授权域名，直连被拒时临时借用受管出口。
//
// 判定与 CLI 登录一致：授权根地址能用 2xx/3xx 访问即视为直连可用；否则申请
// 一个任务级出口租约，验证通过才把 ProxyURL 交给换码请求，作业结束即释放。
type loginEgress struct {
	leases *sshproxy.LeaseManager
}

// loginProbeURLs 是各 Provider 登录前的网络预检地址；未列出的 Provider 不做预检。
var loginProbeURLs = map[string]string{
	"codex": "https://auth.openai.com/",
}

func newLoginEgress(leases *sshproxy.LeaseManager) *loginEgress {
	if leases == nil {
		return nil
	}
	return &loginEgress{leases: leases}
}

func (egress *loginEgress) Acquire(ctx context.Context, providerID string) (string, func(), error) {
	if egress == nil || egress.leases == nil {
		return "", func() {}, nil
	}
	probe := loginProbeURLs[strings.ToLower(strings.TrimSpace(providerID))]
	if probe == "" {
		return "", func() {}, nil
	}
	status, reachable := probeLoginEndpoint(ctx, probe, "")
	if reachable {
		return "", func() {}, nil
	}
	lease, err := egress.leases.Acquire(ctx, "auto")
	if err != nil {
		return "", nil, fmt.Errorf("直连 %s 不可用（%s），受管出口申请失败: %w", probe, status, err)
	}
	proxyStatus, proxyOK := probeLoginEndpoint(ctx, probe, lease.ProxyURL)
	if !proxyOK {
		egress.leases.Release(lease.ID)
		return "", nil, fmt.Errorf("受管出口「%s」仍无法访问 %s（%s）", lease.Name, probe, proxyStatus)
	}
	log.Printf("accountauth: 直连 %s 不可用（%s）；换码临时使用受管出口 %s", probe, status, lease.Name)
	return lease.ProxyURL, func() { egress.leases.Release(lease.ID) }, nil
}

// probeLoginEndpoint 直接或经代理访问探测地址，返回可读状态与是否可用。
func probeLoginEndpoint(ctx context.Context, target, proxy string) (string, bool) {
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
		return "请求无效", false
	}
	response, err := client.Do(request)
	if err != nil {
		return "网络不可达", false
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	return fmt.Sprintf("HTTP %d", response.StatusCode), response.StatusCode < 400
}
