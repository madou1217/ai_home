package accountactivity

// 领取执行器的端口与「有界并发 + 速率限制」的闸门。
//
// 为什么闸门放在 Go：这五条路由的并发控制是本次迁移的核心 —— 探测、批量、单账号
// 三条路径打的是同一个上游端点，Node 侧实测 4 个并发 preview 里 3 个 429。
// 于是这里强制：
//   * 全局同时只允许一个上游调用（MaxConcurrentExecutions）；
//   * 同一 (provider, actionId) 两次调用之间至少间隔 MinExecutionInterval，
//     避免快速失败的账号把上游打成突发；
//   * 等待可被请求上下文取消，不会把 HTTP 连接挂死。
//
// 执行本身委托给 Executor（生产实现是 Node 桥：provider handler、无痕验证码、
// 设备指纹这些只有 Node 运行时具备）。Go 只负责排队、限速、聚合与状态。

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
)

// MaxConcurrentExecutions 是全局并发上限；1 = 串行（与 Node 的全局串行队列一致）。
const MaxConcurrentExecutions = 1

// MinExecutionInterval 是同一动作两次上游调用之间的最小间隔。
const MinExecutionInterval = 250 * time.Millisecond

// ErrExecutorUnavailable 表示没有可用的执行器（Node 桥未接线）。
var ErrExecutorUnavailable = errors.New("activity_executor_unavailable")

// ExecutionRequest 是一次单账号领取/探测请求。
type ExecutionRequest struct {
	Provider   string
	AccountRef string
	ActionID   string
	Params     map[string]any
	DryRun     bool
}

// Executor 执行单账号动作并返回结构化结果。
type Executor interface {
	Execute(ctx context.Context, request ExecutionRequest) (map[string]any, error)
}

// ExecutionGate 串行化上游调用并施加最小间隔。
type ExecutionGate struct {
	slots chan struct{}
	mu    sync.Mutex
	next  map[string]time.Time
	now   func() time.Time
}

// NewExecutionGate 创建闸门。
func NewExecutionGate(now func() time.Time) *ExecutionGate {
	if now == nil {
		now = time.Now
	}
	return &ExecutionGate{
		slots: make(chan struct{}, MaxConcurrentExecutions),
		next:  map[string]time.Time{},
		now:   now,
	}
}

// Execute 通过闸门调用执行器。
func (gate *ExecutionGate) Execute(
	ctx context.Context,
	executor Executor,
	request ExecutionRequest,
) (map[string]any, error) {
	if executor == nil {
		return nil, ErrExecutorUnavailable
	}
	select {
	case gate.slots <- struct{}{}:
		defer func() { <-gate.slots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	key := strings.ToLower(strings.TrimSpace(request.Provider)) + ":" + strings.ToLower(strings.TrimSpace(request.ActionID))
	if err := gate.wait(ctx, key); err != nil {
		return nil, err
	}
	return executor.Execute(ctx, request)
}

func (gate *ExecutionGate) wait(ctx context.Context, key string) error {
	for {
		gate.mu.Lock()
		now := gate.now()
		next := gate.next[key]
		gate.mu.Unlock()
		waitFor := next.Sub(now)
		if waitFor <= 0 {
			break
		}
		timer := time.NewTimer(waitFor)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	gate.mu.Lock()
	gate.next[key] = gate.now().Add(MinExecutionInterval)
	gate.mu.Unlock()
	return nil
}
