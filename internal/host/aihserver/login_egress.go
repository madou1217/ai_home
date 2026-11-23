package aihserver

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/loginprobe"
	"github.com/madou1217/ai_home/internal/runtime/sshproxy"
)

// loginEgress 在 OAuth 换码前预检授权域名，直连被拒时临时借用受管出口。
//
// 判定与 CLI 登录一致：授权根地址能用 2xx/3xx 访问即视为直连可用；否则申请
// 一个任务级出口租约，验证通过才把 ProxyURL 交给换码请求，作业结束即释放。
type loginEgress struct {
	leases *sshproxy.LeaseManager
}

func newLoginEgress(leases *sshproxy.LeaseManager) *loginEgress {
	if leases == nil {
		return nil
	}
	return &loginEgress{leases: leases}
}

func (egress *loginEgress) Acquire(ctx context.Context, providerID string, probeURL string) (string, func(), error) {
	if egress == nil || egress.leases == nil {
		return "", func() {}, nil
	}
	probe := strings.TrimSpace(probeURL)
	if probe == "" {
		return "", func() {}, nil
	}
	direct := loginprobe.Check(ctx, probe, "")
	if direct.Reachable {
		return "", func() {}, nil
	}
	status := direct.Status
	lease, err := egress.leases.Acquire(ctx, "auto")
	if err != nil {
		return "", nil, fmt.Errorf("直连 %s 不可用（%s），受管出口申请失败: %w", probe, status, err)
	}
	if proxied := loginprobe.Check(ctx, probe, lease.ProxyURL); !proxied.Reachable {
		egress.leases.Release(lease.ID)
		return "", nil, fmt.Errorf("受管出口「%s」仍无法访问 %s（%s）", lease.Name, probe, proxied.Status)
	}
	log.Printf("accountauth: 直连 %s 不可用（%s）；换码临时使用受管出口 %s", probe, status, lease.Name)
	return lease.ProxyURL, func() { egress.leases.Release(lease.ID) }, nil
}
