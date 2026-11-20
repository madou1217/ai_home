package webuiaccountbrowserapi

import (
	"context"
	"encoding/json"
	"errors"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/accountbrowser"
)

var (
	ErrAccountNotFound      = errors.New("browser account not found")
	ErrAuthorityUnavailable = errors.New("browser account authority unavailable")
)

// AccountReader reads only stable account identity, never browser credentials.
type AccountReader interface {
	GetByRef(context.Context, accountcore.AccountRef) (accountcore.Account, error)
}

// Authority resolves the server and account from trusted sources before any
// profile I/O. A display name, CLI alias or request-supplied server ID is not an
// identity authority.
type Authority interface {
	Resolve(context.Context, string, string) (accountbrowser.Identity, error)
}

// AccountAuthority binds profiles to an existing account and canonical server.
// ServerID must read the server's durable identity rather than its network URL.
type AccountAuthority struct {
	Accounts AccountReader
	ServerID func(context.Context) (string, error)
}

func (a AccountAuthority) Resolve(ctx context.Context, provider, rawRef string) (accountbrowser.Identity, error) {
	ref, err := accountcore.ParseAccountRef(rawRef)
	if err != nil {
		return accountbrowser.Identity{}, accountbrowser.ErrInvalidIdentity
	}
	if a.Accounts == nil || a.ServerID == nil {
		return accountbrowser.Identity{}, ErrAuthorityUnavailable
	}
	account, err := a.Accounts.GetByRef(ctx, ref)
	if errors.Is(err, accountapp.ErrAccountNotFound) {
		return accountbrowser.Identity{}, ErrAccountNotFound
	}
	if err != nil {
		return accountbrowser.Identity{}, ErrAuthorityUnavailable
	}
	if account.Ref() != ref || account.ProviderID() != provider {
		return accountbrowser.Identity{}, ErrAccountNotFound
	}
	serverID, err := a.ServerID(ctx)
	if err != nil {
		return accountbrowser.Identity{}, ErrAuthorityUnavailable
	}
	identity := accountbrowser.Identity{ServerID: serverID, Provider: provider, AccountRef: ref.String()}
	if err := identity.Validate(); err != nil {
		return accountbrowser.Identity{}, ErrAuthorityUnavailable
	}
	return identity, nil
}

// ReadServerID reads the existing canonical authority. It never creates an ID
// during profile access or substitutes the request host for a missing identity.
func ReadServerID(ctx context.Context, aiHomeDir string) (string, error) {
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return "", ErrAuthorityUnavailable
	}
	value, found, err := appstate.ReadKV(ctx, databasePath, "server:identity")
	if err != nil || !found || len(value) > 4096 {
		return "", ErrAuthorityUnavailable
	}
	var identity struct {
		ID string `json:"id"`
	}
	if json.Unmarshal([]byte(value), &identity) != nil || identity.ID == "" {
		return "", ErrAuthorityUnavailable
	}
	return identity.ID, nil
}
