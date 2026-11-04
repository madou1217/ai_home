package sqliteaccount

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

func TestAccountUIStateRoundTrip(t *testing.T) {
	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := Open(ctx, OpenOptions{AIHomeDir: t.TempDir(), Catalog: catalog})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer store.Close()
	accountRef, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref: accountRef, ProviderID: "codex", CLIAccountID: 1, Enabled: true,
		CreatedAt: time.UnixMilli(100).UTC(), UpdatedAt: time.UnixMilli(100).UTC(),
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	state, err := accountcore.NewUIState(accountcore.UIStateInput{
		AccountRef: accountRef, Status: "down", DisplayName: "Team 01",
		AuthMode: "oauth", APIKeyMode: false, BaseURL: "https://team.example/v1",
		UpdatedAt: time.UnixMilli(2000).UTC(),
	})
	if err != nil {
		t.Fatalf("NewUIState() error = %v", err)
	}
	if err := store.ReplaceAccountUIState(ctx, state); err != nil {
		t.Fatalf("ReplaceAccountUIState() error = %v", err)
	}
	states, err := store.ListAccountUIStates(ctx)
	if err != nil || len(states) != 1 {
		t.Fatalf("ListAccountUIStates() = %v, %v", states, err)
	}
	got := states[0]
	if got.Status() != "down" || got.DisplayName() != "Team 01" || got.BaseURL() != "https://team.example/v1" {
		t.Fatalf("state = %#v", got)
	}
	missingRef, _ := accountcore.ParseAccountRef("acct_ffffffffffffffffffff")
	missing, _ := accountcore.NewUIState(accountcore.UIStateInput{
		AccountRef: missingRef, Status: "up", UpdatedAt: time.UnixMilli(2000).UTC(),
	})
	if err := store.ReplaceAccountUIState(ctx, missing); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("missing account error = %v", err)
	}
}
