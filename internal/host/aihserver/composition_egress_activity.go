package aihserver

import (
	"context"
	"github.com/madou1217/ai_home/application/accountoutcomes"
	"github.com/madou1217/ai_home/application/egressengine"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
	"github.com/madou1217/ai_home/internal/runtime/engineplugin"
	"github.com/madou1217/ai_home/internal/runtime/sessionactivity"
	"log"
	"strings"
	"time"
)

// egressActivityRuntime 是出口池 Manager 与账号活动守护的装配结果。
//
// 从 newHandlers 拆出：出口内核加载、活动守护回调与账号限流判定作为一个
// 独立演进面，新增事件类型不再修改主装配流水线。
type egressActivityRuntime struct {
	manager  *runtimeegress.Manager
	activity *sessionactivity.Daemon
}

func newEgressActivityRuntime(
	ctx context.Context,
	aiHomeDir string,
	hostHomeDir string,
	catalog *providers.Catalog,
	store *sqliteaccount.Store,
	accountRuntime serverAccountRuntime,
	tokenEvents *tokenEventBus,
	outcomeRecorder *accountoutcomes.Recorder,
	errorLog *log.Logger,
) (*egressActivityRuntime, error) {
	enginePlugins := make([]egressengine.Engine, 0)
	for _, client := range engineplugin.Load(aiHomeDir) {
		enginePlugins = append(enginePlugins, client)
	}
	egressManager := runtimeegress.NewManager(runtimeegress.ManagerOptions{
		AIHomeDir:             aiHomeDir,
		HomeDir:               hostHomeDir,
		Catalog:               catalog,
		EnginePlugins:         enginePlugins,
		DisableBuiltinEngines: true,
	})
	if err := egressManager.Start(ctx); err != nil && errorLog != nil {
		errorLog.Printf("出口池后台守护启动降级: %v", err)
	}
	activityDaemon := sessionactivity.NewDaemon(sessionactivity.DaemonOptions{
		AIHomeDir:   aiHomeDir,
		HostHomeDir: hostHomeDir,
		OnSnapshotChanged: func(snapshot map[string]sessionactivity.AccountSnapshot) {
			tokenEvents.PublishAccountActivity(snapshot)
		},
		Catalog: catalog,
		ResolveHarnessTurnMode: func(harnessID string) string {
			definition, ok := catalog.Get(strings.TrimSpace(harnessID))
			if !ok {
				return "external"
			}
			if mode := strings.TrimSpace(string(definition.SessionSync.Mode)); mode != "" {
				return mode
			}
			return "external"
		},
		IsAccountEnabled: func(checkCtx context.Context, _ string, accountRef string) bool {
			if store == nil {
				return true
			}
			parsedRef, parseErr := accountcore.ParseAccountRef(strings.TrimSpace(accountRef))
			if parseErr != nil {
				return true
			}
			overview, lookupErr := store.GetAccountOverview(checkCtx, parsedRef)
			if lookupErr != nil {
				return true
			}
			return overview.Account().Enabled()
		},
		RecordOutcome: func(_ context.Context, accountRef, outcome string, atMS int64) bool {
			if outcomeRecorder == nil {
				return false
			}
			parsedRef, parseErr := accountcore.ParseAccountRef(strings.TrimSpace(accountRef))
			if parseErr != nil {
				return false
			}
			trimmedOutcome := strings.TrimSpace(outcome)
			if trimmedOutcome == "" {
				return false
			}
			var at time.Time
			if atMS > 0 {
				at = time.UnixMilli(atMS)
			}
			outcomeRecorder.RecordAt(parsedRef, trimmedOutcome, at)
			return true
		},
		OnCodebuddyLimit: func(limitCtx context.Context, obs sessionactivity.ObservedCodebuddyLimit) bool {
			parsedRef, parseErr := accountcore.ParseAccountRef(strings.TrimSpace(obs.AccountRef))
			if parseErr != nil {
				return false
			}
			model := strings.TrimSpace(obs.Model)
			if model == "" {
				return false
			}
			route, routeErr := runtimecore.NewModelRoute(parsedRef, model)
			if routeErr != nil {
				return false
			}
			nowMS := time.Now().UnixMilli()
			var retryAfter time.Duration
			if !obs.HardExhaustion && obs.ResetAtMS > nowMS {
				retryAfter = time.Duration(obs.ResetAtMS-nowMS) * time.Millisecond
				if retryAfter > runtimecore.MaxCooldownHint {
					retryAfter = runtimecore.MaxCooldownHint
				}
			}
			classification, classErr := sharedfailure.NewClassification(runtimecore.FailureRateLimited, retryAfter)
			if classErr != nil {
				return false
			}
			failure, failErr := attemptfailure.New(classification)
			if failErr != nil {
				return false
			}
			return accountRuntime.RecordFailure(limitCtx, route, failure) == nil
		},
	})
	activityDaemon.Start(ctx)
	return &egressActivityRuntime{manager: egressManager, activity: activityDaemon}, nil
}
