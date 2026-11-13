package webuiegresspoolapi

import (
	"context"

	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
)

// PoolManager 定义 Go 出口池完整运行态、节点操作、策略与资源查询接口。
// 注入该端口时，Handler 承接完整读写与分页契约；未注入时回退到只读 go_partial 契约以兼容早期测试。
type PoolManager interface {
	DescribePool(ctx context.Context, query runtimeegress.PoolQueryOptions) (*runtimeegress.PoolDescribeResult, string, error)
	ProbePoolNodes(ctx context.Context, nodeName string) runtimeegress.PoolActionResult
	SelectPoolNode(ctx context.Context, nodeName string) runtimeegress.PoolActionResult
	ClearPoolNodeCooldown(ctx context.Context, nodeName string) runtimeegress.PoolActionResult
	SetPoolNodeBlocked(ctx context.Context, nodeName string, blocked bool, reason string) runtimeegress.PoolActionResult
	ReadNodePolicySummary(ctx context.Context) runtimeegress.NodePolicySummary
	UpdateNodePolicy(ctx context.Context, patch runtimeegress.NodePolicyPatch) runtimeegress.PoolActionResult
	ClearDisabledNodePolicy(ctx context.Context) runtimeegress.PoolActionResult
	ListPoolGroupsTree(ctx context.Context) []runtimeegress.ResourceGroupView
	ListPoolsView(ctx context.Context) []runtimeegress.ResourcePoolView
	GetPoolView(ctx context.Context, poolID string) (*runtimeegress.ResourcePoolView, bool)
	GetNodeView(ctx context.Context, nodeID string) (*runtimeegress.ResourceNodeView, bool)
	BuildDiagnosticView(ctx context.Context, query runtimeegress.AccountDiagnosticQuery) runtimeegress.AccountDiagnosticView
}

// Source 读出口池的配置事实：服务是否在跑、当前选择、节点清单。
//
// 对应 Node 的 describeEgressPool（lib/runtime/egress-pool-registry.js）：
// 没有登记出口池服务时返回 Pool{Available:false}，而不是返回 error ——
// 「池没起」是正常状态，「读不出来」才是错误。
type Source interface {
	ReadEgressPool(ctx context.Context) (Pool, error)
}

// Pool 是出口池的配置快照。
//
// Available 为 false 时 Nodes 必须留空：此时「没有出口池」与「池里没有节点」
// 是两件不同的事，传输层会据此输出 nodes:null 而不是空数组。
type Pool struct {
	Available bool
	Status    Status
	Nodes     []Node
}

// Status 是出口池服务的运行态（对应 Node 的 status，只取标量部分）。
//
// 节点数、活动节点下标、冷却数都由传输层从 Nodes 现算，避免端口给出与节点表
// 自相矛盾的值；workDir / dnsProbe / lanes / laneOverflow 属于另一批视图，不在此列。
type Status struct {
	Ready           bool
	ProxyURL        string
	ActiveNode      string
	LastError       string
	ProbeIntervalMS int64
	ProbePort       int
	LaneSlots       int
}

// Node 是池里的一个节点。
//
// 只含出口身份（协议 / 服务器 / 端口）与展示字段，凭据从不出现在这里 ——
// 与 Node 的节点账本同一约束。
type Node struct {
	Name        string
	NodeID      string
	Label       string
	Protocol    string
	Server      string
	Port        int
	CountryCode string
	CountryFlag string
	// Enabled 来自节点来源配置：所属订阅被停用的节点不进池。
	Enabled bool
}

// Health 读节点账本：冷却、拦截、最近一次探测结果。
//
// 整表一次读出，与 Node 的 healthSnapshot 同口径（那边也是一次性拿全量快照）。
// 返回的 map 以节点名为键；缺键表示该节点还没有账本记录，按空账本处理。
//
// 这是可选端口：不接线时响应仍给出节点清单，只是冷却与探测整块不填，
// 并在 unavailable_sources 里标注 node_health。
type Health interface {
	SnapshotNodeHealth(ctx context.Context) (map[string]NodeHealth, error)
}

// NodeHealth 是单个节点的账本事实，尚未换算成展示态。
//
// 冷却是否生效、剩余多久由传输层按读取时刻现算（Node 的 snapshot 也是这么做的），
// 端口只给账本里的事实，避免端口自己持有时钟造成两个真相。
type NodeHealth struct {
	CooldownUntilMS int64
	CooldownKind    string
	Blocked         bool
	BlockedReason   string
	BlockedDetail   string
	Probe           *Probe
}

// Probe 是最近一次探测结果（对应 Node 的 probe 对象）。
type Probe struct {
	OK        bool
	LatencyMS int64
	AtMS      int64
	Error     string
	// Source 标注探测来源：core = 内核探测，library = 节点库里的 TCP 建连实测。
	Source string
}
