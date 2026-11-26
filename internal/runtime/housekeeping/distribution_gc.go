package housekeeping

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/distributioninstall"
)

// DefaultDistributionGCInterval 是发行产物垃圾清理的默认巡检周期（6 小时）。
const DefaultDistributionGCInterval = 6 * time.Hour

// MinDistributionGCInterval 是允许的最小巡检间隔（1 小时），避免频繁扫描磁盘。
const MinDistributionGCInterval = time.Hour

// DistributionGCLogger 接收单轮清理结果与告警。
type DistributionGCLogger interface {
	Info(message string)
	Warn(message string)
}

// DistributionGCOptions 配置发行产物（历史版本、旧安装备份、过期安装包）的定期清理。
type DistributionGCOptions struct {
	// Home 是 AI Home 数据目录（通常为 ~/.ai_home）。
	Home string
	// Interval 为巡检周期，小于 MinDistributionGCInterval 时向上夹紧。
	Interval time.Duration
	// Logger 可为空，为空时静默运行。
	Logger DistributionGCLogger
	// Now 便于测试注入时钟，可为空。
	Now func() time.Time
	// Prune 允许替换清理实现，可为空（默认使用发行包自身的保留策略）。
	Prune func(distributioninstall.PruneOptions) (distributioninstall.PruneReport, error)
}

// DistributionGC 周期性删除超过一个版本以上的发行垃圾：旧 pkg 版本目录、
// 已完成安装事务之外的历史备份、以及 updates/downloads 中过期的安装包。
// 当前安装版本与相邻一份版本会被保留，最多只损失一次回滚能力。
type DistributionGC struct {
	home     string
	interval time.Duration
	logger   DistributionGCLogger
	now      func() time.Time
	prune    func(distributioninstall.PruneOptions) (distributioninstall.PruneReport, error)

	mu      sync.Mutex
	started bool
	stopCh  chan struct{}
	wg      sync.WaitGroup
}

// NewDistributionGC 创建发行产物清理调度器。
func NewDistributionGC(options DistributionGCOptions) *DistributionGC {
	interval := options.Interval
	if interval <= 0 {
		interval = DefaultDistributionGCInterval
	} else if interval < MinDistributionGCInterval {
		interval = MinDistributionGCInterval
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	prune := options.Prune
	if prune == nil {
		prune = distributioninstall.PruneArtifacts
	}
	return &DistributionGC{
		home:     strings.TrimSpace(options.Home),
		interval: interval,
		logger:   options.Logger,
		now:      now,
		prune:    prune,
	}
}

// Start 启动后台巡检协程；Home 为空或重复启动时返回 false。
func (gc *DistributionGC) Start(ctx context.Context) bool {
	if gc == nil || gc.home == "" {
		return false
	}
	gc.mu.Lock()
	defer gc.mu.Unlock()
	if gc.started {
		return false
	}
	if ctx == nil {
		ctx = context.Background()
	}
	stopCh := make(chan struct{})
	gc.started = true
	gc.stopCh = stopCh
	gc.wg.Add(1)
	go gc.loop(ctx, stopCh)
	return true
}

// Stop 停止后台巡检并等待协程退出。
func (gc *DistributionGC) Stop() bool {
	if gc == nil {
		return false
	}
	gc.mu.Lock()
	if !gc.started {
		gc.mu.Unlock()
		return false
	}
	stopCh := gc.stopCh
	gc.started = false
	gc.stopCh = nil
	close(stopCh)
	gc.mu.Unlock()
	gc.wg.Wait()
	return true
}

// RunNow 立即执行一轮清理；与后台巡检并发安全，由清理实现自身的安装锁串行化。
func (gc *DistributionGC) RunNow(ctx context.Context) (distributioninstall.PruneReport, error) {
	var report distributioninstall.PruneReport
	if gc == nil || gc.home == "" {
		return report, ErrInvalidOptions
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return report, err
	}
	report, err := gc.prune(distributioninstall.PruneOptions{Home: gc.home, Now: gc.now()})
	if err != nil {
		if gc.logger != nil {
			gc.logger.Warn("发行产物清理告警: " + err.Error())
		}
		return report, err
	}
	if gc.logger != nil && (len(report.Removed) > 0 || len(report.Failed) > 0) {
		gc.logger.Info("发行产物清理完成: removed=" + strconv.Itoa(len(report.Removed)) +
			" kept=" + strconv.Itoa(len(report.Kept)) +
			" failed=" + strconv.Itoa(len(report.Failed)) +
			" freedMB=" + strconv.Itoa(int(report.FreedBytes/(1<<20))))
	}
	return report, nil
}

func (gc *DistributionGC) loop(ctx context.Context, stopCh chan struct{}) {
	defer gc.wg.Done()
	// 启动时先跑一轮：服务重启会重置周期计时器，开发期频繁重启/重复部署时
	// 6 小时周期可能永远等不到，历史 pkg 目录就会越堆越多。
	_, _ = gc.RunNow(ctx)
	timer := time.NewTimer(gc.interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-stopCh:
			return
		case <-timer.C:
			_, _ = gc.RunNow(ctx)
			timer.Reset(gc.interval)
		}
	}
}
