package accounts_test

import (
	"errors"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

func TestRoutingQueryNormalizesProviderAndAppliesDefaultLimit(t *testing.T) {
	t.Parallel()

	query, err := accountapp.NewRoutingQuery(
		testCatalog(t),
		" CODEX ",
		"gpt-5.6-sol",
		"",
		0,
	)
	if err != nil {
		t.Fatalf("NewRoutingQuery() error = %v", err)
	}
	if query.ProviderID() != "codex" {
		t.Fatalf("ProviderID() = %q, want codex", query.ProviderID())
	}
	if query.ModelID().String() != "gpt-5.6-sol" {
		t.Fatalf("ModelID() = %q, want gpt-5.6-sol", query.ModelID())
	}
	if query.AfterRef() != "" {
		t.Fatalf("AfterRef() = %q, want empty", query.AfterRef())
	}
	if query.Limit() != accountapp.DefaultRoutingLimit {
		t.Fatalf("Limit() = %d, want %d", query.Limit(), accountapp.DefaultRoutingLimit)
	}
}

func TestRoutingQueryRejectsUnknownProviderInvalidCursorAndLimit(t *testing.T) {
	t.Parallel()

	validRef, err := accountcore.ParseAccountRef("acct_4a6fd2d115fe1edacb4a")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	tests := []struct {
		name       string
		catalog    *providers.Catalog
		providerID string
		modelID    string
		afterRef   accountcore.AccountRef
		limit      int
	}{
		{name: "nil catalog", providerID: "codex", modelID: "gpt-5", limit: 1},
		{
			name:       "unknown provider",
			catalog:    testCatalog(t),
			providerID: "future",
			modelID:    "gpt-5",
			limit:      1,
		},
		{name: "invalid model", catalog: testCatalog(t), providerID: "codex", limit: 1},
		{
			name:       "invalid cursor",
			catalog:    testCatalog(t),
			providerID: "codex",
			modelID:    "gpt-5",
			afterRef:   "bad",
			limit:      1,
		},
		{
			name:       "negative limit",
			catalog:    testCatalog(t),
			providerID: "codex",
			modelID:    "gpt-5",
			limit:      -1,
		},
		{
			name:       "limit too large",
			catalog:    testCatalog(t),
			providerID: "codex",
			modelID:    "gpt-5",
			afterRef:   validRef,
			limit:      accountapp.MaxRoutingLimit + 1,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			_, queryErr := accountapp.NewRoutingQuery(
				test.catalog,
				test.providerID,
				test.modelID,
				test.afterRef,
				test.limit,
			)
			if !errors.Is(queryErr, accountapp.ErrInvalidRoutingQuery) {
				t.Fatalf("NewRoutingQuery() error = %v, want ErrInvalidRoutingQuery", queryErr)
			}
		})
	}
}

func TestRoutingAccountContainsOnlyHotPathIdentity(t *testing.T) {
	t.Parallel()

	accountRef, err := accountcore.ParseAccountRef("acct_4a6fd2d115fe1edacb4a")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(42)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountapp.NewRoutingAccount(testCatalog(t), accountapp.RoutingAccountInput{
		Ref:          accountRef,
		ProviderID:   "codex",
		CLIAccountID: cliAccountID,
	})
	if err != nil {
		t.Fatalf("NewRoutingAccount() error = %v", err)
	}
	if account.Ref() != accountRef ||
		account.ProviderID() != "codex" ||
		account.CLIAccountID() != cliAccountID {
		t.Fatalf("RoutingAccount 字段错误: %#v", account)
	}
}

func TestRoutingAccountRejectsNonCanonicalPersistedProvider(t *testing.T) {
	t.Parallel()

	accountRef, err := accountcore.ParseAccountRef("acct_4a6fd2d115fe1edacb4a")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	_, err = accountapp.NewRoutingAccount(testCatalog(t), accountapp.RoutingAccountInput{
		Ref:          accountRef,
		ProviderID:   " CODEX ",
		CLIAccountID: cliAccountID,
	})
	if !errors.Is(err, accountapp.ErrInvalidRoutingAccount) {
		t.Fatalf("NewRoutingAccount() error = %v, want ErrInvalidRoutingAccount", err)
	}
}

// TestRoutingCandidatesCopiesInputAndRejectsOutOfRangeRead 验证候选快照不暴露底层切片。
func TestRoutingCandidatesCopiesInputAndRejectsOutOfRangeRead(t *testing.T) {
	t.Parallel()

	accountRef, err := accountcore.ParseAccountRef("acct_4a6fd2d115fe1edacb4a")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountapp.NewRoutingAccount(
		testCatalog(t),
		accountapp.RoutingAccountInput{
			Ref:          accountRef,
			ProviderID:   "codex",
			CLIAccountID: cliAccountID,
		},
	)
	if err != nil {
		t.Fatalf("NewRoutingAccount() error = %v", err)
	}
	input := []accountapp.RoutingAccount{account, account}
	snapshot := accountapp.NewRoutingCandidates(input)
	input[0] = accountapp.RoutingAccount{}

	got, found := snapshot.At(0)
	if snapshot.Len() != 1 || !found || got.Ref() != account.Ref() {
		t.Fatalf("snapshot len=%d found=%t account=%#v", snapshot.Len(), found, got)
	}
	if _, found := snapshot.At(-1); found {
		t.Fatal("At(-1) found = true, want false")
	}
	if _, found := snapshot.At(1); found {
		t.Fatal("At(1) found = true, want false")
	}
}

// TestRoutingCandidatesFindByRefSupportsOrderedAndUnorderedSnapshots 验证生产二分路径
// 与测试适配器无序回退都返回同一个稳定账号。
func TestRoutingCandidatesFindByRefSupportsOrderedAndUnorderedSnapshots(t *testing.T) {
	t.Parallel()

	accounts := []accountapp.RoutingAccount{
		newRoutingTestAccount(t, 1, "acct_11111111111111111111"),
		newRoutingTestAccount(t, 2, "acct_22222222222222222222"),
		newRoutingTestAccount(t, 3, "acct_33333333333333333333"),
	}
	tests := []struct {
		name     string
		accounts []accountapp.RoutingAccount
	}{
		{name: "ordered", accounts: accounts},
		{name: "unordered", accounts: []accountapp.RoutingAccount{accounts[2], accounts[0], accounts[1]}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			snapshot := accountapp.NewRoutingCandidates(test.accounts)
			got, found := snapshot.FindByRef(accounts[1].Ref())
			if !found || got.Ref() != accounts[1].Ref() || got.CLIAccountID() != accounts[1].CLIAccountID() {
				t.Fatalf("FindByRef() account=%#v found=%t", got, found)
			}
			missing, err := accountcore.ParseAccountRef("acct_99999999999999999999")
			if err != nil {
				t.Fatalf("ParseAccountRef(missing) error = %v", err)
			}
			if _, found := snapshot.FindByRef(missing); found {
				t.Fatal("FindByRef(missing) found = true")
			}
		})
	}
}

// newRoutingTestAccount 创建具有可控稳定引用的紧凑账号投影。
func newRoutingTestAccount(
	t *testing.T,
	alias int64,
	accountRefText string,
) accountapp.RoutingAccount {
	t.Helper()

	accountRef, err := accountcore.ParseAccountRef(accountRefText)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(alias)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountapp.NewRoutingAccount(
		testCatalog(t),
		accountapp.RoutingAccountInput{
			Ref:          accountRef,
			ProviderID:   "codex",
			CLIAccountID: cliAccountID,
		},
	)
	if err != nil {
		t.Fatalf("NewRoutingAccount() error = %v", err)
	}
	return account
}

func testCatalog(t testing.TB) *providers.Catalog {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}
