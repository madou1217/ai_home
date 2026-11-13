package sqliteaccount

import (
	"context"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

func TestStaticAPIKeyCredentialRoundTripAndTombstone(t *testing.T) {
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

	now := time.UnixMilli(1700000000000).UTC()
	registrar, err := accountapp.NewRegistrar(catalog, store, func() time.Time { return now })
	if err != nil {
		t.Fatalf("NewRegistrar() error = %v", err)
	}

	for _, testCase := range []struct {
		provider string
		apiKey   string
		baseURL  string
	}{
		{provider: "gemini", apiKey: "gem-key-123"},
		{provider: "kimi", apiKey: "kimi-key-456", baseURL: "https://api.moonshot.cn/v1/"},
	} {
		cred, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
			ProviderID: testCase.provider,
			APIKey:     testCase.apiKey,
			BaseURL:    testCase.baseURL,
		})
		if err != nil {
			t.Fatalf("NewStaticAPIKeyAuth(%s) error = %v", testCase.provider, err)
		}
		account, err := registrar.Register(ctx, cred, nil)
		if err != nil {
			t.Fatalf("Register(%s) error = %v", testCase.provider, err)
		}
		snapshot, err := store.GetCredentialSnapshot(ctx, account.Ref())
		if err != nil {
			t.Fatalf("GetCredentialSnapshot(%s) error = %v", testCase.provider, err)
		}
		restored, ok := snapshot.Credential().(*accountcore.StaticAPIKeyAuth)
		if !ok || restored.APIKey() != testCase.apiKey {
			t.Fatalf("restored = %#v, want apiKey %q", snapshot.Credential(), testCase.apiKey)
		}
		if apiKeyFlag, err := store.IsAPIKeyAccount(ctx, account.Ref()); err != nil || !apiKeyFlag {
			t.Fatalf("IsAPIKeyAccount(%s) = (%v, %v), want true", testCase.provider, apiKeyFlag, err)
		}
		authKind, authMode, found, err := store.ReadCredentialMeta(ctx, account.Ref())
		if err != nil || !found || authKind != accountcore.StaticAPIKeyAuthKind || authMode != accountcore.StaticAPIKeyAuthMode {
			t.Fatalf("ReadCredentialMeta(%s) = (%q, %q, %v, %v)", testCase.provider, authKind, authMode, found, err)
		}
		if err := store.DeleteAccount(ctx, account.Ref()); err != nil {
			t.Fatalf("DeleteAccount(%s) error = %v", testCase.provider, err)
		}
		tombstoned, err := store.IsAPIKeyTombstoned(ctx, testCase.provider, testCase.apiKey)
		if err != nil || !tombstoned {
			t.Fatalf("IsAPIKeyTombstoned(%s) = (%v, %v), want true", testCase.provider, tombstoned, err)
		}
	}
}
