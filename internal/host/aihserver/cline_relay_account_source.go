package aihserver

import (
	"context"
	"errors"

	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/clinerelay"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// ErrInvalidProviderRelayAccountSource 表示透传账号来源缺少目录、征召器或传输策略。
var ErrInvalidProviderRelayAccountSource = errors.New("透传账号来源依赖无效")

// providerRelayAccountSource 是**单 Provider** 透传通道的账号来源（当前用于 cline）。
//
// 与 familyRelayAccountSource 的关系：家族一个模型可能由四支承载，因此它要按家族表
// 链式开启多个征召会话；单 Provider 通道只有一个 Provider，一次征召即可。两者的内部
// 语义完全相同——复用 Canonical 验证过的公平轮转、运行态熔断、凭据可用性判定，
// 只是「问几支」不同。
type providerRelayAccountSource struct {
	providerID string
	catalog    *providers.Catalog
	recruiter  *accountrouting.Recruiter
	transport  accountrouting.CredentialTransportPolicy
}

// 编译期确认适配器满足 relaycore 的账号来源端口。
var _ relaycore.AccountSource = (*providerRelayAccountSource)(nil)

// newProviderRelayAccountSource 创建只依赖真实调度端口的单 Provider 账号来源。
func newProviderRelayAccountSource(
	providerID string,
	catalog *providers.Catalog,
	recruiter *accountrouting.Recruiter,
	transport accountrouting.CredentialTransportPolicy,
) (*providerRelayAccountSource, error) {
	if providerID == "" || catalog == nil || recruiter == nil || transport == nil {
		return nil, ErrInvalidProviderRelayAccountSource
	}
	return &providerRelayAccountSource{
		providerID: providerID,
		catalog:    catalog,
		recruiter:  recruiter,
		transport:  transport,
	}, nil
}

// Accounts 为指定模型创建一个征召会话。
//
// 模型没有候选时返回的游标会立即耗尽（Next 返回 false），调用方据此把请求交回
// Canonical——这是正常收尾，不是错误。
func (source *providerRelayAccountSource) Accounts(
	ctx context.Context,
	modelID runtimecore.ModelID,
) (relaycore.AccountCursor, error) {
	if source == nil || source.catalog == nil || source.recruiter == nil {
		return nil, ErrInvalidProviderRelayAccountSource
	}
	request, err := accountrouting.NewRequest(
		source.catalog,
		source.providerID,
		modelID.String(),
	)
	if err != nil {
		// Provider 不在目录里属装配错误：返回空游标让调用方交还 Canonical，
		// 而不是让整个请求失败（与家族来源跳过该支同一口径）。
		return &providerExhaustedCursor{}, nil
	}
	session, err := source.recruiter.Begin(ctx, request, source.transport)
	if err != nil {
		return nil, err
	}
	return &providerRelayAccountCursor{session: session}, nil
}

// providerRelayAccountCursor 逐个产出征召会话的账号，耗尽即整体耗尽。
type providerRelayAccountCursor struct {
	session *accountrouting.RecruitmentSession
}

func (cursor *providerRelayAccountCursor) Next(
	ctx context.Context,
) (accountcore.AccountRef, bool, error) {
	if cursor == nil || cursor.session == nil {
		return "", false, nil
	}
	recruited, err := cursor.session.Next(ctx)
	if err != nil {
		if errors.Is(err, accountrouting.ErrNoRoutableAccount) {
			// 候选耗尽是正常收尾，不是错误。
			return "", false, nil
		}
		return "", false, err
	}
	return recruited.Account().Ref(), true, nil
}

// providerExhaustedCursor 是「该 Provider 不在目录里」时返回的空游标。
type providerExhaustedCursor struct{}

func (*providerExhaustedCursor) Next(context.Context) (accountcore.AccountRef, bool, error) {
	return "", false, nil
}

// clineRelayTransportPolicy 判断领域凭据能否由 cline 透传通道承载。
//
// 与家族同一口径：只有原生登录态（带 access token）能走透传；API Key 账号由
// Canonical 承载。策略只表达本地协议兼容性，不做网络请求，也不改变账号运行态。
type clineRelayTransportPolicy struct{}

var _ accountrouting.CredentialTransportPolicy = clineRelayTransportPolicy{}

// SupportsCredential 返回透传通道能否安全承载该凭据。
func (clineRelayTransportPolicy) SupportsCredential(credential accountapp.Credential) bool {
	if credential == nil || credential.ProviderID() != clinerelay.ProviderID {
		return false
	}
	_, err := clinerelay.AccessTokenFromCredential(credential)
	return err == nil
}
