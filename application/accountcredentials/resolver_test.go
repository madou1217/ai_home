package accountcredentials_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestResolverReturnsStaticCredentialWithoutRefresh 验证静态凭据不会触发 OAuth。
func TestResolverReturnsStaticCredentialWithoutRefresh(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "codex",
		identitySeed: "api_key:codex:static",
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	strategy := &resolverTestStrategy{providerID: "codex"}
	resolver := newResolverTestResolver(t, store, strategy, now)

	result, err := resolver.Resolve(context.Background(), store.accountRef)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if result.Refreshed() ||
		result.Credential().IdentitySeed() != credential.IdentitySeed() ||
		strategy.refreshCalls.Load() != 0 {
		t.Fatalf(
			"Resolve() result=%#v refreshCalls=%d",
			result,
			strategy.refreshCalls.Load(),
		)
	}
}

// TestResolverReturnsFreshOAuthCredentialWithoutRefresh 验证未进入刷新窗口的 OAuth 直接返回。
func TestResolverReturnsFreshOAuthCredentialWithoutRefresh(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "claude",
		identitySeed: "oauth:claude:fresh",
		expiresAt:    now.Add(10 * time.Minute),
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	strategy := &resolverTestStrategy{providerID: "claude"}
	resolver := newResolverTestResolver(t, store, strategy, now)

	result, err := resolver.Resolve(context.Background(), store.accountRef)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if result.Refreshed() || strategy.refreshCalls.Load() != 0 {
		t.Fatalf(
			"Resolve() result=%#v refreshCalls=%d",
			result,
			strategy.refreshCalls.Load(),
		)
	}
}

// TestResolverRefreshesDueCredentialAndPersistsNewVersion 验证到期凭据刷新并推进版本。
func TestResolverRefreshesDueCredentialAndPersistsNewVersion(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "codex",
		identitySeed: "oauth:codex:due",
		expiresAt:    now.Add(time.Minute),
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	strategy := &resolverTestStrategy{
		providerID: "codex",
		nextExpiry: now.Add(time.Hour),
	}
	resolver := newResolverTestResolver(t, store, strategy, now)

	result, err := resolver.Resolve(context.Background(), store.accountRef)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if !result.Refreshed() || strategy.refreshCalls.Load() != 1 {
		t.Fatalf(
			"Resolve() result=%#v refreshCalls=%d",
			result,
			strategy.refreshCalls.Load(),
		)
	}
	persisted, err := store.GetCredentialSnapshot(
		context.Background(),
		store.accountRef,
	)
	if err != nil {
		t.Fatalf("GetCredentialSnapshot() error = %v", err)
	}
	persistedCredential := persisted.Credential().(resolverTestCredential)
	if !persistedCredential.expiresAt.Equal(strategy.nextExpiry) ||
		!persisted.UpdatedAt().After(now.Add(-time.Hour)) {
		t.Fatalf("persisted snapshot = %#v", persisted)
	}
}

// TestResolverCoalescesConcurrentRefreshByAccountRef 验证同账号并发只执行一次刷新。
func TestResolverCoalescesConcurrentRefreshByAccountRef(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "claude",
		identitySeed: "oauth:claude:singleflight",
		expiresAt:    now.Add(-time.Minute),
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	strategy := &resolverTestStrategy{
		providerID: "claude",
		nextExpiry: now.Add(time.Hour),
	}
	resolver := newResolverTestResolver(t, store, strategy, now)

	const callers = 100
	start := make(chan struct{})
	var waitGroup sync.WaitGroup
	errorsByCaller := make(chan error, callers)
	waitGroup.Add(callers)
	for range callers {
		go func() {
			defer waitGroup.Done()
			<-start
			result, err := resolver.Resolve(
				context.Background(),
				store.accountRef,
			)
			if err == nil && result.Credential() == nil {
				err = errors.New("Resolve() 返回空凭据")
			}
			errorsByCaller <- err
		}()
	}
	close(start)
	waitGroup.Wait()
	close(errorsByCaller)

	for err := range errorsByCaller {
		if err != nil {
			t.Fatalf("concurrent Resolve() error = %v", err)
		}
	}
	if strategy.refreshCalls.Load() != 1 {
		t.Fatalf(
			"Refresh() calls = %d, want 1",
			strategy.refreshCalls.Load(),
		)
	}
}

// TestResolverDoesNotPersistRejectedRefresh 验证失败结果不会进入凭据存储。
func TestResolverDoesNotPersistRejectedRefresh(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "codex",
		identitySeed: "oauth:codex:rejected",
		expiresAt:    now.Add(-time.Minute),
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	strategy := &resolverTestStrategy{
		providerID: "codex",
		refreshErr: accountcredentials.ErrReauthenticationRequired,
	}
	resolver := newResolverTestResolver(t, store, strategy, now)

	_, err := resolver.Resolve(context.Background(), store.accountRef)
	if !errors.Is(err, accountcredentials.ErrReauthenticationRequired) {
		t.Fatalf("Resolve() error = %v", err)
	}
	persisted, snapshotErr := store.GetCredentialSnapshot(
		context.Background(),
		store.accountRef,
	)
	if snapshotErr != nil {
		t.Fatalf("GetCredentialSnapshot() error = %v", snapshotErr)
	}
	if persisted.Credential().IdentitySeed() != credential.IdentitySeed() ||
		store.replaceCalls.Load() != 0 {
		t.Fatalf(
			"失败刷新修改了凭据: snapshot=%#v replaceCalls=%d",
			persisted,
			store.replaceCalls.Load(),
		)
	}
}

// TestResolverRejectsInvalidApplicationClock 验证无效业务时间失败关闭。
func TestResolverRejectsInvalidApplicationClock(t *testing.T) {
	t.Parallel()

	credential := resolverTestCredential{
		providerID:   "codex",
		identitySeed: "oauth:codex:invalid-clock",
		expiresAt:    resolverTestTime(),
	}
	store := newResolverTestStore(
		t,
		credential,
		resolverTestTime().Add(-time.Hour),
	)
	resolver, err := accountcredentials.NewResolver(
		accountcredentials.Dependencies{
			Store: store,
			Strategies: []accountcredentials.RefreshStrategy{
				&resolverTestStrategy{providerID: "codex"},
			},
			Clock: func() time.Time { return time.Time{} },
		},
	)
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}

	_, err = resolver.Resolve(context.Background(), store.accountRef)
	if !errors.Is(err, accountcredentials.ErrInvalidDependencies) {
		t.Fatalf("Resolve() error = %v", err)
	}
}

// newResolverTestResolver 创建使用内存端口和确定性时钟的 Resolver。
func newResolverTestResolver(
	t *testing.T,
	store accountapp.CredentialVersionStore,
	strategy accountcredentials.RefreshStrategy,
	now time.Time,
) *accountcredentials.Resolver {
	t.Helper()

	resolver, err := accountcredentials.NewResolver(
		accountcredentials.Dependencies{
			Store:      store,
			Strategies: []accountcredentials.RefreshStrategy{strategy},
			Clock:      func() time.Time { return now },
		},
	)
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	return resolver
}

// resolverTestTime 返回所有 Resolver 测试共享的确定性时间。
func resolverTestTime() time.Time {
	return time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)
}

// resolverTestCredential 是带可选过期时间的无敏感凭据。
type resolverTestCredential struct {
	providerID   string
	identitySeed string
	expiresAt    time.Time
}

// ProviderID 返回测试凭据所属 Provider。
func (credential resolverTestCredential) ProviderID() string {
	return credential.providerID
}

// IdentitySeed 返回测试凭据的稳定身份种子。
func (credential resolverTestCredential) IdentitySeed() string {
	return credential.identitySeed
}

// String 返回不含身份种子的安全摘要。
func (credential resolverTestCredential) String() string {
	return fmt.Sprintf(
		"resolverTestCredential{%s}",
		credential.providerID,
	)
}

// GoString 复用安全测试摘要。
func (credential resolverTestCredential) GoString() string {
	return credential.String()
}

// resolverTestStrategy 记录刷新次数并返回确定性新凭据。
type resolverTestStrategy struct {
	providerID   string
	nextExpiry   time.Time
	refreshErr   error
	refreshCalls atomic.Int64
}

// ProviderID 返回测试策略支持的 Provider。
func (strategy *resolverTestStrategy) ProviderID() string {
	return strategy.providerID
}

// ExpiresAt 返回测试凭据携带的可选过期时间。
func (strategy *resolverTestStrategy) ExpiresAt(
	credential accountapp.Credential,
) (time.Time, bool) {
	current, valid := credential.(resolverTestCredential)
	return current.expiresAt, valid && !current.expiresAt.IsZero()
}

// Refresh 记录调用并生成过期时间已经推进的新凭据。
func (strategy *resolverTestStrategy) Refresh(
	_ context.Context,
	credential accountapp.Credential,
	_ time.Time,
) (accountapp.Credential, error) {
	strategy.refreshCalls.Add(1)
	if strategy.refreshErr != nil {
		return nil, strategy.refreshErr
	}
	current := credential.(resolverTestCredential)
	current.expiresAt = strategy.nextExpiry
	return current, nil
}

// resolverTestStore 是线程安全的单账号版本存储测试替身。
type resolverTestStore struct {
	mu           sync.Mutex
	accountRef   accountcore.AccountRef
	snapshot     accountapp.CredentialSnapshot
	replaceCalls atomic.Int64
}

// newResolverTestStore 创建身份和版本均有效的内存快照。
func newResolverTestStore(
	t *testing.T,
	credential accountapp.Credential,
	updatedAt time.Time,
) *resolverTestStore {
	t.Helper()

	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	snapshot, err := accountapp.NewCredentialSnapshot(
		accountRef,
		credential.ProviderID(),
		credential,
		updatedAt,
	)
	if err != nil {
		t.Fatalf("NewCredentialSnapshot() error = %v", err)
	}
	return &resolverTestStore{
		accountRef: accountRef,
		snapshot:   snapshot,
	}
}

// GetCredentialSnapshot 返回当前线程安全快照。
func (store *resolverTestStore) GetCredentialSnapshot(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if accountRef != store.accountRef {
		return accountapp.CredentialSnapshot{}, accountapp.ErrCredentialNotFound
	}
	return store.snapshot, nil
}

// ReplaceCredential 模拟持久层 compare-and-swap。
func (store *resolverTestStore) ReplaceCredential(
	_ context.Context,
	replacement accountapp.CredentialReplacement,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if replacement.AccountRef() != store.accountRef ||
		!replacement.ExpectedUpdatedAt().Equal(store.snapshot.UpdatedAt()) {
		return accountapp.ErrCredentialConflict
	}
	next, err := accountapp.NewCredentialSnapshot(
		replacement.AccountRef(),
		replacement.Credential().ProviderID(),
		replacement.Credential(),
		replacement.UpdatedAt(),
	)
	if err != nil {
		return err
	}
	store.snapshot = next
	store.replaceCalls.Add(1)
	return nil
}
