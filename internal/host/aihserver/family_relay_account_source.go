package aihserver

import (
	"context"
	"errors"

	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/codebuddyfamilyrelay"
)

// ErrInvalidFamilyRelayAccountSource 表示家族透传账号来源缺少目录、征召器或传输策略。
var ErrInvalidFamilyRelayAccountSource = errors.New("家族透传账号来源依赖无效")

// familyRelayAccountSource 让家族透传在未钉选时复用 Canonical 相同的账号调度。
//
// 与 Claude Relay 的 relayAccountSource 只差一处：Canonical 每请求只认一个 Provider，
// 而家族的一个模型可能由多支承载（glm-5.3-flash 在四支的 /v3/config 里都出现），
// 于是这里按家族表链式开启多个征召会话——同一支内部仍然是公平轮转、运行态熔断、
// 凭据可用性判定这套被 Canonical 验证过的语义，跨支只在「当前支候选耗尽」时发生。
type familyRelayAccountSource struct {
	catalog   *providers.Catalog
	recruiter *accountrouting.Recruiter
	transport accountrouting.CredentialTransportPolicy
}

// 编译期确认适配器满足家族透传通道的账号来源端口。
var _ codebuddyfamilyrelay.AccountSource = (*familyRelayAccountSource)(nil)

// newFamilyRelayAccountSource 创建只依赖真实调度端口的家族账号来源。
func newFamilyRelayAccountSource(
	catalog *providers.Catalog,
	recruiter *accountrouting.Recruiter,
	transport accountrouting.CredentialTransportPolicy,
) (*familyRelayAccountSource, error) {
	if catalog == nil || recruiter == nil || transport == nil {
		return nil, ErrInvalidFamilyRelayAccountSource
	}
	return &familyRelayAccountSource{
		catalog:   catalog,
		recruiter: recruiter,
		transport: transport,
	}, nil
}

// Accounts 为指定模型创建按家族表链式的账号游标。
func (source *familyRelayAccountSource) Accounts(
	_ context.Context,
	modelID runtimecore.ModelID,
) (codebuddyfamilyrelay.AccountCursor, error) {
	if source == nil || source.catalog == nil || source.recruiter == nil {
		return nil, ErrInvalidFamilyRelayAccountSource
	}
	return &familyRelayAccountCursor{source: source, modelID: modelID}, nil
}

// familyRelayAccountCursor 挨支征召：当前支候选耗尽后开启下一支。
//
// 会话是懒开启的：模型在一支都没有候选时就安静地整体耗尽，绝不会因为「别的模型
// 没有家族账号」而让未钉选请求拿到错误（调用方据此交回 Canonical）。
type familyRelayAccountCursor struct {
	source  *familyRelayAccountSource
	modelID runtimecore.ModelID
	// index 是下一个待开启的家族 Provider 下标；耗尽即整体耗尽。
	index int
	// session 是当前支的征召会话；为空表示需要开启下一支。
	session *accountrouting.RecruitmentSession
}

// Next 取下一个可用账号；所有支的候选耗尽时返回 false 而不是错误。
//
// 候选耗尽是正常收尾：透传调用方据此交付最后一次真实上游响应，或（一次都没尝试时）
// 把请求原样交回 Canonical。
func (cursor *familyRelayAccountCursor) Next(
	ctx context.Context,
) (accountcore.AccountRef, bool, error) {
	if cursor == nil || cursor.source == nil {
		return "", false, nil
	}
	for {
		if cursor.session == nil {
			if cursor.index >= len(codebuddyfamilyrelay.FamilyProviders) {
				return "", false, nil
			}
			providerID := codebuddyfamilyrelay.FamilyProviders[cursor.index]
			cursor.index++
			request, err := accountrouting.NewRequest(
				cursor.source.catalog,
				providerID,
				cursor.modelID.String(),
			)
			if err != nil {
				// Provider 不在目录里属装配错误：跳过该支而不是让整个请求失败。
				// 装配期由 TestModelRefreshQueueCoversEveryDiscoveryProvider 一类的
				// 守卫盯着覆盖关系，运行期不为配置问题牺牲可用性。
				continue
			}
			session, err := cursor.source.recruiter.Begin(
				ctx,
				request,
				cursor.source.transport,
			)
			if err != nil {
				return "", false, err
			}
			cursor.session = session
		}
		recruited, err := cursor.session.Next(ctx)
		if err != nil {
			if errors.Is(err, accountrouting.ErrNoRoutableAccount) {
				cursor.session = nil
				continue
			}
			return "", false, err
		}
		return recruited.Account().Ref(), true, nil
	}
}

// familyRelayTransportPolicy 判断领域凭据能否由家族透传通道承载。
//
// 与 Node 侧同一口径：只有家族原生登录态（带共享 access token）能走透传；
// API Key 与其他 Provider 的登录态由 Canonical 承载（它尊重账号自带差异）。
// 策略只表达本地协议兼容性，不做网络请求，也不改变账号运行态。
type familyRelayTransportPolicy struct{}

var _ accountrouting.CredentialTransportPolicy = familyRelayTransportPolicy{}

// SupportsCredential 返回透传通道能否安全承载该凭据。
func (familyRelayTransportPolicy) SupportsCredential(
	credential accountapp.Credential,
) bool {
	if credential == nil ||
		!codebuddyfamilyrelay.IsFamilyProvider(credential.ProviderID()) {
		return false
	}
	_, err := codebuddyfamilyrelay.AccessTokenFromCredential(credential)
	return err == nil
}
