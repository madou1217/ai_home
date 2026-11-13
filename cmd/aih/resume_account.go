package main

import (
	"context"
	"fmt"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
)

// resolveResumeAccountID 选择 resume 使用的账号：Provider 默认账号优先，
// 没有默认时取列表里第一个启用账号（与 Node resume 的当前账号语义一致）。
func resolveResumeAccountID(
	ctx context.Context,
	providerID string,
	runtime commandRuntime,
) (accountcore.CLIAccountID, error) {
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return 0, err
	}
	accounts := make([]managementapi.AccountView, 0)
	afterRef := ""
	for page := 0; page < 10; page++ {
		result, listErr := client.ListAccounts(ctx, managementapi.ListOptions{
			AfterRef: afterRef,
			Limit:    200,
		})
		if listErr != nil {
			return 0, fmt.Errorf("读取 Server 账号列表失败: %w", listErr)
		}
		for _, account := range result.Accounts {
			if account.ProviderID == providerID {
				accounts = append(accounts, account)
			}
		}
		if !result.HasMore || result.NextAfterRef == "" {
			break
		}
		afterRef = result.NextAfterRef
	}
	if len(accounts) == 0 {
		return 0, fmt.Errorf("%w: %s 没有可用账号", errInvalidCommand, providerID)
	}
	if snapshot, defaultErr := client.GetProviderDefault(ctx, providerID); defaultErr == nil {
		for _, account := range accounts {
			if account.AccountRef == snapshot.AccountRef {
				return account.CLIAccountID, nil
			}
		}
	}
	for _, account := range accounts {
		if account.Enabled {
			return account.CLIAccountID, nil
		}
	}
	return 0, fmt.Errorf("%w: %s 没有启用账号", errInvalidCommand, strings.TrimSpace(providerID))
}
