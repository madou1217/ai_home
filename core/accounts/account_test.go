package accounts_test

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
)

var (
	_ accounts.IdentitySource = (*codex.OAuthAuth)(nil)
	_ accounts.IdentitySource = (*codex.APIKeyAuth)(nil)
	_ accounts.IdentitySource = (*claude.OAuthAuth)(nil)
	_ accounts.IdentitySource = (*claude.OAuthTokenAuth)(nil)
	_ accounts.IdentitySource = (*claude.APIKeyAuth)(nil)
	_ accounts.IdentitySource = (*claude.AuthTokenAuth)(nil)
)

func TestNewAccountBuildsEnabledAccountFromProviderAuth(t *testing.T) {
	t.Parallel()

	const secret = "sk-test-account-core-secret"
	auth, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: secret})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	cliAccountID, err := accounts.NewCLIAccountID(42)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	createdAt := time.Date(2026, time.July, 27, 12, 30, 15, 987_654_321, time.FixedZone("CST", 8*60*60))

	account, err := accounts.NewAccount(builtinCatalog(t), accounts.NewAccountInput{
		Identity:     auth,
		CLIAccountID: cliAccountID,
		CreatedAt:    createdAt,
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}

	if account.ProviderID() != codex.ProviderID {
		t.Fatalf("ProviderID() = %q, want %q", account.ProviderID(), codex.ProviderID)
	}
	if account.CLIAccountID() != cliAccountID {
		t.Fatalf("CLIAccountID() = %v, want %v", account.CLIAccountID(), cliAccountID)
	}
	if !account.Enabled() {
		t.Fatal("new account must be enabled")
	}
	if !account.IsValid() {
		t.Fatal("new account must satisfy aggregate invariants")
	}
	expectedTime := time.Date(2026, time.July, 27, 4, 30, 15, 987_000_000, time.UTC)
	if !account.CreatedAt().Equal(expectedTime) || !account.UpdatedAt().Equal(expectedTime) {
		t.Fatalf("timestamps = (%s, %s), want %s", account.CreatedAt(), account.UpdatedAt(), expectedTime)
	}
	if account.Ref().String() == "" {
		t.Fatal("Ref() must not be empty")
	}
	if strings.Contains(fmt.Sprintf("%#v", account), secret) {
		t.Fatal("account representation leaked credential")
	}
}

func TestNewAccountRejectsUnknownProviderAndInvalidInput(t *testing.T) {
	t.Parallel()

	cliAccountID, err := accounts.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	validTime := time.Date(2026, time.July, 27, 0, 0, 0, 0, time.UTC)

	tests := []struct {
		name    string
		catalog *providers.Catalog
		input   accounts.NewAccountInput
		target  error
	}{
		{
			name:    "nil catalog",
			catalog: nil,
			input: accounts.NewAccountInput{
				Identity:     testIdentitySource{providerID: "codex", identitySeed: "oauth:codex:user:personal"},
				CLIAccountID: cliAccountID,
				CreatedAt:    validTime,
			},
			target: accounts.ErrUnknownProvider,
		},
		{
			name:    "unknown provider",
			catalog: builtinCatalog(t),
			input: accounts.NewAccountInput{
				Identity:     testIdentitySource{providerID: "future", identitySeed: "oauth:future:user"},
				CLIAccountID: cliAccountID,
				CreatedAt:    validTime,
			},
			target: accounts.ErrUnknownProvider,
		},
		{
			name:    "zero alias",
			catalog: builtinCatalog(t),
			input: accounts.NewAccountInput{
				Identity:  testIdentitySource{providerID: "codex", identitySeed: "oauth:codex:user:personal"},
				CreatedAt: validTime,
			},
			target: accounts.ErrInvalidCLIAccountID,
		},
		{
			name:    "zero time",
			catalog: builtinCatalog(t),
			input: accounts.NewAccountInput{
				Identity:     testIdentitySource{providerID: "codex", identitySeed: "oauth:codex:user:personal"},
				CLIAccountID: cliAccountID,
			},
			target: accounts.ErrInvalidAccountTime,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			_, createErr := accounts.NewAccount(test.catalog, test.input)
			if !errors.Is(createErr, test.target) {
				t.Fatalf("error = %v, want %v", createErr, test.target)
			}
		})
	}
}

func TestAccountWithEnabledReturnsIndependentLifecycleSnapshot(t *testing.T) {
	t.Parallel()

	cliAccountID, err := accounts.NewCLIAccountID(7)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	createdAt := time.Date(2026, time.July, 27, 1, 2, 3, 0, time.UTC)
	account, err := accounts.NewAccount(builtinCatalog(t), accounts.NewAccountInput{
		Identity: testIdentitySource{
			providerID:   "claude",
			identitySeed: "oauth:claude:uuid:01234567-89ab-cdef-0123-456789abcdef",
		},
		CLIAccountID: cliAccountID,
		CreatedAt:    createdAt,
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}

	disabledAt := createdAt.Add(1500 * time.Millisecond)
	disabled, err := account.WithEnabled(false, disabledAt)
	if err != nil {
		t.Fatalf("WithEnabled(false) error = %v", err)
	}
	if !account.Enabled() {
		t.Fatal("original account snapshot was mutated")
	}
	if disabled.Enabled() {
		t.Fatal("disabled account remained enabled")
	}
	if !disabled.UpdatedAt().Equal(disabledAt) {
		t.Fatalf("UpdatedAt() = %s, want %s", disabled.UpdatedAt(), disabledAt)
	}

	unchanged, err := disabled.WithEnabled(false, time.Time{})
	if err != nil {
		t.Fatalf("idempotent WithEnabled(false) error = %v", err)
	}
	if unchanged != disabled {
		t.Fatal("idempotent state change should preserve the snapshot")
	}

	_, err = disabled.WithEnabled(true, createdAt)
	if !errors.Is(err, accounts.ErrAccountTimeRegression) {
		t.Fatalf("error = %v, want ErrAccountTimeRegression", err)
	}
}

func TestZeroAccountRejectsLifecycleChanges(t *testing.T) {
	t.Parallel()

	var account accounts.Account
	if account.IsValid() {
		t.Fatal("zero Account must be invalid")
	}
	_, err := account.WithEnabled(false, time.Time{})
	if !errors.Is(err, accounts.ErrInvalidAccount) {
		t.Fatalf("error = %v, want ErrInvalidAccount", err)
	}
}

func builtinCatalog(t *testing.T) *providers.Catalog {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}
