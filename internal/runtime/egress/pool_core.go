package egress

import (
	"errors"
	"os/exec"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
)

// PoolCoreKind 是出口池内核类型。
type PoolCoreKind string

const (
	PoolCoreMihomo  PoolCoreKind = "mihomo"
	PoolCoreSingBox PoolCoreKind = "sing-box"
)

// PoolCore 是一次出口池启动选定的内核事实。
type PoolCore struct {
	Kind           PoolCoreKind
	Path           string
	Source         string
	Version        string
	UsableNodes    int
	ConfigFileName string
	GlobalGroup    string
}

// ResolvePoolCore 选择能承载最多节点的内核；平局优先 mihomo（兼容旧行为）。
//
// sing-box 支持 AnyTLS/Naive 等新协议，mihomo 对 Snell 等支持更广；按实际节点
// 编译结果选择，避免“装了内核但一半节点不可用”。
func ResolvePoolCore(nodes []ProxyNode, aiHomeDir, platform string) (*PoolCore, error) {
	singBox := subaggregator.ResolvePoolKernel("sing-box", aiHomeDir, platform)
	// mihomo 的托管/客户端路径沿用 egress 既有约定（<aiHome>/tools、客户端内置、
	// PATH），不能只看 subaggregator 的 <aiHome>/bin。
	var mihomo *subaggregator.PoolKernel
	if resolved, err := ResolveMihomoCorePath(CoreResolverOptions{AIHomeDir: aiHomeDir, Platform: platform}); err == nil && resolved != nil {
		mihomo = &subaggregator.PoolKernel{ID: "mihomo", Path: resolved.Path, Source: resolved.Source}
	}
	if singBox == nil && mihomo == nil {
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
	if singBox != nil {
		candidates = append(candidates, candidate{
			core: &PoolCore{
				Kind:           PoolCoreSingBox,
				Path:           singBox.Path,
				Source:         singBox.Source,
				Version:        singBox.Version,
				ConfigFileName: "sing-box.json",
				GlobalGroup:    "AIH-GLOBAL",
			},
			count: countSingBoxPoolNodes(nodes, singBox.Version),
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

func (core *PoolCore) BuildConfig(input PoolConfigInput, nodes []ProxyNode) (*CompiledPoolConfig, error) {
	if core == nil {
		return nil, errors.New("egress_pool_core_not_found")
	}
	input.Nodes = nodes
	switch core.Kind {
	case PoolCoreSingBox:
		input.SingBoxVersion = core.Version
		return BuildSingBoxPoolConfig(input)
	case PoolCoreMihomo:
		return BuildEgressPoolConfig(input)
	default:
		return nil, errors.New("egress_pool_core_unsupported")
	}
}

// CheckConfig 在启动前校验配置；sing-box 提供 `check` 子命令。
func (core *PoolCore) CheckConfig(configPath, workDir string) error {
	if core == nil {
		return errors.New("egress_pool_core_not_found")
	}
	if core.Kind != PoolCoreSingBox {
		return nil
	}
	if err := exec.Command(core.Path, "check", "-c", configPath).Run(); err != nil {
		return errors.New("egress_pool_config_check_failed")
	}
	return nil
}

func (core *PoolCore) RunArgs(configPath, workDir string) []string {
	if core != nil && core.Kind == PoolCoreSingBox {
		return []string{"run", "-c", configPath}
	}
	return []string{"-d", workDir, "-f", configPath}
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

func countSingBoxPoolNodes(nodes []ProxyNode, version string) int {
	count := 0
	for _, node := range nodes {
		compiled, err := subaggregator.CompileSingBoxOutbound(node.ToSubaggregatorNode(), "pool-probe", strings.TrimSpace(version), false)
		if err == nil && !compiled.IsEndpoint {
			count++
		}
	}
	return count
}
