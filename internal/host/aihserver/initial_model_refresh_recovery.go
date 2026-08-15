package aihserver

import (
	"context"
	"errors"
	"log"
	"sync"
)

// initialModelRefreshRecoverer 是 Host 启动 worker 依赖的最小应用端口。
type initialModelRefreshRecoverer interface {
	Recover(ctx context.Context) error
}

// initialModelRefreshRecoveryWorker 持有启动扫描的取消和等待生命周期。
type initialModelRefreshRecoveryWorker struct {
	cancel    context.CancelFunc
	done      chan struct{}
	closeOnce sync.Once
}

// startInitialModelRefreshRecoveryWorker 异步启动恢复扫描，绝不等待上游模型发现。
func startInitialModelRefreshRecoveryWorker(
	parent context.Context,
	recovery initialModelRefreshRecoverer,
	errorLog *log.Logger,
) (*initialModelRefreshRecoveryWorker, error) {
	if parent == nil || recovery == nil {
		return nil, ErrInvalidOptions
	}
	ctx, cancel := context.WithCancel(parent)
	worker := &initialModelRefreshRecoveryWorker{
		cancel: cancel,
		done:   make(chan struct{}),
	}
	go func() {
		defer close(worker.done)
		if err := recovery.Recover(ctx); err != nil &&
			!errors.Is(err, context.Canceled) &&
			errorLog != nil {
			errorLog.Printf("账号首次模型刷新启动恢复失败: %v", err)
		}
	}()
	return worker, nil
}

// Close 先取消数据库扫描并等待退出，调用方随后才能关闭协调器和 Store。
func (worker *initialModelRefreshRecoveryWorker) Close() error {
	if worker == nil {
		return nil
	}
	worker.closeOnce.Do(func() {
		worker.cancel()
		<-worker.done
	})
	return nil
}
