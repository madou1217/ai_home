package egress

import (
	"context"
	"errors"
	"os"
	"strings"

	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
)

// strategyRuntime 是一种出口策略在运行时的三个入口。
//
// 新增策略 = StrategyDefinition + 注册一个 runtime；解析、CLI 启动、展示不再
// 各自写 mode switch。池模式因为有自己的车道/直连池状态，单独注册实现。
type strategyRuntime struct {
	Resolve func(manager *Manager, ctx context.Context, binding *agyegress.Binding, opts ResolveAccountEgressOptions) EgressResolveResult
	Launch  func(ctx context.Context, aiHomeDir, provider, accountRef string, binding *agyegress.Binding) (LaunchEgress, error)
	Display func(ctx context.Context, manager *Manager, binding *agyegress.Binding, upstream *UpstreamInfo) (kind string, proxyURL string, include bool)
}

var strategyRuntimes = map[string]strategyRuntime{}

func init() {
	for _, mode := range []string{
		agyegress.ModeDirect,
		agyegress.ModeSystem,
		agyegress.ModeTUN,
		agyegress.ModeURL,
		agyegress.ModeSSH,
	} {
		strategyRuntimes[mode] = strategyRuntime{
			Resolve: func(manager *Manager, ctx context.Context, binding *agyegress.Binding, opts ResolveAccountEgressOptions) EgressResolveResult {
				return manager.resolveNonPoolTarget(ctx, binding, opts)
			},
			Launch:  launchNonPoolStrategy,
			Display: displayNonPoolStrategy,
		}
	}
	strategyRuntimes[agyegress.ModePool] = strategyRuntime{
		Resolve: func(manager *Manager, ctx context.Context, binding *agyegress.Binding, opts ResolveAccountEgressOptions) EgressResolveResult {
			return manager.resolvePoolTarget(ctx, binding, opts)
		},
		Launch:  launchPoolStrategy,
		Display: displayPoolStrategy,
	}
}

func strategyRuntimeFor(mode string) (strategyRuntime, bool) {
	runtime, ok := strategyRuntimes[strings.ToLower(strings.TrimSpace(mode))]
	return runtime, ok
}

func launchNonPoolStrategy(ctx context.Context, aiHomeDir, provider, accountRef string, binding *agyegress.Binding) (LaunchEgress, error) {
	_ = accountRef
	resolved, err := ResolveNonPoolExit(ctx, aiHomeDir, provider, binding)
	if err != nil {
		return LaunchEgress{}, err
	}
	return LaunchEgress{Bound: true, Mode: resolved.Mode, ProxyURL: resolved.ProxyURL}, nil
}

func launchPoolStrategy(ctx context.Context, aiHomeDir, provider, accountRef string, binding *agyegress.Binding) (LaunchEgress, error) {
	ref := strings.TrimSpace(accountRef)
	_ = provider
	state, reason := ReadLivePoolState(aiHomeDir, nil)
	if state != nil && ref != "" && bindingUsesSessionLanes(binding) {
		// session 策略：CLI 进程各自领一条会话车道，避免多个终端共用同一出口。
		if alloc := AcquireSessionLane(aiHomeDir, ref, state.SessionLanes[ref], os.Getpid(), nil, 0); alloc != nil && alloc.URL != "" {
			return LaunchEgress{Bound: true, Mode: agyegress.ModePool, ProxyURL: alloc.URL}, nil
		}
	}
	laneURL := ""
	if state != nil && ref != "" {
		laneURL = strings.TrimSpace(state.Lanes[ref])
	}
	if laneURL != "" {
		return LaunchEgress{Bound: true, Mode: agyegress.ModePool, ProxyURL: laneURL}, nil
	}
	if endpoint, endpointErr := SelectEndpointPoolProxy(ctx, aiHomeDir, ref, binding); endpointErr == nil && endpoint != nil {
		return LaunchEgress{Bound: true, Mode: agyegress.ModePool, ProxyURL: endpoint.ProxyURL}, nil
	}
	if state == nil {
		if reason == "" {
			reason = "egress_pool_not_running"
		}
		return LaunchEgress{}, errors.New(reason)
	}
	return LaunchEgress{}, errors.New("egress_pool_lane_not_ready")
}

func displayNonPoolStrategy(ctx context.Context, manager *Manager, binding *agyegress.Binding, upstream *UpstreamInfo) (string, string, bool) {
	if binding == nil || upstream == nil {
		return "", "", false
	}
	resolved, err := ResolveNonPoolExit(ctx, manager.aiHomeDir, upstream.Provider, binding)
	if err != nil {
		return "", "", false
	}
	switch resolved.Mode {
	case agyegress.ModeSystem:
		return "system", "", true
	case agyegress.ModeURL:
		return "proxy", resolved.ProxyURL, true
	case agyegress.ModeSSH:
		return "ssh", resolved.ProxyURL, true
	default:
		return "direct", "", true
	}
}

func displayPoolStrategy(context.Context, *Manager, *agyegress.Binding, *UpstreamInfo) (string, string, bool) {
	// 池的网络出口由 BuildUpstreamsView 的车道/直连池逻辑展示。
	return "", "", false
}
