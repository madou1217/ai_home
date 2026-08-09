package main

import (
	"context"
	"fmt"
	"io"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// runAccountSetEnabled 通过 Go Server 管理面提交账号启停和内存路由变化。
func runAccountSetEnabled(
	ctx context.Context,
	target aihaccount.AccountTarget,
	enabled bool,
	runtime commandRuntime,
) error {
	managementKey, found := runtime.lookupEnv("AIH_SERVER_MANAGEMENT_KEY")
	if !found || strings.TrimSpace(managementKey) == "" {
		return fmt.Errorf(
			"%w: enable/disable 需要 AIH_SERVER_MANAGEMENT_KEY",
			errInvalidCommand,
		)
	}
	client, err := managementapi.New(
		runtime.managementAPI,
		managementapi.Config{
			BaseURL: lookupOrDefault(
				runtime.lookupEnv,
				"AIH_SERVER_BASE_URL",
				defaultGatewayBaseURL,
			),
			ManagementKey: managementKey,
		},
	)
	if err != nil {
		return fmt.Errorf("初始化账号管理 API 失败: %w", err)
	}
	accountRef, err := resolveManagementAccountRef(ctx, client, target)
	if err != nil {
		return fmt.Errorf("解析 Server 账号目标失败: %w", err)
	}
	result, err := client.SetEnabled(ctx, accountRef, enabled)
	if err != nil {
		return fmt.Errorf("更新 Server 账号状态失败: %w", err)
	}
	writeAccountStateResult(runtime.stdout, result)
	return nil
}

// resolveManagementAccountRef 保持 AccountRef 直达，数字别名只在目标 Server 解析。
func resolveManagementAccountRef(
	ctx context.Context,
	client *managementapi.Client,
	target aihaccount.AccountTarget,
) (accountcore.AccountRef, error) {
	if target.AccountRef != "" {
		return accountcore.ParseAccountRef(target.AccountRef)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(target.CLIAccountID)
	if err != nil {
		return "", err
	}
	result, err := client.ResolveAlias(ctx, target.ProviderID, cliAccountID)
	if err != nil {
		return "", err
	}
	return result.AccountRef, nil
}

// writeAccountStateResult 输出 Server 已提交的最小无敏感账号状态。
func writeAccountStateResult(
	output io.Writer,
	result managementapi.AccountSnapshot,
) {
	if result.Enabled {
		_, _ = fmt.Fprintln(output, "账号已启用。")
	} else {
		_, _ = fmt.Fprintln(output, "账号已停用。")
	}
	writeAccountDetailField(output, "Provider", result.ProviderID)
	writeAccountDetailField(output, "账号别名", result.CLIAccountID.String())
	writeAccountDetailField(output, "AccountRef", result.AccountRef.String())
	writeAccountDetailField(output, "用户状态", accountEnabledLabel(result.Enabled))
	writeAccountDetailField(output, "更新时间", accountTimeLabel(result.UpdatedAt))
}

// writeAccountStateUsage 说明启停命令必须和运行中 Server 共用一个账号事实。
func writeAccountStateUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih account enable <account_ref|provider:id>")
	_, _ = fmt.Fprintln(output, "  aih account disable <account_ref|provider:id>")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "行为:")
	_, _ = fmt.Fprintln(output, "  通过运行中的 Go Server Management API 原子更新 accounts.enabled。")
	_, _ = fmt.Fprintln(output, "  Server 在同一进程立即维护账号模型正排、倒排和 /v1/models 快照。")
	_, _ = fmt.Fprintln(output, "  重复 enable/disable 是幂等操作；不访问 Provider、不读取或输出凭据正文。")
	_, _ = fmt.Fprintln(output, "  provider:id 由目标 Server 解析，不使用本地数据库猜测远程账号身份。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "环境变量:")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_BASE_URL（默认 http://127.0.0.1:9527）")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_MANAGEMENT_KEY（必填）")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "API:")
	_, _ = fmt.Fprintln(output, "  GET   /v1/management/account-aliases/{provider}/{id}")
	_, _ = fmt.Fprintln(output, "  PATCH /v1/management/accounts/{account_ref}  {\"enabled\":true|false}")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "示例:")
	_, _ = fmt.Fprintln(output, "  aih account disable claude:1")
	_, _ = fmt.Fprintln(output, "  aih account enable acct_0123456789abcdef0123")
}
