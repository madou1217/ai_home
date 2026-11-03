package accounts

import (
	"context"
	"errors"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidModelRefreshLifecycleDependencies 表示账号生命周期刷新边界缺少下游服务或调度器。
	ErrInvalidModelRefreshLifecycleDependencies = errors.New("账号模型生命周期刷新依赖无效")
	// ErrInvalidModelRefreshLifecycleRequest 表示账号生命周期刷新请求缺少上下文或稳定身份。
	ErrInvalidModelRefreshLifecycleRequest = errors.New("账号模型生命周期刷新请求无效")
	// ErrInvalidModelRefreshLifecycleResult 表示下游事务返回了无效或错位账号。
	ErrInvalidModelRefreshLifecycleResult = errors.New("账号模型生命周期刷新结果无效")
)

// ModelRefreshScheduler 接收提交后的低敏模型刷新信号。
type ModelRefreshScheduler interface {
	ScheduleModelRefresh(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		providerID string,
	) error
}

// ModelRefreshInvalidatingScheduler 在凭据提交后切换账号刷新代次。
type ModelRefreshInvalidatingScheduler interface {
	ModelRefreshScheduler
	DeletionCleanup
}

// RegistrationService 是模型刷新 Decorator 需要的最小注册端口。
type RegistrationService interface {
	Register(
		ctx context.Context,
		credential Credential,
		profile PublicProfile,
	) (accountcore.Account, error)
}

// ReauthenticationService 是模型刷新 Decorator 需要的最小重登端口。
type ReauthenticationService interface {
	ValidateTarget(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		providerID string,
	) error
	Reauthenticate(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		credential Credential,
		profile PublicProfile,
	) (accountcore.Account, error)
}

// StaticCredentialRotationService 是模型刷新 Decorator 需要的最小轮换端口。
type StaticCredentialRotationService interface {
	Rotate(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		replacement Credential,
	) (accountcore.Account, error)
}

// RegistrationModelRefreshDecorator 在注册事务提交后异步维护首次模型快照。
type RegistrationModelRefreshDecorator struct {
	next      RegistrationService
	scheduler ModelRefreshScheduler
}

// NewRegistrationModelRefreshDecorator 创建不改变注册结果的异步模型刷新边界。
func NewRegistrationModelRefreshDecorator(
	next RegistrationService,
	scheduler ModelRefreshScheduler,
) (*RegistrationModelRefreshDecorator, error) {
	if next == nil || scheduler == nil {
		return nil, ErrInvalidModelRefreshLifecycleDependencies
	}
	return &RegistrationModelRefreshDecorator{
		next:      next,
		scheduler: scheduler,
	}, nil
}

// Register 先提交账号事务，再以稳定身份发出有界入队信号。
func (decorator *RegistrationModelRefreshDecorator) Register(
	ctx context.Context,
	credential Credential,
	profile PublicProfile,
) (accountcore.Account, error) {
	if decorator == nil || decorator.next == nil || decorator.scheduler == nil || ctx == nil {
		return accountcore.Account{}, ErrInvalidModelRefreshLifecycleRequest
	}
	account, err := decorator.next.Register(ctx, credential, profile)
	if err != nil {
		return accountcore.Account{}, err
	}
	return scheduleCommittedAccountModelRefresh(ctx, decorator.scheduler, account, "")
}

// ReauthenticationModelRefreshDecorator 在 OAuth 重登提交后异步刷新模型快照。
type ReauthenticationModelRefreshDecorator struct {
	next      ReauthenticationService
	scheduler ModelRefreshInvalidatingScheduler
}

// NewReauthenticationModelRefreshDecorator 创建保持重登预检语义的异步刷新边界。
func NewReauthenticationModelRefreshDecorator(
	next ReauthenticationService,
	scheduler ModelRefreshInvalidatingScheduler,
) (*ReauthenticationModelRefreshDecorator, error) {
	if next == nil || scheduler == nil {
		return nil, ErrInvalidModelRefreshLifecycleDependencies
	}
	return &ReauthenticationModelRefreshDecorator{
		next:      next,
		scheduler: scheduler,
	}, nil
}

// ValidateTarget 直接复用下游 OAuth 目标预检，不提前调度模型刷新。
func (decorator *ReauthenticationModelRefreshDecorator) ValidateTarget(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) error {
	if decorator == nil || decorator.next == nil || decorator.scheduler == nil || ctx == nil {
		return ErrInvalidModelRefreshLifecycleRequest
	}
	return decorator.next.ValidateTarget(ctx, accountRef, providerID)
}

// Reauthenticate 保留旧模型快照，并在同身份凭据事务提交后安排刷新。
func (decorator *ReauthenticationModelRefreshDecorator) Reauthenticate(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	credential Credential,
	profile PublicProfile,
) (accountcore.Account, error) {
	if decorator == nil || decorator.next == nil || decorator.scheduler == nil ||
		ctx == nil || !accountRef.IsValid() {
		return accountcore.Account{}, ErrInvalidModelRefreshLifecycleRequest
	}
	account, err := decorator.next.Reauthenticate(ctx, accountRef, credential, profile)
	if err != nil {
		return accountcore.Account{}, err
	}
	return rescheduleCommittedAccountModelRefresh(
		ctx,
		decorator.scheduler,
		account,
		accountRef,
	)
}

// StaticCredentialRotationModelRefreshDecorator 在静态凭据轮换提交后异步刷新模型快照。
type StaticCredentialRotationModelRefreshDecorator struct {
	next      StaticCredentialRotationService
	scheduler ModelRefreshInvalidatingScheduler
}

// NewStaticCredentialRotationModelRefreshDecorator 创建保持轮换事务边界的异步刷新装饰器。
func NewStaticCredentialRotationModelRefreshDecorator(
	next StaticCredentialRotationService,
	scheduler ModelRefreshInvalidatingScheduler,
) (*StaticCredentialRotationModelRefreshDecorator, error) {
	if next == nil || scheduler == nil {
		return nil, ErrInvalidModelRefreshLifecycleDependencies
	}
	return &StaticCredentialRotationModelRefreshDecorator{
		next:      next,
		scheduler: scheduler,
	}, nil
}

// Rotate 保留最后一次成功模型快照，并在轮换成功后安排刷新。
func (decorator *StaticCredentialRotationModelRefreshDecorator) Rotate(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	replacement Credential,
) (accountcore.Account, error) {
	if decorator == nil || decorator.next == nil || decorator.scheduler == nil ||
		ctx == nil || !accountRef.IsValid() {
		return accountcore.Account{}, ErrInvalidModelRefreshLifecycleRequest
	}
	account, err := decorator.next.Rotate(ctx, accountRef, replacement)
	if err != nil {
		return accountcore.Account{}, err
	}
	return rescheduleCommittedAccountModelRefresh(
		ctx,
		decorator.scheduler,
		account,
		accountRef,
	)
}

// rescheduleCommittedAccountModelRefresh 先校验提交结果，再原子切换协调器代次语义。
func rescheduleCommittedAccountModelRefresh(
	ctx context.Context,
	scheduler ModelRefreshInvalidatingScheduler,
	account accountcore.Account,
	expectedRef accountcore.AccountRef,
) (accountcore.Account, error) {
	if !account.IsValid() || account.Ref() != expectedRef {
		return accountcore.Account{}, ErrInvalidModelRefreshLifecycleResult
	}
	scheduler.ForgetAccount(expectedRef)
	return scheduleCommittedAccountModelRefresh(
		ctx,
		scheduler,
		account,
		expectedRef,
	)
}

// scheduleCommittedAccountModelRefresh 统一校验提交结果，并隔离旁路入队失败。
func scheduleCommittedAccountModelRefresh(
	ctx context.Context,
	scheduler ModelRefreshScheduler,
	account accountcore.Account,
	expectedRef accountcore.AccountRef,
) (accountcore.Account, error) {
	if !account.IsValid() || expectedRef.IsValid() && account.Ref() != expectedRef {
		return accountcore.Account{}, ErrInvalidModelRefreshLifecycleResult
	}
	// 入队失败不能把已经提交的账号事务伪装成失败。
	_ = scheduler.ScheduleModelRefresh(
		context.WithoutCancel(ctx),
		account.Ref(),
		account.ProviderID(),
	)
	return account, nil
}
