package egress

import (
	"context"
	"errors"
	"os/exec"
	"strings"

	"github.com/madou1217/ai_home/application/egressengine"
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
	// Engine 非空时表示该池由进程插件编译配置；否则使用内置过渡适配器。
	Engine egressengine.Engine
	// pluginSpec 是本次编译结果，供 CheckConfig/RunArgs 使用。
	pluginSpec *egressengine.LaunchSpec
	// pluginAIHome/pluginPlatform 透传给插件定位内核（不含宿主凭据）。
	pluginAIHome   string
	pluginPlatform string
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

func (core *PoolCore) BuildConfig(ctx context.Context, input PoolConfigInput, nodes []ProxyNode) (*CompiledPoolConfig, error) {
	if core == nil {
		return nil, errors.New("egress_pool_core_not_found")
	}
	if core.Engine != nil {
		return core.buildPluginConfig(ctx, input, nodes)
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

// buildPluginConfig 把主体输入翻译成 egress.engine 契约，插件只返回配置。
func (core *PoolCore) buildPluginConfig(ctx context.Context, input PoolConfigInput, nodes []ProxyNode) (*CompiledPoolConfig, error) {
	interfaceName := ""
	if input.InterfaceName != nil {
		interfaceName = strings.TrimSpace(*input.InterfaceName)
	} else {
		interfaceName = ResolvePhysicalInterface(input.InterfacesFunc)
	}
	request := egressengine.CompileRequest{
		AIHomeDir:      core.pluginAIHome,
		Platform:       core.pluginPlatform,
		Nodes:          toEngineNodes(nodes),
		MixedPort:      input.MixedPort,
		ControllerPort: input.ControllerPort,
		ProbePort:      input.ProbePort,
		LanePorts:      input.LanePorts,
		Secret:         input.Secret,
		InterfaceName:  interfaceName,
		Rules:          toEngineRules(input.Routing),
		DNS:            toEngineDNS(input.Routing.DNS),
		Version:        core.Version,
	}
	spec, err := core.Engine.Compile(ctx, request)
	if err != nil {
		return nil, err
	}
	core.pluginSpec = &spec
	if strings.TrimSpace(spec.ConfigFileName) != "" {
		core.ConfigFileName = spec.ConfigFileName
	}
	if strings.TrimSpace(spec.GlobalGroup) != "" {
		core.GlobalGroup = spec.GlobalGroup
	}
	nodeNames := make([]string, 0, len(spec.NodeTags))
	nodeEntries := make([]RuntimeNodeEntry, 0, len(spec.NodeTags))
	for _, tag := range spec.NodeTags {
		nodeNames = append(nodeNames, tag.Tag)
		identity := strings.TrimSpace(tag.Identity)
		if identity == "" {
			identity = BuildExitIdentity(tag.Protocol, tag.Server, tag.Port)
		}
		nodeID := strings.TrimSpace(tag.NodeID)
		if nodeID == "" {
			nodeID = BuildNodeEntityID(tag.Protocol, tag.Server, tag.Port)
		}
		label := strings.TrimSpace(tag.Label)
		if label == "" {
			label = tag.Tag
		}
		nodeEntries = append(nodeEntries, RuntimeNodeEntry{
			Name: tag.Tag, NodeID: nodeID, Identity: identity, Label: label,
			Protocol: tag.Protocol, Server: tag.Server, Port: tag.Port, Enabled: true,
		})
	}
	return &CompiledPoolConfig{
		JSONBytes:     spec.Config,
		NodeNames:     nodeNames,
		NodeEntries:   nodeEntries,
		InterfaceName: interfaceName,
	}, nil
}

// CheckConfig 在启动前校验配置；sing-box 提供 `check` 子命令。
func (core *PoolCore) CheckConfig(configPath, workDir string) error {
	if core == nil {
		return errors.New("egress_pool_core_not_found")
	}
	if core.Engine != nil {
		// 插件 compile 已负责配置合法性；宿主的 `check` 约定只适用于内置参考适配器。
		return nil
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
	if core != nil && core.pluginSpec != nil && len(core.pluginSpec.Args) > 0 {
		args := make([]string, 0, len(core.pluginSpec.Args))
		for _, arg := range core.pluginSpec.Args {
			arg = strings.ReplaceAll(arg, "{{config}}", configPath)
			arg = strings.ReplaceAll(arg, "{{dir}}", workDir)
			args = append(args, arg)
		}
		return args
	}
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

func toEngineNodes(nodes []ProxyNode) []egressengine.Node {
	out := make([]egressengine.Node, 0, len(nodes))
	for _, node := range nodes {
		options := make(map[string]any, len(node.Raw))
		for key, value := range node.Raw {
			options[key] = value
		}
		out = append(out, egressengine.Node{
			ID: node.ID, Name: node.Name, Protocol: node.Protocol,
			Server: node.Server, Port: node.Port, Options: options,
		})
	}
	return out
}

func toEngineRules(policy RoutingPolicy) []egressengine.Rule {
	out := make([]egressengine.Rule, 0, len(policy.Rules))
	for _, rule := range policy.Rules {
		out = append(out, egressengine.Rule{Type: rule.Type, Value: rule.Value, Action: rule.Action})
	}
	return out
}

func toEngineDNS(dns RoutingDNS) egressengine.DNS {
	return egressengine.DNS{
		Mode: dns.Mode, Servers: append([]string(nil), dns.Servers...), Route: dns.Route,
	}
}
