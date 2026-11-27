package aihserver

import (
	"context"
	"time"

	"github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/runtime/tokenrefreshdaemon"
)

// usageAuthInvalidMarker 把额度接口 401/403 投影为账号级 auth_invalid。
//
// 额度刷新是账号页之外最稳定能触达官方端点、并拿到明确 401/403 的路径。
// 不标记的话，WebUI 与 CLI 只能看到缓存的 schedulable，无法提示重新登录。
type usageAuthInvalidMarker struct {
	store   *sqliteaccount.Store
	runtime accountusage.RuntimeProjection
	clock   accountusage.Clock
}

func (marker usageAuthInvalidMarker) MarkAuthInvalid(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	reason string,
) error {
	if marker.store == nil || !accountRef.IsValid() {
		return nil
	}
	applier, _ := marker.runtime.(tokenrefreshdaemon.AccountStateApplier)
	now := time.Now()
	if marker.clock != nil {
		now = marker.clock()
	}
	_, err := tokenrefreshdaemon.MarkAccountReauthRequired(
		ctx,
		marker.store,
		applier,
		accountRef,
		reason,
		now,
	)
	return err
}

func (marker usageAuthInvalidMarker) ClearAuthInvalid(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) error {
	if marker.store == nil || !accountRef.IsValid() {
		return nil
	}
	notifier, _ := marker.runtime.(tokenrefreshdaemon.AccountRuntimeNotifier)
	now := time.Now()
	if marker.clock != nil {
		now = marker.clock()
	}
	_, err := tokenrefreshdaemon.ClearAccountAuthInvalid(
		ctx,
		marker.store,
		notifier,
		accountRef,
		now,
	)
	// ClearAccountAuthInvalid 在 notifier 为空时不会动单独的块表；这里显式清掉，
	// 避免 openapp 的 AuthInvalid 仍为 true。
	_ = marker.store.DeleteAccountBlock(ctx, accountRef, runtimecore.FailureReauthenticationRequired)
	if notifier == nil {
		if clearer, ok := marker.runtime.(interface {
			ClearAccountState(context.Context, accountcore.AccountRef) error
		}); ok {
			_ = clearer.ClearAccountState(ctx, accountRef)
		}
	}
	return err
}
