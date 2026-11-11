package sqliteaccount

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/core/providers"
)

func newReKeyTestAuth(t *testing.T, email string) *agy.OAuthAuth {
	t.Helper()
	refreshedAt := time.Date(2026, time.November, 11, 10, 0, 0, 0, time.UTC)
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         email,
		AccessToken:   "agy-access-" + email,
		RefreshToken:  "agy-refresh-" + email,
		ExpiresAtMS:   refreshedAt.Add(time.Hour).UnixMilli(),
		RefreshedAtMS: refreshedAt.UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth(%s) error = %v", email, err)
	}
	return auth
}

func openReKeyTestStore(t *testing.T, credential accountapp.Credential) (*Store, accountcore.AccountRef) {
	t.Helper()
	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := Open(ctx, OpenOptions{AIHomeDir: t.TempDir(), Catalog: catalog})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ref, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref: ref, ProviderID: credential.ProviderID(), CLIAccountID: 7, Enabled: true,
		CreatedAt: time.UnixMilli(100_000).UTC(), UpdatedAt: time.UnixMilli(100_000).UTC(),
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	document, err := store.credentials.Encode(credential)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("BeginTx() error = %v", err)
	}
	if err := insertCredential(ctx, transaction, ref, document, 100_000); err != nil {
		_ = transaction.Rollback()
		t.Fatalf("insertCredential() error = %v", err)
	}
	if err := transaction.Commit(); err != nil {
		t.Fatalf("Commit() error = %v", err)
	}
	return store, ref
}

func TestReKeyAccountMovesAccountCredentialAndChildRows(t *testing.T) {
	ctx := context.Background()
	before := newReKeyTestAuth(t, "before@example.test")
	after := newReKeyTestAuth(t, "after@example.test")
	store, oldRef := openReKeyTestStore(t, before)
	newRef, err := accountcore.DeriveAccountRef(after)
	if err != nil || newRef == oldRef {
		t.Fatalf("DeriveAccountRef(after) = %s, %v", newRef, err)
	}
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO account_models (account_ref, model_id, upstream_available, manual_policy, updated_at_ms)
		 VALUES (?, 'gemini-3-pro', 1, 'inherit', 100000)`,
		oldRef.String(),
	); err != nil {
		t.Fatalf("insert model error = %v", err)
	}
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO account_model_probes (account_ref, provider_id, last_attempt_at_ms, last_error_code, last_error_message, last_source, last_model_count, updated_at_ms)
		 VALUES (?, 'agy', 100000, '', '', 'test', 1, 100000)`,
		oldRef.String(),
	); err != nil {
		t.Fatalf("insert probe error = %v", err)
	}
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO account_defaults (provider_id, account_ref, updated_at_ms) VALUES ('agy', ?, 100000)`,
		oldRef.String(),
	); err != nil {
		t.Fatalf("insert default error = %v", err)
	}
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO account_profiles (
			account_ref, display_name, email, subscription_kind, subscription_raw,
			format_version, profile_json, updated_at_ms
		) VALUES (?, ?, ?, 'unknown', '', 1, ?, 100000)`,
		oldRef.String(),
		"before@example.test",
		"before@example.test",
		`{"email":"before@example.test","subscription":"ultra"}`,
	); err != nil {
		t.Fatalf("insert profile error = %v", err)
	}
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO account_ui_state (account_ref, display_name, updated_at_ms)
		 VALUES (?, 'before@example.test', 100000)`,
		oldRef.String(),
	); err != nil {
		t.Fatalf("insert ui state error = %v", err)
	}

	updatedAt := time.UnixMilli(200_000).UTC()
	snapshot, err := store.ReKeyAccount(ctx, oldRef, after, updatedAt)
	if err != nil {
		t.Fatalf("ReKeyAccount() error = %v", err)
	}
	if snapshot.AccountRef() != newRef {
		t.Fatalf("snapshot ref = %s, want %s", snapshot.AccountRef(), newRef)
	}
	if _, err := store.GetByRef(ctx, oldRef); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("GetByRef(old) error = %v, want not found", err)
	}
	migrated, err := store.GetByRef(ctx, newRef)
	if err != nil {
		t.Fatalf("GetByRef(new) error = %v", err)
	}
	if migrated.CLIAccountID() != 7 || !migrated.Enabled() ||
		!migrated.CreatedAt().Equal(time.UnixMilli(100_000).UTC()) {
		t.Fatalf("migrated account = %#v", migrated)
	}
	credential, err := store.GetCredential(ctx, newRef)
	if err != nil {
		t.Fatalf("GetCredential(new) error = %v", err)
	}
	auth, ok := credential.(*agy.OAuthAuth)
	if !ok || auth.Email() != "after@example.test" {
		t.Fatalf("credential = %#v, want after@example.test", credential)
	}
	// 公开资料/展示名里的旧邮箱必须跟着身份一起更新。
	var profileEmail, profileName, profileJSON, uiName string
	if err := store.db.QueryRowContext(ctx,
		"SELECT email, display_name, profile_json FROM account_profiles WHERE account_ref = ?",
		newRef.String(),
	).Scan(&profileEmail, &profileName, &profileJSON); err != nil {
		t.Fatalf("read migrated profile error = %v", err)
	}
	if profileEmail != "after@example.test" || profileName != "after@example.test" ||
		!strings.Contains(profileJSON, "after@example.test") {
		t.Fatalf("profile = %q / %q / %s", profileEmail, profileName, profileJSON)
	}
	if err := store.db.QueryRowContext(ctx,
		"SELECT display_name FROM account_ui_state WHERE account_ref = ?",
		newRef.String(),
	).Scan(&uiName); err != nil {
		t.Fatalf("read migrated ui state error = %v", err)
	}
	if uiName != "after@example.test" {
		t.Fatalf("ui display name = %q", uiName)
	}
	for table, want := range map[string]int{
		"account_models":       1,
		"account_model_probes": 1,
		"account_defaults":     1,
		"account_profiles":     1,
		"account_ui_state":     1,
	} {
		var newCount, oldCount int
		if err := store.db.QueryRowContext(ctx,
			"SELECT COUNT(*) FROM "+table+" WHERE account_ref = ?", newRef.String(),
		).Scan(&newCount); err != nil {
			t.Fatalf("count new %s error = %v", table, err)
		}
		if err := store.db.QueryRowContext(ctx,
			"SELECT COUNT(*) FROM "+table+" WHERE account_ref = ?", oldRef.String(),
		).Scan(&oldCount); err != nil {
			t.Fatalf("count old %s error = %v", table, err)
		}
		if newCount != want || oldCount != 0 {
			t.Fatalf("%s rows new=%d old=%d, want new=%d old=0", table, newCount, oldCount, want)
		}
	}
}

func TestReKeyAccountRejectsExistingIdentity(t *testing.T) {
	ctx := context.Background()
	before := newReKeyTestAuth(t, "before@example.test")
	after := newReKeyTestAuth(t, "after@example.test")
	store, oldRef := openReKeyTestStore(t, before)
	newRef, err := accountcore.DeriveAccountRef(after)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	// 新身份已经注册成另一个账号：必须冲突，不能悄悄合并。
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO accounts (account_ref, provider_id, cli_account_id, enabled, created_at_ms, updated_at_ms)
		 VALUES (?, 'agy', 8, 1, 100000, 100000)`,
		newRef.String(),
	); err != nil {
		t.Fatalf("insert existing account error = %v", err)
	}
	if _, err := store.ReKeyAccount(ctx, oldRef, after, time.UnixMilli(200_000).UTC()); !errors.Is(err, accountapp.ErrAccountReKeyConflict) {
		t.Fatalf("ReKeyAccount() error = %v, want ErrAccountReKeyConflict", err)
	}
	if _, err := store.GetByRef(ctx, oldRef); err != nil {
		t.Fatalf("old account must survive failed rekey: %v", err)
	}
}

// 路由排除行跟着账号搬走后，内存索引也必须保持排除状态；否则 re-key 会把
// 原本不可征召的账号重新放回候选集合。
func TestReKeyAccountKeepsRoutingExclusion(t *testing.T) {
	ctx := context.Background()
	before := newReKeyTestAuth(t, "before@example.test")
	after := newReKeyTestAuth(t, "after@example.test")
	store, oldRef := openReKeyTestStore(t, before)
	newRef, err := accountcore.DeriveAccountRef(after)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	if _, err := store.ReplaceDiscoveredModels(
		ctx,
		oldRef,
		[]runtimecore.ModelID{"gemini-3-pro"},
		time.UnixMilli(150_000).UTC(),
	); err != nil {
		t.Fatalf("ReplaceDiscoveredModels() error = %v", err)
	}
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO account_routing_exclusions (account_ref, excluded, reason, updated_at_ms)
		 VALUES (?, 1, 'test', 100000)`,
		oldRef.String(),
	); err != nil {
		t.Fatalf("insert exclusion error = %v", err)
	}
	if _, err := store.ReKeyAccount(ctx, oldRef, after, time.UnixMilli(200_000).UTC()); err != nil {
		t.Fatalf("ReKeyAccount() error = %v", err)
	}
	candidates, err := store.LoadRoutingCandidates(ctx, "agy", "gemini-3-pro")
	if err != nil {
		t.Fatalf("LoadRoutingCandidates() error = %v", err)
	}
	if _, found := candidates.FindByRef(newRef); found {
		t.Fatal("excluded account must not become routable after rekey")
	}
	var excluded int
	if err := store.db.QueryRowContext(ctx,
		"SELECT excluded FROM account_routing_exclusions WHERE account_ref = ?",
		newRef.String(),
	).Scan(&excluded); err != nil {
		t.Fatalf("read migrated exclusion error = %v", err)
	}
	if excluded != 1 {
		t.Fatalf("excluded = %d, want 1", excluded)
	}
}
