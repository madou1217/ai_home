package egress

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
)

// BuildSingBoxPoolConfig 把节点库编译为 sing-box 运行配置。
//
// 与 mihomo 配置共用同一套车道/探测组名（AIH-GLOBAL/AIH-PROBE/LANE-n），
// 因此 supervisor 的控制器操作（选择节点、延迟探测、车道同步）不需要分叉。
// 只监听回环；每个入站通过 route 规则指向自己的 selector。
func BuildSingBoxPoolConfig(input PoolConfigInput) (*CompiledPoolConfig, error) {
	if input.MixedPort <= 0 {
		return nil, errors.New("egress_pool_mixed_port_required")
	}
	if input.ControllerPort <= 0 {
		return nil, errors.New("egress_pool_controller_port_required")
	}
	secret := strings.TrimSpace(input.Secret)
	if secret == "" {
		return nil, errors.New("egress_pool_controller_secret_required")
	}

	var interfaceName string
	if input.InterfaceName != nil {
		interfaceName = strings.TrimSpace(*input.InterfaceName)
	} else {
		interfaceName = ResolvePhysicalInterface(input.InterfacesFunc)
	}

	outbounds := make([]map[string]any, 0, len(input.Nodes)+4)
	nodeNames := make([]string, 0, len(input.Nodes))
	nodeEntries := make([]RuntimeNodeEntry, 0, len(input.Nodes))
	for _, node := range input.Nodes {
		tag := fmt.Sprintf("node-%d", len(nodeNames))
		compiled, err := subaggregator.CompileSingBoxOutbound(node.ToSubaggregatorNode(), tag, input.SingBoxVersion, false)
		if err != nil || compiled.IsEndpoint {
			// Endpoint（如 WireGuard）不能出现在 selector 的 outbounds 列表里；
			// 协议不支持或版本不满足的节点直接跳过，数量会体现在 nodeNames。
			continue
		}
		item := yamlMapToMap(compiled.Item)
		if interfaceName != "" {
			item["bind_interface"] = interfaceName
		}
		outbounds = append(outbounds, item)
		for _, extra := range compiled.Extras {
			outbounds = append(outbounds, yamlMapToMap(extra))
		}
		nodeNames = append(nodeNames, tag)
		nodeEntries = append(nodeEntries, runtimeEntryFromProxy(tag, node, true))
	}
	if len(nodeNames) == 0 {
		return nil, errors.New("egress_pool_no_usable_nodes")
	}

	selector := func(tag string, names []string) map[string]any {
		return map[string]any{
			"type":      "selector",
			"tag":       tag,
			"outbounds": append([]string(nil), names...),
			"default":   names[0],
		}
	}
	selectors := []map[string]any{selector("AIH-GLOBAL", nodeNames)}
	if input.ProbePort > 0 {
		selectors = append(selectors, selector("AIH-PROBE", nodeNames))
	}
	laneIndexes := make([]int, 0, len(input.LanePorts))
	for index, port := range input.LanePorts {
		if port <= 0 {
			continue
		}
		laneIndexes = append(laneIndexes, index)
		selectors = append(selectors, selector(LaneGroupName(index), nodeNames))
	}

	userRules := input.Routing.SingBoxRoutingRules()
	ruleOutbound := func(action string, laneGroup string) string {
		switch action {
		case "direct":
			return "direct"
		case "reject":
			return "block"
		default:
			return laneGroup
		}
	}
	rules := make([]map[string]any, 0, len(userRules)*(len(laneIndexes)+1)+1+len(laneIndexes))
	for _, index := range laneIndexes {
		laneTag := fmt.Sprintf("aih-lane-%d", index)
		for _, rule := range userRules {
			item := map[string]any{"inbound": []string{laneTag}, "outbound": ruleOutbound(rule.Action, LaneGroupName(index))}
			for key, value := range rule.Match {
				item[key] = value
			}
			rules = append(rules, item)
		}
	}

	inbounds := []map[string]any{{
		"type":        "mixed",
		"tag":         "aih-mixed",
		"listen":      PoolBindHost,
		"listen_port": input.MixedPort,
	}}
	if input.ProbePort > 0 {
		inbounds = append(inbounds, map[string]any{
			"type":        "mixed",
			"tag":         "aih-probe",
			"listen":      PoolBindHost,
			"listen_port": input.ProbePort,
		})
		rules = append(rules, map[string]any{
			"inbound":  []string{"aih-probe"},
			"outbound": "AIH-PROBE",
		})
	}
	for _, index := range laneIndexes {
		inbounds = append(inbounds, map[string]any{
			"type":        "mixed",
			"tag":         fmt.Sprintf("aih-lane-%d", index),
			"listen":      PoolBindHost,
			"listen_port": input.LanePorts[index],
		})
		rules = append(rules, map[string]any{
			"inbound":  []string{fmt.Sprintf("aih-lane-%d", index)},
			"outbound": LaneGroupName(index),
		})
	}
	for _, rule := range userRules {
		item := map[string]any{"inbound": []string{"aih-mixed"}, "outbound": ruleOutbound(rule.Action, "AIH-GLOBAL")}
		for key, value := range rule.Match {
			item[key] = value
		}
		rules = append(rules, item)
	}

	auxiliary := []map[string]any{
		{"type": "direct", "tag": "direct"},
		{"type": "block", "tag": "block"},
	}
	allOutbounds := append([]map[string]any(nil), selectors...)
	allOutbounds = append(allOutbounds, outbounds...)
	allOutbounds = append(allOutbounds, auxiliary...)
	configMap := map[string]any{
		"log":       map[string]any{"level": "warn"},
		"inbounds":  inbounds,
		"outbounds": allOutbounds,
		"route": map[string]any{
			"rules": rules,
			"final": "AIH-GLOBAL",
		},
		"experimental": map[string]any{
			"clash_api": map[string]any{
				"external_controller": fmt.Sprintf("%s:%d", PoolControllerHost, input.ControllerPort),
				"secret":              secret,
			},
		},
	}
	if dns := input.Routing.SingBoxDNS(); dns != nil {
		configMap["dns"] = dns
	}
	jsonBytes, err := json.MarshalIndent(configMap, "", " ")
	if err != nil {
		return nil, fmt.Errorf("egress_pool_config_marshal_failed:%w", err)
	}
	return &CompiledPoolConfig{
		Config:        configMap,
		JSONBytes:     jsonBytes,
		NodeNames:     nodeNames,
		NodeEntries:   nodeEntries,
		InterfaceName: interfaceName,
	}, nil
}
