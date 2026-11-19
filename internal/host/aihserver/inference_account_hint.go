package aihserver

import (
	"context"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

// inferenceAccountHintResolver 把会话模型改写里的账号提示解析成规范账号。
type inferenceAccountHintResolver struct {
	store *sqliteaccount.Store
}

func (resolver inferenceAccountHintResolver) ResolveAccountHint(
	ctx context.Context,
	hint string,
	providerHint string,
) (accountcore.AccountRef, string, error) {
	hint = strings.TrimSpace(hint)
	providerHint = strings.ToLower(strings.TrimSpace(providerHint))
	if resolver.store == nil || hint == "" {
		return "", "", accountcore.ErrInvalidAccountRef
	}
	if strings.HasPrefix(hint, "acct_") {
		ref, err := accountcore.ParseAccountRef(hint)
		if err != nil {
			return "", "", err
		}
		account, err := resolver.store.GetByRef(ctx, ref)
		if err != nil {
			return "", "", err
		}
		return account.Ref(), account.ProviderID(), nil
	}
	cliID, err := accountcore.ParseCLIAccountID(hint)
	if err != nil || providerHint == "" || providerHint == "auto" {
		return "", "", accountcore.ErrInvalidAccountRef
	}
	account, err := resolver.store.GetByCLIAccountID(ctx, providerHint, cliID)
	if err != nil {
		return "", "", err
	}
	return account.Ref(), account.ProviderID(), nil
}
