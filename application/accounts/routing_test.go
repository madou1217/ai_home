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

func testCatalog(t *testing.T) *providers.Catalog {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}
