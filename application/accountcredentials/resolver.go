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
	// recoverableRefreshRetryDelay 吸收瞬时故障后的请求突发，不替代真实上游判断。
	recoverableRefreshRetryDelay = 30 * time.Second
	// invalidRefreshRetryDelay 避免同一失效 Refresh Token 被每个请求重复提交。
	invalidRefreshRetryDelay = 24 * time.Hour
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
	// ErrCredentialNotRefreshable 表示静态凭据或长效 Token 没有官方刷新协议。
	ErrCredentialNotRefreshable = errors.New("账号凭据不可刷新")
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

// credentialResolution 在解析器内部保留同一次读取的完整快照。
// 对外 Result 继续只暴露凭据绑定和刷新事实，不携带持久化时间。
type credentialResolution struct {
	snapshot  accountapp.CredentialSnapshot
	refreshed bool
}

func (resolution credentialResolution) result() Result {
	return Result{
		binding:   resolution.snapshot.Binding(),
		refreshed: resolution.refreshed,
	}
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
	store             accountapp.CredentialVersionStore
	strategies        map[string]RefreshStrategy
	clock             accountapp.Clock
	flights           refreshFlightGroup
	refreshSuppressMu sync.Mutex
	refreshSuppress   map[string]refreshSuppression
}

var _ accountapp.DeletionCleanup = (*Resolver)(nil)

// refreshSuppression 只记录失败凭据的持久化观察时间和重试期限。
// 不保存 Access Token、Refresh Token 或其可逆派生值。
type refreshSuppression struct {
	credentialUpdatedAt time.Time
	retryAt             time.Time
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
		store:           dependencies.Store,
		strategies:      strategies,
		clock:           dependencies.Clock,
		refreshSuppress: make(map[string]refreshSuppression),
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
	resolution, err := resolver.resolve(ctx, accountRef)
	if err != nil {
		return Result{}, err
	}
	return resolution.result(), nil
}

// ResolveObservedCredentialBinding 复用同一次凭据快照读取，同时返回稳定绑定和
// 上游终态写入守卫所需的低敏观察。
func (resolver *Resolver) ResolveObservedCredentialBinding(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialBinding, CredentialObservation, error) {
	resolution, err := resolver.resolve(ctx, accountRef)
	if err != nil {
		return accountapp.CredentialBinding{}, CredentialObservation{}, err
	}
	observation, err := NewCredentialObservation(resolution.snapshot)
	if err != nil {
		return accountapp.CredentialBinding{}, CredentialObservation{}, err
	}
	return resolution.snapshot.Binding(), observation, nil
}

func (resolver *Resolver) resolve(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (credentialResolution, error) {
	if resolver == nil ||
		resolver.store == nil ||
		ctx == nil ||
		!accountRef.IsValid() {
		return credentialResolution{}, ErrInvalidResolveRequest
	}
	if err := ctx.Err(); err != nil {
		return credentialResolution{}, err
	}
	snapshot, strategy, due, err := resolver.readResolutionState(
		ctx,
		accountRef,
	)
	if err != nil {
		return credentialResolution{}, err
	}
	if !due {
		return currentResolution(snapshot), nil
	}
	now, err := resolver.currentTime()
	if err != nil {
		return credentialResolution{}, err
	}
	if resolver.suppressesRefresh(snapshot, now) {
		return currentResolution(snapshot), nil
	}
	resolution, err := resolver.executeRefreshFlight(ctx, accountRef, func() (credentialResolution, error) {
		return resolver.refreshCurrent(ctx, accountRef, strategy, false)
	})
	if err == nil {
		return resolution, nil
	}
	// 共享飞行保留原始刷新错误：普通预刷新可继续尝试当前 Access Token，
	// 同时加入该飞行的真实 401 强制刷新仍能看到 reauth 结论。
	if !resolution.snapshot.IsValid() ||
		!canUseCurrentCredentialAfterRefreshFailure(err) {
		return credentialResolution{}, err
	}
	return currentResolution(resolution.snapshot), nil
}

// ResolveCredential 以最小端口形式返回当前可用凭据，供账号征召等应用用例组合。
func (resolver *Resolver) ResolveCredential(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.Credential, error) {
	resolution, err := resolver.resolve(ctx, accountRef)
	if err != nil {
		return nil, err
	}
	return resolution.snapshot.Credential(), nil
}

// ResolveCredentialBinding 返回可用凭据及其稳定账号绑定，供账号征召复核来源。
func (resolver *Resolver) ResolveCredentialBinding(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialBinding, error) {
	resolution, err := resolver.resolve(ctx, accountRef)
	if err != nil {
		return accountapp.CredentialBinding{}, err
	}
	return resolution.snapshot.Binding(), nil
}

// ForceRefreshCredentialBinding 在上游明确拒绝当前 OAuth 后强制刷新并返回新绑定。
//
// 它只服务常驻 Provider Runtime 的 401 恢复；普通启动和路由仍使用 Resolve 的
// 到期窗口，避免无意义刷新。静态凭据会明确返回 ErrCredentialNotRefreshable。
func (resolver *Resolver) ForceRefreshCredentialBinding(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialBinding, error) {
	if resolver == nil ||
		resolver.store == nil ||
		ctx == nil ||
		!accountRef.IsValid() {
		return accountapp.CredentialBinding{}, ErrInvalidResolveRequest
	}
	if err := ctx.Err(); err != nil {
		return accountapp.CredentialBinding{}, err
	}
	snapshot, strategy, _, err := resolver.readResolutionState(ctx, accountRef)
	if err != nil {
		return accountapp.CredentialBinding{}, err
	}
	if _, refreshable := strategy.ExpiresAt(snapshot.Credential()); !refreshable {
		return accountapp.CredentialBinding{}, ErrCredentialNotRefreshable
	}
	resolution, err := resolver.executeRefreshFlight(ctx, accountRef, func() (credentialResolution, error) {
		return resolver.refreshCurrent(ctx, accountRef, strategy, true)
	})
	if err != nil {
		return accountapp.CredentialBinding{}, err
	}
	return resolution.snapshot.Binding(), nil
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
	force bool,
) (credentialResolution, error) {
	snapshot, strategy, due, err := resolver.readResolutionState(
		ctx,
		accountRef,
	)
	if err != nil {
		return credentialResolution{}, err
	}
	if strategy.ProviderID() != expectedStrategy.ProviderID() {
		return credentialResolution{}, ErrInvalidRefreshResult
	}
	_, refreshable := strategy.ExpiresAt(snapshot.Credential())
	if force && !refreshable {
		return credentialResolution{}, ErrCredentialNotRefreshable
	}
	if !force && !due {
		return currentResolution(snapshot), nil
	}
	now, err := resolver.currentTime()
	if err != nil {
		return credentialResolution{}, err
	}
	refreshedAt := nextCredentialVersion(now, snapshot.UpdatedAt())
	credential, err := strategy.Refresh(
		ctx,
		snapshot.Credential(),
		refreshedAt,
	)
	if err != nil {
		resolver.rememberRefreshFailure(snapshot, now, err)
		return currentResolution(snapshot), err
	}
	replacement, err := accountapp.NewCredentialReplacement(
		snapshot,
		credential,
		refreshedAt,
	)
	if err != nil {
		return credentialResolution{}, ErrInvalidRefreshResult
	}
	if err := resolver.store.ReplaceCredential(ctx, replacement); err != nil {
		if errors.Is(err, accountapp.ErrCredentialConflict) {
			return resolver.resolveCredentialConflict(ctx, accountRef, snapshot.UpdatedAt())
		}
		return credentialResolution{}, err
	}
	resolver.forgetRefreshSuppression(accountRef)
	refreshed, err := accountapp.NewCredentialSnapshot(
		accountRef,
		credential.ProviderID(),
		credential,
		refreshedAt,
	)
	if err != nil {
		return credentialResolution{}, ErrInvalidRefreshResult
	}
	return credentialResolution{snapshot: refreshed, refreshed: true}, nil
}

// executeRefreshFlight 合并同账号刷新，并隔离 leader 私有的取消状态。
// 健康 follower 只在继承了其他调用方取消时独立重试一次，Provider 真实错误不重放。
func (resolver *Resolver) executeRefreshFlight(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	operation func() (credentialResolution, error),
) (credentialResolution, error) {
	resolution, err := resolver.flights.Do(
		ctx,
		accountRef.String(),
		operation,
	)
	if ctx.Err() != nil ||
		(!errors.Is(err, context.Canceled) &&
			!errors.Is(err, context.DeadlineExceeded)) {
		return resolution, err
	}
	return resolver.flights.Do(ctx, accountRef.String(), operation)
}

// canUseCurrentCredentialAfterRefreshFailure 只放行 Provider 已归类的预刷新失败。
// 当前 Access Token 是否失效由随后真实上游响应判定；取消、非法结果和存储错误仍返回。
func canUseCurrentCredentialAfterRefreshFailure(err error) bool {
	if errors.Is(err, context.Canceled) ||
		errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	return errors.Is(err, ErrRefreshUnavailable) ||
		errors.Is(err, ErrRefreshRejected) ||
		errors.Is(err, ErrReauthenticationRequired)
}

// suppressesRefresh 按 AccountRef 和 credential.updated_at 精确匹配。
// 新登录或凭据轮换推进时间后会立即解除旧抑制。
func (resolver *Resolver) suppressesRefresh(
	snapshot accountapp.CredentialSnapshot,
	now time.Time,
) bool {
	resolver.refreshSuppressMu.Lock()
	defer resolver.refreshSuppressMu.Unlock()

	key := snapshot.AccountRef().String()
	observation, found := resolver.refreshSuppress[key]
	if !found {
		return false
	}
	if !observation.credentialUpdatedAt.Equal(snapshot.UpdatedAt()) ||
		!now.Before(observation.retryAt) {
		delete(resolver.refreshSuppress, key)
		return false
	}
	return true
}

// rememberRefreshFailure 以 O(1) 按账号记录下一次允许刷新时间。
// 失效 grant 使用长抑制；瞬时故障和一般拒绝只吸收短请求突发。
func (resolver *Resolver) rememberRefreshFailure(
	snapshot accountapp.CredentialSnapshot,
	now time.Time,
	err error,
) {
	delay := recoverableRefreshRetryDelay
	switch {
	case errors.Is(err, context.Canceled),
		errors.Is(err, context.DeadlineExceeded):
		return
	case errors.Is(err, ErrReauthenticationRequired):
		delay = invalidRefreshRetryDelay
	case errors.Is(err, ErrRefreshUnavailable),
		errors.Is(err, ErrRefreshRejected):
	default:
		return
	}

	resolver.refreshSuppressMu.Lock()
	resolver.refreshSuppress[snapshot.AccountRef().String()] = refreshSuppression{
		credentialUpdatedAt: snapshot.UpdatedAt(),
		retryAt:             now.Add(delay),
	}
	resolver.refreshSuppressMu.Unlock()
}

func (resolver *Resolver) forgetRefreshSuppression(accountRef accountcore.AccountRef) {
	resolver.refreshSuppressMu.Lock()
	delete(resolver.refreshSuppress, accountRef.String())
	resolver.refreshSuppressMu.Unlock()
}

// ForgetAccount 在账号事实删除提交后释放该账号的进程内刷新抑制。
// 删除清理必须幂等，因此无效引用和 nil receiver 都直接返回。
func (resolver *Resolver) ForgetAccount(accountRef accountcore.AccountRef) {
	if resolver == nil || !accountRef.IsValid() {
		return
	}
	resolver.forgetRefreshSuppression(accountRef)
}

// resolveCredentialConflict 接受其他进程已经成功写入的可用新版本。
func (resolver *Resolver) resolveCredentialConflict(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	rejectedVersion time.Time,
) (credentialResolution, error) {
	snapshot, _, _, err := resolver.readResolutionState(ctx, accountRef)
	if err != nil {
		return credentialResolution{}, err
	}
	if !snapshot.UpdatedAt().After(rejectedVersion) {
		return credentialResolution{}, accountapp.ErrCredentialConflict
	}
	return currentResolution(snapshot), nil
}

// currentResolution 保留不需要刷新或已由其他进程刷新的完整快照。
func currentResolution(snapshot accountapp.CredentialSnapshot) credentialResolution {
	return credentialResolution{snapshot: snapshot}
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
	result credentialResolution
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
	operation func() (credentialResolution, error),
) (credentialResolution, error) {
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
) (credentialResolution, error) {
	select {
	case <-ctx.Done():
		return credentialResolution{}, ctx.Err()
	case <-call.done:
		return call.result, call.err
	}
}
