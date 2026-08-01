package sqliteaccount

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestLaunchAccountSelectorUsesIndexedSQLiteSelections 验证三种启动选择都从单库返回同一稳定账号。
func TestLaunchAccountSelectorUsesIndexedSQLiteSelections(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	account := registerDefaultTestAccount(
		t,
		store,
		mustCodexAPIKey(t, "launch-selection-indexed"),
	)
	providerDefault := newProviderDefault(
		t,
		"codex",
		account.Ref(),
		testAccountTime().Add(time.Minute),
	)
	if _, err := store.SetProviderDefault(ctx, providerDefault); err != nil {
		t.Fatalf("SetProviderDefault() error = %v", err)
	}
	selector, err := accountapp.NewLaunchAccountSelector(store.catalog, store)
	if err != nil {
		t.Fatalf("NewLaunchAccountSelector() error = %v", err)
	}

	requests := []accountapp.LaunchSelectionRequest{
		{ProviderID: "codex", AccountRef: account.Ref()},
		{ProviderID: "codex", CLIAccountID: account.CLIAccountID()},
		{ProviderID: "codex"},
	}
	wantSources := []accountapp.LaunchSelectionSource{
		accountapp.LaunchSelectionSourceAccountRef,
		accountapp.LaunchSelectionSourceCLIAccountID,
		accountapp.LaunchSelectionSourceProviderDefault,
	}
	for index, request := range requests {
		selection, err := selector.Resolve(ctx, request)
		if err != nil {
			t.Fatalf("Resolve(%d) error = %v", index, err)
		}
		if selection.Account() != account || selection.Source() != wantSources[index] {
			t.Fatalf(
				"Resolve(%d) = (%#v, %s)",
				index,
				selection.Account(),
				selection.Source(),
			)
		}
	}
}

// TestLaunchAccountSelectorRejectsSQLiteIneligibleAccounts 验证真实数据库不会把跨 Provider、停用或无凭据账号用于启动。
func TestLaunchAccountSelectorRejectsSQLiteIneligibleAccounts(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	configured := registerDefaultTestAccount(
		t,
		store,
		mustCodexAPIKey(t, "launch-selection-eligibility"),
	)
	unconfigured := newCodexAPIKeyAccount(
		t,
		store,
		2,
		"launch-selection-unconfigured",
	)
	if err := store.Create(ctx, unconfigured); err != nil {
		t.Fatalf("Create(unconfigured) error = %v", err)
	}
	claudeAccount := registerDefaultTestAccount(
		t,
		store,
		mustClaudeAPIKey(t, "launch-selection-provider-mismatch"),
	)
	selector, err := accountapp.NewLaunchAccountSelector(store.catalog, store)
	if err != nil {
		t.Fatalf("NewLaunchAccountSelector() error = %v", err)
	}

	tests := []struct {
		name    string
		request accountapp.LaunchSelectionRequest
		wantErr error
	}{
		{
			name: "unconfigured",
			request: accountapp.LaunchSelectionRequest{
				ProviderID: "codex",
				AccountRef: unconfigured.Ref(),
			},
			wantErr: accountapp.ErrLaunchSelectionUnconfigured,
		},
		{
			name: "provider mismatch",
			request: accountapp.LaunchSelectionRequest{
				ProviderID: "codex",
				AccountRef: claudeAccount.Ref(),
			},
			wantErr: accountapp.ErrLaunchSelectionProviderMismatch,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := selector.Resolve(ctx, test.request); !errors.Is(
				err,
				test.wantErr,
			) {
				t.Fatalf("Resolve() error = %v, want %v", err, test.wantErr)
			}
		})
	}

	if _, err := store.SetEnabled(
		ctx,
		configured.Ref(),
		false,
		testAccountTime().Add(time.Minute),
	); err != nil {
		t.Fatalf("SetEnabled(false) error = %v", err)
	}
	if _, err := selector.Resolve(ctx, accountapp.LaunchSelectionRequest{
		ProviderID: "codex",
		AccountRef: configured.Ref(),
	}); !errors.Is(err, accountapp.ErrLaunchSelectionDisabled) {
		t.Fatalf("Resolve(disabled) error = %v", err)
	}
	if _, err := selector.Resolve(
		ctx,
		accountapp.LaunchSelectionRequest{ProviderID: "claude"},
	); !errors.Is(err, accountapp.ErrProviderDefaultNotFound) {
		t.Fatalf("Resolve(missing default) error = %v", err)
	}
}

// TestLoadLaunchCandidateByRefRejectsInvalidReference 验证适配器不会向 SQLite 发送无效身份。
func TestLoadLaunchCandidateByRefRejectsInvalidReference(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	if _, err := store.LoadLaunchCandidateByRef(
		context.Background(),
		accountcore.AccountRef("invalid"),
	); !errors.Is(err, accountapp.ErrInvalidLaunchSelection) {
		t.Fatalf("LoadLaunchCandidateByRef() error = %v", err)
	}
}

// TestLaunchAccountSelectorRejectsCorruptedCredentialSnapshot 验证仅有凭据行不等于可启动凭据。
func TestLaunchAccountSelectorRejectsCorruptedCredentialSnapshot(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	account := registerDefaultTestAccount(
		t,
		store,
		mustCodexAPIKey(t, "launch-selection-corrupted"),
	)
	if _, err := store.db.ExecContext(
		ctx,
		"UPDATE account_credentials SET credential_json = '{}' WHERE account_ref = ?",
		account.Ref().String(),
	); err != nil {
		t.Fatalf("corrupt credential fixture error = %v", err)
	}
	selector, err := accountapp.NewLaunchAccountSelector(store.catalog, store)
	if err != nil {
		t.Fatalf("NewLaunchAccountSelector() error = %v", err)
	}
	if _, err := selector.Resolve(ctx, accountapp.LaunchSelectionRequest{
		ProviderID: "codex",
		AccountRef: account.Ref(),
	}); !errors.Is(err, ErrIncompatibleDatabase) {
		t.Fatalf("Resolve(corrupted credential) error = %v", err)
	}
}
