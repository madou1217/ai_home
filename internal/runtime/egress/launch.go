package egress

import (
	"context"
	"errors"
	"fmt"
	"strings"

	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
)

// LaunchEgress 描述一次前台 CLI 启动应使用的账号出口。
//
// 与网关侧 AccountEgressResolver 的区别：这里不启动出口池、不探测、不重启
// 桌面端，只读取已经生效的事实；池车道未就绪时由调用方失败关闭。
type LaunchEgress struct {
	Bound bool
	// Mode 取值 direct / system / url / pool / tun。
	Mode     string
	ProxyURL string
}

// proxyEnvNames 是需要覆盖的前台 CLI 代理变量（runner 会把键名归一化为大写）。
var proxyEnvNames = []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"}

// ResolveAccountLaunchEgress 读取账号出口绑定与出口池运行态。
//
// 未绑定返回 Bound=false（保留宿主环境，等价于 OAuth 授权时的默认网络）。
// 绑定损坏、退役记录、池未运行或车道缺失都返回 error：显式出口是隔离承诺，
// 不能静默回落到宿主网络。
func ResolveAccountLaunchEgress(
	ctx context.Context,
	aiHomeDir string,
	accountRef string,
) (LaunchEgress, error) {
	ref := strings.TrimSpace(accountRef)
	if strings.TrimSpace(aiHomeDir) == "" || ref == "" {
		return LaunchEgress{}, nil
	}
	binding, found, err := agyegress.NewStore(aiHomeDir).Read(ctx, ref)
	if err != nil {
		return LaunchEgress{}, fmt.Errorf("egress_binding_read_failed: %w", err)
	}
	if !found {
		return LaunchEgress{}, nil
	}
	if binding.Retired {
		return LaunchEgress{}, fmt.Errorf("egress_binding_retired: %s", strings.TrimSpace(binding.Mode))
	}
	mode := strings.ToLower(strings.TrimSpace(binding.Mode))
	switch mode {
	case agyegress.ModeDirect, agyegress.ModeTUN, agyegress.ModeSystem:
		return LaunchEgress{Bound: true, Mode: mode}, nil
	case agyegress.ModeURL:
		proxyURL := strings.TrimSpace(binding.ProxyURL)
		if proxyURL == "" {
			return LaunchEgress{}, errors.New("egress_proxy_missing")
		}
		return LaunchEgress{Bound: true, Mode: mode, ProxyURL: proxyURL}, nil
	case agyegress.ModeSSH:
		proxyURL, err := ManagedSSHProxyURL(aiHomeDir, binding.ProxyURL)
		if err != nil {
			return LaunchEgress{}, fmt.Errorf("ssh_proxy_unavailable: %w", err)
		}
		return LaunchEgress{Bound: true, Mode: mode, ProxyURL: proxyURL}, nil
	case agyegress.ModePool:
		state, reason := ReadLivePoolState(aiHomeDir, nil)
		if state == nil {
			if reason == "" {
				reason = "egress_pool_not_running"
			}
			return LaunchEgress{}, errors.New(reason)
		}
		laneURL := strings.TrimSpace(state.Lanes[ref])
		if laneURL == "" {
			return LaunchEgress{}, errors.New("egress_pool_lane_not_ready")
		}
		return LaunchEgress{Bound: true, Mode: mode, ProxyURL: laneURL}, nil
	default:
		return LaunchEgress{}, fmt.Errorf("egress_mode_unsupported: %s", mode)
	}
}

// Env 把出口翻译成前台 CLI 的环境变更。
//
// system 保留宿主代理；direct/tun 清除代理变量；url/pool 覆盖为出口代理。
// 与 WebUI 启动器的 applyAccountEgressProxyEnv 保持同一语义。
func (result LaunchEgress) Env() (set map[string]string, unset []string) {
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