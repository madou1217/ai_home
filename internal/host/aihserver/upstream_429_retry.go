package aihserver

import (
	"context"
	"log"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/upstreamretry"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountdeletionruntime"
	runtimeupstreamretry "github.com/madou1217/ai_home/internal/runtime/upstreamretry"
)

type upstream429LogObserver struct {
	logger *log.Logger
}

func (observer upstream429LogObserver) ObserveWait(event upstreamretry.WaitEvent) {
	if observer.logger == nil {
		return
	}
	observer.logger.Printf(
		"upstream 429 retry wait: surface=%s provider=%s account=%s retry=%d/%d delay_ms=%d source=%s pinned=%t policy_source=%s",
		event.Surface,
		event.ProviderID,
		event.AccountRef,
		event.RetryNumber,
		event.MaxRetries,
		event.Delay.Milliseconds(),
		event.WaitSource,
		event.Pinned,
		event.PolicySource,
	)
}

func (observer upstream429LogObserver) ObserveOutcome(event upstreamretry.OutcomeEvent) {
	if observer.logger == nil {
		return
	}
	observer.logger.Printf(
		"upstream 429 retry finished: surface=%s provider=%s account=%s outcome=%s retries=%d total_wait_ms=%d abort_reason=%s",
		event.Surface,
		event.ProviderID,
		event.AccountRef,
		event.Outcome,
		event.Retries,
		event.TotalWait.Milliseconds(),
		event.AbortReason,
	)
}

func newUpstream429RetryRuntime(
	ctx context.Context,
	aiHomeDir string,
	errorLog *log.Logger,
) (*runtimeupstreamretry.Store, *upstreamretry.Controller) {
	store, err := runtimeupstreamretry.OpenStore(ctx, aiHomeDir)
	if err != nil {
		if errorLog != nil {
			errorLog.Printf("初始化上游 429 重试策略存储降级: %v", err)
		}
		return nil, nil
	}
	var observer upstreamretry.Observer
	if errorLog != nil {
		observer = upstream429LogObserver{logger: errorLog}
	}
	controller := upstreamretry.NewController(store, time.Now, nil, observer)
	return store, controller
}

// upstream429DeletionOwner removes persisted per-account 429 overrides only
// after durable account deletion has committed.
type upstream429DeletionOwner struct {
	store *runtimeupstreamretry.Store
}

var _ accountdeletionruntime.Owner = upstream429DeletionOwner{}

func (upstream429DeletionOwner) Inspect(context.Context, accountcore.Account) ([]accountapp.DeletionBlocker, error) {
	return nil, nil
}

func (upstream429DeletionOwner) Release(context.Context, accountcore.Account) error {
	return nil
}

func (upstream429DeletionOwner) Prepare(context.Context, accountcore.Account) error {
	return nil
}

func (owner upstream429DeletionOwner) Finish(ctx context.Context, account accountcore.Account, committed bool) error {
	if !committed || owner.store == nil || !account.Ref().IsValid() {
		return nil
	}
	return owner.store.DeleteAccountOverride(ctx, account.Ref().String())
}
