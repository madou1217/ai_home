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

// TestModelManagementRefreshUsesStableCredentialSnapshotBinding 验证静态凭据轮换后
// 不从新密钥重新派生账号主键，并把读取版本传给模型写事务做 CAS。
func TestModelManagementRefreshUsesStableCredentialSnapshotBinding(t *testing.T) {
	t.Parallel()

	oldCredential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "synthetic-stable-account-old-key",
	})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth(old) error = %v", err)
	}
	accountRef, err := accountcore.DeriveAccountRef(oldCredential)
	if err != nil {
		t.Fatalf("DeriveAccountRef(old) error = %v", err)
	}
	currentCredential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "synthetic-stable-account-current-key",
	})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth(current) error = %v", err)
	}
	derivedCurrentRef, err := accountcore.DeriveAccountRef(currentCredential)
	if err != nil {
		t.Fatalf("DeriveAccountRef(current) error = %v", err)
	}
	if derivedCurrentRef == accountRef {
		t.Fatal("测试凭据没有形成静态轮换身份差异")
	}
	credentialVersion := time.Date(
		2026,
		time.August,
		13,
		12,
		0,
		0,
		0,
		time.UTC,
	)
	snapshot, err := accountapp.NewCredentialSnapshot(
		accountRef,
		codex.ProviderID,
		currentCredential,
		credentialVersion,
	)
	if err != nil {
		t.Fatalf("NewCredentialSnapshot() error = %v", err)
	}
	discoverer := &observableModelDiscoverer{
		providerID: codex.ProviderID,
		models:     []string{"gpt-after-rotation"},
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
	store := &modelManagementStoreStub{
		credential: currentCredential,
		snapshot:   snapshot,
	}
	management, err := accountapp.NewModelManagement(
		store,
		store,
		discovery,
		time.Now,
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
		!store.expectedCredentialUpdatedAt.Equal(credentialVersion) {
		t.Fatalf("snapshot refresh discovery=%d store=%#v", discoverer.calls, store)
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
	credential                  accountapp.Credential
	snapshot                    accountapp.CredentialSnapshot
	snapshotErr                 error
	replacedRef                 accountcore.AccountRef
	replacedModels              []runtimecore.ModelID
	replacedAt                  time.Time
	expectedCredentialUpdatedAt time.Time
	replaceCalls                int
}

func (store *modelManagementStoreStub) GetCredentialSnapshot(
	context.Context,
	accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	if store.snapshot.IsValid() || store.snapshotErr != nil {
		return store.snapshot, store.snapshotErr
	}
	accountRef, err := accountcore.DeriveAccountRef(store.credential)
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	return accountapp.NewCredentialSnapshot(
		accountRef,
		store.credential.ProviderID(),
		store.credential,
		time.Date(2026, time.August, 13, 0, 0, 0, 0, time.UTC),
	)
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

func (store *modelManagementStoreStub) ReplaceDiscoveredModelsIfCredentialVersion(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	models []runtimecore.ModelID,
	expectedCredentialUpdatedAt time.Time,
	updatedAt time.Time,
) ([]accountapp.AccountModel, error) {
	store.expectedCredentialUpdatedAt = expectedCredentialUpdatedAt
	return store.ReplaceDiscoveredModels(ctx, accountRef, models, updatedAt)
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
