package egress

import (
	"context"
	"errors"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/application/egressengine"
)

// resolvePoolCore 先询问进程插件，插件不可用/不承载节点时才回落到内置参考适配器。
//
// 插件只回答“能编译多少节点”和内核路径；选择顺序按描述符 priority 高到低，
// 平局按 ID，保证不同会话/重启的选择稳定。
func (m *Manager) resolvePoolCore(ctx context.Context, nodes []ProxyNode) (*PoolCore, error) {
	engineNodes := toEngineNodes(nodes)
	for _, engine := range m.sortedEnginePlugins() {
		descriptor := engine.Descriptor()
		result, err := engine.Resolve(ctx, egressengine.ResolveRequest{
			AIHomeDir: m.aiHomeDir,
			Platform:  m.platform,
			Nodes:     engineNodes,
		})
		if err != nil || result.UsableNodes <= 0 || strings.TrimSpace(result.Binary) == "" {
			continue
		}
		return &PoolCore{
			Kind:           PoolCoreKind("plugin:" + descriptor.ID),
			Path:           result.Binary,
			Source:         "plugin",
			Version:        result.Version,
			UsableNodes:    result.UsableNodes,
			ConfigFileName: result.ConfigFileName,
			GlobalGroup:    result.GlobalGroup,
			Engine:         engine,
			pluginAIHome:   m.aiHomeDir,
			pluginPlatform: m.platform,
		}, nil
	}
	if m.disableBuiltinEngines {
		return nil, errors.New("egress_engine_not_installed")
	}
	return m.builtinPoolCore(nodes)
}

// sortedEnginePlugins 按优先级与 ID 稳定排序插件，保证不同重启/会话的选择一致。
func (m *Manager) sortedEnginePlugins() []egressengine.Engine {
	plugins := append([]egressengine.Engine(nil), m.enginePlugins...)
	sort.SliceStable(plugins, func(left, right int) bool {
		a, b := plugins[left].Descriptor(), plugins[right].Descriptor()
		if a.Priority != b.Priority {
			return a.Priority > b.Priority
		}
		return a.ID < b.ID
	})
	return plugins
}

// engineSupports 判断插件是否声明了某种配置形态；空能力列表按 pool 兼容。
func engineSupports(descriptor egressengine.Descriptor, capability string) bool {
	if len(descriptor.Capabilities) == 0 {
		return capability == "pool"
	}
	for _, item := range descriptor.Capabilities {
		if strings.EqualFold(strings.TrimSpace(item), capability) {
			return true
		}
	}
	return false
}

// LeaseEngine 为单节点租约选择声明了 lease 能力的插件。
//
// 租约与出口池共享同一份插件集合，但选择顺序仍按 priority/ID；
// 节点不可编译或内核缺失的插件会被跳过，不会退回内置编译器。
func (m *Manager) LeaseEngine(ctx context.Context, node ProxyNode) (egressengine.Engine, egressengine.ResolveResult, error) {
	if m == nil {
		return nil, egressengine.ResolveResult{}, errors.New("egress_engine_not_installed")
	}
	engineNodes := toEngineNodes([]ProxyNode{node})
	for _, engine := range m.sortedEnginePlugins() {
		if !engineSupports(engine.Descriptor(), "lease") {
			continue
		}
		result, err := engine.Resolve(ctx, egressengine.ResolveRequest{
			AIHomeDir: m.aiHomeDir,
			Platform:  m.platform,
			Nodes:     engineNodes,
		})
		if err != nil || result.UsableNodes <= 0 || strings.TrimSpace(result.Binary) == "" {
			continue
		}
		return engine, result, nil
	}
	return nil, egressengine.ResolveResult{}, errors.New("egress_engine_not_installed")
}

// HasLeaseEngine 只回答是否存在声明 lease 能力的插件，不启动内核。
func (m *Manager) HasLeaseEngine() bool {
	if m == nil {
		return false
	}
	for _, engine := range m.enginePlugins {
		if engineSupports(engine.Descriptor(), "lease") {
			return true
		}
	}
	return false
}
