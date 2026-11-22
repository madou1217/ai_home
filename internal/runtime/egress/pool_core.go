package egress

import (
	"context"
	"errors"
	"strings"

	"github.com/madou1217/ai_home/application/egressengine"
)

// PoolCoreKind 是出口池内核类型。
type PoolCoreKind string

const (
	PoolCoreMihomo PoolCoreKind = "mihomo"
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

func (core *PoolCore) BuildConfig(ctx context.Context, input PoolConfigInput, nodes []ProxyNode) (*CompiledPoolConfig, error) {
	if core == nil {
		return nil, errors.New("egress_pool_core_not_found")
	}
	if core.Engine != nil {
		return core.buildPluginConfig(ctx, input, nodes)
	}
	input.Nodes = nodes
	return core.buildBuiltinConfig(input, nodes)
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
	return core.checkBuiltinConfig(configPath)
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
	return core.builtinRunArgs(configPath, workDir)
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
