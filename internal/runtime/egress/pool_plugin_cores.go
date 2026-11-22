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
	plugins := append([]egressengine.Engine(nil), m.enginePlugins...)
	sort.SliceStable(plugins, func(left, right int) bool {
		a, b := plugins[left].Descriptor(), plugins[right].Descriptor()
		if a.Priority != b.Priority {
			return a.Priority > b.Priority
		}
		return a.ID < b.ID
	})
	for _, engine := range plugins {
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
	return ResolvePoolCore(nodes, m.aiHomeDir, m.platform)
}
