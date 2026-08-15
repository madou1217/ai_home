package accountcredentials_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// TestResolverUsesCurrentAccessTokenAfterPreemptiveInvalidGrant 验证刷新凭据被拒绝
// 只证明 refresh 路径失效；仍存在的当前 Access Token 必须交给真实上游判定。
func TestResolverUsesCurrentAccessTokenAfterPreemptiveInvalidGrant(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "claude",
		identitySeed: "oauth:claude:live-access-invalid-grant",
		expiresAt:    now.Add(-time.Minute),
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	strategy := &resolverTestStrategy{
		providerID: "claude",
		refreshErr: accountcredentials.ErrReauthenticationRequired,
	}
	resolver := newResolverTestResolver(t, store, strategy, now)

	result, err := resolver.Resolve(context.Background(), store.accountRef)

	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if result.Refreshed() ||
		result.Credential().IdentitySeed() != credential.IdentitySeed() ||
		strategy.refreshCalls.Load() != 1 ||
		store.replaceCalls.Load() != 0 {
		t.Fatalf(
			"Resolve() result=%#v refresh=%d replace=%d",
			result,
			strategy.refreshCalls.Load(),
			store.replaceCalls.Load(),
		)
	}
}

// TestResolverUsesCurrentAccessTokenAfterTransientRefreshFailure 验证预刷新网络失败
// 不会在真实上游尚未拒绝 Access Token 前制造假的 no_available_account。
func TestResolverUsesCurrentAccessTokenAfterTransientRefreshFailure(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "codex",
		identitySeed: "oauth:codex:live-access-refresh-unavailable",
		expiresAt:    now.Add(-time.Minute),
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	strategy := &resolverTestStrategy{
		providerID: "codex",
		refreshErr: accountcredentials.ErrRefreshUnavailable,
	}
	resolver := newResolverTestResolver(t, store, strategy, now)

	result, err := resolver.Resolve(context.Background(), store.accountRef)

	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if result.Credential().IdentitySeed() != credential.IdentitySeed() ||
		strategy.refreshCalls.Load() != 1 ||
		store.replaceCalls.Load() != 0 {
		t.Fatalf(
			"Resolve() result=%#v refresh=%d replace=%d",
			result,
			strategy.refreshCalls.Load(),
			store.replaceCalls.Load(),
		)
	}
}

// TestResolverSuppressesRepeatedInvalidGrantForSameCredential 验证同一持久凭据
// 在 24 小时内不会让每个推理请求重复撞击已经拒绝的 refresh grant。
func TestResolverSuppressesRepeatedInvalidGrantForSameCredential(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "codex",
		identitySeed: "oauth:codex:suppress-invalid-grant",
		expiresAt:    now.Add(-time.Minute),
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	strategy := &resolverTestStrategy{
		providerID: "codex",
		refreshErr: accountcredentials.ErrReauthenticationRequired,
	}
	resolver := newResolverTestResolver(t, store, strategy, now)

	for range 2 {
		if _, err := resolver.Resolve(context.Background(), store.accountRef); err != nil {
			t.Fatalf("Resolve() error = %v", err)
		}
	}
	if strategy.refreshCalls.Load() != 1 {
		t.Fatalf("Refresh() calls = %d, want 1", strategy.refreshCalls.Load())
	}
}

// TestResolverRetriesInvalidGrantAfterCredentialReplacement 验证重新登录写入新的
// credential.updated_at 后立即解除旧 grant 抑制，不等待 24 小时。
func TestResolverRetriesInvalidGrantAfterCredentialReplacement(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "claude",
		identitySeed: "oauth:claude:replacement-unlocks-refresh",
		expiresAt:    now.Add(-time.Minute),
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	strategy := &resolverTestStrategy{
		providerID: "claude",
		refreshErr: accountcredentials.ErrReauthenticationRequired,
	}
	resolver := newResolverTestResolver(t, store, strategy, now)

	if _, err := resolver.Resolve(context.Background(), store.accountRef); err != nil {
		t.Fatalf("first Resolve() error = %v", err)
	}
	store.replaceSnapshot(t, credential, now.Add(time.Millisecond))
	if _, err := resolver.Resolve(context.Background(), store.accountRef); err != nil {
		t.Fatalf("second Resolve() error = %v", err)
	}
	if strategy.refreshCalls.Load() != 2 {
		t.Fatalf("Refresh() calls = %d, want 2", strategy.refreshCalls.Load())
	}
}

// TestResolverForceRefreshStillReportsInvalidGrant 验证真实上游 401 触发的强制刷新
// 不受预刷新抑制影响，必须把明确的 reauth 需求返回给调用方。
func TestResolverForceRefreshStillReportsInvalidGrant(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "codex",
		identitySeed: "oauth:codex:force-after-invalid-grant",
		expiresAt:    now.Add(-time.Minute),
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	strategy := &resolverTestStrategy{
		providerID: "codex",
		refreshErr: accountcredentials.ErrReauthenticationRequired,
	}
	resolver := newResolverTestResolver(t, store, strategy, now)

	if _, err := resolver.Resolve(context.Background(), store.accountRef); err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	_, err := resolver.ForceRefreshCredentialBinding(context.Background(), store.accountRef)
	if !errors.Is(err, accountcredentials.ErrReauthenticationRequired) {
		t.Fatalf("ForceRefreshCredentialBinding() error = %v", err)
	}
	if strategy.refreshCalls.Load() != 2 {
		t.Fatalf("Refresh() calls = %d, want 2", strategy.refreshCalls.Load())
	}
}

// TestResolverForceRefreshDoesNotInheritPreemptiveFallback 验证普通预刷新和
// 真实上游 401 的强制刷新即使共享同一刷新飞行，也必须按调用方语义解释失败。
func TestResolverForceRefreshDoesNotInheritPreemptiveFallback(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "codex",
		identitySeed: "oauth:codex:concurrent-force-invalid-grant",
		expiresAt:    now.Add(-time.Minute),
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	strategy := &blockingRejectedRefreshStrategy{
		providerID: "codex",
		started:    make(chan struct{}),
		release:    make(chan struct{}),
	}
	resolver := newResolverTestResolver(t, store, strategy, now)

	resolveDone := make(chan error, 1)
	go func() {
		_, err := resolver.Resolve(context.Background(), store.accountRef)
		resolveDone <- err
	}()
	select {
	case <-strategy.started:
	case <-time.After(time.Second):
		t.Fatal("普通预刷新未启动")
	}

	forceDone := make(chan error, 1)
	go func() {
		_, err := resolver.ForceRefreshCredentialBinding(
			context.Background(),
			store.accountRef,
		)
		forceDone <- err
	}()
	// Force 在加入已有飞行前会读取一次当前快照；等待读取完成，避免只测到
	// 普通刷新完成以后才发起的串行情形。
	deadline := time.Now().Add(time.Second)
	for store.readCalls.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if store.readCalls.Load() < 3 {
		t.Fatal("强制刷新未进入当前凭据读取")
	}
	time.Sleep(10 * time.Millisecond)
	close(strategy.release)

	if err := <-resolveDone; err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if err := <-forceDone; !errors.Is(
		err,
		accountcredentials.ErrReauthenticationRequired,
	) {
		t.Fatalf("ForceRefreshCredentialBinding() error = %v", err)
	}
	if strategy.refreshCalls.Load() != 1 {
		t.Fatalf("Refresh() calls = %d, want 1", strategy.refreshCalls.Load())
	}
}

// TestResolverNormalFollowerKeepsFallbackBehindForceLeader 验证强制刷新作为
// leader 时，同一飞行中的普通预刷新仍按自己的语义使用当前 Access Token。
func TestResolverNormalFollowerKeepsFallbackBehindForceLeader(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "claude",
		identitySeed: "oauth:claude:force-leader-normal-follower",
		expiresAt:    now.Add(-time.Minute),
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	strategy := &blockingRejectedRefreshStrategy{
		providerID: "claude",
		started:    make(chan struct{}),
		release:    make(chan struct{}),
	}
	resolver := newResolverTestResolver(t, store, strategy, now)

	forceDone := make(chan error, 1)
	go func() {
		_, err := resolver.ForceRefreshCredentialBinding(
			context.Background(),
			store.accountRef,
		)
		forceDone <- err
	}()
	select {
	case <-strategy.started:
	case <-time.After(time.Second):
		t.Fatal("强制刷新未启动")
	}

	resolveDone := make(chan error, 1)
	go func() {
		_, err := resolver.Resolve(context.Background(), store.accountRef)
		resolveDone <- err
	}()
	waitForResolverReadCount(t, store, 3)
	close(strategy.release)

	if err := <-forceDone; !errors.Is(
		err,
		accountcredentials.ErrReauthenticationRequired,
	) {
		t.Fatalf("ForceRefreshCredentialBinding() error = %v", err)
	}
	if err := <-resolveDone; err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if strategy.refreshCalls.Load() != 1 {
		t.Fatalf("Refresh() calls = %d, want 1", strategy.refreshCalls.Load())
	}
}

// TestResolverDoesNotSwallowCanceledRefresh 验证请求取消不能伪装成旧凭据成功。
func TestResolverDoesNotSwallowCanceledRefresh(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "claude",
		identitySeed: "oauth:claude:canceled-preemptive-refresh",
		expiresAt:    now.Add(-time.Minute),
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	ctx, cancel := context.WithCancel(context.Background())
	strategy := cancelingRefreshStrategy{
		providerID: "claude",
		cancel:     cancel,
	}
	resolver := newResolverTestResolver(t, store, strategy, now)

	_, err := resolver.Resolve(ctx, store.accountRef)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Resolve() error = %v, want context.Canceled", err)
	}
}

// TestResolverRetriesForeignCancellationForForceFollower 验证普通请求作为飞行 leader
// 被取消时，仍存活的真实 401 强制刷新不会继承另一个调用方的取消状态。
func TestResolverRetriesForeignCancellationForForceFollower(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "codex",
		identitySeed: "oauth:codex:normal-cancel-force-live",
		expiresAt:    now.Add(-time.Minute),
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	strategy := &cancelFirstRefreshStrategy{
		providerID: "codex",
		started:    make(chan struct{}),
	}
	resolver := newResolverTestResolver(t, store, strategy, now)
	leaderContext, cancelLeader := context.WithCancel(context.Background())

	leaderDone := make(chan error, 1)
	go func() {
		_, err := resolver.Resolve(leaderContext, store.accountRef)
		leaderDone <- err
	}()
	select {
	case <-strategy.started:
	case <-time.After(time.Second):
		t.Fatal("普通刷新 leader 未启动")
	}

	followerDone := make(chan error, 1)
	go func() {
		_, err := resolver.ForceRefreshCredentialBinding(
			context.Background(),
			store.accountRef,
		)
		followerDone <- err
	}()
	waitForResolverReadCount(t, store, 3)
	cancelLeader()

	if err := <-leaderDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("Resolve() error = %v", err)
	}
	if err := <-followerDone; !errors.Is(
		err,
		accountcredentials.ErrReauthenticationRequired,
	) {
		t.Fatalf("ForceRefreshCredentialBinding() error = %v", err)
	}
	if strategy.refreshCalls.Load() != 2 {
		t.Fatalf("Refresh() calls = %d, want 2", strategy.refreshCalls.Load())
	}
}

// TestResolverRetriesForeignCancellationForNormalFollower 验证真实 401 请求作为
// 飞行 leader 被取消时，仍存活的普通预刷新会独立重试并保留旧 Token 回退语义。
func TestResolverRetriesForeignCancellationForNormalFollower(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "claude",
		identitySeed: "oauth:claude:force-cancel-normal-live",
		expiresAt:    now.Add(-time.Minute),
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	strategy := &cancelFirstRefreshStrategy{
		providerID: "claude",
		started:    make(chan struct{}),
	}
	resolver := newResolverTestResolver(t, store, strategy, now)
	leaderContext, cancelLeader := context.WithCancel(context.Background())

	leaderDone := make(chan error, 1)
	go func() {
		_, err := resolver.ForceRefreshCredentialBinding(
			leaderContext,
			store.accountRef,
		)
		leaderDone <- err
	}()
	select {
	case <-strategy.started:
	case <-time.After(time.Second):
		t.Fatal("强制刷新 leader 未启动")
	}

	followerDone := make(chan error, 1)
	go func() {
		_, err := resolver.Resolve(context.Background(), store.accountRef)
		followerDone <- err
	}()
	waitForResolverReadCount(t, store, 3)
	cancelLeader()

	if err := <-leaderDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("ForceRefreshCredentialBinding() error = %v", err)
	}
	if err := <-followerDone; err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if strategy.refreshCalls.Load() != 2 {
		t.Fatalf("Refresh() calls = %d, want 2", strategy.refreshCalls.Load())
	}
}

// TestResolverKeepsSuppressionUntilCredentialCommit 验证上游刷新成功但凭据 CAS
// 写入失败时，不会提前解除旧 grant 的抑制并立即重放可能已旋转的 Refresh Token。
func TestResolverKeepsSuppressionUntilCredentialCommit(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "codex",
		identitySeed: "oauth:codex:suppression-before-cas",
		expiresAt:    now.Add(-time.Minute),
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	strategy := &resolverTestStrategy{
		providerID: "codex",
		refreshErr: accountcredentials.ErrReauthenticationRequired,
	}
	resolver := newResolverTestResolver(t, store, strategy, now)

	if _, err := resolver.Resolve(context.Background(), store.accountRef); err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	persistErr := errors.New("synthetic credential persistence failure")
	store.setReplaceError(persistErr)
	strategy.refreshErr = nil
	strategy.nextExpiry = now.Add(time.Hour)
	_, err := resolver.ForceRefreshCredentialBinding(context.Background(), store.accountRef)
	if !errors.Is(err, persistErr) {
		t.Fatalf("ForceRefreshCredentialBinding() error = %v", err)
	}
	if _, err := resolver.Resolve(context.Background(), store.accountRef); err != nil {
		t.Fatalf("second Resolve() error = %v", err)
	}
	if strategy.refreshCalls.Load() != 2 {
		t.Fatalf("Refresh() calls = %d, want 2", strategy.refreshCalls.Load())
	}
}

// TestResolverForgetAccountReleasesRefreshSuppression 验证账号删除生命周期可以
// O(1) 释放不再会被访问的抑制条目。
func TestResolverForgetAccountReleasesRefreshSuppression(t *testing.T) {
	t.Parallel()

	now := resolverTestTime()
	credential := resolverTestCredential{
		providerID:   "claude",
		identitySeed: "oauth:claude:deleted-suppression",
		expiresAt:    now.Add(-time.Minute),
	}
	store := newResolverTestStore(t, credential, now.Add(-time.Hour))
	strategy := &resolverTestStrategy{
		providerID: "claude",
		refreshErr: accountcredentials.ErrReauthenticationRequired,
	}
	resolver := newResolverTestResolver(t, store, strategy, now)

	if _, err := resolver.Resolve(context.Background(), store.accountRef); err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	resolver.ForgetAccount(store.accountRef)
	if _, err := resolver.Resolve(context.Background(), store.accountRef); err != nil {
		t.Fatalf("second Resolve() error = %v", err)
	}
	if strategy.refreshCalls.Load() != 2 {
		t.Fatalf("Refresh() calls = %d, want 2", strategy.refreshCalls.Load())
	}
}

// TestResolverThrottlesSequentialRecoverableRefreshFailures 验证 singleflight 之外的
// 连续请求也不会对暂时失败或一般拒绝的 Token Endpoint 形成刷新风暴。
func TestResolverThrottlesSequentialRecoverableRefreshFailures(t *testing.T) {
	t.Parallel()

	for _, refreshErr := range []error{
		accountcredentials.ErrRefreshUnavailable,
		accountcredentials.ErrRefreshRejected,
	} {
		refreshErr := refreshErr
		t.Run(refreshErr.Error(), func(t *testing.T) {
			t.Parallel()

			now := resolverTestTime()
			credential := resolverTestCredential{
				providerID:   "codex",
				identitySeed: "oauth:codex:sequential-refresh-throttle:" + refreshErr.Error(),
				expiresAt:    now.Add(-time.Minute),
			}
			store := newResolverTestStore(t, credential, now.Add(-time.Hour))
			strategy := &resolverTestStrategy{
				providerID: "codex",
				refreshErr: refreshErr,
			}
			resolver := newResolverTestResolver(t, store, strategy, now)

			for range 2 {
				if _, err := resolver.Resolve(context.Background(), store.accountRef); err != nil {
					t.Fatalf("Resolve() error = %v", err)
				}
			}
			if strategy.refreshCalls.Load() != 1 {
				t.Fatalf("Refresh() calls = %d, want 1", strategy.refreshCalls.Load())
			}
		})
	}
}

// blockingRejectedRefreshStrategy 让并发测试精确控制共享刷新飞行。
type blockingRejectedRefreshStrategy struct {
	providerID   string
	started      chan struct{}
	release      chan struct{}
	refreshCalls atomic.Int64
}

func (strategy *blockingRejectedRefreshStrategy) ProviderID() string {
	return strategy.providerID
}

func (*blockingRejectedRefreshStrategy) ExpiresAt(
	credential accountapp.Credential,
) (time.Time, bool) {
	current, valid := credential.(resolverTestCredential)
	return current.expiresAt, valid && !current.expiresAt.IsZero()
}

func (strategy *blockingRejectedRefreshStrategy) Refresh(
	ctx context.Context,
	_ accountapp.Credential,
	_ time.Time,
) (accountapp.Credential, error) {
	if strategy.refreshCalls.Add(1) == 1 {
		close(strategy.started)
	}
	select {
	case <-ctx.Done():
		return nil, errors.Join(
			accountcredentials.ErrRefreshUnavailable,
			ctx.Err(),
		)
	case <-strategy.release:
		return nil, accountcredentials.ErrReauthenticationRequired
	}
}

// cancelingRefreshStrategy 模拟 Provider 在 HTTP 请求期间观察到调用方取消。
type cancelingRefreshStrategy struct {
	providerID string
	cancel     context.CancelFunc
}

// cancelFirstRefreshStrategy 让首个共享飞行随 leader 取消，后续独立重试返回 grant 失效。
type cancelFirstRefreshStrategy struct {
	providerID   string
	started      chan struct{}
	refreshCalls atomic.Int64
}

func (strategy *cancelFirstRefreshStrategy) ProviderID() string {
	return strategy.providerID
}

func (*cancelFirstRefreshStrategy) ExpiresAt(
	credential accountapp.Credential,
) (time.Time, bool) {
	current, valid := credential.(resolverTestCredential)
	return current.expiresAt, valid && !current.expiresAt.IsZero()
}

func (strategy *cancelFirstRefreshStrategy) Refresh(
	ctx context.Context,
	_ accountapp.Credential,
	_ time.Time,
) (accountapp.Credential, error) {
	if strategy.refreshCalls.Add(1) != 1 {
		return nil, accountcredentials.ErrReauthenticationRequired
	}
	close(strategy.started)
	<-ctx.Done()
	return nil, errors.Join(accountcredentials.ErrRefreshUnavailable, ctx.Err())
}

func waitForResolverReadCount(
	t *testing.T,
	store *resolverTestStore,
	want int64,
) {
	t.Helper()

	deadline := time.Now().Add(time.Second)
	for store.readCalls.Load() < want && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if store.readCalls.Load() < want {
		t.Fatalf("credential reads = %d, want >= %d", store.readCalls.Load(), want)
	}
	// 读取返回后只剩加入共享飞行；让出一个窄调度窗口，避免把并发用例退化为串行。
	time.Sleep(10 * time.Millisecond)
}

func (strategy cancelingRefreshStrategy) ProviderID() string {
	return strategy.providerID
}

func (cancelingRefreshStrategy) ExpiresAt(
	credential accountapp.Credential,
) (time.Time, bool) {
	current, valid := credential.(resolverTestCredential)
	return current.expiresAt, valid && !current.expiresAt.IsZero()
}

func (strategy cancelingRefreshStrategy) Refresh(
	ctx context.Context,
	_ accountapp.Credential,
	_ time.Time,
) (accountapp.Credential, error) {
	strategy.cancel()
	return nil, errors.Join(
		accountcredentials.ErrRefreshUnavailable,
		ctx.Err(),
	)
}
