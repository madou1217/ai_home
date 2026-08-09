package aihaccount

import (
	"context"
	"errors"
	"fmt"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidAccountTarget 表示账号详情目标既不是 AccountRef 也不是 Provider 数字别名。
	ErrInvalidAccountTarget = errors.New("AIH 账号目标无效")
	// ErrInvalidShowRequest 表示账号详情请求缺少有效上下文或目标。
	ErrInvalidShowRequest = errors.New("AIH 账号详情请求无效")
)

// AccountTarget 是账号详情支持的两种无歧义身份之一。
//
// AccountRef 与 Provider 数字别名必须且只能设置一组。
type AccountTarget struct {
	AccountRef   string
	ProviderID   string
	CLIAccountID int64
}

// ParseAccountTarget 解析稳定 AccountRef 或 provider:id 详情目标。
func ParseAccountTarget(value string) (AccountTarget, error) {
	if accountRef, err := accountcore.ParseAccountRef(value); err == nil {
		return AccountTarget{AccountRef: accountRef.String()}, nil
	}
	providerID, aliasValue, found := strings.Cut(value, ":")
	if !found ||
		providerID == "" ||
		strings.TrimSpace(providerID) != providerID ||
		strings.ToLower(providerID) != providerID ||
		strings.Contains(aliasValue, ":") {
		return AccountTarget{}, ErrInvalidAccountTarget
	}
	cliAccountID, err := accountcore.ParseCLIAccountID(aliasValue)
	if err != nil {
		return AccountTarget{}, ErrInvalidAccountTarget
	}
	return AccountTarget{
		ProviderID:   providerID,
		CLIAccountID: cliAccountID.Int64(),
	}, nil
}

// isValid 判断详情目标是否只选择一种规范身份。
func (target AccountTarget) isValid() bool {
	if target.AccountRef != "" {
		_, err := accountcore.ParseAccountRef(target.AccountRef)
		return err == nil && target.ProviderID == "" && target.CLIAccountID == 0
	}
	if target.ProviderID == "" ||
		strings.TrimSpace(target.ProviderID) != target.ProviderID ||
		strings.ToLower(target.ProviderID) != target.ProviderID {
		return false
	}
	_, err := accountcore.NewCLIAccountID(target.CLIAccountID)
	return err == nil
}

// ShowAccount 按稳定 AccountRef 或 Provider 数字别名读取单个公开账号详情。
func (app *App) ShowAccount(
	ctx context.Context,
	target AccountTarget,
) (AccountView, error) {
	if app == nil || ctx == nil || !target.isValid() {
		return AccountView{}, ErrInvalidShowRequest
	}
	if err := ctx.Err(); err != nil {
		return AccountView{}, err
	}
	accountRef, err := app.resolveAccountTarget(ctx, target)
	if err != nil {
		return AccountView{}, err
	}
	overview, err := app.accounts.GetAccountOverview(ctx, accountRef)
	if err != nil {
		return AccountView{}, fmt.Errorf("读取账号详情失败: %w", err)
	}
	if overview.Account().Ref() != accountRef {
		return AccountView{}, ErrInvalidShowRequest
	}
	return newAccountView(overview), nil
}

// resolveAccountTarget 只把 Provider 数字别名解析成稳定 AccountRef。
func (app *App) resolveAccountTarget(
	ctx context.Context,
	target AccountTarget,
) (accountcore.AccountRef, error) {
	if target.AccountRef != "" {
		accountRef, err := accountcore.ParseAccountRef(target.AccountRef)
		if err != nil {
			return "", ErrInvalidShowRequest
		}
		return accountRef, nil
	}
	cliAccountID, err := accountcore.NewCLIAccountID(target.CLIAccountID)
	if err != nil {
		return "", ErrInvalidShowRequest
	}
	account, err := app.accounts.GetByCLIAccountID(
		ctx,
		target.ProviderID,
		cliAccountID,
	)
	if err != nil {
		return "", fmt.Errorf("解析账号数字别名失败: %w", err)
	}
	if !account.IsValid() ||
		account.ProviderID() != target.ProviderID ||
		account.CLIAccountID() != cliAccountID {
		return "", ErrInvalidShowRequest
	}
	return account.Ref(), nil
}
