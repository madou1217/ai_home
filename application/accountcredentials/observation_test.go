package accountcredentials_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestResolverCarriesCredentialObservationWithoutSecondRead 验证征召结果复用原凭据快照，
// 不为了生成请求级观察再读取一次存储。
func TestResolverCarriesCredentialObservationWithoutSecondRead(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "codex",
		identitySeed: "api_key:codex:observed",
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	resolver := newResolverTestResolver(
		t,
		store,
		&resolverTestStrategy{providerID: "codex"},
		now,
	)

	binding, observation, err := resolver.ResolveObservedCredentialBinding(
		context.Background(),
		store.accountRef,
	)
	if err != nil {
		t.Fatalf("ResolveObservedCredentialBinding() error = %v", err)
	}
	if !binding.IsValid() ||
		!observation.IsValid() ||
		observation.AccountRef() != store.accountRef ||
		store.readCalls.Load() != 1 {
		t.Fatalf(
			"binding=%#v observation=%#v reads=%d",
			binding,
			observation,
			store.readCalls.Load(),
		)
	}
}

// TestResolverVerifiesObservationAgainstCurrentCredentialSnapshot 验证失败冷路径会发现
// 重登、静态轮换或自动刷新已经推进了 credential.updated_at。
func TestResolverVerifiesObservationAgainstCurrentCredentialSnapshot(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "claude",
		identitySeed: "api_key:claude:observed",
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	resolver := newResolverTestResolver(
		t,
		store,
		&resolverTestStrategy{providerID: "claude"},
		now,
	)

	_, observation, err := resolver.ResolveObservedCredentialBinding(
		context.Background(),
		store.accountRef,
	)
	if err != nil {
		t.Fatalf("ResolveObservedCredentialBinding() error = %v", err)
	}
	current, err := resolver.IsCurrentCredentialObservation(
		context.Background(),
		observation,
	)
	if err != nil || !current {
		t.Fatalf("current=%t error=%v, want true", current, err)
	}

	store.replaceSnapshot(t, credential, now)
	current, err = resolver.IsCurrentCredentialObservation(
		context.Background(),
		observation,
	)
	if err != nil || current {
		t.Fatalf("current=%t error=%v, want false", current, err)
	}
	if store.readCalls.Load() != 3 {
		t.Fatalf("GetCredentialSnapshot() calls = %d, want 3", store.readCalls.Load())
	}
}

// TestResolverFailsClosedWhenObservationCannotBeVerified 验证存储错误不会把旧凭据
// 错认成当前代次。
func TestResolverFailsClosedWhenObservationCannotBeVerified(t *testing.T) {
	t.Parallel()

	wantErr := errors.New("synthetic observation read failure")
	resolver, err := accountcredentials.NewResolver(accountcredentials.Dependencies{
		Store: observationFailingStore{err: wantErr},
		Strategies: []accountcredentials.RefreshStrategy{
			&resolverTestStrategy{providerID: "codex"},
		},
		Clock: func() time.Time { return resolverTestTime() },
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	observation := newResolverTestObservation(t)

	current, verifyErr := resolver.IsCurrentCredentialObservation(
		context.Background(),
		observation,
	)
	if current || !errors.Is(verifyErr, wantErr) {
		t.Fatalf("current=%t error=%v", current, verifyErr)
	}
}

type observationFailingStore struct {
	err error
}

func (store observationFailingStore) GetCredentialSnapshot(
	context.Context,
	accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	return accountapp.CredentialSnapshot{}, store.err
}

func (observationFailingStore) ReplaceCredential(
	context.Context,
	accountapp.CredentialReplacement,
) error {
	return nil
}

func newResolverTestObservation(t *testing.T) accountcredentials.CredentialObservation {
	t.Helper()

	credential := resolverTestCredential{
		providerID:   "codex",
		identitySeed: "api_key:codex:observation-error",
	}
	store := newResolverTestStore(t, credential, resolverTestTime().Add(-time.Hour))
	observation, err := accountcredentials.NewCredentialObservation(store.snapshot)
	if err != nil {
		t.Fatalf("NewCredentialObservation() error = %v", err)
	}
	return observation
}
