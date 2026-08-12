package main

import (
	"context"
	"errors"
	"strings"

	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
)

var errInvalidGatewayAccountResolver = errors.New("远端 Gateway 账号解析器无效")

// managementGatewayAccountResolver 只把远端公开账号投影回 Gateway Planner 所需的基础实体。
//
// 该适配器不会读取凭据、模型、usage 或运行态；这些数据始终只存在目标 Server。
type managementGatewayAccountResolver struct {
	client  *managementapi.Client
	catalog *providers.Catalog
}

// newManagementGatewayAccountResolver 为固定 Relay 创建目标 Server 的账号别名解析端口。
//
// 账号池 Relay 不需要 Management Key，因此未配置时返回 nil 而不是阻断账号池启动。
func newManagementGatewayAccountResolver(
	httpClient managementapi.HTTPClient,
	baseURL string,
	managementKey string,
) (providerlaunch.GatewayAccountResolver, error) {
	if strings.TrimSpace(managementKey) == "" {
		return nil, nil
	}
	client, err := managementapi.New(httpClient, managementapi.Config{
		BaseURL:       baseURL,
		ManagementKey: managementKey,
	})
	if err != nil {
		return nil, err
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil, err
	}
	return &managementGatewayAccountResolver{
		client:  client,
		catalog: catalog,
	}, nil
}

// GetByCLIAccountID 通过目标 Server 的单库解析数字别名，再构造无凭据的短生命周期快照。
func (resolver *managementGatewayAccountResolver) GetByCLIAccountID(
	ctx context.Context,
	providerID string,
	cliAccountID accountcore.CLIAccountID,
) (accountcore.Account, error) {
	if resolver == nil || resolver.client == nil || resolver.catalog == nil {
		return accountcore.Account{}, errInvalidGatewayAccountResolver
	}
	snapshot, err := resolver.client.ResolveAlias(ctx, providerID, cliAccountID)
	if err != nil {
		return accountcore.Account{}, err
	}
	account, err := accountcore.RestoreAccount(resolver.catalog, accountcore.RestoreAccountInput{
		Ref:          snapshot.AccountRef,
		ProviderID:   snapshot.ProviderID,
		CLIAccountID: snapshot.CLIAccountID,
		Enabled:      snapshot.Enabled,
		CreatedAt:    snapshot.CreatedAt,
		UpdatedAt:    snapshot.UpdatedAt,
	})
	if err != nil {
		return accountcore.Account{}, errInvalidGatewayAccountResolver
	}
	return account, nil
}
