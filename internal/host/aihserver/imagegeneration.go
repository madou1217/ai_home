package aihserver

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	agyaccount "github.com/madou1217/ai_home/core/accounts/agy"
	codexaccount "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/images"
)

// 本文件把图片子系统接到宿主征召器与模型目录上。
//
// 图片模块本身只消费「候选账号」与「Provider」两个窄端口，因此账号读取、运行态判断与
// 凭据解析全部留在宿主层，与本仓既有的分层一致。

var (
	// errImageProviderUnresolved 表示没有任何 Provider 能服务该图片模型。
	errImageProviderUnresolved = errors.New("没有可服务该图片模型的 Provider")
	// errImageAccountUnavailable 表示征召不到可用账号。
	errImageAccountUnavailable = errors.New("没有可用的图片账号")
)

// imageTransportPolicy 声明图片上游协议可以承载哪些凭据。
//
// 图片上游有两类形态：codex OAuth 的 Images API 与 api-key 的 OpenAI 兼容端点。
// claude 凭据没有图片通道，因此不在这里声明，让它在能力闸门处得到明确的 400。
type imageTransportPolicy struct{}

// SupportsCredential 判断凭据能否由图片上游协议承载。
func (imageTransportPolicy) SupportsCredential(credential accountapp.Credential) bool {
	switch credential.(type) {
	case *codexaccount.OAuthAuth, *codexaccount.APIKeyAuth, *agyaccount.OAuthAuth:
		return true
	default:
		return false
	}
}

// imageAccountSource 用既有征召器提供图片候选账号。
//
// 它每次只返回一个账号：图片编排在失败换号时用 exclude 重新征召，因此不需要在这里
// 复制公平轮转策略，也不会与对话链路的账号选择产生两套顺序。
type imageAccountSource struct {
	catalog    *providers.Catalog
	recruiter  *accountrouting.Recruiter
	transports accountrouting.CredentialTransportPolicy
}

// Candidates 征召下一个尚未尝试过的账号。
func (source imageAccountSource) Candidates(
	ctx context.Context,
	provider string,
	model string,
	exclude []string,
) ([]images.Account, error) {
	if source.recruiter == nil || source.catalog == nil {
		return nil, errImageAccountUnavailable
	}
	excluded := make([]accountcore.AccountRef, 0, len(exclude))
	for _, raw := range exclude {
		accountRef, err := accountcore.ParseAccountRef(strings.TrimSpace(raw))
		if err != nil {
			continue
		}
		excluded = append(excluded, accountRef)
	}
	request, err := accountrouting.NewRequestExcluding(
		source.catalog,
		provider,
		model,
		excluded,
	)
	if err != nil {
		return nil, errImageAccountUnavailable
	}
	result, err := source.recruiter.Recruit(ctx, request, source.transports)
	if err != nil {
		return nil, errImageAccountUnavailable
	}
	account, err := toImageAccount(provider, result.Account(), result.Credential())
	if err != nil {
		return nil, err
	}
	return []images.Account{account}, nil
}

// toImageAccount 把凭据投影成图片策略所需的账号视图。
func toImageAccount(
	provider string,
	routingAccount accountapp.RoutingAccount,
	credential accountapp.Credential,
) (images.Account, error) {
	account := images.Account{
		Provider:   provider,
		AccountRef: routingAccount.Ref().String(),
	}
	switch typed := credential.(type) {
	case *codexaccount.OAuthAuth:
		account.AccessToken = typed.AccessToken()
		account.UpstreamAccountID = typed.UpstreamAccountID()
		account.Email = typed.Email()
	case *codexaccount.APIKeyAuth:
		account.APIKey = typed.APIKey()
		account.BaseURL = typed.BaseURL()
		account.APIKeyMode = true
	case *agyaccount.OAuthAuth:
		account.AccessToken = typed.AccessToken()
		account.Email = typed.Email()
	default:
		return images.Account{}, errImageAccountUnavailable
	}
	return account, nil
}

// imageProviderResolver 把图片请求解析成 Provider。
//
// 解析顺序与 Node 一致：请求显式声明的 provider 优先；否则按本地可路由模型目录反查。
// 反查要求模型被恰好一个 Provider 拥有——多个候选时不做任意选择，避免把请求静默发到
// 用户没指定的厂商。
type imageProviderResolver struct {
	catalog *providers.Catalog
	models  accountapp.RoutableModelReader
}

// ResolveProvider 返回服务该模型的 Provider。
func (resolver imageProviderResolver) ResolveProvider(
	ctx context.Context,
	provider string,
	model string,
) (string, error) {
	if resolver.catalog == nil {
		return "", errImageProviderUnresolved
	}
	declared := strings.ToLower(strings.TrimSpace(provider))
	if declared != "" {
		canonical, found := resolver.catalog.CanonicalID(declared)
		if !found {
			return "", fmt.Errorf("%w: %s", errImageProviderUnresolved, declared)
		}
		return canonical, nil
	}
	if resolver.models == nil {
		return "", errImageProviderUnresolved
	}
	models, err := resolver.models.ListRoutableModels(ctx)
	if err != nil {
		return "", errImageProviderUnresolved
	}
	owners := map[string]struct{}{}
	for _, candidate := range models {
		if !candidate.IsValid() {
			continue
		}
		if candidate.ModelID().String() != model {
			continue
		}
		owners[candidate.ProviderID()] = struct{}{}
	}
	switch len(owners) {
	case 0:
		return "", fmt.Errorf("%w: %s", errImageProviderUnresolved, model)
	case 1:
		for owner := range owners {
			return owner, nil
		}
	}
	return "", fmt.Errorf(
		"%w: model %s is served by multiple providers, declare provider explicitly",
		errImageProviderUnresolved,
		model,
	)
}
