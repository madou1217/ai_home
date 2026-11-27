package aihserver

import (
	"context"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/kirocred"
	"github.com/madou1217/ai_home/internal/adapters/codebuddyfamily/tokenrefresh"
)

// usageCredentialRefresher 按 Provider 分派账号级凭据刷新。
//
// Kiro 与 CodeBuddy 家族都需要在额度探测前/401 后刷新；其它 Provider 的
// 刷新由各自的链处理，这里保持快照不变。
type usageCredentialRefresher struct {
	kiro   *kirocred.Refresher
	family *tokenrefresh.Refresher
}

func (refresher usageCredentialRefresher) RefreshCredential(
	ctx context.Context,
	snapshot accountapp.CredentialSnapshot,
) (accountapp.CredentialSnapshot, error) {
	if providerID := snapshot.ProviderID(); providers.IsCodeBuddyFamilyProvider(providerID) {
		if refresher.family == nil {
			return snapshot, nil
		}
		return refresher.family.RefreshCredential(ctx, snapshot)
	}
	if snapshot.ProviderID() == "kiro" && refresher.kiro != nil {
		return refresher.kiro.RefreshCredential(ctx, snapshot)
	}
	return snapshot, nil
}

func (refresher usageCredentialRefresher) ForceRefreshCredential(
	ctx context.Context,
	snapshot accountapp.CredentialSnapshot,
) (accountapp.CredentialSnapshot, error) {
	if providerID := snapshot.ProviderID(); providers.IsCodeBuddyFamilyProvider(providerID) {
		if refresher.family == nil {
			return snapshot, nil
		}
		return refresher.family.ForceRefreshCredential(ctx, snapshot)
	}
	// 非家族 Provider 没有可用的强制刷新实现：保持原有语义，交给调用方
	// 根据 401 标记状态。
	return accountapp.CredentialSnapshot{}, usageapp.ErrCredentialRejected
}
