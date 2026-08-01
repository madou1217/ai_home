// Package accountcredentials 把持久化账号凭据解析为当前可直接使用的版本。
//
// 该应用层只编排版本读取、过期判断、Provider 刷新策略、并发合并和 CAS 写入，
// 不依赖 SQLite、HTTP 端点、Server 路由或 Provider 原生文件。
package accountcredentials

import (
	"context"
	"errors"
	"sync"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// DefaultRefreshSkew 提前刷新即将过期的 OAuth Access Token。
	DefaultRefreshSkew = 5 * time.Minute
)

var (
	// ErrInvalidDependencies 表示 Resolver 缺少存储、策略或时钟。
	ErrInvalidDependencies = errors.New("账号凭据解析依赖无效")
	// ErrInvalidResolveRequest 表示目标 AccountRef 无效。
	ErrInvalidResolveRequest = errors.New("账号凭据解析请求无效")
	// ErrRefreshStrategyNotFound 表示 Provider 没有注册凭据刷新策略。
	ErrRefreshStrategyNotFound = errors.New("账号凭据刷新策略不存在")
	// ErrRefreshUnavailable 表示 OAuth 刷新网络或上游暂时不可用。
	ErrRefreshUnavailable = errors.New("账号 OAuth 刷新暂时不可用")
	// ErrRefreshRejected 表示上游拒绝了当前刷新请求。
	ErrRefreshRejected = errors.New("账号 OAuth 刷新被拒绝")
	// ErrReauthenticationRequired 表示 Refresh Token 已失效，需要用户重新认证。
	ErrReauthenticationRequired = errors.New("账号需要重新认证")
	// ErrInvalidRefreshResult 表示 Provider 返回的凭据不完整或改变了账号身份。
	ErrInvalidRefreshResult = errors.New("账号 OAuth 刷新结果无效")
)

// RefreshStrategy 封装一个 Provider 的可刷新凭据识别、过期时间和官方刷新协议。
type RefreshStrategy interface {
	// ProviderID 返回策略唯一支持的规范 Provider。
	ProviderID() string
	// ExpiresAt 返回 refreshable OAuth 的 Access Token 过期时间。
	ExpiresAt(
		credential accountapp.Credential,
	) (time.Time, bool)
	// Refresh 调用官方协议并返回身份不变的新领域凭据。
	Refresh(
		ctx context.Context,
		credential accountapp.Credential,
		refreshedAt time.Time,
	) (accountapp.Credential, error)
}

// Dependencies 集中声明 Resolver 的最小应用端口。
type Dependencies struct {
	// Store 提供凭据版本读取和 CAS 替换。
	Store accountapp.CredentialVersionStore
	// Strategies 是当前已研究 Provider 的刷新策略。
	Strategies []RefreshStrategy
	// Clock 提供过期判断和凭据版本时间。
	Clock accountapp.Clock
}

// Result 返回当前可用凭据以及本次是否执行了真实刷新。
type Result struct {
	binding   accountapp.CredentialBinding
	refreshed bool
}

// Credential 返回当前可直接交给上游适配器的领域凭据。
func (result Result) Credential() accountapp.Credential {
	return result.binding.Credential()
}

// Binding 返回凭据和稳定账号引用之间经过持久化层验证的绑定。
func (result Result) Binding() accountapp.CredentialBinding {
	return result.binding
}

// Refreshed 表示当前调用是否完成并持久化了新 OAuth Token。
func (result Result) Refreshed() bool {
	return result.refreshed
}

// Resolver 按 AccountRef 延迟读取凭据，并按账号合并并发刷新。
type Resolver struct {
	store      accountapp.CredentialVersionStore
	strategies map[string]RefreshStrategy
	clock      accountapp.Clock
	flights    refreshFlightGroup
}

// NewResolver 创建使用固定五分钟刷新窗口的凭据解析用例。
func NewResolver(dependencies Dependencies) (*Resolver, error) {
	if dependencies.Store == nil ||
		dependencies.Clock == nil ||
		len(dependencies.Strategies) == 0 {
		return nil, ErrInvalidDependencies
	}
	strategies := make(
		map[string]RefreshStrategy,
		len(dependencies.Strategies),
	)
	for _, strategy := range dependencies.Strategies {
		if strategy == nil || strategy.ProviderID() == "" {
			return nil, ErrInvalidDependencies
		}
		providerID := strategy.ProviderID()
		if _, duplicated := strategies[providerID]; duplicated {
			return nil, ErrInvalidDependencies
		}
		strategies[providerID] = strategy
	}
	return &Resolver{
		store:      dependencies.Store,
		strategies: strategies,
		clock:      dependencies.Clock,
		flights: refreshFlightGroup{
			active: make(map[string]*refreshCall),
		},
	}, nil
}

// Resolve 返回静态凭据、仍新鲜的 OAuth，或刷新后完成 CAS 持久化的 OAuth。
func (resolver *Resolver) Resolve(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (Result, error) {
	if resolver == nil ||
		resolver.store == nil ||
		ctx == nil ||
		!accountRef.IsValid() {
		return Result{}, ErrInvalidResolveRequest
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	snapshot, strategy, due, err := resolver.readResolutionState(
		ctx,
		accountRef,
	)
	if err != nil {
		return Result{}, err
	}
	if !due {
		return currentResult(snapshot), nil
	}
	return resolver.flights.Do(ctx, accountRef.String(), func() (Result, error) {
		return resolver.refreshCurrent(ctx, accountRef, strategy)
	})
}

// ResolveCredential 以最小端口形式返回当前可用凭据，供账号征召等应用用例组合。
func (resolver *Resolver) ResolveCredential(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.Credential, error) {
	result, err := resolver.Resolve(ctx, accountRef)
	if err != nil {
		return nil, err
	}
	return result.Credential(), nil
}

// ResolveCredentialBinding 返回可用凭据及其稳定账号绑定，供账号征召复核来源。
func (resolver *Resolver) ResolveCredentialBinding(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialBinding, error) {
	result, err := resolver.Resolve(ctx, accountRef)
	if err != nil {
		return accountapp.CredentialBinding{}, err
	}
	return result.Binding(), nil
}

// readResolutionState 读取最新凭据，并选择唯一 Provider 刷新策略。
func (resolver *Resolver) readResolutionState(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (
	accountapp.CredentialSnapshot,
	RefreshStrategy,
	bool,
	error,
) {
	snapshot, err := resolver.store.GetCredentialSnapshot(ctx, accountRef)
	if err != nil {
		return accountapp.CredentialSnapshot{}, nil, false, err
	}
	if !snapshot.IsValid() || snapshot.AccountRef() != accountRef {
		return accountapp.CredentialSnapshot{}, nil, false, ErrInvalidRefreshResult
	}
	strategy, found := resolver.strategies[snapshot.Credential().ProviderID()]
	if !found {
		return accountapp.CredentialSnapshot{}, nil, false, ErrRefreshStrategyNotFound
	}
	now, err := resolver.currentTime()
	if err != nil {
		return accountapp.CredentialSnapshot{}, nil, false, err
	}
	return snapshot, strategy, refreshDueAt(snapshot, strategy, now), nil
}

// refreshDueAt 只根据 Access Token 的明确过期时间决定是否刷新。
func refreshDueAt(
	snapshot accountapp.CredentialSnapshot,
	strategy RefreshStrategy,
	now time.Time,
) bool {
	expiresAt, refreshable := strategy.ExpiresAt(snapshot.Credential())
	if !refreshable || expiresAt.IsZero() {
		return false
	}
	return expiresAt.Sub(now) <= DefaultRefreshSkew
}

// refreshCurrent 在 singleflight 内重新读取，避免用等待前的旧 Token 发起刷新。
func (resolver *Resolver) refreshCurrent(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	expectedStrategy RefreshStrategy,
) (Result, error) {
	snapshot, strategy, due, err := resolver.readResolutionState(
		ctx,
		accountRef,
	)
	if err != nil {
		return Result{}, err
	}
	if strategy.ProviderID() != expectedStrategy.ProviderID() {
		return Result{}, ErrInvalidRefreshResult
	}
	if !due {
		return currentResult(snapshot), nil
	}
	now, err := resolver.currentTime()
	if err != nil {
		return Result{}, err
	}
	refreshedAt := nextCredentialVersion(now, snapshot.UpdatedAt())
	credential, err := strategy.Refresh(
		ctx,
		snapshot.Credential(),
		refreshedAt,
	)
	if err != nil {
		return Result{}, err
	}
	replacement, err := accountapp.NewCredentialReplacement(
		snapshot,
		credential,
		refreshedAt,
	)
	if err != nil {
		return Result{}, ErrInvalidRefreshResult
	}
	if err := resolver.store.ReplaceCredential(ctx, replacement); err != nil {
		if errors.Is(err, accountapp.ErrCredentialConflict) {
			return resolver.resolveCredentialConflict(ctx, accountRef)
		}
		return Result{}, err
	}
	binding, err := accountapp.NewCredentialBinding(
		accountRef,
		credential.ProviderID(),
		credential,
	)
	if err != nil {
		return Result{}, ErrInvalidRefreshResult
	}
	return Result{binding: binding, refreshed: true}, nil
}

// resolveCredentialConflict 接受其他进程已经成功写入的可用新版本。
func (resolver *Resolver) resolveCredentialConflict(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (Result, error) {
	snapshot, _, due, err := resolver.readResolutionState(ctx, accountRef)
	if err != nil {
		return Result{}, err
	}
	if due {
		return Result{}, accountapp.ErrCredentialConflict
	}
	return currentResult(snapshot), nil
}

// currentResult 把不需要刷新或已由其他进程刷新的快照转成结果。
func currentResult(snapshot accountapp.CredentialSnapshot) Result {
	return Result{binding: snapshot.Binding()}
}

// currentTime 拒绝无法形成持久化毫秒版本的应用时钟。
func (resolver *Resolver) currentTime() (time.Time, error) {
	now := resolver.clock().UTC()
	if now.IsZero() || now.UnixMilli() <= 0 || now.Year() > 9999 {
		return time.Time{}, ErrInvalidDependencies
	}
	return now, nil
}

// nextCredentialVersion 生成不受毫秒级并发和时钟回拨影响的递增版本。
func nextCredentialVersion(now time.Time, current time.Time) time.Time {
	next := time.UnixMilli(now.UTC().UnixMilli()).UTC()
	if !next.After(current) {
		return current.Add(time.Millisecond)
	}
	return next
}

// refreshCall 保存一个账号正在执行的唯一刷新结果。
type refreshCall struct {
	done   chan struct{}
	result Result
	err    error
}

// refreshFlightGroup 只在进程内按 AccountRef 合并活动刷新，不缓存终态结果。
type refreshFlightGroup struct {
	mu     sync.Mutex
	active map[string]*refreshCall
}

// Do 让第一个调用执行刷新，其余调用等待同一个安全结果。
func (group *refreshFlightGroup) Do(
	ctx context.Context,
	key string,
	operation func() (Result, error),
) (Result, error) {
	group.mu.Lock()
	if call, found := group.active[key]; found {
		group.mu.Unlock()
		return waitForRefresh(ctx, call)
	}
	call := &refreshCall{done: make(chan struct{})}
	group.active[key] = call
	group.mu.Unlock()

	call.result, call.err = operation()
	group.mu.Lock()
	delete(group.active, key)
	close(call.done)
	group.mu.Unlock()
	return call.result, call.err
}

// waitForRefresh 支持等待者独立取消，而不终止已经发出的官方刷新请求。
func waitForRefresh(
	ctx context.Context,
	call *refreshCall,
) (Result, error) {
	select {
	case <-ctx.Done():
		return Result{}, ctx.Err()
	case <-call.done:
		return call.result, call.err
	}
}
