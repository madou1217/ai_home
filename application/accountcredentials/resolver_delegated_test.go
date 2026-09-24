package accountcredentials_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
)

// TestDelegatedResolverNeverRefreshesDueCredential 验证宿主独占刷新时，
// 即将过期的 OAuth 也只返回宿主同步进来的当前凭据，不调用官方刷新协议。
func TestDelegatedResolverNeverRefreshesDueCredential(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	store := newResolverTestStore(t, resolverTestCredential{
		providerID:   "codex",
		identitySeed: "oauth:codex:delegated-due",
		expiresAt:    now.Add(time.Minute),
	}, now.Add(-time.Hour))
	strategy := &resolverTestStrategy{providerID: "codex", nextExpiry: now.Add(time.Hour)}
	resolver := newDelegatedResolver(t, store, strategy, now)

	result, err := resolver.Resolve(context.Background(), store.accountRef)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if result.Refreshed() || strategy.refreshCalls.Load() != 0 {
		t.Fatalf("delegated Resolve() refreshed=%v refreshCalls=%d", result.Refreshed(), strategy.refreshCalls.Load())
	}
}

// TestDelegatedResolverReportsForcedRefreshUnavailable 验证 401 恢复路径在委托模式下
// 报告暂不可用（等待宿主同步），而不是自行轮换 Refresh Token。
func TestDelegatedResolverReportsForcedRefreshUnavailable(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	store := newResolverTestStore(t, resolverTestCredential{
		providerID:   "codex",
		identitySeed: "oauth:codex:delegated-force",
		expiresAt:    now.Add(time.Hour),
	}, now.Add(-time.Hour))
	strategy := &resolverTestStrategy{providerID: "codex", nextExpiry: now.Add(2 * time.Hour)}
	resolver := newDelegatedResolver(t, store, strategy, now)

	_, err := resolver.ForceRefreshCredentialBinding(context.Background(), store.accountRef)
	if !errors.Is(err, accountcredentials.ErrRefreshUnavailable) || strategy.refreshCalls.Load() != 0 {
		t.Fatalf("delegated ForceRefresh err=%v refreshCalls=%d", err, strategy.refreshCalls.Load())
	}
}

func newDelegatedResolver(
	t *testing.T,
	store *resolverTestStore,
	strategy accountcredentials.RefreshStrategy,
	now time.Time,
) *accountcredentials.Resolver {
	t.Helper()
	resolver, err := accountcredentials.NewResolver(accountcredentials.Dependencies{
		Store:            store,
		Strategies:       []accountcredentials.RefreshStrategy{strategy},
		Clock:            func() time.Time { return now },
		RefreshDelegated: true,
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	return resolver
}
