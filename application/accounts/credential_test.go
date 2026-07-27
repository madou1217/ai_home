package accounts_test

import (
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

func TestRegistrationBindsAccountAndCredentialIdentity(t *testing.T) {
	t.Parallel()

	const apiKey = "sk-test-registration-secret"
	auth, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: apiKey})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(7)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	createdAt := time.Date(2026, time.July, 27, 1, 2, 3, 456_789_123, time.FixedZone("CST", 8*60*60))
	account, err := accountcore.NewAccount(testCatalog(t), accountcore.NewAccountInput{
		Identity:     auth,
		CLIAccountID: cliAccountID,
		CreatedAt:    createdAt,
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}

	registration, err := accountapp.NewRegistration(account, auth, createdAt)
	if err != nil {
		t.Fatalf("NewRegistration() error = %v", err)
	}
	if registration.Account() != account || registration.Credential() != auth {
		t.Fatal("Registration 没有保存原始领域值")
	}
	expectedTime := time.Date(2026, time.July, 26, 17, 2, 3, 456_000_000, time.UTC)
	if !registration.CredentialUpdatedAt().Equal(expectedTime) {
		t.Fatalf("CredentialUpdatedAt() = %s, want %s", registration.CredentialUpdatedAt(), expectedTime)
	}
}

func TestRegistrationRejectsMismatchedCredential(t *testing.T) {
	t.Parallel()

	firstAuth, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "sk-test-first-secret"})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth(first) error = %v", err)
	}
	secondAuth, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "sk-test-second-secret"})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth(second) error = %v", err)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	createdAt := time.Date(2026, time.July, 27, 0, 0, 0, 0, time.UTC)
	account, err := accountcore.NewAccount(testCatalog(t), accountcore.NewAccountInput{
		Identity:     firstAuth,
		CLIAccountID: cliAccountID,
		CreatedAt:    createdAt,
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}

	for _, credential := range []accountapp.Credential{nil, secondAuth} {
		_, registrationErr := accountapp.NewRegistration(account, credential, createdAt)
		if !errors.Is(registrationErr, accountapp.ErrInvalidRegistration) {
			t.Fatalf("NewRegistration() error = %v, want ErrInvalidRegistration", registrationErr)
		}
	}
	_, err = accountapp.NewRegistration(account, firstAuth, time.Time{})
	if !errors.Is(err, accountapp.ErrInvalidRegistration) {
		t.Fatalf("zero time error = %v, want ErrInvalidRegistration", err)
	}
}
