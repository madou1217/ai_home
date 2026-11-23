// Package pluginruntime 是 Go 数据面使用插件发布投影的应用层。
//
// 发布投影由 Go 的插件宿主构建：每个活跃或排空中的代次是一份不可变投影，
// 由宿主替换进 Registry。数据面默认按活跃代次（最高代次）执行插件阶段；
// 内部转发仍可携带代次号把请求固定到某个代次。本包只依赖窄的 Invoker 端口，
// 不关心 socket、令牌或 HTTP。
package pluginruntime

import (
	"context"
	"encoding/json"
	"errors"
	"path"
	"sort"
	"sync"
	"time"
)

// ErrInvalidProjection 表示推送的投影结构无效。
var ErrInvalidProjection = errors.New("插件发布投影无效")

// ContributionScope 声明贡献项只在哪些 Provider / Host / 模型上生效。
// 空维度表示不限制；调用方拿不到对应值时也不做过滤，避免静默跳过插件。
type ContributionScope struct {
	Providers []string `json:"providers,omitempty"`
	Hosts     []string `json:"hosts,omitempty"`
	Models    []string `json:"models,omitempty"`
}

func (scope *ContributionScope) empty() bool {
	return scope == nil || (len(scope.Providers) == 0 && len(scope.Hosts) == 0 && len(scope.Models) == 0)
}

// Contribution 是投影里的一个贡献项（与 Node 快照字段一致）。
type Contribution struct {
	ID            string             `json:"id"`
	Capability    string             `json:"capability"`
	Order         int                `json:"order"`
	FailurePolicy string             `json:"failurePolicy"`
	InstanceID    string             `json:"instanceId"`
	Scope         *ContributionScope `json:"scope,omitempty"`
}

// Applies 报告贡献项是否适用于本次调用。provider/host 为精确匹配（支持 *）；
// model 支持 path.Match 通配（例如 gpt-*）。对应维度为空时不限制。
func (item Contribution) Applies(provider, host, model string) bool {
	if item.Scope.empty() {
		return true
	}
	if provider != "" && !matchesScopeList(item.Scope.Providers, provider, false) {
		return false
	}
	if host != "" && !matchesScopeList(item.Scope.Hosts, host, false) {
		return false
	}
	if model != "" && !matchesScopeList(item.Scope.Models, model, true) {
		return false
	}
	return true
}

func matchesScopeList(patterns []string, value string, allowGlob bool) bool {
	if len(patterns) == 0 {
		return true
	}
	for _, pattern := range patterns {
		if pattern == "*" || pattern == value {
			return true
		}
		if allowGlob {
			if matched, err := path.Match(pattern, value); err == nil && matched {
				return true
			}
		}
	}
	return false
}

// Projection 是一个代次的不可变贡献快照。
type Projection struct {
	Generation    int64          `json:"generation"`
	Contributions []Contribution `json:"contributions"`
}

// ByCapability 返回某能力的全部贡献项，按 order、instanceId、id 稳定排序（与 Node buildSnapshot 一致）。
func (projection Projection) ByCapability(capability string) []Contribution {
	return projection.ByCapabilityFor(capability, "", "", "")
}

// ByCapabilityFor 返回某能力且适用于给定 Provider / Host / 模型的贡献项。
func (projection Projection) ByCapabilityFor(capability, provider, host, model string) []Contribution {
	items := make([]Contribution, 0)
	for _, item := range projection.Contributions {
		if item.Capability == capability && item.Applies(provider, host, model) {
			items = append(items, item)
		}
	}
	sort.SliceStable(items, func(left, right int) bool {
		if items[left].Order != items[right].Order {
			return items[left].Order < items[right].Order
		}
		if items[left].InstanceID != items[right].InstanceID {
			return items[left].InstanceID < items[right].InstanceID
		}
		return items[left].ID < items[right].ID
	})
	return items
}

// Has 报告投影是否含某能力的贡献项。
func (projection Projection) Has(capability string) bool {
	for _, item := range projection.Contributions {
		if item.Capability == capability {
			return true
		}
	}
	return false
}

func (projection Projection) valid() bool {
	if projection.Generation <= 0 {
		return false
	}
	for _, item := range projection.Contributions {
		if item.ID == "" || item.Capability == "" || item.InstanceID == "" ||
			(item.FailurePolicy != "deny" && item.FailurePolicy != "delegate") {
			return false
		}
	}
	return true
}

// EmbeddedInvoker 是不依赖本机 socket 的插件调用端口（process-only 代次使用）。
type EmbeddedInvoker interface {
	InvokeEmbedded(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration) (json.RawMessage, error)
}

// EmbeddedReverseInvoker 是可选的带反向调用版本（gateway.attempt next）。
type EmbeddedReverseInvoker interface {
	InvokeEmbeddedReverse(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration, onCall ReverseCall) (json.RawMessage, error)
}

// HostAccess 是连接 Plugin Host 所需的本机地址与令牌（只经管理接口传入，不落日志）。
type HostAccess struct {
	Address string
	Token   string
}

// Registry 保存插件宿主推送的全部存活代次；整体替换，读多写少。
type Registry struct {
	mu                    sync.RWMutex
	host                  HostAccess
	embedded              EmbeddedInvoker
	embeddedContributions map[string]bool
	generations           map[int64]Projection
	// accountRefs 把 Go 账号引用翻译成 Node 的账号引用（历史账号同步后两边可能不同），
	// 让观察事件里的 accountRef 与 Node 路径一致。只含两边不同的条目。
	accountRefs map[string]string
}

// NewRegistry 创建空注册表（没有任何代次时所有请求都不经过插件）。
func NewRegistry() *Registry {
	return &Registry{generations: map[int64]Projection{}}
}

// Replace 用插件宿主推送的完整存活集合替换当前内容，返回已接受的代次。
// 任一投影无效时整体拒绝，保留原内容。
func (registry *Registry) Replace(host HostAccess, projections []Projection, accountRefs map[string]string) ([]int64, error) {
	next := make(map[int64]Projection, len(projections))
	for _, projection := range projections {
		if !projection.valid() {
			return nil, ErrInvalidProjection
		}
		contributions := append([]Contribution(nil), projection.Contributions...)
		next[projection.Generation] = Projection{Generation: projection.Generation, Contributions: contributions}
	}
	if len(next) > 0 && (host.Address == "" || host.Token == "") && registry.embedded == nil {
		return nil, ErrInvalidProjection
	}
	refs := make(map[string]string, len(accountRefs))
	for goRef, nodeRef := range accountRefs {
		if goRef != "" && nodeRef != "" {
			refs[goRef] = nodeRef
		}
	}
	registry.mu.Lock()
	registry.host = host
	registry.generations = next
	registry.accountRefs = refs
	registry.mu.Unlock()
	accepted := make([]int64, 0, len(next))
	for generation := range next {
		accepted = append(accepted, generation)
	}
	sort.Slice(accepted, func(left, right int) bool { return accepted[left] < accepted[right] })
	return accepted, nil
}

// SetEmbeddedInvoker 设置不依赖 socket 的调用端口；进程后端只依赖它。
func (registry *Registry) SetEmbeddedInvoker(invoker EmbeddedInvoker) {
	registry.mu.Lock()
	registry.embedded = invoker
	registry.mu.Unlock()
}

// EmbeddedInvoker 返回当前内嵌调用端口（可能为 nil）。
func (registry *Registry) EmbeddedInvoker() EmbeddedInvoker {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	return registry.embedded
}

// SetEmbeddedContributions 标记由内嵌运行时承载的贡献项（process 插件）。
func (registry *Registry) SetEmbeddedContributions(contributions map[string]bool) {
	registry.mu.Lock()
	registry.embeddedContributions = contributions
	registry.mu.Unlock()
}

// IsEmbeddedContribution 报告该贡献项是否必须走内嵌运行时（而不是 Node socket）。
func (registry *Registry) IsEmbeddedContribution(contributionID string) bool {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	return registry.embeddedContributions[contributionID]
}

// Get 返回某代次的投影。
func (registry *Registry) Get(generation int64) (Projection, bool) {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	projection, ok := registry.generations[generation]
	return projection, ok
}

// Active 返回活跃代次（最高代次）的投影；没有存活代次时返回 false。
func (registry *Registry) Active() (Projection, bool) {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	var (
		active Projection
		found  bool
	)
	for generation, projection := range registry.generations {
		if !found || generation > active.Generation {
			active = Projection{
				Generation:    generation,
				Contributions: append([]Contribution(nil), projection.Contributions...),
			}
			found = true
		}
	}
	return active, found
}

// Snapshots 一次取回全部存活代次的不可变副本（按代次升序）。
//
// 与「先 Generations() 再逐个 Get()」相比，单次读锁保证诊断视图不会跨一次
// Replace 取到混合代次——列表一致性检查必须看同一瞬间的投影。
func (registry *Registry) Snapshots() []Projection {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	snapshots := make([]Projection, 0, len(registry.generations))
	for _, projection := range registry.generations {
		snapshots = append(snapshots, Projection{
			Generation:    projection.Generation,
			Contributions: append([]Contribution(nil), projection.Contributions...),
		})
	}
	sort.Slice(snapshots, func(left, right int) bool {
		return snapshots[left].Generation < snapshots[right].Generation
	})
	return snapshots
}

// Generations 返回当前存活的代次（升序）。
func (registry *Registry) Generations() []int64 {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	generations := make([]int64, 0, len(registry.generations))
	for generation := range registry.generations {
		generations = append(generations, generation)
	}
	sort.Slice(generations, func(left, right int) bool { return generations[left] < generations[right] })
	return generations
}

// NodeAccountRef 把 Go 账号引用翻译成 Node 的账号引用；没有映射时原样返回。
func (registry *Registry) NodeAccountRef(goRef string) string {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	if nodeRef, ok := registry.accountRefs[goRef]; ok {
		return nodeRef
	}
	return goRef
}

// GoAccountRef 把 Node 账号引用翻译回 Go 账号引用；没有映射时原样返回。
func (registry *Registry) GoAccountRef(nodeRef string) string {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	for goRef, mapped := range registry.accountRefs {
		if mapped == nodeRef {
			return goRef
		}
	}
	return nodeRef
}

// Host 返回当前 Plugin Host 地址与令牌。
func (registry *Registry) Host() HostAccess {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	return registry.host
}
