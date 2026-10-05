// Package pluginruntime 是 Go 数据面使用插件发布投影的应用层。
//
// Node 控制面是代次的唯一 owner：它把每个活跃或排空中的代次的不可变投影推给 Go，
// 只把 Go 已确认的代次随请求转发（内部头带代次号）。Go 从不自行挑选「最新版本」，
// 只按请求携带的代次查投影、调用同一个 Plugin Host。本包只依赖窄的 Invoker 端口，
// 不关心 socket、令牌或 HTTP。
package pluginruntime

import (
	"errors"
	"sort"
	"sync"
)

// ErrInvalidProjection 表示推送的投影结构无效。
var ErrInvalidProjection = errors.New("插件发布投影无效")

// Contribution 是投影里的一个贡献项（与 Node 快照字段一致）。
type Contribution struct {
	ID            string `json:"id"`
	Capability    string `json:"capability"`
	Order         int    `json:"order"`
	FailurePolicy string `json:"failurePolicy"`
	InstanceID    string `json:"instanceId"`
}

// Projection 是一个代次的不可变贡献快照。
type Projection struct {
	Generation    int64          `json:"generation"`
	Contributions []Contribution `json:"contributions"`
}

// ByCapability 返回某能力的贡献项，按 order、instanceId、id 稳定排序（与 Node buildSnapshot 一致）。
func (projection Projection) ByCapability(capability string) []Contribution {
	items := make([]Contribution, 0)
	for _, item := range projection.Contributions {
		if item.Capability == capability {
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

// HostAccess 是连接 Plugin Host 所需的本机地址与令牌（只经管理接口传入，不落日志）。
type HostAccess struct {
	Address string
	Token   string
}

// Registry 保存 Node 推送的全部存活代次；整体替换，读多写少。
type Registry struct {
	mu          sync.RWMutex
	host        HostAccess
	generations map[int64]Projection
}

// NewRegistry 创建空注册表（没有任何代次时所有请求都不经过插件）。
func NewRegistry() *Registry {
	return &Registry{generations: map[int64]Projection{}}
}

// Replace 用 Node 推送的完整存活集合替换当前内容，返回已接受的代次。
// 任一投影无效时整体拒绝，保留原内容。
func (registry *Registry) Replace(host HostAccess, projections []Projection) ([]int64, error) {
	next := make(map[int64]Projection, len(projections))
	for _, projection := range projections {
		if !projection.valid() {
			return nil, ErrInvalidProjection
		}
		contributions := append([]Contribution(nil), projection.Contributions...)
		next[projection.Generation] = Projection{Generation: projection.Generation, Contributions: contributions}
	}
	if len(next) > 0 && (host.Address == "" || host.Token == "") {
		return nil, ErrInvalidProjection
	}
	registry.mu.Lock()
	registry.host = host
	registry.generations = next
	registry.mu.Unlock()
	accepted := make([]int64, 0, len(next))
	for generation := range next {
		accepted = append(accepted, generation)
	}
	sort.Slice(accepted, func(left, right int) bool { return accepted[left] < accepted[right] })
	return accepted, nil
}

// Get 返回某代次的投影。
func (registry *Registry) Get(generation int64) (Projection, bool) {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	projection, ok := registry.generations[generation]
	return projection, ok
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

// Host 返回当前 Plugin Host 地址与令牌。
func (registry *Registry) Host() HostAccess {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	return registry.host
}
