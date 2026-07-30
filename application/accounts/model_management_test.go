package accounts_test

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

// TestModelManagementRefreshesValidatedCredentialSnapshot 验证刷新先复核身份再替换模型。
func TestModelManagementRefreshesValidatedCredentialSnapshot(t *testing.T) {
	t.Parallel()

	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "synthetic-model-management-key",
	})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth() error = %v", err)
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	discoverer := &observableModelDiscoverer{
		providerID: "codex",
		models:     []string{"gpt-zeta", "gpt-alpha"},
	}
	discovery, err := accountapp.NewModelDiscovery(
		testCatalog(t),
		[]accountapp.ProviderModelDiscoverer{
			discoverer,
			&observableModelDiscoverer{
				providerID: "claude",
				models:     []string{"claude-sonnet-4"},
			},
		},
	)
	if err != nil {
		t.Fatalf("NewModelDiscovery() error = %v", err)
	}
	store := &modelManagementStoreStub{credential: credential}
	updatedAt := time.Date(
		2026,
		time.July,
		30,
		9,
		8,
		7,
		654_999_999,
		time.UTC,
	)
	management, err := accountapp.NewModelManagement(
		store,
		store,
		discovery,
		func() time.Time { return updatedAt },
	)
	if err != nil {
		t.Fatalf("NewModelManagement() error = %v", err)
	}
	if _, err := management.RefreshAccountModels(
		context.Background(),
		accountRef,
	); err != nil {
		t.Fatalf("RefreshAccountModels() error = %v", err)
	}
	if discoverer.calls != 1 ||
		store.replaceCalls != 1 ||
		store.replacedRef != accountRef ||
		len(store.replacedModels) != 2 ||
		store.replacedModels[0].String() != "gpt-alpha" ||
		store.replacedModels[1].String() != "gpt-zeta" ||
		!store.replacedAt.Equal(updatedAt.Truncate(time.Millisecond)) {
		t.Fatalf(
			"refresh discovery=%d store=%#v",
			discoverer.calls,
			store,
		)
	}
}

// TestModelManagementKeepsSnapshotWhenDiscoveryFails 验证上游失败不会调用替换端口。
func TestModelManagementKeepsSnapshotWhenDiscoveryFails(t *testing.T) {
	t.Parallel()

	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "synthetic-model-failure-key",
	})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth() error = %v", err)
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	discoverer := &observableModelDiscoverer{
		providerID: "codex",
		err:        errors.New("synthetic upstream failure"),
	}
	discovery, err := accountapp.NewModelDiscovery(
		testCatalog(t),
		[]accountapp.ProviderModelDiscoverer{
			discoverer,
			&observableModelDiscoverer{
				providerID: "claude",
				models:     []string{"claude-sonnet-4"},
			},
		},
	)
	if err != nil {
		t.Fatalf("NewModelDiscovery() error = %v", err)
	}
	store := &modelManagementStoreStub{credential: credential}
	management, err := accountapp.NewModelManagement(
		store,
		store,
		discovery,
		time.Now,
	)
	if err != nil {
		t.Fatalf("NewModelManagement() error = %v", err)
	}
	_, err = management.RefreshAccountModels(context.Background(), accountRef)
	if !errors.Is(err, accountapp.ErrModelDiscoveryFailed) {
		t.Fatalf("RefreshAccountModels() error = %v", err)
	}
	if discoverer.calls != 1 || store.replaceCalls != 0 {
		t.Fatalf(
			"failed refresh discovery=%d replace=%d",
			discoverer.calls,
			store.replaceCalls,
		)
	}
}

// observableModelDiscoverer 记录应用服务是否访问 Provider 目录。
type observableModelDiscoverer struct {
	providerID string
	models     []string
	err        error
	calls      int
}

func (discoverer *observableModelDiscoverer) ProviderID() string {
	return discoverer.providerID
}

func (discoverer *observableModelDiscoverer) DiscoverModels(
	context.Context,
	accountapp.Credential,
) ([]string, error) {
	discoverer.calls++
	return discoverer.models, discoverer.err
}

// modelManagementStoreStub 实现凭据读取和模型替换两个细粒度端口。
type modelManagementStoreStub struct {
	credential     accountapp.Credential
	credentialErr  error
	replacedRef    accountcore.AccountRef
	replacedModels []runtimecore.ModelID
	replacedAt     time.Time
	replaceCalls   int
}

func (store *modelManagementStoreStub) GetCredential(
	context.Context,
	accountcore.AccountRef,
) (accountapp.Credential, error) {
	return store.credential, store.credentialErr
}

func (store *modelManagementStoreStub) ListAccountModels(
	context.Context,
	accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	return nil, nil
}

func (store *modelManagementStoreStub) ReplaceDiscoveredModels(
	_ context.Context,
	accountRef accountcore.AccountRef,
	models []runtimecore.ModelID,
	updatedAt time.Time,
) ([]accountapp.AccountModel, error) {
	store.replaceCalls++
	store.replacedRef = accountRef
	store.replacedModels = append([]runtimecore.ModelID(nil), models...)
	store.replacedAt = updatedAt
	return nil, nil
}

func (store *modelManagementStoreStub) SetManualModelPolicy(
	context.Context,
	accountcore.AccountRef,
	runtimecore.ModelID,
	accountapp.ModelManualPolicy,
	time.Time,
) ([]accountapp.AccountModel, error) {
	return nil, nil
}
