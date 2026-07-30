package codexoauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/testsupport/accountmodels"
)

// TestCredentialResolverRefreshesCodexThroughSQLiteIntegration 验证 100 并发的完整持久化链。
func TestCredentialResolverRefreshesCodexThroughSQLiteIntegration(
	t *testing.T,
) {
	t.Parallel()

	var tokenCalls atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, _ *http.Request) {
			tokenCalls.Add(1)
			writeJSON(t, response, map[string]any{
				"access_token": codexRefreshAccessToken(
					t,
					testClock().Add(time.Hour).Unix(),
				),
			})
		},
	))
	defer tokenServer.Close()

	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: t.TempDir(),
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	defer func() {
		_ = store.Close()
	}()
	initial := codexRefreshCredential(
		t,
		testClock().Add(-time.Minute).Unix(),
	)
	modelDiscovery, err := accountmodels.NewDiscovery(catalog)
	if err != nil {
		t.Fatalf("accountmodels.NewDiscovery() error = %v", err)
	}
	registrar, err := accountapp.NewRegistrar(
		catalog,
		store,
		modelDiscovery,
		testClock,
	)
	if err != nil {
		t.Fatalf("accounts.NewRegistrar() error = %v", err)
	}
	account, err := registrar.Register(ctx, initial, nil)
	if err != nil {
		t.Fatalf("Registrar.Register() error = %v", err)
	}
	resolver, err := accountcredentials.NewResolver(
		accountcredentials.Dependencies{
			Store: store,
			Strategies: []accountcredentials.RefreshStrategy{
				newTestProvider(t, tokenServer.URL),
			},
			Clock: testClock,
		},
	)
	if err != nil {
		t.Fatalf("accountcredentials.NewResolver() error = %v", err)
	}

	const callers = 100
	var waitGroup sync.WaitGroup
	errorsByCaller := make(chan error, callers)
	waitGroup.Add(callers)
	for range callers {
		go func() {
			defer waitGroup.Done()
			result, resolveErr := resolver.Resolve(ctx, account.Ref())
			if resolveErr == nil &&
				result.Credential().IdentitySeed() != initial.IdentitySeed() {
				resolveErr = accountcredentials.ErrInvalidRefreshResult
			}
			errorsByCaller <- resolveErr
		}()
	}
	waitGroup.Wait()
	close(errorsByCaller)
	for resolveErr := range errorsByCaller {
		if resolveErr != nil {
			t.Fatalf("Resolver.Resolve() error = %v", resolveErr)
		}
	}
	if tokenCalls.Load() != 1 {
		t.Fatalf("Codex refresh HTTP calls = %d, want 1", tokenCalls.Load())
	}
	persisted, err := store.GetCredentialSnapshot(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetCredentialSnapshot() error = %v", err)
	}
	auth, valid := persisted.Credential().(*codex.OAuthAuth)
	if !valid ||
		auth.AccessExpiresAtMS() != testClock().Add(time.Hour).UnixMilli() ||
		auth.RefreshToken() != initial.RefreshToken() ||
		!persisted.UpdatedAt().After(testClock()) {
		t.Fatalf("persisted Codex credential = %T %#v", auth, persisted)
	}
	t.Logf(
		"provider=codex callers=%d refresh_http_calls=%d account_ref_unchanged=true cas_version_ms=%d",
		callers,
		tokenCalls.Load(),
		persisted.UpdatedAt().UnixMilli(),
	)
}
