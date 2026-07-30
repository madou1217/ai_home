package claudeoauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/testsupport/accountmodels"
)

// TestCredentialResolverRefreshesClaudeThroughSQLiteIntegration 验证 Claude 刷新落盘闭环。
func TestCredentialResolverRefreshesClaudeThroughSQLiteIntegration(
	t *testing.T,
) {
	t.Parallel()

	var tokenCalls atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, _ *http.Request) {
			tokenCalls.Add(1)
			writeJSON(t, response, map[string]any{
				"access_token":  "sk-ant-oat01-integration-refreshed",
				"refresh_token": "sk-ant-ort01-integration-rotated",
				"expires_in":    3600,
				"scope":         "user:profile user:inference",
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
	initial := claudeRefreshCredential(t)
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
	provider := newTestProvider(
		t,
		tokenServer.URL,
		"https://example.invalid/profile",
	)
	resolver, err := accountcredentials.NewResolver(
		accountcredentials.Dependencies{
			Store:      store,
			Strategies: []accountcredentials.RefreshStrategy{provider},
			Clock:      testClock,
		},
	)
	if err != nil {
		t.Fatalf("accountcredentials.NewResolver() error = %v", err)
	}

	result, err := resolver.Resolve(ctx, account.Ref())
	if err != nil {
		t.Fatalf("Resolver.Resolve() error = %v", err)
	}
	if !result.Refreshed() || tokenCalls.Load() != 1 {
		t.Fatalf(
			"Resolver result refreshed=%t tokenCalls=%d",
			result.Refreshed(),
			tokenCalls.Load(),
		)
	}
	persisted, err := store.GetCredentialSnapshot(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetCredentialSnapshot() error = %v", err)
	}
	auth, valid := persisted.Credential().(*claude.OAuthAuth)
	if !valid ||
		auth.AccessToken() != "sk-ant-oat01-integration-refreshed" ||
		auth.RefreshToken() != "sk-ant-ort01-integration-rotated" ||
		auth.ExpiresAtMS() != persisted.UpdatedAt().Add(time.Hour).UnixMilli() ||
		auth.AccountUUID() != initial.AccountUUID() {
		t.Fatalf("persisted Claude credential = %T %#v", auth, persisted)
	}
	t.Logf(
		"provider=claude refresh_http_calls=%d account_ref_unchanged=true refresh_token_rotated=true expires_at_ms=%d",
		tokenCalls.Load(),
		auth.ExpiresAtMS(),
	)
}
