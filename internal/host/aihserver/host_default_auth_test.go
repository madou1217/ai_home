package aihserver

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
)

type stubDefaultStore struct {
	value accountcore.ProviderDefault
	err   error
}

func (store stubDefaultStore) GetProviderDefault(
	context.Context,
	string,
) (accountcore.ProviderDefault, error) {
	return store.value, store.err
}

func hostSyncAuth(t *testing.T) *agy.OAuthAuth {
	t.Helper()
	refreshedAt := time.Date(2026, time.November, 12, 10, 0, 0, 0, time.UTC)
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "host-sync@example.test",
		AccessToken:   "host-access",
		RefreshToken:  "host-refresh",
		ExpiresAtMS:   refreshedAt.Add(time.Hour).UnixMilli(),
		RefreshedAtMS: refreshedAt.UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

func TestSyncDefaultAgyAuthWritesGlobalFilesForDefaultAccount(t *testing.T) {
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	definition, err := accountcore.NewProviderDefault("agy", ref, time.UnixMilli(1_800_000_000_000).UTC())
	if err != nil {
		t.Fatalf("NewProviderDefault() error = %v", err)
	}
	home := t.TempDir()
	if err := syncDefaultAgyAuthToHost(
		context.Background(),
		stubDefaultStore{value: definition},
		home,
		ref,
		hostSyncAuth(t),
	); err != nil {
		t.Fatalf("syncDefaultAgyAuthToHost() error = %v", err)
	}
	tokenPath := filepath.Join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")
	if _, err := os.Stat(tokenPath); err != nil {
		t.Fatalf("global token missing: %v", err)
	}
	email, err := os.ReadFile(filepath.Join(home, ".gemini", "antigravity-cli", "email.cache"))
	if err != nil || string(email) != "host-sync@example.test" {
		t.Fatalf("email.cache = %q, %v", string(email), err)
	}
}

func TestSyncDefaultAgyAuthSkipsNonDefaultAccount(t *testing.T) {
	defaultRef, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	otherRef, _ := accountcore.ParseAccountRef("acct_abcdef0123456789abcd")
	definition, err := accountcore.NewProviderDefault("agy", defaultRef, time.UnixMilli(1_800_000_000_000).UTC())
	if err != nil {
		t.Fatalf("NewProviderDefault() error = %v", err)
	}
	home := t.TempDir()
	if err := syncDefaultAgyAuthToHost(
		context.Background(),
		stubDefaultStore{value: definition},
		home,
		otherRef,
		hostSyncAuth(t),
	); err != nil {
		t.Fatalf("syncDefaultAgyAuthToHost() error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".gemini")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("non-default account must not write host files: %v", err)
	}
	if err := syncDefaultAgyAuthToHost(
		context.Background(),
		stubDefaultStore{err: errors.New("no default")},
		home,
		defaultRef,
		hostSyncAuth(t),
	); err != nil {
		t.Fatalf("missing default must be ignored: %v", err)
	}
}
