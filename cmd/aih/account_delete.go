package main

import (
	"context"
	"fmt"
	"io"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// runAccountDelete 通过目标 Go Server 删除账号及其持久化和内存从属状态。
func runAccountDelete(
	ctx context.Context,
	target aihaccount.AccountTarget,
	runtime commandRuntime,
) error {
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	snapshot, err := resolveManagementAccount(ctx, client, target)
	if err != nil {
		return fmt.Errorf("读取待删除 Server 账号失败: %w", err)
	}
	if err := client.DeleteAccount(ctx, snapshot.AccountRef); err != nil {
		return fmt.Errorf("删除 Server 账号失败: %w", err)
	}
	writeAccountDeleteResult(runtime.stdout, snapshot)
	return nil
}

// resolveManagementAccount 返回目标 Server 的公开账号快照，避免删除后猜测身份。
func resolveManagementAccount(
	ctx context.Context,
	client *managementapi.Client,
	target aihaccount.AccountTarget,
) (managementapi.AccountSnapshot, error) {
	if target.AccountRef != "" {
		accountRef, err := accountcore.ParseAccountRef(target.AccountRef)
		if err != nil {
			return managementapi.AccountSnapshot{}, err
		}
		return client.GetAccount(ctx, accountRef)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(target.CLIAccountID)
	if err != nil {
		return managementapi.AccountSnapshot{}, err
	}
	return client.ResolveAlias(ctx, target.ProviderID, cliAccountID)
}

// writeAccountDeleteResult 只显示删除前已从 Server 核实的公开身份。
func writeAccountDeleteResult(
	output io.Writer,
	snapshot managementapi.AccountSnapshot,
) {
	_, _ = fmt.Fprintln(output, "账号已删除。")
	writeAccountDetailField(output, "Provider", snapshot.ProviderID)
	writeAccountDetailField(output, "账号别名", snapshot.CLIAccountID.String())
	writeAccountDetailField(output, "AccountRef", snapshot.AccountRef.String())
}

// writeAccountDeleteUsage 说明不可恢复边界与显式确认要求。
func writeAccountDeleteUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih account delete <account_ref|provider:id> --yes")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "行为:")
	_, _ = fmt.Fprintln(output, "  通过运行中的 Go Server 删除账号、凭据、资料、模型、额度和默认关系。")
	_, _ = fmt.Fprintln(output, "  Server 同时遗忘该账号的额度刷新任务、运行状态和路由候选。")
	_, _ = fmt.Fprintln(output, "  删除不可恢复，必须显式提供 --yes；命令不会访问 Provider 或输出凭据正文。")
	_, _ = fmt.Fprintln(output, "  provider:id 由目标 Server 解析，不使用本地数据库猜测远程账号身份。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "环境变量:")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_BASE_URL（默认 http://127.0.0.1:9527）")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_MANAGEMENT_KEY（必填）")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "API:")
	_, _ = fmt.Fprintln(output, "  GET    /v1/management/account-aliases/{provider}/{id}")
	_, _ = fmt.Fprintln(output, "  GET    /v1/management/accounts/{account_ref}")
	_, _ = fmt.Fprintln(output, "  DELETE /v1/management/accounts/{account_ref}（204，无响应体）")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "示例:")
	_, _ = fmt.Fprintln(output, "  aih account delete claude:1 --yes")
	_, _ = fmt.Fprintln(output, "  aih account delete acct_0123456789abcdef0123 --yes")
}
