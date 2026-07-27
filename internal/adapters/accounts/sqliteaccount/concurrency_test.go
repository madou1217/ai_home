package sqliteaccount

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func TestCredentialStoreRegistersIndependentAccountsConcurrently(t *testing.T) {
	t.Parallel()

	const accountCount = 32
	store := openTestStore(t)
	registrations := make([]accountapp.Registration, 0, accountCount)
	for index := 1; index <= accountCount; index++ {
		credential := mustCodexAPIKey(t, fmt.Sprintf("sk-test-concurrent-%d", index))
		account := newAccountForCredential(t, store, credential, int64(index))
		registration, err := accountapp.NewRegistration(account, credential, testAccountTime())
		if err != nil {
			t.Fatalf("NewRegistration(%d) error = %v", index, err)
		}
		registrations = append(registrations, registration)
	}

	errorsByRegistration := registerConcurrently(store, registrations)
	for index, err := range errorsByRegistration {
		if err != nil {
			t.Fatalf("Register(%d) error = %v", index, err)
		}
	}

	var accountRows, credentialRows int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM accounts").Scan(&accountRows); err != nil {
		t.Fatalf("count accounts error = %v", err)
	}
	if err := store.db.QueryRow("SELECT COUNT(*) FROM account_credentials").Scan(&credentialRows); err != nil {
		t.Fatalf("count credentials error = %v", err)
	}
	if accountRows != accountCount || credentialRows != accountCount {
		t.Fatalf(
			"concurrent row counts = (%d, %d), want (%d, %d)",
			accountRows,
			credentialRows,
			accountCount,
			accountCount,
		)
	}
}

func TestCredentialStoreAllowsOnlyOneConcurrentRegistrationForSameIdentity(t *testing.T) {
	t.Parallel()

	const attemptCount = 16
	store := openTestStore(t)
	credential := mustCodexAPIKey(t, "sk-test-concurrent-same-identity")
	account := newAccountForCredential(t, store, credential, 1)
	registration, err := accountapp.NewRegistration(account, credential, testAccountTime())
	if err != nil {
		t.Fatalf("NewRegistration() error = %v", err)
	}
	registrations := make([]accountapp.Registration, attemptCount)
	for index := range registrations {
		registrations[index] = registration
	}

	errorsByRegistration := registerConcurrently(store, registrations)
	successCount := 0
	conflictCount := 0
	for _, registerErr := range errorsByRegistration {
		switch {
		case registerErr == nil:
			successCount++
		case errors.Is(registerErr, accountapp.ErrAccountConflict):
			conflictCount++
		default:
			t.Fatalf("Register() unexpected error = %v", registerErr)
		}
	}
	if successCount != 1 || conflictCount != attemptCount-1 {
		t.Fatalf(
			"concurrent outcomes = success:%d conflict:%d, want 1/%d",
			successCount,
			conflictCount,
			attemptCount-1,
		)
	}
}

func TestCredentialStoreScopesCLIAccountIDByProvider(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	codexCredential := mustCodexAPIKey(t, "sk-test-shared-alias-codex")
	claudeCredential := mustClaudeAPIKey(t, "sk-ant-api-test-shared-alias")
	credentials := []accountapp.Credential{codexCredential, claudeCredential}

	for _, credential := range credentials {
		account := newAccountForCredential(t, store, credential, 7)
		registration, err := accountapp.NewRegistration(account, credential, testAccountTime())
		if err != nil {
			t.Fatalf("NewRegistration(%s) error = %v", credential.ProviderID(), err)
		}
		if err := store.Register(context.Background(), registration); err != nil {
			t.Fatalf("Register(%s) error = %v", credential.ProviderID(), err)
		}
	}

	alias, err := accountcore.NewCLIAccountID(7)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	for _, providerID := range []string{"codex", "claude"} {
		account, err := store.GetByCLIAccountID(context.Background(), providerID, alias)
		if err != nil {
			t.Fatalf("GetByCLIAccountID(%s) error = %v", providerID, err)
		}
		if account.ProviderID() != providerID {
			t.Fatalf("GetByCLIAccountID(%s) provider = %s", providerID, account.ProviderID())
		}
	}
}

func TestCredentialStoreRecoversAccountAndCredentialAfterRestart(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	aiHomeDir := t.TempDir()
	catalog := newTestCatalog(t)
	first, err := Open(ctx, OpenOptions{AIHomeDir: aiHomeDir, Catalog: catalog})
	if err != nil {
		t.Fatalf("first Open() error = %v", err)
	}
	credential := mustClaudeAPIKey(t, "sk-ant-api-test-restart")
	account := newAccountForCredential(t, first, credential, 11)
	registration, err := accountapp.NewRegistration(account, credential, testAccountTime())
	if err != nil {
		t.Fatalf("NewRegistration() error = %v", err)
	}
	if err := first.Register(ctx, registration); err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("first Close() error = %v", err)
	}

	second, err := Open(ctx, OpenOptions{AIHomeDir: aiHomeDir, Catalog: catalog})
	if err != nil {
		t.Fatalf("second Open() error = %v", err)
	}
	t.Cleanup(func() {
		_ = second.Close()
	})
	restoredAccount, err := second.GetByRef(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetByRef() error = %v", err)
	}
	restoredCredential, err := second.GetCredential(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetCredential() error = %v", err)
	}
	if restoredAccount != account ||
		restoredCredential.IdentitySeed() != credential.IdentitySeed() {
		t.Fatalf(
			"restart restore mismatch: account=%#v credential=%T",
			restoredAccount,
			restoredCredential,
		)
	}
}

// registerConcurrently 让所有注册在同一时刻竞争 SQLite 写事务。
func registerConcurrently(
	store *Store,
	registrations []accountapp.Registration,
) []error {
	start := make(chan struct{})
	results := make([]error, len(registrations))
	var waitGroup sync.WaitGroup
	waitGroup.Add(len(registrations))
	for index, registration := range registrations {
		go func() {
			defer waitGroup.Done()
			<-start
			results[index] = store.Register(context.Background(), registration)
		}()
	}
	close(start)
	waitGroup.Wait()
	return results
}
