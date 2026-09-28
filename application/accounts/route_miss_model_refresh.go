package accounts

import (
	"context"
	"errors"
	"sync"
	"time"
)

var (
	// ErrInvalidRouteMissModelRefresh 表示路由未命中触发器缺少重扫端口、节流或时钟。
	ErrInvalidRouteMissModelRefresh = errors.New("路由未命中模型刷新触发器配置无效")
)

// ProviderModelRefreshSweeper 是触发器需要的单 Provider 重扫端口。
type ProviderModelRefreshSweeper interface {
	SweepProvider(ctx context.Context, providerID string) error
}

// RouteMissModelRefreshOptions 显式配置节流窗口、单次重扫上限和失败观察。
type RouteMissModelRefreshOptions struct {
	// Sweeper 执行本地候选查询和刷新入队。
	Sweeper ProviderModelRefreshSweeper
	// MinInterval 是同 Provider 两次重扫的最小间隔。
	MinInterval time.Duration
	// SweepTimeout 限制一次重扫的本地查询和入队时间。
	SweepTimeout time.Duration
	// Clock 提供节流时间。
	Clock Clock
	// Observer 接收重扫失败；为空时静默。
	Observer func(providerID string, err error)
}

// RouteMissModelRefresh 在已知 Provider 的精确路由未命中时异步重扫该 Provider。
//
// 路由目录只能被账号模型快照修正，而目录缺模型时请求在选账号前就失败，按账号的
// 纠错刷新永远不会触发。客户端可以任意构造模型名，因此按 Provider 节流且从不
// 阻塞调用方。
type RouteMissModelRefresh struct {
	mu          sync.Mutex
	sweeper     ProviderModelRefreshSweeper
	minInterval time.Duration
	timeout     time.Duration
	clock       Clock
	observer    func(providerID string, err error)
	lastSweep   map[string]time.Time
	ctx         context.Context
	cancel      context.CancelFunc
	running     sync.WaitGroup
	closed      bool
}

// NewRouteMissModelRefresh 创建按 Provider 节流的异步触发器。
func NewRouteMissModelRefresh(
	options RouteMissModelRefreshOptions,
) (*RouteMissModelRefresh, error) {
	if options.Sweeper == nil ||
		options.MinInterval <= 0 ||
		options.SweepTimeout <= 0 ||
		options.Clock == nil {
		return nil, ErrInvalidRouteMissModelRefresh
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &RouteMissModelRefresh{
		sweeper:     options.Sweeper,
		minInterval: options.MinInterval,
		timeout:     options.SweepTimeout,
		clock:       options.Clock,
		observer:    options.Observer,
		lastSweep:   make(map[string]time.Time),
		ctx:         ctx,
		cancel:      cancel,
	}, nil
}

// ReportRouteMiss 记录一次路由未命中；节流窗口外才启动后台重扫，立即返回。
func (refresh *RouteMissModelRefresh) ReportRouteMiss(providerID string) {
	if refresh == nil || providerID == "" {
		return
	}
	refresh.mu.Lock()
	now := refresh.clock()
	last, seen := refresh.lastSweep[providerID]
	if refresh.closed || (seen && now.Sub(last) < refresh.minInterval) {
		refresh.mu.Unlock()
		return
	}
	refresh.lastSweep[providerID] = now
	refresh.running.Add(1)
	refresh.mu.Unlock()

	go func() {
		defer refresh.running.Done()
		ctx, cancel := context.WithTimeout(refresh.ctx, refresh.timeout)
		defer cancel()
		err := refresh.sweeper.SweepProvider(ctx, providerID)
		if err != nil && !errors.Is(err, context.Canceled) && refresh.observer != nil {
			refresh.observer(providerID, err)
		}
	}()
}

// Close 停止接收新触发并等待进行中的重扫退出；调用方随后才能关闭协调器。
func (refresh *RouteMissModelRefresh) Close() error {
	if refresh == nil {
		return nil
	}
	refresh.mu.Lock()
	if refresh.closed {
		refresh.mu.Unlock()
		return nil
	}
	refresh.closed = true
	refresh.cancel()
	refresh.mu.Unlock()
	refresh.running.Wait()
	return nil
}
