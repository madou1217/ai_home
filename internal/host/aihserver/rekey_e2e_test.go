package aihserver

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	agyprojection "github.com/madou1217/ai_home/internal/adapters/agy/projection"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// identityChangingAgyStrategy 模拟刷新换回另一个邮箱（id_token 变化）。
type identityChangingAgyStrategy struct {
	now  time.Time
	next *agy.OAuthAuth
}

func (*identityChangingAgyStrategy) ProviderID() string { return "agy" }

func (strategy *identityChangingAgyStrategy) ExpiresAt(accountapp.Credential) (time.Time, bool) {
	return strategy.now.Add(-time.Minute), true
}

func (strategy *identityChangingAgyStrategy) Refresh(
	_ context.Context,
	_ accountapp.Credential,
	refreshedAt time.Time,
) (accountapp.Credential, error) {
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         strategy.next.Email(),
		AccessToken:   strategy.next.AccessToken(),
		RefreshToken:  strategy.next.RefreshToken(),
		ExpiresAtMS:   refreshedAt.Add(time.Hour).UnixMilli(),
		RefreshedAtMS: refreshedAt.UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		return nil, err
	}
	return auth, nil
}

// TestAgyReKeyEndToEnd 走真实 sqlite 存储 + 真实 resolver + 真实投影物化：
// 刷新返回新身份后，账号、凭据、模型、额度、默认账号、路由索引和运行投影
// 必须整体迁到新 AccountRef，旧引用不能留下任何行。
func TestAgyReKeyEndToEnd(t *testing.T) {
	ctx := context.Background()
	aiHomeDir := t.TempDir()
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	before, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "before@example.test",
		AccessToken:   "old-access",
		RefreshToken:  "old-refresh",
		ExpiresAtMS:   now.Add(time.Hour).UnixMilli(),
		RefreshedAtMS: now.Add(-time.Hour).UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth(before) error = %v", err)
	}
	oldRef, err := accountcore.DeriveAccountRef(before)
	if err != nil {
		t.Fatalf("DeriveAccountRef(before) error = %v", err)
	}
	after, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "after@example.test",
		AccessToken:   "new-access",
		RefreshToken:  "new-refresh",
		ExpiresAtMS:   now.Add(2 * time.Hour).UnixMilli(),
		RefreshedAtMS: now.UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth(after) error = %v", err)
	}
	newRef, err := accountcore.DeriveAccountRef(after)
	if err != nil || newRef == oldRef {
		t.Fatalf("DeriveAccountRef(after) = %s, %v", newRef, err)
	}

	createdAt := now.Add(-24 * time.Hour)
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref: oldRef, ProviderID: "agy", CLIAccountID: 7, Enabled: true,
		CreatedAt: createdAt, UpdatedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	registration, err := accountapp.NewRegistration(account, before, createdAt)
	if err != nil {
		t.Fatalf("NewRegistration() error = %v", err)
	}
	if err := store.Register(ctx, registration); err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	if _, err := store.ReplaceDiscoveredModels(
		ctx,
		oldRef,
		[]runtimecore.ModelID{"gemini-3-pro"},
		createdAt,
	); err != nil {
		t.Fatalf("ReplaceDiscoveredModels() error = %v", err)
	}
	if err := store.RecordModelProbe(ctx, accountapp.ModelProbeRecord{
		AccountRef:  oldRef,
		AttemptedAt: createdAt,
		Succeeded:   true,
		Source:      "remote",
		ModelCount:  1,
		UpdatedAt:   createdAt,
	}); err != nil {
		t.Fatalf("RecordModelProbe() error = %v", err)
	}
	providerDefault, err := accountcore.NewProviderDefault("agy", oldRef, createdAt)
	if err != nil {
		t.Fatalf("NewProviderDefault() error = %v", err)
	}
	if _, err := store.SetProviderDefault(ctx, providerDefault); err != nil {
		t.Fatalf("SetProviderDefault() error = %v", err)
	}
	usageSnapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: oldRef,
		ProviderID: "agy",
		Source:     "test",
		PlanType:   "test",
		CapturedAt: createdAt,
		Entries: []usagecore.EntryInput{{
			Bucket:               "gemini-3-pro",
			Kind:                 usagecore.KindWindow,
			Scope:                usagecore.ScopeModelFamily,
			ScopeKey:             "gemini-3-pro",
			HasRemaining:         true,
			RemainingBasisPoints: 5_000,
			WindowSeconds:        3_600,
			ResetAt:              createdAt.Add(time.Hour),
			Availability:         usagecore.AvailabilityAvailable,
		}},
	})
	if err != nil {
		t.Fatalf("NewSnapshot() error = %v", err)
	}
	if err := store.ReplaceUsageSnapshot(ctx, usageSnapshot); err != nil {
		t.Fatalf("ReplaceUsageSnapshot() error = %v", err)
	}

	// 账号级出口绑定按旧引用命名，re-key 后必须搬到新引用。
	appStatePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	egressValue := `{"mode":"proxy","proxyUrl":"socks5://127.0.0.1:1080","updatedAt":1}`
	if err := appstate.WriteKV(
		ctx,
		appStatePath,
		"account:egress:"+oldRef.String(),
		egressValue,
		1,
	); err != nil {
		t.Fatalf("seed egress binding error = %v", err)
	}

	// 旧引用的运行投影：目录里只有旧 token，re-key 后必须整体改名并写入新 token。
	oldRuntimeDir := filepath.Join(aiHomeDir, "run", "auth-projections", "agy", oldRef.String())
	if err := os.MkdirAll(filepath.Join(oldRuntimeDir, ".gemini"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(oldRuntimeDir, ".gemini", "oauth_creds.json"),
		[]byte(`{"access_token":"old-access","refresh_token":"old-refresh","scope":"cloud-platform"}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	resolver, err := accountcredentials.NewResolver(accountcredentials.Dependencies{
		Store:       store,
		Strategies:  []accountcredentials.RefreshStrategy{&identityChangingAgyStrategy{now: now, next: after}},
		Clock:       func() time.Time { return now },
		OwnsRefresh: func(ref accountcore.AccountRef) bool { return ref == oldRef },
		ReKeyStore:  store,
		OnAccountReKeyed: func(previous, current accountcore.AccountRef, providerID string) {
			if providerID != "agy" {
				t.Errorf("providerID = %q, want agy", providerID)
			}
			if err := renameAuthProjectionDir(aiHomeDir, providerID, previous, current); err != nil {
				t.Errorf("renameAuthProjectionDir() error = %v", err)
			}
			if err := moveAccountEgressBinding(aiHomeDir, previous, current); err != nil {
				t.Errorf("moveAccountEgressBinding() error = %v", err)
			}
		},
		OnCredentialRefreshed: func(ref accountcore.AccountRef, credential accountapp.Credential) {
			auth, ok := credential.(*agy.OAuthAuth)
			if !ok {
				t.Errorf("credential type = %T", credential)
				return
			}
			if err := agyprojection.Write(aiHomeDir, ref.String(), auth); err != nil {
				t.Errorf("agyprojection.Write() error = %v", err)
			}
		},
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	result, err := resolver.Resolve(ctx, oldRef)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if result.Binding().AccountRef() != newRef {
		t.Fatalf("resolved ref = %s, want %s", result.Binding().AccountRef(), newRef)
	}

	if _, err := store.GetByRef(ctx, oldRef); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("GetByRef(old) error = %v, want not found", err)
	}
	migrated, err := store.GetByRef(ctx, newRef)
	if err != nil {
		t.Fatalf("GetByRef(new) error = %v", err)
	}
	if migrated.CLIAccountID() != 7 || !migrated.Enabled() ||
		!migrated.CreatedAt().Equal(createdAt) {
		t.Fatalf("migrated account = %#v", migrated)
	}
	credential, err := store.GetCredential(ctx, newRef)
	if err != nil {
		t.Fatalf("GetCredential(new) error = %v", err)
	}
	if auth, ok := credential.(*agy.OAuthAuth); !ok || auth.Email() != "after@example.test" {
		t.Fatalf("credential = %#v, want after@example.test", credential)
	}
	models, err := store.ListAccountModels(ctx, newRef)
	if err != nil || len(models) != 1 {
		t.Fatalf("ListAccountModels(new) = %d, %v", len(models), err)
	}
	currentDefault, err := store.GetProviderDefault(ctx, "agy")
	if err != nil {
		t.Fatalf("GetProviderDefault() error = %v", err)
	}
	if currentDefault.AccountRef() != newRef {
		t.Fatalf("default ref = %s, want %s", currentDefault.AccountRef(), newRef)
	}
	candidates, err := store.LoadRoutingCandidates(ctx, "agy", "gemini-3-pro")
	if err != nil {
		t.Fatalf("LoadRoutingCandidates() error = %v", err)
	}
	if _, found := candidates.FindByRef(newRef); !found {
		t.Fatal("new ref missing from routing candidates")
	}
	if _, found := candidates.FindByRef(oldRef); found {
		t.Fatal("old ref still routable")
	}

	// 投影：旧目录搬走，新目录里是新 token，且保留了 scope。
	if _, err := os.Stat(oldRuntimeDir); !os.IsNotExist(err) {
		t.Fatalf("old projection dir still exists: %v", err)
	}
	newRuntimeDir := filepath.Join(aiHomeDir, "run", "auth-projections", "agy", newRef.String())
	raw, err := os.ReadFile(filepath.Join(newRuntimeDir, ".gemini", "oauth_creds.json"))
	if err != nil {
		t.Fatalf("read new oauth_creds.json error = %v", err)
	}
	var creds map[string]any
	if err := json.Unmarshal(raw, &creds); err != nil {
		t.Fatalf("decode oauth_creds.json error = %v", err)
	}
	if creds["access_token"] != "new-access" {
		t.Fatalf("projection access_token = %v, want new-access", creds["access_token"])
	}
	if creds["scope"] != "cloud-platform" {
		t.Fatalf("projection scope = %v, want preserved", creds["scope"])
	}
	if _, err := os.Stat(filepath.Join(newRuntimeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token")); err != nil {
		t.Fatalf("antigravity projection missing: %v", err)
	}

	movedEgress, found, err := appstate.ReadKV(
		ctx,
		appStatePath,
		"account:egress:"+newRef.String(),
	)
	if err != nil || !found || movedEgress != egressValue {
		t.Fatalf("moved egress = %q, found=%v, err=%v", movedEgress, found, err)
	}
	if _, found, _ := appstate.ReadKV(
		ctx,
		appStatePath,
		"account:egress:"+oldRef.String(),
	); found {
		t.Fatal("old egress binding must be removed")
	}
}
