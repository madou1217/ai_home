//go:build !no_builtin_engines

package egress

import (
	"errors"
	"os"

	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
)

// ResolvePoolCore 是内置参考适配器的回退路径，只保留 mihomo。
//
// 生产构建带 no_builtin_engines，不会编译到这里；sing-box 与后续内核
// 一律通过 egress.engine 进程插件接入，避免主体重新长出内核分支。
func ResolvePoolCore(nodes []ProxyNode, aiHomeDir, platform string) (*PoolCore, error) {
	// 内置回退只保留 mihomo（proxypoollease/测试仍依赖）；sing-box 只走插件。
	var mihomo *subaggregator.PoolKernel
	if resolved, err := ResolveMihomoCorePath(CoreResolverOptions{AIHomeDir: aiHomeDir, Platform: platform}); err == nil && resolved != nil {
		mihomo = &subaggregator.PoolKernel{ID: "mihomo", Path: resolved.Path, Source: resolved.Source}
	}
	if mihomo == nil {
		return nil, errors.New("egress_pool_core_not_found")
	}
	type candidate struct {
		core  *PoolCore
		count int
		ok    bool
	}
	candidates := make([]candidate, 0, 2)
	if mihomo != nil {
		candidates = append(candidates, candidate{
			core: &PoolCore{
				Kind:           PoolCoreMihomo,
				Path:           mihomo.Path,
				Source:         mihomo.Source,
				Version:        mihomo.Version,
				ConfigFileName: "config.json",
				GlobalGroup:    mihomoGlobalGroup,
			},
			count: countMihomoPoolNodes(nodes),
			ok:    true,
		})
	}
	best := candidates[0]
	for _, item := range candidates[1:] {
		if item.count > best.count {
			best = item
		}
	}
	best.core.UsableNodes = best.count
	return best.core, nil
}

func countMihomoPoolNodes(nodes []ProxyNode) int {
	count := 0
	for _, node := range nodes {
		if _, err := subaggregator.CompileMihomoProxy(node.ToSubaggregatorNode(), "pool-probe", "mihomo"); err == nil {
			count++
		}
	}
	return count
}

func (core *PoolCore) buildBuiltinConfig(input PoolConfigInput, nodes []ProxyNode) (*CompiledPoolConfig, error) {
	input.Nodes = nodes
	if core.Kind == PoolCoreMihomo {
		return BuildEgressPoolConfig(input)
	}
	return nil, errors.New("egress_pool_core_unsupported")
}

func (core *PoolCore) checkBuiltinConfig(configPath string) error {
	return nil
}

func (core *PoolCore) builtinRunArgs(configPath, workDir string) []string {
	return []string{"-d", workDir, "-f", configPath}
}

// newExplicitPoolCore 供测试/显式路径注入：沿用 mihomo 语义。
func newExplicitPoolCore(path string) (*PoolCore, error) {
	if !isValidCoreFile(os.Stat, path) {
		return nil, errors.New("egress_pool_core_not_found")
	}
	return &PoolCore{
		Kind:           PoolCoreMihomo,
		Path:           path,
		Source:         "configured",
		ConfigFileName: "config.json",
		GlobalGroup:    mihomoGlobalGroup,
	}, nil
}

func (m *Manager) builtinPoolCore(nodes []ProxyNode) (*PoolCore, error) {
	return ResolvePoolCore(nodes, m.aiHomeDir, m.platform)
}
