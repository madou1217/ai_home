package persistent

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultJanitorInterval 是后台持久会话回收器的默认巡检周期（30 分钟）。
	DefaultJanitorInterval = 30 * time.Minute
	// MinJanitorInterval 是允许的最小后台巡检间隔（60 秒），防止高频枚举 tmux。
	MinJanitorInterval = 60 * time.Second
)

// JanitorLogger 接收巡检日志与非致命告警。
type JanitorLogger interface {
	Info(message string)
	Warn(message string)
}

// JanitorOptions 配置持久会话后台回收调度器。
type JanitorOptions struct {
	Collector    SessionCollector
	Closer       SessionCloser
	PruneSockets func(ctx context.Context) (SocketPruneSummary, error)
	Interval     time.Duration
	Env          func(string) string
	Now          func() time.Time
	Policy       *ReapPolicy
	Logger       JanitorLogger
}

// JanitorRunResult 描述单次 RunNow 的回收结果。
type JanitorRunResult struct {
	Ran      bool                `json:"ran"`
	Skipped  bool                `json:"skipped"`
	Reason   string              `json:"reason,omitempty"`
	Sessions ReapResult          `json:"sessions"`
	Sockets  *SocketPruneSummary `json:"sockets,omitempty"`
}

// Janitor 定期扫描空闲持久会话、回收超时/超量会话并顺带清理死 tmux socket。
type Janitor struct {
	collector    SessionCollector
	closer       SessionCloser
	pruneSockets func(ctx context.Context) (SocketPruneSummary, error)
	interval     time.Duration
	env          func(string) string
	now          func() time.Time
	policy       *ReapPolicy
	logger       JanitorLogger

	mu      sync.Mutex
	started bool
	running bool
	stopCh  chan struct{}
	wg      sync.WaitGroup
}

// NewJanitor 创建持久会话清理调度器，自动夹紧最小间隔至 MinJanitorInterval。
func NewJanitor(opts JanitorOptions) *Janitor {
	interval := opts.Interval
	if interval <= 0 {
		interval = DefaultJanitorInterval
	} else if interval < MinJanitorInterval {
		interval = MinJanitorInterval
	}
	pruneSockets := opts.PruneSockets
	if pruneSockets == nil {
		pruneSockets = func(ctx context.Context) (SocketPruneSummary, error) {
			return PruneStaleTmuxSockets(ctx, SocketPruneOptions{})
		}
	}
	return &Janitor{
		collector:    opts.Collector,
		closer:       opts.Closer,
		pruneSockets: pruneSockets,
		interval:     interval,
		env:          opts.Env,
		now:          opts.Now,
		policy:       opts.Policy,
		logger:       opts.Logger,
	}
}

// Start 启动后台周期巡检协程；重复调用返回 false。
func (janitor *Janitor) Start(ctx context.Context) bool {
	if janitor == nil || janitor.collector == nil || janitor.closer == nil {
		return false
	}
	janitor.mu.Lock()
	defer janitor.mu.Unlock()
	if janitor.started {
		return false
	}
	if ctx == nil {
		ctx = context.Background()
	}
	stopCh := make(chan struct{})
	janitor.started = true
	janitor.stopCh = stopCh
	janitor.wg.Add(1)
	go janitor.loop(ctx, stopCh)
	return true
}

// Stop 停止后台巡检并等待已退出的循环协程完成。
func (janitor *Janitor) Stop() bool {
	if janitor == nil {
		return false
	}
	janitor.mu.Lock()
	if !janitor.started {
		janitor.mu.Unlock()
		return false
	}
	stopCh := janitor.stopCh
	janitor.started = false
	janitor.stopCh = nil
	close(stopCh)
	janitor.mu.Unlock()

	janitor.wg.Wait()
	return true
}

// RunNow 立即执行一轮空闲会话回收与死 socket 清理；若已有巡检进行中则跳过。
func (janitor *Janitor) RunNow(ctx context.Context) (JanitorRunResult, error) {
	if janitor == nil || janitor.collector == nil || janitor.closer == nil {
		return JanitorRunResult{Skipped: true, Reason: "unconfigured"}, ErrInvalidManager
	}
	if ctx == nil {
		ctx = context.Background()
	}

	janitor.mu.Lock()
	if janitor.running {
		janitor.mu.Unlock()
		return JanitorRunResult{Skipped: true, Reason: "running"}, nil
	}
	janitor.running = true
	janitor.mu.Unlock()

	defer func() {
		janitor.mu.Lock()
		janitor.running = false
		janitor.mu.Unlock()
	}()

	rows, err := janitor.collector.CollectSessions(ctx)
	if err != nil {
		if janitor.logger != nil {
			janitor.logger.Warn(fmt.Sprintf("空闲会话回收失败：%v", err))
		}
		return JanitorRunResult{Ran: true}, err
	}

	reapResult := ReapIdleSessions(ctx, rows, ReapOptions{
		Env:    janitor.env,
		Now:    janitor.now,
		Policy: janitor.policy,
		Closer: janitor.closer,
	})
	if message := strings.TrimSpace(DescribeReapResult(reapResult)); message != "" && janitor.logger != nil {
		janitor.logger.Info(message)
	}

	var socketSummary *SocketPruneSummary
	if janitor.pruneSockets != nil {
		if pruned, pruneErr := janitor.pruneSockets(ctx); pruneErr == nil {
			socketSummary = &pruned
			if pruned.Removed > 0 && janitor.logger != nil {
				janitor.logger.Info(fmt.Sprintf("清理失效 tmux socket：删除 %d 个（扫描 %d，保留 %d）", pruned.Removed, pruned.Scanned, pruned.Kept))
			}
		} else if janitor.logger != nil {
			janitor.logger.Warn(fmt.Sprintf("清理失效 tmux socket 失败：%v", pruneErr))
		}
	}

	return JanitorRunResult{
		Ran:      true,
		Sessions: reapResult,
		Sockets:  socketSummary,
	}, nil
}

func (janitor *Janitor) loop(ctx context.Context, stopCh <-chan struct{}) {
	defer janitor.wg.Done()
	ticker := time.NewTicker(janitor.interval)
	defer ticker.Stop()

	for {
		select {
		case <-stopCh:
			return
		case <-ctx.Done():
			janitor.mu.Lock()
			if janitor.stopCh == stopCh {
				janitor.started = false
				janitor.stopCh = nil
			}
			janitor.mu.Unlock()
			return
		case <-ticker.C:
			_, _ = janitor.RunNow(ctx)
		}
	}
}
