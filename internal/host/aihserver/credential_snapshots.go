package aihserver

import (
	"context"
	"errors"
	"fmt"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// credentialSnapshotStore 是额度探测与模型发现共用的当前凭据读取端口。
type credentialSnapshotStore interface {
	GetCredentialSnapshot(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.CredentialSnapshot, error)
}

// credentialSnapshots 先完成必要 OAuth 刷新，再读取与 SQLite CAS 对齐的
// 当前凭据快照；额度与模型发现共用同一条刷新/代际链路，不各自维护刷新器。
type credentialSnapshots struct {
	resolver *accountcredentials.Resolver
	store    credentialSnapshotStore
}

// ResolveCredentialSnapshot 返回刷新完成后当前数据库中的凭据代次。
func (snapshots credentialSnapshots) ResolveCredentialSnapshot(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	resolved, err := snapshots.resolver.Resolve(ctx, accountRef)
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	return snapshots.store.GetCredentialSnapshot(ctx, resolved.Binding().AccountRef())
}

// RefreshCredential 在模型发现使用凭据前复用同一个解析器完成到期刷新。
//
// 模型发现原先只接了 kiro 专用刷新器；agy 这类 access token 只有 1h 的 Provider
// 会在 token 过期后仍拿库里的旧值直接探测，上游固定返回 401。这里改用与额度、
// 推理相同的刷新策略：到期判断、并发合并与 CAS 写回都由 resolver 负责。
// 未登记刷新策略的 Provider（例如 opencode 的静态凭据）保持原快照继续发现。
func (snapshots credentialSnapshots) RefreshCredential(
	ctx context.Context,
	snapshot accountapp.CredentialSnapshot,
) (accountapp.CredentialSnapshot, error) {
	if snapshots.resolver == nil || snapshots.store == nil {
		return accountapp.CredentialSnapshot{}, usageapp.ErrInvalidDependencies
	}
	if !snapshot.IsValid() {
		return accountapp.CredentialSnapshot{}, accountapp.ErrInvalidCredentialSnapshot
	}
	resolved, err := snapshots.resolver.Resolve(ctx, snapshot.AccountRef())
	if err != nil {
		if errors.Is(err, accountcredentials.ErrRefreshStrategyNotFound) {
			return snapshot, nil
		}
		return accountapp.CredentialSnapshot{}, modelCredentialRecoveryError(err)
	}
	// 刷新可能触发账号 re-key（身份变化），必须按解析结果的新引用读回快照；
	// 继续用入参的旧引用会 ErrCredentialNotFound，看起来像刷新失败。
	return snapshots.store.GetCredentialSnapshot(ctx, resolved.Binding().AccountRef())
}

// RecoverModelCredential 只在模型目录 401 后调用；静态密钥不会尝试 OAuth 刷新。
// 代次检查在 Resolver 的共享刷新飞行内再次执行，避免轮换期间重复刷新新令牌。
func (snapshots credentialSnapshots) RecoverModelCredential(
	ctx context.Context,
	snapshot accountapp.CredentialSnapshot,
) (accountapp.CredentialSnapshot, error) {
	if snapshots.resolver == nil || snapshots.store == nil {
		return accountapp.CredentialSnapshot{}, usageapp.ErrInvalidDependencies
	}
	binding, err := snapshots.resolver.ForceRefreshCredentialBindingIfCurrent(ctx, snapshot)
	if err != nil {
		return accountapp.CredentialSnapshot{}, modelCredentialRecoveryError(err)
	}
	return snapshots.store.GetCredentialSnapshot(ctx, binding.AccountRef())
}

// modelCredentialRecoveryError 仅把无法自动恢复的凭据拒绝转成模型探测终态。
// 普通刷新拒绝、网络故障和取消保持原错误，避免把它们变成重新登录要求。
func modelCredentialRecoveryError(err error) error {
	if errors.Is(err, accountcredentials.ErrReauthenticationRequired) ||
		errors.Is(err, accountcredentials.ErrCredentialNotRefreshable) ||
		errors.Is(err, accountcredentials.ErrRefreshStrategyNotFound) ||
		errors.Is(err, accountapp.ErrReauthenticationIdentityMismatch) {
		return fmt.Errorf("%w: %w", accountapp.ErrModelAuthenticationRejected, err)
	}
	return err
}
