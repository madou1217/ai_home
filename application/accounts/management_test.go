package accounts_test

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

// TestManagementDelegatesBoundedOverviewQueries 验证管理用例保持查询对象和稳定身份不变。
func TestManagementDelegatesBoundedOverviewQueries(t *testing.T) {
	t.Parallel()

	account := newManagementTestAccount(t)
	overview, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account: account,
	})
	if err != nil {
		t.Fatalf("NewAccountOverview() error = %v", err)
	}
	query, err := accountapp.NewOverviewQuery("", 25)
	if err != nil {
		t.Fatalf("NewOverviewQuery() error = %v", err)
	}
	overviewStore := &managementOverviewStore{
		listResult: []accountapp.AccountOverview{overview},
		getResult:  overview,
	}
	management, err := accountapp.NewManagement(
		overviewStore,
		&managementLifecycleStore{},
		func() time.Time { return time.Now() },
	)
	if err != nil {
		t.Fatalf("NewManagement() error = %v", err)
	}

	listed, err := management.ListAccountOverviews(context.Background(), query)
	if err != nil {
		t.Fatalf("ListAccountOverviews() error = %v", err)
	}
	got, err := management.GetAccountOverview(context.Background(), account.Ref())
	if err != nil {
		t.Fatalf("GetAccountOverview() error = %v", err)
	}
	if len(listed) != 1 ||
		listed[0].Account() != account ||
		got.Account() != account ||
		overviewStore.listQuery != query ||
		overviewStore.getRef != account.Ref() {
		t.Fatalf(
			"management query delegation invalid: listed=%#v got=%#v store=%#v",
			listed,
			got,
			overviewStore,
		)
	}
	byAlias, err := management.GetAccountOverviewByCLIAccountID(
		context.Background(),
		account.ProviderID(),
		account.CLIAccountID(),
	)
	if err != nil ||
		byAlias.Account() != account ||
		overviewStore.aliasProviderID != account.ProviderID() ||
		overviewStore.aliasAccountID != account.CLIAccountID() {
		t.Fatalf("alias overview=%#v store=%#v error=%v", byAlias, overviewStore, err)
	}
}

// TestManagementSetEnabledUsesInjectedClock 验证启停命令只读取一次应用时钟。
func TestManagementSetEnabledUsesInjectedClock(t *testing.T) {
	t.Parallel()

	account := newManagementTestAccount(t)
	changedAt := account.UpdatedAt().Add(time.Minute)
	disabled, err := account.WithEnabled(false, changedAt)
	if err != nil {
		t.Fatalf("WithEnabled() error = %v", err)
	}
	lifecycleStore := &managementLifecycleStore{result: disabled}
	clockCalls := 0
	management, err := accountapp.NewManagement(
		&managementOverviewStore{},
		lifecycleStore,
		func() time.Time {
			clockCalls++
			return changedAt
		},
	)
	if err != nil {
		t.Fatalf("NewManagement() error = %v", err)
	}

	got, err := management.SetAccountEnabled(
		context.Background(),
		account.Ref(),
		false,
	)
	if err != nil {
		t.Fatalf("SetAccountEnabled() error = %v", err)
	}
	if got != disabled ||
		lifecycleStore.accountRef != account.Ref() ||
		lifecycleStore.enabled ||
		!lifecycleStore.changedAt.Equal(changedAt) ||
		clockCalls != 1 {
		t.Fatalf(
			"management lifecycle delegation invalid: got=%#v store=%#v calls=%d",
			got,
			lifecycleStore,
			clockCalls,
		)
	}
}

// TestManagementRejectsInvalidDependenciesAndIdentity 验证错误装配和无效账号身份失败关闭。
func TestManagementRejectsInvalidDependenciesAndIdentity(t *testing.T) {
	t.Parallel()

	overviewStore := &managementOverviewStore{}
	lifecycleStore := &managementLifecycleStore{}
	clock := func() time.Time { return time.Now() }
	tests := []struct {
		name           string
		overviewStore  accountapp.AccountOverviewStore
		lifecycleStore accountapp.AccountLifecycleStore
		clock          accountapp.Clock
	}{
		{name: "missing overview store", lifecycleStore: lifecycleStore, clock: clock},
		{name: "missing lifecycle store", overviewStore: overviewStore, clock: clock},
		{name: "missing clock", overviewStore: overviewStore, lifecycleStore: lifecycleStore},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			_, err := accountapp.NewManagement(
				test.overviewStore,
				test.lifecycleStore,
				test.clock,
			)
			if !errors.Is(err, accountapp.ErrInvalidManagementDependencies) {
				t.Fatalf(
					"NewManagement() error = %v, want ErrInvalidManagementDependencies",
					err,
				)
			}
		})
	}

	management, err := accountapp.NewManagement(
		overviewStore,
		lifecycleStore,
		clock,
	)
	if err != nil {
		t.Fatalf("NewManagement() error = %v", err)
	}
	if _, err := management.SetAccountEnabled(
		context.Background(),
		"invalid",
		false,
	); !errors.Is(err, accountcore.ErrInvalidAccountRef) {
		t.Fatalf("SetAccountEnabled() error = %v, want ErrInvalidAccountRef", err)
	}
	if _, err := management.ListAccountOverviews(
		context.Background(),
		accountapp.OverviewQuery{},
	); !errors.Is(err, accountapp.ErrInvalidOverview) {
		t.Fatalf("ListAccountOverviews() error = %v, want ErrInvalidOverview", err)
	}
	if lifecycleStore.calls != 0 {
		t.Fatalf("invalid identity reached lifecycle store: calls=%d", lifecycleStore.calls)
	}
	if overviewStore.listCalls != 0 {
		t.Fatalf("invalid query reached overview store: calls=%d", overviewStore.listCalls)
	}
}

// managementOverviewStore 是账号管理查询用例的可观察测试替身。
type managementOverviewStore struct {
	listQuery       accountapp.OverviewQuery
	listResult      []accountapp.AccountOverview
	listErr         error
	listCalls       int
	getRef          accountcore.AccountRef
	getResult       accountapp.AccountOverview
	getErr          error
	aliasProviderID string
	aliasAccountID  accountcore.CLIAccountID
	aliasResult     accountapp.AccountOverview
	aliasErr        error
}

// GetAccountOverviewByCLIAccountID 记录 Provider 数字别名并返回预设投影。
func (store *managementOverviewStore) GetAccountOverviewByCLIAccountID(
	_ context.Context,
	providerID string,
	cliAccountID accountcore.CLIAccountID,
) (accountapp.AccountOverview, error) {
	store.aliasProviderID = providerID
	store.aliasAccountID = cliAccountID
	if store.aliasResult.Account().IsValid() || store.aliasErr != nil {
		return store.aliasResult, store.aliasErr
	}
	return store.getResult, store.getErr
}

// ListAccountOverviews 记录分页查询并返回预设结果。
func (store *managementOverviewStore) ListAccountOverviews(
	_ context.Context,
	query accountapp.OverviewQuery,
) ([]accountapp.AccountOverview, error) {
	store.listCalls++
	store.listQuery = query
	return store.listResult, store.listErr
}

// GetAccountOverview 记录稳定账号身份并返回预设结果。
func (store *managementOverviewStore) GetAccountOverview(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.AccountOverview, error) {
	store.getRef = accountRef
	return store.getResult, store.getErr
}

// managementLifecycleStore 是账号启停用例的可观察测试替身。
type managementLifecycleStore struct {
	accountRef accountcore.AccountRef
	enabled    bool
	changedAt  time.Time
	result     accountcore.Account
	err        error
	calls      int
}

// SetEnabled 记录生命周期命令并返回预设账号快照。
func (store *managementLifecycleStore) SetEnabled(
	_ context.Context,
	accountRef accountcore.AccountRef,
	enabled bool,
	changedAt time.Time,
) (accountcore.Account, error) {
	store.calls++
	store.accountRef = accountRef
	store.enabled = enabled
	store.changedAt = changedAt
	return store.result, store.err
}

// newManagementTestAccount 创建账号管理用例共享的有效账号。
func newManagementTestAccount(t *testing.T) accountcore.Account {
	t.Helper()

	auth, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "management-test-credential",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(
		testCatalog(t),
		accountcore.NewAccountInput{
			Identity:     auth,
			CLIAccountID: alias,
			CreatedAt:    time.Date(2026, time.July, 27, 0, 0, 0, 0, time.UTC),
		},
	)
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	return account
}
