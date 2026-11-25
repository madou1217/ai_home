package pluginhost

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/pluginerr"
)

// HybridHost 按 manifest.runtime 把插件分给两个后端：
//   - node    → 现有 Supervisor（JS 插件运行时）
//   - process → ProcessHost（任意语言，行分隔 JSON-RPC）
//
// Node 后端同时提供数据面 socket；process 插件通过 Runtime.Invoke 调用。
// 一个能力只属于一个后端，Invoke 按 prepare 结果的贡献项路由。
type HybridHost struct {
	node    HostClient
	process *ProcessHost

	mu                   sync.RWMutex
	nodeStarted          bool
	processContributions map[string]bool
	// nodePreparedGeneration 是最近一次真正交给 node 宿主 prepare 的代次；
	// 0 表示该代次没有 node 插件参与，Activate 不应调用 node。
	nodePreparedGeneration int64
	log                    func(string)
}

func NewHybridHost(node HostClient, process *ProcessHost) *HybridHost {
	if process == nil {
		process = NewProcessHost(nil)
	}
	return &HybridHost{node: node, process: process, processContributions: map[string]bool{}}
}

// SetLog 注入宿主日志出口（仅用于诊断；为空时不输出）。
func (host *HybridHost) SetLog(log func(string)) {
	if host == nil {
		return
	}
	host.mu.Lock()
	host.log = log
	host.mu.Unlock()
}

func (host *HybridHost) Start(ctx context.Context) error {
	// Node 后端按需启动：process-only 代次不需要 Node 进程。
	return host.process.Start(ctx)
}

func (host *HybridHost) Stop(ctx context.Context) error {
	var first error
	if host.node != nil && host.nodeRunning() {
		if err := host.node.Stop(ctx); err != nil {
			first = err
		}
	}
	if err := host.process.Stop(ctx); err != nil && first == nil {
		first = err
	}
	return first
}

func (host *HybridHost) Prepare(ctx context.Context, generation int64, plugins []PluginSpec) (HostPrepareResult, error) {
	nodePlugins := make([]PluginSpec, 0, len(plugins))
	processPlugins := make([]PluginSpec, 0)
	for _, spec := range plugins {
		if strings.EqualFold(strings.TrimSpace(spec.Runtime), "process") {
			processPlugins = append(processPlugins, spec)
		} else {
			nodePlugins = append(nodePlugins, spec)
		}
	}
	result := HostPrepareResult{Generation: generation, State: "prepared"}
	processContributions := map[string]bool{}
	if len(processPlugins) > 0 {
		processResult, err := host.process.Prepare(ctx, generation, processPlugins)
		if err != nil {
			_ = host.process.Stop(context.Background())
			return HostPrepareResult{}, err
		}
		result.Contributions = append(result.Contributions, processResult.Contributions...)
		result.ProcessContributions = append(result.ProcessContributions, processResult.ProcessContributions...)
		result.Diagnostics = append(result.Diagnostics, processResult.Diagnostics...)
		for _, contributionID := range processResult.Contributions {
			processContributions[contributionID] = true
		}
	}
	if host.node != nil && len(nodePlugins) > 0 {
		if !host.nodeRunning() {
			if err := host.node.Start(ctx); err != nil {
				_ = host.process.Stop(context.Background())
				return HostPrepareResult{}, err
			}
			host.mu.Lock()
			host.nodeStarted = true
			host.mu.Unlock()
		}
		nodeResult, err := host.node.Prepare(ctx, generation, nodePlugins)
		if err != nil {
			_ = host.process.Stop(context.Background())
			return HostPrepareResult{}, err
		}
		result.Contributions = append(result.Contributions, nodeResult.Contributions...)
		result.Diagnostics = append(result.Diagnostics, nodeResult.Diagnostics...)
		result.Errors = append(result.Errors, nodeResult.Errors...)
		// 必须把 node 侧的拒绝透传上来。
		//
		// Node 在插件加载失败时返回 state="rejected" 且**不登记该代次**，
		// 但这里若不采纳它的 State，调用方会以为准备成功、接着 activate
		// 一个不存在的代次，最终只得到 plugin_generation_unknown——真正的原因
		// （哪个插件、为什么加载失败）被完全掩盖。真机实测：一个旧格式插件
		// 导致整台机器的插件宿主无法启动，日志里却只有这一行空泛错误。
		if nodeResult.State != "prepared" {
			result.State = nodeResult.State
			host.mu.Lock()
			host.nodePreparedGeneration = 0
			host.mu.Unlock()
			_ = host.process.Stop(context.Background())
			return result, nil
		}
	}
	host.mu.Lock()
	host.processContributions = processContributions
	// 记录本次 prepare 是否真的把这一代交给了 node 宿主。Activate 必须据此
	// 决定要不要调 node：node 宿主进程可能仍在运行（之前跑过 node 插件），
	// 但这一代只有 process 插件参与 prepare，node 侧没有该 generation 的
	// candidate，盲目 activate 会得到 plugin_generation_unknown
	// （真机实测：装载 2 个 process 插件时稳定复现）。
	host.nodePreparedGeneration = 0
	if host.node != nil && len(nodePlugins) > 0 {
		host.nodePreparedGeneration = generation
	}
	host.mu.Unlock()
	return result, nil
}

func (host *HybridHost) Activate(ctx context.Context, generation int64, retainPrevious bool) (HostActivateResult, error) {
	host.mu.RLock()
	nodePrepared := host.nodePreparedGeneration == generation
	host.mu.RUnlock()
	if host.node != nil && nodePrepared && host.nodeRunning() {
		if _, err := host.node.Activate(ctx, generation, retainPrevious); err != nil {
			return HostActivateResult{}, err
		}
	}
	if _, err := host.process.Activate(ctx, generation, retainPrevious); err != nil {
		return HostActivateResult{}, err
	}
	return HostActivateResult{Generation: generation, State: "active"}, nil
}

func (host *HybridHost) Invoke(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration) (json.RawMessage, error) {
	host.mu.RLock()
	isProcess := host.processContributions[contributionID]
	host.mu.RUnlock()
	if isProcess {
		return host.process.Invoke(ctx, generation, contributionID, value, timeout)
	}
	if host.node == nil {
		return nil, errProcessHostUnavailable
	}
	return host.node.Invoke(ctx, generation, contributionID, value, timeout)
}

func (host *HybridHost) InvokeReverse(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration, onCall func(context.Context, string, json.RawMessage) (any, error)) (json.RawMessage, error) {
	host.mu.RLock()
	isProcess := host.processContributions[contributionID]
	host.mu.RUnlock()
	if isProcess {
		return host.process.InvokeReverse(ctx, generation, contributionID, value, timeout, onCall)
	}
	if host.node == nil {
		return nil, errProcessHostUnavailable
	}
	reverse, ok := host.node.(HostReverseClient)
	if !ok {
		return nil, pluginerr.New("plugin_rpc_invalid", "当前宿主不支持反向调用")
	}
	return reverse.InvokeReverse(ctx, generation, contributionID, value, timeout, onCall)
}

func (host *HybridHost) Dispose(ctx context.Context, generation int64) (HostDisposeResult, error) {
	if host.node != nil && host.nodeRunning() {
		_, _ = host.node.Dispose(ctx, generation)
	}
	_, _ = host.process.Dispose(ctx, generation)
	return HostDisposeResult{Generation: generation, State: "disposed"}, nil
}

func (host *HybridHost) Status(ctx context.Context) (HostStatusResult, error) {
	result := HostStatusResult{Generations: []int64{}}
	if host.node != nil && host.nodeRunning() {
		nodeStatus, err := host.node.Status(ctx)
		if err == nil {
			result = nodeStatus
		}
	}
	processStatus, err := host.process.Status(ctx)
	if err != nil {
		return result, err
	}
	seen := map[int64]bool{}
	for _, generation := range result.Generations {
		seen[generation] = true
	}
	for _, generation := range processStatus.Generations {
		if !seen[generation] {
			result.Generations = append(result.Generations, generation)
		}
	}
	return result, nil
}

func (host *HybridHost) Ping(ctx context.Context) error {
	if host.node != nil && host.nodeRunning() {
		if err := host.node.Ping(ctx); err != nil {
			return err
		}
	}
	return host.process.Ping(ctx)
}

func (host *HybridHost) SocketPath() string {
	if host.node == nil || !host.nodeRunning() {
		return ""
	}
	return host.node.SocketPath()
}

func (host *HybridHost) Token() string {
	if host.node == nil || !host.nodeRunning() {
		return ""
	}
	return host.node.Token()
}

func (host *HybridHost) PID() int {
	if host.node == nil || !host.nodeRunning() {
		return host.process.PID()
	}
	return host.node.PID()
}

func (host *HybridHost) Running() bool {
	if host.node != nil && host.nodeRunning() {
		return true
	}
	return host.process.Running()
}

func (host *HybridHost) nodeRunning() bool {
	host.mu.RLock()
	defer host.mu.RUnlock()
	return host.nodeStarted
}

var _ HostClient = (*HybridHost)(nil)
