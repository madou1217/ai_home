package accountrecovery

import (
	"context"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// Reauthenticator 在原子重登成功后保留阻塞，等待可证明代次的恢复。
type Reauthenticator struct {
	next    ReauthenticationService
	runtime Runtime
}

// NewReauthenticator 创建不改变原重登事务职责的 Decorator。
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

// Reauthenticate 验证持久化结果，不凭同账号成功返回解除凭据阻塞。
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
	// 同账号成功返回不证明替换了凭据或绑定了阻塞代次。
	return account, nil
}
