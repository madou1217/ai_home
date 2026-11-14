package accountcredentials

import (
	"context"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// ForceRefreshCredentialBindingIfCurrent 仅在被上游拒绝的凭据仍为当前代次时强制刷新。
// 已安装的新版本直接复用；与预刷新及原 force 入口共用同一 flight 和 CAS 链路。
// 若其他刷新已完成 re-key 并删除旧引用，读取仍返回存储错误，不猜测新账号身份。
func (resolver *Resolver) ForceRefreshCredentialBindingIfCurrent(
	ctx context.Context,
	rejected accountapp.CredentialSnapshot,
) (accountapp.CredentialBinding, error) {
	if resolver == nil || resolver.store == nil || ctx == nil || !rejected.IsValid() {
		return accountapp.CredentialBinding{}, ErrInvalidResolveRequest
	}
	if err := ctx.Err(); err != nil {
		return accountapp.CredentialBinding{}, err
	}
	snapshot, current, err := resolver.readCurrentCredentialSnapshot(ctx, rejected)
	if err != nil {
		return accountapp.CredentialBinding{}, err
	}
	if !current {
		return snapshot.Binding(), nil
	}
	resolution, err := resolver.executeRefreshFlight(ctx, rejected.AccountRef(), func() (credentialResolution, error) {
		return resolver.forceRefreshIfCurrent(ctx, rejected)
	})
	resolution, err = resolver.reconcileRefreshFlightFailure(ctx, rejected, resolution, err)
	if err != nil {
		// 不能采用普通预刷新在 token 尚未过期时的降级：这个代次已经真实收到 401。
		return accountapp.CredentialBinding{}, err
	}
	snapshot = resolution.snapshot
	if !snapshot.IsValid() || snapshot.ProviderID() != rejected.ProviderID() ||
		(snapshot.AccountRef() != rejected.AccountRef() && !resolution.refreshed) {
		return accountapp.CredentialBinding{}, ErrInvalidRefreshResult
	}
	if !snapshot.UpdatedAt().After(rejected.UpdatedAt()) {
		// follower 可能加入普通预刷新的 no-op flight；它不能证明被拒代次已恢复。
		return accountapp.CredentialBinding{}, ErrRefreshUnavailable
	}
	return snapshot.Binding(), nil
}

// readCurrentCredentialSnapshot 复核账号、Provider 及入口观察之后的持久化代次。
// 返回 current=false 表示已有严格更新的快照，连静态凭据也可以直接复用。
func (resolver *Resolver) readCurrentCredentialSnapshot(
	ctx context.Context,
	observed accountapp.CredentialSnapshot,
) (accountapp.CredentialSnapshot, bool, error) {
	if err := ctx.Err(); err != nil {
		return accountapp.CredentialSnapshot{}, false, err
	}
	snapshot, err := resolver.store.GetCredentialSnapshot(ctx, observed.AccountRef())
	if ctxErr := ctx.Err(); ctxErr != nil {
		return accountapp.CredentialSnapshot{}, false, ctxErr
	}
	if err != nil {
		return accountapp.CredentialSnapshot{}, false, err
	}
	if !snapshot.IsValid() || snapshot.AccountRef() != observed.AccountRef() ||
		snapshot.ProviderID() != observed.ProviderID() {
		return accountapp.CredentialSnapshot{}, false, ErrInvalidRefreshResult
	}
	if snapshot.UpdatedAt().Before(observed.UpdatedAt()) {
		return accountapp.CredentialSnapshot{}, false, accountapp.ErrCredentialConflict
	}
	return snapshot, snapshot.UpdatedAt().Equal(observed.UpdatedAt()), nil
}

// forceRefreshIfCurrent 在共享 flight 内再次检查代次和抑制，不能用排队前的观察刷新。
func (resolver *Resolver) forceRefreshIfCurrent(
	ctx context.Context,
	rejected accountapp.CredentialSnapshot,
) (credentialResolution, error) {
	if err := ctx.Err(); err != nil {
		return credentialResolution{}, err
	}
	snapshot, current, err := resolver.readCurrentCredentialSnapshot(ctx, rejected)
	if err != nil {
		return credentialResolution{}, err
	}
	if !current {
		return currentResolution(snapshot), nil
	}
	now, err := resolver.currentTime()
	if err != nil {
		return credentialResolution{}, err
	}
	if suppression, suppressed := resolver.suppressedRefresh(snapshot, now); suppressed {
		switch {
		case suppression.identityMismatch:
			return currentResolution(snapshot), accountapp.ErrReauthenticationIdentityMismatch
		case suppression.reauthentication:
			return currentResolution(snapshot), ErrReauthenticationRequired
		default:
			return currentResolution(snapshot), ErrRefreshUnavailable
		}
	}
	strategy, found := resolver.strategies[snapshot.ProviderID()]
	if !found {
		return currentResolution(snapshot), ErrRefreshStrategyNotFound
	}
	if _, refreshable := strategy.ExpiresAt(snapshot.Credential()); !refreshable {
		return currentResolution(snapshot), ErrCredentialNotRefreshable
	}
	if resolver.delegatesRefresh(snapshot.AccountRef(), strategy) {
		return currentResolution(snapshot), ErrRefreshUnavailable
	}
	return resolver.refreshSnapshot(ctx, snapshot, strategy)
}
