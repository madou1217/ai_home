package accountusage

import (
	"context"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// RefreshScheduler 接收低敏账号身份和 Provider 的异步额度刷新信号。
type RefreshScheduler interface {
	ScheduleUsageRefresh(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		providerID string,
	) error
}

// RegistrationService 是账号创建与原生导入共享的最小注册端口。
type RegistrationService interface {
	Register(
		ctx context.Context,
		credential accountapp.Credential,
		profile accountapp.PublicProfile,
	) (accountcore.Account, error)
}

// ReauthenticationService 是 OAuth Job 使用的最小重登端口。
type ReauthenticationService interface {
	ValidateTarget(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		providerID string,
	) error
	Reauthenticate(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		credential accountapp.Credential,
		profile accountapp.PublicProfile,
	) (accountcore.Account, error)
}

// RegistrationDecorator 在账号事务成功后发出一次异步额度刷新信号。
type RegistrationDecorator struct {
	next      RegistrationService
	scheduler RefreshScheduler
}

// NewRegistrationDecorator 创建不改变注册事务结果的调度 Decorator。
func NewRegistrationDecorator(
	next RegistrationService,
	scheduler RefreshScheduler,
) (*RegistrationDecorator, error) {
	if next == nil || scheduler == nil {
		return nil, ErrInvalidDependencies
	}
	return &RegistrationDecorator{next: next, scheduler: scheduler}, nil
}

// Register 只在返回有效已持久化账号后安排刷新。
func (decorator *RegistrationDecorator) Register(
	ctx context.Context,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
) (accountcore.Account, error) {
	if decorator == nil ||
		decorator.next == nil ||
		decorator.scheduler == nil ||
		ctx == nil {
		return accountcore.Account{}, ErrInvalidRequest
	}
	account, err := decorator.next.Register(ctx, credential, profile)
	if err != nil {
		return accountcore.Account{}, err
	}
	if !account.IsValid() {
		return accountcore.Account{}, ErrInvalidSnapshot
	}
	// 入队失败不能把已经提交的账号事务伪装成失败。
	_ = decorator.scheduler.ScheduleUsageRefresh(
		context.WithoutCancel(ctx),
		account.Ref(),
		account.ProviderID(),
	)
	return account, nil
}

// ReauthenticationDecorator 在同身份重登成功后发出异步额度刷新信号。
type ReauthenticationDecorator struct {
	next      ReauthenticationService
	scheduler RefreshScheduler
}

// NewReauthenticationDecorator 创建保持原重登验证和事务边界的 Decorator。
func NewReauthenticationDecorator(
	next ReauthenticationService,
	scheduler RefreshScheduler,
) (*ReauthenticationDecorator, error) {
	if next == nil || scheduler == nil {
		return nil, ErrInvalidDependencies
	}
	return &ReauthenticationDecorator{next: next, scheduler: scheduler}, nil
}

// ValidateTarget 直接复用下游预检，不提前安排刷新。
func (decorator *ReauthenticationDecorator) ValidateTarget(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) error {
	if decorator == nil ||
		decorator.next == nil ||
		decorator.scheduler == nil ||
		ctx == nil {
		return ErrInvalidRequest
	}
	return decorator.next.ValidateTarget(ctx, accountRef, providerID)
}

// Reauthenticate 只在下游返回同一有效账号后安排刷新。
func (decorator *ReauthenticationDecorator) Reauthenticate(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
) (accountcore.Account, error) {
	if decorator == nil ||
		decorator.next == nil ||
		decorator.scheduler == nil ||
		ctx == nil ||
		!accountRef.IsValid() {
		return accountcore.Account{}, ErrInvalidRequest
	}
	account, err := decorator.next.Reauthenticate(
		ctx,
		accountRef,
		credential,
		profile,
	)
	if err != nil {
		return accountcore.Account{}, err
	}
	if !account.IsValid() || account.Ref() != accountRef {
		return accountcore.Account{}, ErrInvalidSnapshot
	}
	_ = decorator.scheduler.ScheduleUsageRefresh(
		context.WithoutCancel(ctx),
		account.Ref(),
		account.ProviderID(),
	)
	return account, nil
}
