package aihserver

import (
	"context"
	"log"
	"sort"
	"time"

	"github.com/madou1217/ai_home/application/accountoutcomes"
	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
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

// RuntimeSnapshot 合并运行态的阻塞 / cooldown 与记录器的最近结果，供账号页调度状态展示。
// 底层运行态不支持快照时（测试替身）只返回最近结果。
func (runtime outcomeRecordingRuntime) RuntimeSnapshot() []runtimeapp.AccountView {
	var views []runtimeapp.AccountView
	if snapshotter, ok := runtime.serverAccountRuntime.(runtimeapp.Snapshotter); ok {
		views = snapshotter.RuntimeSnapshot()
	}
	activity := runtime.outcomes.LastActivity()
	seen := make(map[accountcore.AccountRef]bool, len(views))
	for index := range views {
		seen[views[index].AccountRef] = true
		applyActivity(&views[index], activity[views[index].AccountRef])
	}
	for accountRef, entry := range activity {
		if seen[accountRef] {
			continue
		}
		view := runtimeapp.AccountView{AccountRef: accountRef}
		applyActivity(&view, entry)
		views = append(views, view)
	}
	sort.Slice(views, func(left, right int) bool {
		return views[left].AccountRef.String() < views[right].AccountRef.String()
	})
	return views
}

func applyActivity(view *runtimeapp.AccountView, activity accountoutcomes.Activity) {
	view.LastSuccessAt = activity.LastSuccessAt
	view.LastFailureAt = activity.LastFailureAt
	view.LastFailureKind = activity.LastFailureKind
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
