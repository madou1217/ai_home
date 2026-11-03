package aihserver

import (
	"context"
	"errors"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountoutcomes"
	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	"github.com/madou1217/ai_home/application/accountusagefeed"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	"github.com/madou1217/ai_home/internal/adapters/images"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// accountOutcomeFlushInterval 是内存计数写入 aih.db 的间隔。
const accountOutcomeFlushInterval = 30 * time.Second

// outcomeRecordingRuntime 是账号运行态的装饰器：先交给真实运行态记账，再为账号页
// 状态条计一次结果。统计永不改变返回值，也不在热路径写数据库，见 accountoutcomes。
// 覆盖 Canonical 推理、Claude native relay 与 Codex WS 三个共享运行态的入口。
type outcomeRecordingRuntime struct {
	serverAccountRuntime
	outcomes *accountoutcomes.Recorder
	// usage 收集成功尝试的 token 用量，Node 增量拉取后计入账号 Token 用量。
	usage *accountusagefeed.Feed
	// usageLedger 是 Go 自有的跨重启 token 事实账本；写失败只记录日志，不改变上游结果。
	usageLedger usageLedgerWriter
	accounts    usageLedgerAccountReader
	errorLog    *log.Logger
	// quotaRefresh 在额度耗尽类失败后排一次立即的额度刷新（见 quota_failure_refresh.go）。
	quotaRefresh *quotaFailureRefresh
}

// RecordSuccess 记账后计入 success。
func (runtime outcomeRecordingRuntime) RecordSuccess(
	ctx context.Context,
	route runtimecore.ModelRoute,
	success inferencegateway.AttemptSuccess,
) error {
	err := runtime.serverAccountRuntime.RecordSuccess(ctx, route, success)
	runtime.outcomes.Record(route.AccountRef(), accountoutcomes.OutcomeSuccess)
	if usage, ok := success.Usage(); ok {
		runtime.usage.Append(route.AccountRef(), route.ModelID().String(), success.HappenedAt(), usage)
		if runtime.usageLedger != nil && runtime.accounts != nil {
			record, recordErr := buildUsageLedgerRecord(ctx, runtime.accounts, route, success)
			if recordErr == nil {
				recordErr = runtime.usageLedger.AppendUsageRecord(ctx, record)
			}
			if recordErr != nil && runtime.errorLog != nil {
				runtime.errorLog.Printf("写入 Go token 用量账本失败（本次推理不受影响）: %v", recordErr)
			}
		}
	}
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
	runtime.quotaRefresh.observe(route.AccountRef(), failure.RuntimeKind())
	return err
}

// RecordImageUsage 把生图的 token 用量写进与推理路径同一个管道。
//
// 先入 Node 增量拉取的用量事件，再落 Go 自己的账本；与 RecordSuccess 的用量部分同义，
// 只是不触发运行态状态机（生图不参与对话的账号调度判定）。记账失败只影响统计。
func (runtime outcomeRecordingRuntime) RecordImageUsage(
	ctx context.Context,
	accountRef string,
	model string,
	usage inference.Usage,
	at time.Time,
) {
	ref, err := accountcore.ParseAccountRef(strings.TrimSpace(accountRef))
	if err != nil || !usage.IsValid() || usage.TotalTokens() == 0 {
		return
	}
	runtime.usage.Append(ref, model, at, usage)
	if runtime.usageLedger == nil || runtime.accounts == nil {
		return
	}
	route, routeErr := runtimecore.NewModelRoute(ref, model)
	if routeErr != nil {
		return
	}
	success, successErr := inferencegateway.NewAttemptSuccess(at)
	if successErr != nil {
		return
	}
	record, recordErr := buildUsageLedgerRecord(ctx, runtime.accounts, route, success.WithUsage(usage))
	if recordErr != nil {
		return
	}
	if recordErr = runtime.usageLedger.AppendUsageRecord(ctx, record); recordErr != nil && runtime.errorLog != nil {
		runtime.errorLog.Printf("写入生图 token 用量账本失败（本次请求不受影响）: %v", recordErr)
	}
}

// RecordImageSuccess 把生图成功记给账号运行态。
//
// 与 Node 的 markProxyAccountSuccess 同义：计入账号页的最近成功，并让运行态按
// 「不早于最后失败的成功」清掉该 (账号, 模型) 的 cooldown。不带 usage——生图的 token
// 由 RecordImageUsage 单独记账，这里再带一次就会重复计数。
func (runtime outcomeRecordingRuntime) RecordImageSuccess(
	ctx context.Context,
	accountRef string,
	model string,
	at time.Time,
) {
	ref, err := accountcore.ParseAccountRef(strings.TrimSpace(accountRef))
	if err != nil {
		return
	}
	route, routeErr := runtimecore.NewModelRoute(ref, strings.TrimSpace(model))
	if routeErr != nil {
		return
	}
	success, successErr := inferencegateway.NewAttemptSuccess(at)
	if successErr != nil {
		return
	}
	if err = runtime.RecordSuccess(ctx, route, success); err != nil && runtime.errorLog != nil {
		runtime.errorLog.Printf("记录生图账号成功失败（本次请求不受影响）: %v", err)
	}
}

// RecordImageFailure 把一次生图尝试失败记给账号运行态。
//
// 失败账号不是上游给的：上游只回「这次请求失败了」，它并不知道我们用的是哪把凭据。
// 是哪个账号失败由编排层知道（images.Execute 换号循环里的 next），经观察者交进来。
// 记下来与 Node 的 markProxyAccountFailure 同义：401/403 硬阻塞、429 冷却、5xx 冷却，
// 400 这类请求侧错误不动账号状态。
func (runtime outcomeRecordingRuntime) RecordImageFailure(
	ctx context.Context,
	accountRef string,
	model string,
	cause error,
) {
	ref, err := accountcore.ParseAccountRef(strings.TrimSpace(accountRef))
	if err != nil {
		return
	}
	route, routeErr := runtimecore.NewModelRoute(ref, strings.TrimSpace(model))
	if routeErr != nil {
		return
	}
	failure, failureErr := imageAttemptFailure(cause, time.Now())
	if failureErr != nil {
		return
	}
	if err = runtime.RecordFailure(ctx, route, failure); err != nil && runtime.errorLog != nil {
		runtime.errorLog.Printf("记录生图账号失败失败（本次请求不受影响）: %v", err)
	}
}

// imageAttemptFailure 把生图策略错误映射成运行态失败分类。
//
// 状态码是唯一稳定证据：401/403 → 凭据失效（硬阻塞，不再调度该账号），429 → 限流冷却，
// 5xx → 上游不可用冷却，400/422 → 请求侧问题（不动账号状态）。没有状态码的网络错误
// 走传输层身份分类；都认不出时归 upstream_unavailable（可换号），与 Node 同口径。
func imageAttemptFailure(cause error, at time.Time) (inferencegateway.AttemptFailure, error) {
	if imageErr, ok := images.AsError(cause); ok && imageErr != nil && imageErr.StatusCode > 0 {
		classification, observeErr := upstreamfailure.ObserveHTTP(
			imageErr.StatusCode, nil, []byte(imageErr.UpstreamBody), at)
		if observeErr == nil {
			return attemptfailure.New(classification)
		}
		if errors.Is(observeErr, upstreamfailure.ErrNoFailureEvidence) {
			// 失败状态码之外（比如 2xx 却走到错误分支）：没有失败证据，不写账号状态。
			return inferencegateway.AttemptFailure{}, observeErr
		}
	}
	if failure, err := attemptfailure.NewTransport(cause); err == nil {
		return failure, nil
	}
	return attemptfailure.NewClassified(runtimecore.FailureUpstreamUnavailable)
}

// bindUsageRefresh 接上额度子系统的立即刷新入口（额度子系统晚于运行态装饰器创建）。
func (runtime outcomeRecordingRuntime) bindUsageRefresh(schedule usageRefreshScheduler) {
	runtime.quotaRefresh.bind(schedule)
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

// UsageEventsSince 暴露用量事件环给管理接口（见 accountusageeventsapi）。
func (runtime outcomeRecordingRuntime) UsageEventsSince(after uint64) ([]accountusagefeed.Event, uint64, bool) {
	return runtime.usage.Since(after)
}

// UsageBootID 返回用量事件环的进程实例标识。
func (runtime outcomeRecordingRuntime) UsageBootID() string {
	return runtime.usage.BootID()
}
