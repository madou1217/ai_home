package aihserver

import (
	"context"
	"log"
	"time"
)

const (
	// modelProbeRetryInitialDelay 让启动恢复先把从未探测的账号入队，再做到期重试。
	modelProbeRetryInitialDelay = 45 * time.Second
	// modelProbeRetryInterval 是扫描到期失败事实的周期。真正的退避间隔由
	// application/modelprobes 的声明式策略决定，这里只负责及时看到到期项。
	modelProbeRetryInterval = time.Minute
	// modelProbeRetryTimeout 限制一轮本地查询与入队时间。
	modelProbeRetryTimeout = 30 * time.Second
)

// modelProbeRetrier 是到期失败账号重试的应用端口。
type modelProbeRetrier interface {
	RetryDueProbes(ctx context.Context) error
}

// modelProbeRetryWorker 是失败探测到期重试的生命周期句柄。
type modelProbeRetryWorker = periodicWorker

// startModelProbeRetryWorker 周期扫描失败事实，把已过退避窗口的账号重新入队。
func startModelProbeRetryWorker(
	parent context.Context,
	retrier modelProbeRetrier,
	errorLog *log.Logger,
) (*modelProbeRetryWorker, error) {
	if parent == nil || retrier == nil {
		return nil, errInvalidPeriodicWorker
	}
	return startPeriodicWorker(
		parent,
		modelProbeRetryInitialDelay,
		modelProbeRetryInterval,
		modelProbeRetryTimeout,
		"账号模型探测到期重试",
		retrier.RetryDueProbes,
		errorLog,
	)
}
