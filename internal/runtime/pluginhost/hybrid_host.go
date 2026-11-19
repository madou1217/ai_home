package pluginhost

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"
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
}

func NewHybridHost(node HostClient, process *ProcessHost) *HybridHost {
	if process == nil {
		process = NewProcessHost(nil)
	}
	return &HybridHost{node: node, process: process, processContributions: map[string]bool{}}
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
	}
	host.mu.Lock()
	host.processContributions = processContributions
	host.mu.Unlock()
	return result, nil
}

func (host *HybridHost) Activate(ctx context.Context, generation int64, retainPrevious bool) (HostActivateResult, error) {
	if host.node != nil && host.nodeRunning() {
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
