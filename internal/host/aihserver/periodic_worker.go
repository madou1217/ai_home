package aihserver

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"
)

// errInvalidPeriodicWorker 表示周期 worker 缺少上下文、回调或合理的时间参数。
var errInvalidPeriodicWorker = errors.New("周期 worker 配置无效")

// periodicWorker 是后台周期任务的统一生命周期载体。
//
// 模型目录重扫和失败探测重试共享同一套「延迟启动 → 固定周期执行 → 超时约束 →
// 关闭等待」语义；差异只在标签、周期和回调，不复制第二份 goroutine 生命周期代码。
type periodicWorker struct {
	cancel    context.CancelFunc
	done      chan struct{}
	closeOnce sync.Once
}

// startPeriodicWorker 延迟 initialDelay 后按 interval 周期执行 run。
//
// 每次执行有独立的 timeout；单轮失败只记录日志，不终止后续周期。
func startPeriodicWorker(
	parent context.Context,
	initialDelay time.Duration,
	interval time.Duration,
	timeout time.Duration,
	label string,
	run func(context.Context) error,
	errorLog *log.Logger,
) (*periodicWorker, error) {
	if parent == nil || run == nil ||
		initialDelay <= 0 || interval <= 0 || timeout <= 0 {
		return nil, errInvalidPeriodicWorker
	}
	ctx, cancel := context.WithCancel(parent)
	worker := &periodicWorker{
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
			runCtx, runCancel := context.WithTimeout(ctx, timeout)
			err := run(runCtx)
			runCancel()
			if err != nil && !errors.Is(err, context.Canceled) && errorLog != nil {
				errorLog.Printf("%s失败: %v", label, err)
			}
			timer.Reset(interval)
		}
	}()
	return worker, nil
}

// Close 取消周期任务并等待当前一轮退出。
func (worker *periodicWorker) Close() error {
	if worker == nil {
		return nil
	}
	worker.closeOnce.Do(func() {
		worker.cancel()
		<-worker.done
	})
	return nil
}
