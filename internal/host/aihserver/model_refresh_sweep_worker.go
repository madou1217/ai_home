package aihserver

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"
)

const (
	// modelRefreshSweepInitialDelay 让启动流量和首次恢复先完成，再修正过期目录。
	modelRefreshSweepInitialDelay = 2 * time.Minute
	// modelRefreshSweepInterval 是全量已启用账号模型目录的重扫周期。
	modelRefreshSweepInterval = 6 * time.Hour
	// routeMissRefreshMinInterval 是同 Provider 路由未命中触发重扫的最小间隔。
	routeMissRefreshMinInterval = 5 * time.Minute
	// modelRefreshSweepTimeout 限制一次重扫的本地查询和入队时间。
	modelRefreshSweepTimeout = 30 * time.Second
)

// modelRefreshSweeper 是周期 worker 依赖的最小应用端口。
type modelRefreshSweeper interface {
	Sweep(ctx context.Context) error
}

// modelRefreshSweepWorker 持有周期重扫的取消和等待生命周期。
type modelRefreshSweepWorker struct {
	cancel    context.CancelFunc
	done      chan struct{}
	closeOnce sync.Once
}

// startModelRefreshSweepWorker 延迟后按固定周期重扫；每轮只入队，不等待上游发现。
func startModelRefreshSweepWorker(
	parent context.Context,
	sweeper modelRefreshSweeper,
	initialDelay time.Duration,
	interval time.Duration,
	errorLog *log.Logger,
) (*modelRefreshSweepWorker, error) {
	if parent == nil || sweeper == nil || initialDelay <= 0 || interval <= 0 {
		return nil, ErrInvalidOptions
	}
	ctx, cancel := context.WithCancel(parent)
	worker := &modelRefreshSweepWorker{
		cancel: cancel,
		done:   make(chan struct{}),
	}
	go func() {
		defer close(worker.done)
		timer := time.NewTimer(initialDelay)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
			sweepCtx, sweepCancel := context.WithTimeout(ctx, modelRefreshSweepTimeout)
			err := sweeper.Sweep(sweepCtx)
			sweepCancel()
			if err != nil && !errors.Is(err, context.Canceled) && errorLog != nil {
				errorLog.Printf("账号模型目录周期重扫失败: %v", err)
			}
			timer.Reset(interval)
		}
	}()
	return worker, nil
}

// Close 取消周期重扫并等待退出，调用方随后才能关闭协调器和 Store。
func (worker *modelRefreshSweepWorker) Close() error {
	if worker == nil {
		return nil
	}
	worker.closeOnce.Do(func() {
		worker.cancel()
		<-worker.done
	})
	return nil
}
