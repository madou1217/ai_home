package pluginhost

import (
	"fmt"
	"sort"
	"strings"
)

// HostServiceVersions 声明宿主自带的公共服务及合同版本。
var HostServiceVersions = map[string]string{
	"aih": "1.0.0",
}

// GenerationPlan 是静态依赖规划的结果：校验通过时给出确定性加载顺序。
type GenerationPlan struct {
	OK          bool                `json:"ok"`
	Diagnostics []PrepareDiagnostic `json:"diagnostics,omitempty"`
	Order       []string            `json:"order,omitempty"`
}

// PlanGeneration 在启动或准备候选代次之前检查实例冲突、插件重复、贡献项重复、
// 服务冲突/缺失/版本不满足与循环依赖，返回确定性的拓扑加载顺序（依赖在前，同层按 instanceId 排序）。
func PlanGeneration(plugins []PluginSpec) GenerationPlan {
	diagnostics := make([]PrepareDiagnostic, 0)
	byInstance := make(map[string]map[string]any, len(plugins))
	pluginIDs := make(map[string]string, len(plugins))
	contributionOwners := make(map[string]string)
	type serviceOwner struct {
		instanceID string
		version    string
	}
	serviceOwners := make(map[string]serviceOwner)

	for _, item := range plugins {
		instanceID := strings.TrimSpace(item.InstanceID)
		if _, exists := byInstance[instanceID]; exists {
			diagnostics = append(diagnostics, PrepareDiagnostic{
				Code:       CodeInstanceDuplicate,
				Detail:     fmt.Sprintf("实例 %s 重复", instanceID),
				InstanceID: instanceID,
			})
			continue
		}
		manifest := item.Manifest
		byInstance[instanceID] = manifest

		pluginID := stringField(manifest, "pluginId")
		if pluginID != "" {
			if owner, dup := pluginIDs[pluginID]; dup {
				_ = owner
				diagnostics = append(diagnostics, PrepareDiagnostic{
					Code:       CodePluginIDDuplicate,
					Detail:     fmt.Sprintf("插件 %s 在同一代次中出现多次", pluginID),
					InstanceID: instanceID,
					PluginID:   pluginID,
				})
			} else {
				pluginIDs[pluginID] = instanceID
			}
		}

		for _, contrib := range mapSlice(manifest, "contributes") {
			cid := stringField(contrib, "id")
			if cid == "" {
				continue
			}
			if owner, dup := contributionOwners[cid]; dup {
				diagnostics = append(diagnostics, PrepareDiagnostic{
					Code:           CodeContributionDuplicate,
					Detail:         fmt.Sprintf("贡献项 %s 同时由 %s 与 %s 声明", cid, owner, instanceID),
					InstanceID:     instanceID,
					ContributionID: cid,
				})
			} else {
				contributionOwners[cid] = instanceID
			}
		}

		for _, svc := range mapSlice(manifest, "provides") {
			name := stringField(svc, "name")
			ver := stringField(svc, "version")
			if name == "" {
				continue
			}
			if _, reserved := HostServiceVersions[name]; reserved {
				diagnostics = append(diagnostics, PrepareDiagnostic{
					Code:       CodeServiceReserved,
					Detail:     fmt.Sprintf("服务名 %s 由宿主保留", name),
					InstanceID: instanceID,
					Service:    name,
				})
				continue
			}
			if owner, dup := serviceOwners[name]; dup {
				diagnostics = append(diagnostics, PrepareDiagnostic{
					Code:       CodeServiceConflict,
					Detail:     fmt.Sprintf("服务 %s 同时由 %s 与 %s 提供", name, owner.instanceID, instanceID),
					InstanceID: instanceID,
					Service:    name,
				})
			} else {
				serviceOwners[name] = serviceOwner{instanceID: instanceID, version: ver}
			}
		}
	}

	edges := make(map[string][]string, len(byInstance))
	for instanceID, manifest := range byInstance {
		depSet := make(map[string]struct{})
		for _, req := range mapSlice(manifest, "requires") {
			name := stringField(req, "name")
			versionRange := stringField(req, "versionRange")
			if name == "" {
				continue
			}
			if hostVer, isHost := HostServiceVersions[name]; isHost {
				if !SatisfiesSemverRange(hostVer, versionRange) {
					diagnostics = append(diagnostics, PrepareDiagnostic{
						Code:       CodeServiceVersionMismatch,
						Detail:     fmt.Sprintf("%s 需要宿主服务 %s@%s，宿主提供的是 %s", instanceID, name, versionRange, hostVer),
						InstanceID: instanceID,
						Service:    name,
					})
				}
				continue
			}
			provider, exists := serviceOwners[name]
			if !exists {
				diagnostics = append(diagnostics, PrepareDiagnostic{
					Code:       CodeServiceMissing,
					Detail:     fmt.Sprintf("%s 需要的服务 %s 没有任何启用的插件提供", instanceID, name),
					InstanceID: instanceID,
					Service:    name,
				})
				continue
			}
			if !SatisfiesSemverRange(provider.version, versionRange) {
				diagnostics = append(diagnostics, PrepareDiagnostic{
					Code:       CodeServiceVersionMismatch,
					Detail:     fmt.Sprintf("%s 需要 %s@%s，%s 提供的是 %s", instanceID, name, versionRange, provider.instanceID, provider.version),
					InstanceID: instanceID,
					Service:    name,
				})
				continue
			}
			if provider.instanceID != instanceID {
				depSet[provider.instanceID] = struct{}{}
			}
		}
		deps := make([]string, 0, len(depSet))
		for dep := range depSet {
			deps = append(deps, dep)
		}
		sort.Strings(deps)
		edges[instanceID] = deps
	}

	nodes := make([]string, 0, len(byInstance))
	for instanceID := range byInstance {
		nodes = append(nodes, instanceID)
	}
	sort.Strings(nodes)

	cycle := findCycle(edges, nodes)
	if len(cycle) > 0 {
		diagnostics = append(diagnostics, PrepareDiagnostic{
			Code:   CodeDependencyCycle,
			Detail: fmt.Sprintf("服务依赖成环：%s", strings.Join(cycle, " → ")),
			Cycle:  cycle,
		})
	}

	order := make([]string, 0, len(nodes))
	if len(cycle) == 0 {
		done := make(map[string]bool, len(nodes))
		var place func(string)
		place = func(node string) {
			if done[node] {
				return
			}
			for _, dep := range edges[node] {
				place(dep)
			}
			done[node] = true
			order = append(order, node)
		}
		for _, node := range nodes {
			place(node)
		}
	}

	return GenerationPlan{
		OK:          len(diagnostics) == 0,
		Diagnostics: diagnostics,
		Order:       order,
	}
}

func findCycle(edges map[string][]string, nodes []string) []string {
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make(map[string]int, len(nodes))
	stack := make([]string, 0, len(nodes))

	var visit func(string) []string
	visit = func(node string) []string {
		color[node] = gray
		stack = append(stack, node)
		for _, next := range edges[node] {
			switch color[next] {
			case gray:
				idx := -1
				for i, item := range stack {
					if item == next {
						idx = i
						break
					}
				}
				if idx >= 0 {
					cycle := make([]string, 0, len(stack)-idx+1)
					cycle = append(cycle, stack[idx:]...)
					cycle = append(cycle, next)
					return cycle
				}
			case white:
				if found := visit(next); len(found) > 0 {
					return found
				}
			}
		}
		stack = stack[:len(stack)-1]
		color[node] = black
		return nil
	}

	for _, node := range nodes {
		if color[node] == white {
			if found := visit(node); len(found) > 0 {
				return found
			}
		}
	}
	return nil
}

func stringField(m map[string]any, key string) string {
	if len(m) == 0 {
		return ""
	}
	v, ok := m[key].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(v)
}

func mapSlice(m map[string]any, key string) []map[string]any {
	if len(m) == 0 {
		return nil
	}
	raw, ok := m[key]
	if !ok || raw == nil {
		return nil
	}
	switch typed := raw.(type) {
	case []map[string]any:
		return typed
	case []any:
		out := make([]map[string]any, 0, len(typed))
		for _, elem := range typed {
			if item, ok := elem.(map[string]any); ok {
				out = append(out, item)
			}
		}
		return out
	default:
		return nil
	}
}
