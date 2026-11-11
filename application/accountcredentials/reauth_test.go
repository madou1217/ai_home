package accountcredentials

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// failingRefreshStrategy 模拟「刷新必然失败」的 Provider，并给出可控过期时间。
type failingRefreshStrategy struct {
	now       time.Time
	expiresAt time.Time
	err       error
}

func (*failingRefreshStrategy) ProviderID() string { return "test" }

func (strategy *failingRefreshStrategy) ExpiresAt(accountapp.Credential) (time.Time, bool) {
	return strategy.expiresAt, true
}

func (strategy *failingRefreshStrategy) Refresh(
	context.Context,
	accountapp.Credential,
	time.Time,
) (accountapp.Credential, error) {
	return nil, strategy.err
}

func newFailingResolver(t *testing.T, now time.Time, expiresAt time.Time, failure error) (*Resolver, accountcore.AccountRef) {
	t.Helper()
	credential := delegationCredential{
		providerID: "test",
		seed:       "seed-1",
		access:     "expired",
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	snapshot, err := accountapp.NewCredentialSnapshot(
		accountRef,
		credential.providerID,
		credential,
		now.Add(-time.Hour),
	)
	if err != nil {
		t.Fatalf("NewCredentialSnapshot() error = %v", err)
	}
	resolver, err := NewResolver(Dependencies{
		Store:      &delegationStore{snapshot: snapshot},
		Strategies: []RefreshStrategy{&failingRefreshStrategy{now: now, expiresAt: expiresAt, err: failure}},
		Clock:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	return resolver, accountRef
}

// 过期凭据 + 刷新失败：必须把 reauth 结论交给调用方，不能拿死 token 去打上游。
func TestExpiredCredentialSurfacesRefreshFailure(t *testing.T) {
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	resolver, accountRef := newFailingResolver(
		t,
		now,
		now.Add(-time.Minute),
		ErrReauthenticationRequired,
	)
	if _, err := resolver.Resolve(context.Background(), accountRef); !errors.Is(
		err,
		ErrReauthenticationRequired,
	) {
		t.Fatalf("Resolve() error = %v, want reauthentication required", err)
	}
}

// 预刷新窗口内（还没过期）刷新失败仍可使用当前 token，保持原有行为。
func TestUnexpiredCredentialKeepsCurrentTokenAfterRefreshFailure(t *testing.T) {
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	resolver, accountRef := newFailingResolver(
		t,
		now,
		now.Add(time.Minute),
		ErrReauthenticationRequired,
	)
	result, err := resolver.Resolve(context.Background(), accountRef)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if result.Credential() == nil {
		t.Fatal("Resolve() returned nil credential")
	}
}

// 失效 grant 的长抑制期内，过期凭据仍要回报 reauth，而不是静默 401。
func TestSuppressedReauthenticationStillSurfacesForExpiredCredential(t *testing.T) {
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	resolver, accountRef := newFailingResolver(
		t,
		now,
		now.Add(-time.Minute),
		ErrReauthenticationRequired,
	)
	for attempt := 0; attempt < 2; attempt++ {
		if _, err := resolver.Resolve(context.Background(), accountRef); !errors.Is(
			err,
			ErrReauthenticationRequired,
		) {
			t.Fatalf("attempt %d: Resolve() error = %v, want reauthentication required", attempt, err)
		}
	}
}
