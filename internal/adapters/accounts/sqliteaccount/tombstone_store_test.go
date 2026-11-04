package sqliteaccount

import (
	"context"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
)

func TestDeleteAccountWritesAccountAndAPIKeyTombstones(t *testing.T) {
	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}
	store, err := Open(ctx, OpenOptions{AIHomeDir: t.TempDir(), Catalog: catalog})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatal(err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref: accountRef, ProviderID: "codex", CLIAccountID: 1, Enabled: true,
		CreatedAt: time.UnixMilli(100).UTC(), UpdatedAt: time.UnixMilli(100).UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Create(ctx, account); err != nil {
		t.Fatal(err)
	}

	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  "sk-tombstone-test",
		BaseURL: "https://tombstone.example/v1",
	})
	if err != nil {
		t.Fatal(err)
	}
	document, err := store.credentials.Encode(credential)
	if err != nil {
		t.Fatal(err)
	}
	credentialRef, err := accountcore.DeriveCredentialRef(credential)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(
		ctx,
		`INSERT INTO account_credentials (
			account_ref, credential_ref, auth_kind, auth_mode,
			format_version, credential_json, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		accountRef.String(),
		credentialRef.String(),
		document.authKind,
		document.authMode,
		credentialFormatVersion,
		string(document.json),
		100,
	); err != nil {
		t.Fatal(err)
	}

	if err := store.DeleteAccount(ctx, accountRef); err != nil {
		t.Fatal(err)
	}
	if tombstoned, err := store.IsAccountTombstoned(ctx, accountRef.String()); err != nil || !tombstoned {
		t.Fatalf("account tombstone = %v, %v", tombstoned, err)
	}
	if tombstoned, err := store.IsAPIKeyTombstoned(ctx, "codex", "sk-tombstone-test"); err != nil || !tombstoned {
		t.Fatalf("api key tombstone = %v, %v", tombstoned, err)
	}
	if tombstoned, err := store.IsAPIKeyTombstoned(ctx, "codex", "another-key"); err != nil || tombstoned {
		t.Fatalf("other key tombstone = %v, %v", tombstoned, err)
	}
	if _, err := store.GetByRef(ctx, accountRef); err == nil {
		t.Fatal("deleted account should not be readable")
	}
}
