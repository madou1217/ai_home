package aihserver

import (
	"context"
	"log"
	"time"

	"github.com/madou1217/ai_home/application/accountoutcomes"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

// accountOutcomeFlushInterval 是内存计数写入 aih.db 的间隔。
const accountOutcomeFlushInterval = 30 * time.Second

// outcomeRecordingRuntime 是账号运行态的装饰器：先交给真实运行态记账，再为账号页
// 状态条计一次结果。统计永不改变返回值，也不在热路径写数据库，见 accountoutcomes。
// 覆盖 Canonical 推理、Claude native relay 与 Codex WS 三个共享运行态的入口。
type outcomeRecordingRuntime struct {
	serverAccountRuntime
	outcomes *accountoutcomes.Recorder
}

// RecordSuccess 记账后计入 success。
func (runtime outcomeRecordingRuntime) RecordSuccess(
	ctx context.Context,
	route runtimecore.ModelRoute,
	success inferencegateway.AttemptSuccess,
) error {
	err := runtime.serverAccountRuntime.RecordSuccess(ctx, route, success)
	runtime.outcomes.Record(route.AccountRef(), accountoutcomes.OutcomeSuccess)
	return err
}

// RecordFailure 记账后按失败类型计数。
func (runtime outcomeRecordingRuntime) RecordFailure(
	ctx context.Context,
	route runtimecore.ModelRoute,
	failure inferencegateway.AttemptFailure,
) error {
	err := runtime.serverAccountRuntime.RecordFailure(ctx, route, failure)
	runtime.outcomes.Record(route.AccountRef(), string(failure.RuntimeKind()))
	return err
}

// newAccountOutcomeRecorder 创建并启动结果记录器。
func newAccountOutcomeRecorder(
	ctx context.Context,
	store *sqliteaccount.Store,
	errorLog *log.Logger,
) (*accountoutcomes.Recorder, error) {
	recorder, err := accountoutcomes.NewRecorder(accountoutcomes.RecorderOptions{
		Store:         store,
		Clock:         time.Now,
		FlushInterval: accountOutcomeFlushInterval,
		Location:      time.Local,
		OnError: func(err error) {
			if errorLog != nil {
				errorLog.Printf("账号结果写入失败（下次刷新重试）: %v", err)
			}
		},
	})
	if err != nil {
		return nil, err
	}
	recorder.Start(ctx)
	return recorder, nil
}
