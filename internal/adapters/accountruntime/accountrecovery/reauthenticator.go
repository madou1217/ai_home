package accountrecovery

import (
	"context"
	"errors"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// Reauthenticator 在原子重登成功后解除账号凭据阻塞。
type Reauthenticator struct {
	next    ReauthenticationService
	runtime Runtime
}

// NewReauthenticator 创建不改变原重登事务职责的恢复 Decorator。
func NewReauthenticator(
	next ReauthenticationService,
	runtime Runtime,
) (*Reauthenticator, error) {
	if next == nil || runtime == nil {
		return nil, ErrInvalidDependencies
	}
	return &Reauthenticator{
		next:    next,
		runtime: runtime,
	}, nil
}

// ValidateTarget 直接复用原用例预检，不提前修改运行态。
func (decorator *Reauthenticator) ValidateTarget(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) error {
	if decorator == nil ||
		decorator.next == nil ||
		decorator.runtime == nil ||
		ctx == nil {
		return ErrInvalidRequest
	}
	return decorator.next.ValidateTarget(ctx, accountRef, providerID)
}

// Reauthenticate 只在持久化成功且返回同一账号后解除凭据阻塞。
func (decorator *Reauthenticator) Reauthenticate(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
) (accountcore.Account, error) {
	if decorator == nil ||
		decorator.next == nil ||
		decorator.runtime == nil ||
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
		return accountcore.Account{}, ErrInvalidResult
	}
	if err := decorator.runtime.ClearAccountBlock(
		context.WithoutCancel(ctx),
		accountRef,
		runtimecore.RecoveryCredentialsUpdated,
	); err != nil {
		return accountcore.Account{}, errors.Join(
			ErrRuntimeRecovery,
			err,
		)
	}
	return account, nil
}
