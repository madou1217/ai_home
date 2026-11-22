package egress

import (
	"context"
	"errors"
	"fmt"
	"strings"

	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
)

// NonPoolExit 是“非出口池策略”解析后的统一出口事实。
//
// launch、probe、展示都必须消费这一份结果，不能各自再写一套 mode switch；
// 池模式有独立的车道/直连池解析，不在这里。
type NonPoolExit struct {
	Bound    bool
	Mode     string
	ProxyURL string
	Direct   bool
	System   bool
}

// ResolveNonPoolExit 把 direct/system/tun/url/ssh 绑定解析成统一出口。
//
// 失败关闭：URL 非法、SSH 隧道未就绪、未知/退役模式都返回错误，绝不回落。
func ResolveNonPoolExit(
	ctx context.Context,
	aiHomeDir string,
	provider string,
	binding *agyegress.Binding,
) (NonPoolExit, error) {
	if binding == nil {
		return NonPoolExit{}, nil
	}
	if binding.Retired {
		return NonPoolExit{}, fmt.Errorf("egress_binding_retired: %s", strings.TrimSpace(binding.Mode))
	}
	mode := strings.ToLower(strings.TrimSpace(binding.Mode))
	switch mode {
	case agyegress.ModeDirect, agyegress.ModeTUN:
		return NonPoolExit{Bound: true, Mode: mode, Direct: true}, nil
	case agyegress.ModeSystem:
		return NonPoolExit{Bound: true, Mode: mode, System: true}, nil
	case agyegress.ModeURL:
		proxyURL := strings.TrimSpace(binding.ProxyURL)
		if proxyURL == "" {
			return NonPoolExit{}, errors.New("egress_proxy_missing")
		}
		if issue := agyegress.ProxyURLIssueForProvider(proxyURL, provider); issue != "" {
			return NonPoolExit{}, errors.New(issue)
		}
		return NonPoolExit{Bound: true, Mode: mode, ProxyURL: proxyURL}, nil
	case agyegress.ModeSSH:
		proxyURL, err := ManagedSSHProxyURL(aiHomeDir, binding.ProxyURL)
		if err != nil {
			return NonPoolExit{}, fmt.Errorf("ssh_proxy_unavailable: %w", err)
		}
		return NonPoolExit{Bound: true, Mode: mode, ProxyURL: proxyURL}, nil
	default:
		return NonPoolExit{}, fmt.Errorf("egress_mode_unsupported: %s", mode)
	}
}

// Env 把非池出口映射为前台 CLI 代理环境（与 LaunchEgress.Env 同语义）。
func (result NonPoolExit) Env() (set map[string]string, unset []string) {
	if !result.Bound {
		return nil, nil
	}
	switch result.Mode {
	case agyegress.ModeDirect, agyegress.ModeTUN:
		return nil, append([]string(nil), proxyEnvNames...)
	case agyegress.ModeSystem:
		return nil, nil
	default:
		if strings.TrimSpace(result.ProxyURL) == "" {
			return nil, nil
		}
		set = make(map[string]string, len(proxyEnvNames))
		for _, name := range proxyEnvNames {
			set[name] = result.ProxyURL
		}
		return set, nil
	}
}