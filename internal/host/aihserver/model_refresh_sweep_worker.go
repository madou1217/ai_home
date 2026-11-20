package aihserver

import (
	"context"
	"log"
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

// modelRefreshSweepWorker 是目录重扫 worker 的生命周期句柄。
type modelRefreshSweepWorker = periodicWorker

// startModelRefreshSweepWorker 延迟后按固定周期重扫；每轮只入队，不等待上游发现。
func startModelRefreshSweepWorker(
	parent context.Context,
	sweeper modelRefreshSweeper,
	initialDelay time.Duration,
	interval time.Duration,
	errorLog *log.Logger,
) (*modelRefreshSweepWorker, error) {
	if parent == nil || sweeper == nil {
		return nil, errInvalidPeriodicWorker
	}
	return startPeriodicWorker(
		parent,
		initialDelay,
		interval,
		modelRefreshSweepTimeout,
		"账号模型目录周期重扫",
		sweeper.Sweep,
		errorLog,
	)
}
