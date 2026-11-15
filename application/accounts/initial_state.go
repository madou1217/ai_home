package accounts

import (
	"context"
	"errors"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// InitialAccountState applies only to the first atomic registration. The zero
// value preserves normal enabled registration; it never updates existing users.
type InitialAccountState struct{ Disabled bool }

var ErrInitialAccountStateUnsupported = errors.New("账号注册端口不支持初始停用状态")

type InitialStateRegistration interface {
	RegisterWithInitialState(context.Context, Credential, PublicProfile, InitialAccountState) (accountcore.Account, error)
}

type InitialStateImporter interface {
	ImportWithInitialState(context.Context, Credential, PublicProfile, InitialAccountState) (AccountImportResult, error)
}

// RegisterInitialAccount preserves old registration ports for default state but
// fails before writes when a disabled import cannot be propagated end to end.
func RegisterInitialAccount(ctx context.Context, next AccountImportRegistration, credential Credential, profile PublicProfile, state InitialAccountState) (accountcore.Account, error) {
	if state.Disabled {
		port, ok := next.(InitialStateRegistration)
		if !ok {
			return accountcore.Account{}, ErrInitialAccountStateUnsupported
		}
		return port.RegisterWithInitialState(ctx, credential, profile, state)
	}
	return next.Register(ctx, credential, profile)
}
