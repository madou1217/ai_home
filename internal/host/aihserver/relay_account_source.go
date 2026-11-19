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
	// providers 是按优先级排列的账号域。
	//
	// claude 是原生归属；codex 账号只有在凭据能按厂商契约投影出原生 Messages
	// 端点时才会被 transport 策略放行（见 transportpolicy.MessagesUpstream），
	// 其余 codex 账号在征召阶段就被过滤，不会影响公平轮转。
	providers []inference.ProviderID
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
		providers: []inference.ProviderID{
			inference.ProviderClaude,
			inference.ProviderCodex,
		},
	}, nil
}

// Accounts 为指定模型开启一次征召会话。
func (source *relayAccountSource) Accounts(
	ctx context.Context,
	modelID runtimecore.ModelID,
) (claudenativerelay.AccountCursor, error) {
	if source == nil || ctx == nil || !modelID.IsValid() {
		return nil, accountrouting.ErrInvalidRequest
	}
	return &relayAccountCursor{source: source, modelID: modelID}, nil
}

// relayAccountCursor 按账号域顺序把多个征召会话包装成一个账号游标。
//
// 一个模型可能同时存在于 claude 与 codex 账号域（双协议厂商）。游标先耗尽
// claude 候选，再进入 codex；某个账号域没有该模型时直接跳过，不视为错误。
type relayAccountCursor struct {
	source        *relayAccountSource
	modelID       runtimecore.ModelID
	providerIndex int
	session       *accountrouting.RecruitmentSession
}

// Next 取下一个可用账号；全部候选耗尽时返回 false 而不是错误。
//
// 候选耗尽是正常收尾，调用方据此交付最后一次真实上游响应；把它当错误会让
// 网关合成自有失败，从而洗掉上游的真实状态码。
func (cursor *relayAccountCursor) Next(
	ctx context.Context,
) (accountcore.AccountRef, bool, error) {
	for {
		if cursor.session == nil {
			if cursor.providerIndex >= len(cursor.source.providers) {
				return "", false, nil
			}
			provider := cursor.source.providers[cursor.providerIndex]
			cursor.providerIndex++
			request, err := accountrouting.NewRequest(
				cursor.source.catalog,
				string(provider),
				cursor.modelID.String(),
			)
			if err != nil {
				// 该账号域不认识这个模型，继续下一个账号域。
				continue
			}
			session, err := cursor.source.recruiter.Begin(
				ctx,
				request,
				cursor.source.transport,
			)
			if err != nil {
				if errors.Is(err, accountrouting.ErrNoRoutableAccount) {
					continue
				}
				return "", false, err
			}
			cursor.session = session
		}
		recruited, err := cursor.session.Next(ctx)
		if err == nil {
			return recruited.Account().Ref(), true, nil
		}
		if errors.Is(err, accountrouting.ErrNoRoutableAccount) {
			cursor.session = nil
			continue
		}
		return "", false, err
	}
}
