package aihserver

import (
	"context"
	"errors"

	"github.com/madou1217/ai_home/application/accountrouting"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/claudenativerelay"
)

// relayAccountSource 让透传通道复用 Canonical 相同的账号调度。
//
// 透传不该自建一套账号选择：公平轮转、运行态熔断、凭据可用性判定都已经在
// Recruiter 里实现且被 Canonical 路径验证过。两套实现会在冷却语义上分叉。
type relayAccountSource struct {
	catalog   *providers.Catalog
	recruiter *accountrouting.Recruiter
	transport accountrouting.CredentialTransportPolicy
}

// 编译期确认适配器满足透传通道的账号来源端口。
var _ claudenativerelay.AccountSource = (*relayAccountSource)(nil)

// newRelayAccountSource 创建只依赖真实调度端口的账号来源。
func newRelayAccountSource(
	catalog *providers.Catalog,
	recruiter *accountrouting.Recruiter,
	transport accountrouting.CredentialTransportPolicy,
) (*relayAccountSource, error) {
	if catalog == nil || recruiter == nil || transport == nil {
		return nil, errors.New("Claude Relay 账号来源依赖无效")
	}
	return &relayAccountSource{
		catalog:   catalog,
		recruiter: recruiter,
		transport: transport,
	}, nil
}

// Accounts 为指定模型开启一次征召会话。
func (source *relayAccountSource) Accounts(
	ctx context.Context,
	modelID runtimecore.ModelID,
) (claudenativerelay.AccountCursor, error) {
	request, err := accountrouting.NewRequest(
		source.catalog,
		string(inference.ProviderClaude),
		modelID.String(),
	)
	if err != nil {
		return nil, err
	}
	session, err := source.recruiter.Begin(ctx, request, source.transport)
	if err != nil {
		return nil, err
	}
	return &relayAccountCursor{session: session}, nil
}

// relayAccountCursor 把征召会话包装成账号游标。
type relayAccountCursor struct {
	session *accountrouting.RecruitmentSession
}

// Next 取下一个可用账号；候选耗尽时返回 false 而不是错误。
//
// 候选耗尽是正常收尾，调用方据此交付最后一次真实上游响应；把它当错误会让
// 网关合成自有失败，从而洗掉上游的真实状态码。
func (cursor *relayAccountCursor) Next(
	ctx context.Context,
) (accountcore.AccountRef, bool, error) {
	recruited, err := cursor.session.Next(ctx)
	if err != nil {
		if errors.Is(err, accountrouting.ErrNoRoutableAccount) {
			return "", false, nil
		}
		return "", false, err
	}
	return recruited.Account().Ref(), true, nil
}
