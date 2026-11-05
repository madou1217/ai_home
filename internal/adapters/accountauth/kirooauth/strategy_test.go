package kirooauth

import (
	"context"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

type fakeRefresher struct {
	calls int
}

func (fake *fakeRefresher) Refresh(context.Context, accountapp.Credential) (accountapp.Credential, error) {
	fake.calls++
	return nil, nil
}

func TestStrategyProviderAndDelegation(t *testing.T) {
	fake := &fakeRefresher{}
	strategy, err := New(fake)
	if err != nil {
		t.Fatal(err)
	}
	if strategy.ProviderID() != ProviderID {
		t.Fatalf("provider = %q", strategy.ProviderID())
	}
	if _, err := strategy.Refresh(context.Background(), nil, time.Now()); err != nil && fake.calls != 1 {
		t.Fatalf("Refresh 必须委托给 refresher: calls=%d", fake.calls)
	}
	if fake.calls != 1 {
		t.Fatalf("calls = %d", fake.calls)
	}
}

func TestStrategyExpiresAtRejectsForeignCredential(t *testing.T) {
	strategy, err := New(&fakeRefresher{})
	if err != nil {
		t.Fatal(err)
	}
	identity, err := accountcore.NewNativeSubjectIdentity("kimi", "user_01ABC")
	if err != nil {
		t.Fatal(err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(`{"access_token":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := strategy.ExpiresAt(credential); ok {
		t.Fatal("非 kiro 凭据不应给出过期时间")
	}
}

func TestNewRejectsNilRefresher(t *testing.T) {
	if _, err := New(nil); err == nil {
		t.Fatal("缺少 refresher 必须报错")
	}
}
