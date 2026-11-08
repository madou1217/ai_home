package tokenrefresh_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/tokenrefresh"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// fakeRefresher 只返回预先给定的凭据，用来单独验证适配层的身份守卫。
type fakeRefresher struct {
	providerID string
	next       accountapp.Credential
	err        error
}

func (refresher fakeRefresher) ProviderID() string { return refresher.providerID }

func (fakeRefresher) ExpiresAt(accountapp.Credential) (time.Time, bool) {
	return time.Time{}, false
}

func (refresher fakeRefresher) Refresh(
	context.Context,
	accountapp.Credential,
) (accountapp.Credential, error) {
	return refresher.next, refresher.err
}

func geminiCredential(t *testing.T, email string) *accountcore.NativeCredential {
	t.Helper()
	payload := []byte(
		`{"googleAccounts":{"active":"` + email + `"},"oauthCreds":{"access_token":"a","refresh_token":"r"}}`,
	)
	credential, err := nativeaccount.NewDecoder().DecodeNativeAuth("gemini", payload)
	if err != nil {
		t.Fatalf("DecodeNativeAuth() error = %v", err)
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		t.Fatalf("credential type = %T", credential)
	}
	return native
}

func TestStrategyRejectsChangedIdentity(t *testing.T) {
	original := geminiCredential(t, "a@example.com")
	strategy, err := tokenrefresh.NewStrategy(fakeRefresher{
		providerID: "gemini",
		next:       geminiCredential(t, "b@example.com"),
	})
	if err != nil {
		t.Fatalf("NewStrategy() error = %v", err)
	}
	_, refreshErr := strategy.Refresh(context.Background(), original, time.Now())
	if !errors.Is(refreshErr, accountcredentials.ErrInvalidRefreshResult) {
		t.Fatalf("error = %v", refreshErr)
	}
}

func TestStrategyRejectsNilResult(t *testing.T) {
	strategy, err := tokenrefresh.NewStrategy(fakeRefresher{providerID: "gemini"})
	if err != nil {
		t.Fatalf("NewStrategy() error = %v", err)
	}
	_, refreshErr := strategy.Refresh(
		context.Background(),
		geminiCredential(t, "a@example.com"),
		time.Now(),
	)
	if !errors.Is(refreshErr, accountcredentials.ErrInvalidRefreshResult) {
		t.Fatalf("error = %v", refreshErr)
	}
}

func TestStrategyPassesThroughProtocolError(t *testing.T) {
	strategy, err := tokenrefresh.NewStrategy(fakeRefresher{
		providerID: "gemini",
		err:        accountcredentials.ErrReauthenticationRequired,
	})
	if err != nil {
		t.Fatalf("NewStrategy() error = %v", err)
	}
	_, refreshErr := strategy.Refresh(
		context.Background(),
		geminiCredential(t, "a@example.com"),
		time.Now(),
	)
	if !errors.Is(refreshErr, accountcredentials.ErrReauthenticationRequired) {
		t.Fatalf("error = %v", refreshErr)
	}
}
