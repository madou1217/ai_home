package accountsapi_test

import (
	"context"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// newAccountServiceImporter 让既有 HTTP 测试替身复用真实导入应用服务语义。
func newAccountServiceImporter(
	t *testing.T,
	service *accountServiceStub,
) *accountapp.AccountImporter {
	t.Helper()

	importer, err := accountapp.NewAccountImporter(service, service, service)
	if err != nil {
		t.Fatalf("NewAccountImporter() error = %v", err)
	}
	return importer
}

// GetByRef 返回测试替身最近一次持久化的统一公开投影对应聚合。
func (service *accountServiceStub) GetByRef(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountcore.Account, error) {
	if service.overview == nil || service.overview.Account().Ref() != accountRef {
		return accountcore.Account{}, accountapp.ErrAccountNotFound
	}
	return service.overview.Account(), nil
}

// Reauthenticate 模拟同一 OAuth 身份在原账号内更新，不分配新数字别名。
func (service *accountServiceStub) Reauthenticate(
	_ context.Context,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
) (accountcore.Account, error) {
	account, err := service.GetByRef(context.Background(), accountRef)
	if err != nil {
		return accountcore.Account{}, err
	}
	service.registeredCredential = credential
	service.registeredProfile = profile
	return account, nil
}
