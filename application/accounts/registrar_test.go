package accounts_test

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
)

// TestRegistrarBuildsIdentityBoundRequest 验证注册用例只向持久化端口提交规范命令。
func TestRegistrarBuildsIdentityBoundRequest(t *testing.T) {
	t.Parallel()

	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "registrar-test-credential",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	observedAt := time.Date(
		2026,
		time.July,
		27,
		17,
		1,
		2,
		345_999_999,
		time.FixedZone("CST", 8*60*60),
	)
	expectedTime := time.Date(2026, time.July, 27, 9, 1, 2, 345_000_000, time.UTC)
	store := &registrationStoreStub{}
	clockCalls := 0
	catalog := testCatalog(t)
	registrar, err := accountapp.NewRegistrar(
		catalog,
		store,
		newTestModelDiscovery(t, catalog),
		func() time.Time {
			clockCalls++
			return observedAt
		},
	)
	if err != nil {
		t.Fatalf("NewRegistrar() error = %v", err)
	}

	if _, err := registrar.Register(
		context.Background(),
		credential,
		nil,
	); err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	expectedRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	if store.calls != 1 ||
		clockCalls != 1 ||
		!store.request.IsValid() ||
		store.request.AccountRef() != expectedRef ||
		store.request.ProviderID() != codex.ProviderID ||
		store.request.Credential() != credential ||
		store.request.HasProfile() ||
		!store.request.RegisteredAt().Equal(expectedTime) {
		t.Fatalf(
			"registration request invalid: request=%#v store_calls=%d clock_calls=%d",
			store.request,
			store.calls,
			clockCalls,
		)
	}
}

// TestRegistrarRejectsMismatchedProfileBeforePersistence 验证凭据和公开资料身份不一致时失败关闭。
func TestRegistrarRejectsMismatchedProfileBeforePersistence(t *testing.T) {
	t.Parallel()

	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "registrar-mismatch-credential",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	profile, err := codex.NewAccountProfile(codex.Profile{
		UserID:    "registrar-oauth-user",
		AccountID: codex.PersonalAccountID,
		Email:     "registrar@example.invalid",
		Plan:      codex.ParsePlan("plus"),
	})
	if err != nil {
		t.Fatalf("NewAccountProfile() error = %v", err)
	}
	store := &registrationStoreStub{}
	catalog := testCatalog(t)
	discoveryCalls := 0
	registrar, err := accountapp.NewRegistrar(
		catalog,
		store,
		newObservedModelDiscovery(t, catalog, &discoveryCalls),
		func() time.Time {
			return time.Date(2026, time.July, 27, 0, 0, 0, 0, time.UTC)
		},
	)
	if err != nil {
		t.Fatalf("NewRegistrar() error = %v", err)
	}

	if _, err := registrar.Register(
		context.Background(),
		credential,
		profile,
	); !errors.Is(err, accountapp.ErrInvalidRegistration) {
		t.Fatalf("Register() error = %v, want ErrInvalidRegistration", err)
	}
	if store.calls != 0 || discoveryCalls != 0 {
		t.Fatalf(
			"mismatched profile reached external port: store=%d discovery=%d",
			store.calls,
			discoveryCalls,
		)
	}
}

// TestRegistrarRejectsInvalidDependencies 验证注册用例不能在缺少依赖时启动。
func TestRegistrarRejectsInvalidDependencies(t *testing.T) {
	t.Parallel()

	store := &registrationStoreStub{}
	clock := func() time.Time { return time.Now() }
	tests := []struct {
		name    string
		catalog bool
		store   accountapp.RegistrationStore
		models  bool
		clock   accountapp.Clock
	}{
		{name: "missing catalog", store: store, models: true, clock: clock},
		{name: "missing store", catalog: true, models: true, clock: clock},
		{name: "missing models", catalog: true, store: store, clock: clock},
		{name: "missing clock", catalog: true, store: store, models: true},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			var catalog = testCatalog(t)
			if !test.catalog {
				catalog = nil
			}
			var models *accountapp.ModelDiscovery
			if test.models && catalog != nil {
				models = newTestModelDiscovery(t, catalog)
			}
			_, err := accountapp.NewRegistrar(
				catalog,
				test.store,
				models,
				test.clock,
			)
			if !errors.Is(err, accountapp.ErrInvalidRegistrarDependencies) {
				t.Fatalf(
					"NewRegistrar() error = %v, want ErrInvalidRegistrarDependencies",
					err,
				)
			}
		})
	}
}

// newTestModelDiscovery 创建 Codex、Claude 共用的无网络目录策略。
func newTestModelDiscovery(
	t *testing.T,
	catalog *providers.Catalog,
) *accountapp.ModelDiscovery {
	t.Helper()

	discovery, err := accountapp.NewModelDiscovery(
		catalog,
		[]accountapp.ProviderModelDiscoverer{
			testProviderModelDiscoverer{providerID: "codex"},
			testProviderModelDiscoverer{providerID: "claude"},
		},
	)
	if err != nil {
		t.Fatalf("NewModelDiscovery() error = %v", err)
	}
	return discovery
}

// newObservedModelDiscovery 创建可验证无效输入不会访问目录的测试注册表。
func newObservedModelDiscovery(
	t *testing.T,
	catalog *providers.Catalog,
	calls *int,
) *accountapp.ModelDiscovery {
	t.Helper()

	discovery, err := accountapp.NewModelDiscovery(
		catalog,
		[]accountapp.ProviderModelDiscoverer{
			testProviderModelDiscoverer{
				providerID: "codex",
				calls:      calls,
			},
			testProviderModelDiscoverer{
				providerID: "claude",
				calls:      calls,
			},
		},
	)
	if err != nil {
		t.Fatalf("NewModelDiscovery() error = %v", err)
	}
	return discovery
}

// testProviderModelDiscoverer 返回确定性的账号管理阶段模型目录。
type testProviderModelDiscoverer struct {
	providerID string
	calls      *int
}

func (discoverer testProviderModelDiscoverer) ProviderID() string {
	return discoverer.providerID
}

func (discoverer testProviderModelDiscoverer) DiscoverModels(
	context.Context,
	accountapp.Credential,
) ([]string, error) {
	if discoverer.calls != nil {
		*discoverer.calls++
	}
	return []string{"test-model"}, nil
}

// registrationStoreStub 是注册应用用例的可观察持久化替身。
type registrationStoreStub struct {
	request accountapp.RegistrationRequest
	result  accountcore.Account
	err     error
	calls   int
}

// RegisterNew 记录注册命令并返回预设结果。
func (store *registrationStoreStub) RegisterNew(
	_ context.Context,
	request accountapp.RegistrationRequest,
) (accountcore.Account, error) {
	store.calls++
	store.request = request
	return store.result, store.err
}
