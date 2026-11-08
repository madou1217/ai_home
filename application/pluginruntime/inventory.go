package pluginruntime

import (
	"encoding/json"
	"sort"
	"strings"
)

// 实例在 Go 投影里的三种状态。
const (
	// InstanceStatusProjected 表示实例的贡献项出现在当前活跃代次里。
	InstanceStatusProjected = "projected"
	// InstanceStatusRetiring 表示实例只出现在正在排空的旧代次里。
	InstanceStatusRetiring = "retiring"
	// InstanceStatusAbsent 表示所有存活代次里都没有该实例。
	InstanceStatusAbsent = "absent"
)

// 一致性问题码：与 Node doctor 的既有码保持同名，便于两条链路并排排障。
const (
	IssueInstalledInvalid          = "plugin_installed_invalid"
	IssueInstalledDuplicate        = "plugin_installed_duplicate"
	IssueInstanceDuplicate         = "plugin_instance_duplicate"
	IssueInstanceArtifactMissing   = "plugin_instance_artifact_missing"
	IssueInstanceNotProjected      = "plugin_instance_not_projected"
	IssueInstanceContributionDelta = "plugin_instance_contribution_mismatch"
	IssueProjectionOrphan          = "plugin_projection_orphan"
)

// LiveProjections 是 Go 已确认的存活代次来源（生产由 *Registry 实现）。
//
// 只暴露一次取齐的快照：一致性诊断不能跨两次读取拼出混合代次。
type LiveProjections interface {
	Snapshots() []Projection
}

// InstalledView 是列表里的已安装制品，字段与 Node control.list() 对齐。
type InstalledView struct {
	PluginID    string          `json:"pluginId"`
	Version     string          `json:"version"`
	Digest      string          `json:"digest"`
	InstalledAt int64           `json:"installedAt"`
	Signature   json.RawMessage `json:"signature"`
	Permissions json.RawMessage `json:"permissions"`
	Contributes []string        `json:"contributes"`
}

// InstanceView 是列表里的实例期望状态，字段与 Node control.list() 对齐。
//
// 配置只回显键名：值可能含用户填入的凭据，与 Node 的隐私边界一致。
type InstanceView struct {
	InstanceID            string   `json:"instanceId"`
	PluginID              string   `json:"pluginId"`
	Version               string   `json:"version"`
	Enabled               bool     `json:"enabled"`
	ConfigurationKeys     []string `json:"configurationKeys"`
	PermissionsAcceptedAt *int64   `json:"permissionsAcceptedAt"`
	UpdatedAt             int64    `json:"updatedAt"`
}

// RuntimeContribution 是活跃代次里的一个贡献项（由 Node 推送、Go 已确认）。
type RuntimeContribution struct {
	ID            string `json:"id"`
	Capability    string `json:"capability"`
	Order         int    `json:"order"`
	FailurePolicy string `json:"failurePolicy"`
	InstanceID    string `json:"instanceId"`
	Generation    int64  `json:"generation"`
}

// RuntimeInstance 把控制面实例与 Go 投影并排展示。
type RuntimeInstance struct {
	InstanceID    string  `json:"instanceId"`
	Status        string  `json:"status"`
	Generations   []int64 `json:"generations"`
	Contributions int     `json:"contributions"`
}

// RuntimeView 是 Go 数据面当前确认的插件运行态，不含 Node 宿主进程细节。
type RuntimeView struct {
	ActiveGeneration    int64                 `json:"activeGeneration"`
	Generations         []int64               `json:"generations"`
	RetiringGenerations []int64               `json:"retiringGenerations"`
	Contributions       []RuntimeContribution `json:"contributions"`
	Instances           []RuntimeInstance     `json:"instances"`
}

// Issue 是一条控制面与投影不一致的发现；detail 只写结构事实，不回显配置值。
type Issue struct {
	Code       string `json:"code"`
	PluginID   string `json:"pluginId,omitempty"`
	InstanceID string `json:"instanceId,omitempty"`
	Detail     string `json:"detail,omitempty"`
}

// Consistency 汇总一致性问题；没有发现问题时 Issues 仍是空数组而不是 null。
type Consistency struct {
	OK     bool    `json:"ok"`
	Issues []Issue `json:"issues"`
}

// Inventory 是只读插件清单的完整响应体（handler 再包 ok/readOnly/source 信封）。
type Inventory struct {
	Revision    int64           `json:"revision"`
	Installed   []InstalledView `json:"installed"`
	Instances   []InstanceView  `json:"instances"`
	Runtime     RuntimeView     `json:"runtime"`
	Consistency Consistency     `json:"consistency"`
}

// BuildInventory 把 Node 控制状态与 Go 已确认的存活代次拼成只读清单。
//
// 这里不做任何“自动修复”：控制面与投影不一致时只记录 Issue，让运维看到真实缺口。
func BuildInventory(state ControlState, live LiveProjections) Inventory {
	state = state.Normalize()
	inventory := Inventory{
		Revision:  state.Revision,
		Installed: make([]InstalledView, 0, len(state.Installed)),
		Instances: make([]InstanceView, 0, len(state.Instances)),
		Runtime: RuntimeView{
			Generations:         []int64{},
			RetiringGenerations: []int64{},
			Contributions:       []RuntimeContribution{},
			Instances:           []RuntimeInstance{},
		},
		Consistency: Consistency{OK: true, Issues: []Issue{}},
	}
	issues := make([]Issue, 0)

	// 已安装制品：按 pluginId@version 建索引，重复项保留首条并记录。
	installedIndex := make(map[string]InstalledRecord, len(state.Installed))
	for _, item := range state.Installed {
		contributes := make([]string, 0, len(item.Manifest.Contributes))
		for _, contribution := range item.Manifest.Contributes {
			if contribution.ID != "" {
				contributes = append(contributes, contribution.ID)
			}
		}
		inventory.Installed = append(inventory.Installed, InstalledView{
			PluginID:    item.PluginID,
			Version:     item.Version,
			Digest:      item.Digest,
			InstalledAt: item.InstalledAt,
			Signature:   signatureOrUnsigned(item.Signature),
			Permissions: item.Permissions,
			Contributes: contributes,
		})
		if item.PluginID == "" || item.Version == "" {
			issues = append(issues, Issue{Code: IssueInstalledInvalid, PluginID: item.PluginID, Detail: "已安装记录缺少 pluginId 或 version"})
			continue
		}
		key := installedKey(item.PluginID, item.Version)
		if _, found := installedIndex[key]; found {
			issues = append(issues, Issue{Code: IssueInstalledDuplicate, PluginID: item.PluginID, Detail: "同一 pluginId@version 存在多条已安装记录"})
			continue
		}
		installedIndex[key] = item
	}

	// 投影索引：实例 → 代次 → 活跃代次内的贡献项集合。
	snapshots := liveSnapshots(live)
	activeGeneration := int64(0)
	if len(snapshots) > 0 {
		activeGeneration = snapshots[len(snapshots)-1].Generation
	}
	inventory.Runtime.ActiveGeneration = activeGeneration
	inventory.Runtime.Generations = make([]int64, 0, len(snapshots))
	projectedGenerations := make(map[string][]int64)
	activeContributions := make(map[string]map[string]struct{})
	for _, projection := range snapshots {
		generation := projection.Generation
		inventory.Runtime.Generations = append(inventory.Runtime.Generations, generation)
		if generation < activeGeneration {
			inventory.Runtime.RetiringGenerations = append(inventory.Runtime.RetiringGenerations, generation)
		}
		for _, contribution := range projection.Contributions {
			projectedGenerations[contribution.InstanceID] = append(projectedGenerations[contribution.InstanceID], generation)
			if generation != activeGeneration {
				continue
			}
			inventory.Runtime.Contributions = append(inventory.Runtime.Contributions, RuntimeContribution{
				ID:            contribution.ID,
				Capability:    contribution.Capability,
				Order:         contribution.Order,
				FailurePolicy: contribution.FailurePolicy,
				InstanceID:    contribution.InstanceID,
				Generation:    generation,
			})
			if activeContributions[contribution.InstanceID] == nil {
				activeContributions[contribution.InstanceID] = make(map[string]struct{})
			}
			activeContributions[contribution.InstanceID][contribution.ID] = struct{}{}
		}
	}

	// 控制面实例：保持 Node 的记录顺序，重复 instanceId 只认首条。
	seenInstances := make(map[string]struct{}, len(state.Instances))
	enabledInstances := make(map[string]InstanceRecord, len(state.Instances))
	for _, instance := range state.Instances {
		inventory.Instances = append(inventory.Instances, InstanceView{
			InstanceID:            instance.InstanceID,
			PluginID:              instance.PluginID,
			Version:               instance.Version,
			Enabled:               instance.Enabled,
			ConfigurationKeys:     instance.sortedConfigurationKeys(),
			PermissionsAcceptedAt: instance.PermissionsAcceptedAt,
			UpdatedAt:             instance.UpdatedAt,
		})
		if instance.InstanceID == "" {
			issues = append(issues, Issue{Code: IssueInstanceDuplicate, PluginID: instance.PluginID, Detail: "实例缺少 instanceId"})
			continue
		}
		if _, found := seenInstances[instance.InstanceID]; found {
			issues = append(issues, Issue{Code: IssueInstanceDuplicate, PluginID: instance.PluginID, InstanceID: instance.InstanceID, Detail: "同一 instanceId 出现多次"})
			continue
		}
		seenInstances[instance.InstanceID] = struct{}{}
		if instance.Enabled {
			enabledInstances[instance.InstanceID] = instance
		}

		installed, found := installedIndex[installedKey(instance.PluginID, instance.Version)]
		if !found {
			issues = append(issues, Issue{Code: IssueInstanceArtifactMissing, PluginID: instance.PluginID, InstanceID: instance.InstanceID, Detail: "实例引用的插件版本未安装"})
		} else if instance.Enabled {
			issues = append(issues, instanceConsistencyIssues(instance, installed, activeContributions[instance.InstanceID])...)
		}
		if !instance.Enabled {
			if _, projected := activeContributions[instance.InstanceID]; projected {
				issues = append(issues, Issue{Code: IssueProjectionOrphan, PluginID: instance.PluginID, InstanceID: instance.InstanceID, Detail: "实例在控制面已停用，但仍出现在活跃代次投影里"})
			}
		}
	}

	// 投影里出现、控制面完全没有的实例同样只报告，不删投影。
	orphanIDs := make([]string, 0)
	for instanceID := range activeContributions {
		if _, found := seenInstances[instanceID]; !found {
			orphanIDs = append(orphanIDs, instanceID)
		}
	}
	sort.Strings(orphanIDs)
	for _, instanceID := range orphanIDs {
		issues = append(issues, Issue{Code: IssueProjectionOrphan, InstanceID: instanceID, Detail: "活跃代次投影里的实例在控制面不存在"})
	}

	// 运行态实例列表取控制面与投影的并集，便于直接看到“有投影没实例”。
	runtimeIDs := make(map[string]struct{}, len(seenInstances)+len(activeContributions))
	for instanceID := range seenInstances {
		runtimeIDs[instanceID] = struct{}{}
	}
	for instanceID := range projectedGenerations {
		runtimeIDs[instanceID] = struct{}{}
	}
	sortedRuntimeIDs := make([]string, 0, len(runtimeIDs))
	for instanceID := range runtimeIDs {
		sortedRuntimeIDs = append(sortedRuntimeIDs, instanceID)
	}
	sort.Strings(sortedRuntimeIDs)
	for _, instanceID := range sortedRuntimeIDs {
		projected := activeContributions[instanceID]
		status := InstanceStatusAbsent
		if len(projected) > 0 {
			status = InstanceStatusProjected
		} else if len(projectedGenerations[instanceID]) > 0 {
			status = InstanceStatusRetiring
		}
		inventory.Runtime.Instances = append(inventory.Runtime.Instances, RuntimeInstance{
			InstanceID:    instanceID,
			Status:        status,
			Generations:   sortedGenerations(projectedGenerations[instanceID]),
			Contributions: len(projected),
		})
	}

	inventory.Consistency.Issues = issues
	inventory.Consistency.OK = len(issues) == 0
	return inventory
}

// instanceConsistencyIssues 比较「已安装清单声明的贡献项」与「活跃代次里的贡献项」。
func instanceConsistencyIssues(
	instance InstanceRecord,
	installed InstalledRecord,
	projected map[string]struct{},
) []Issue {
	declared := make(map[string]struct{}, len(installed.Manifest.Contributes))
	declaredIDs := make([]string, 0, len(installed.Manifest.Contributes))
	for _, contribution := range installed.Manifest.Contributes {
		if contribution.ID == "" {
			continue
		}
		declared[contribution.ID] = struct{}{}
		declaredIDs = append(declaredIDs, contribution.ID)
	}
	// 清单本身没有贡献项时没有任何东西需要投影；不把“未出现在投影”当成故障。
	if len(declaredIDs) == 0 {
		return nil
	}
	missing := make([]string, 0)
	for _, id := range declaredIDs {
		if _, found := projected[id]; !found {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		return []Issue{{
			Code:       IssueInstanceNotProjected,
			PluginID:   instance.PluginID,
			InstanceID: instance.InstanceID,
			Detail:     "活跃代次缺少贡献项：" + strings.Join(missing, ", "),
		}}
	}
	extra := make([]string, 0)
	for id := range projected {
		if _, found := declared[id]; !found {
			extra = append(extra, id)
		}
	}
	if len(extra) > 0 {
		sort.Strings(extra)
		return []Issue{{
			Code:       IssueInstanceContributionDelta,
			PluginID:   instance.PluginID,
			InstanceID: instance.InstanceID,
			Detail:     "活跃代次出现清单未声明的贡献项：" + strings.Join(extra, ", "),
		}}
	}
	return nil
}

func installedKey(pluginID string, version string) string {
	return pluginID + "@" + version
}

func signatureOrUnsigned(signature json.RawMessage) json.RawMessage {
	if len(signature) == 0 || string(signature) == "null" {
		return json.RawMessage(`{"status":"unsigned"}`)
	}
	return signature
}

// liveSnapshots 取一次投影快照并按代次升序返回；没有投影时返回空切片。
func liveSnapshots(live LiveProjections) []Projection {
	if live == nil {
		return []Projection{}
	}
	snapshots := append([]Projection(nil), live.Snapshots()...)
	sort.SliceStable(snapshots, func(left, right int) bool {
		return snapshots[left].Generation < snapshots[right].Generation
	})
	return snapshots
}

func sortedGenerations(generations []int64) []int64 {
	sorted := append([]int64(nil), generations...)
	sort.Slice(sorted, func(left, right int) bool { return sorted[left] < sorted[right] })
	return sorted
}
