package main

import (
	"context"
	"fmt"
	"io"

	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// runAccountCredential 解析静态凭据子资源命令。
func runAccountCredential(
	ctx context.Context,
	arguments []string,
	runtime commandRuntime,
) error {
	if len(arguments) == 0 || isRootHelp(arguments[0]) || arguments[0] == "help" {
		writeAccountCredentialUsage(runtime.stdout)
		return nil
	}
	if arguments[0] == "update" && len(arguments) == 2 && isRootHelp(arguments[1]) {
		writeAccountCredentialUsage(runtime.stdout)
		return nil
	}
	if len(arguments) != 3 || arguments[0] != "update" || arguments[2] != "--from-env" {
		writeAccountCredentialUsage(runtime.stderr)
		return fmt.Errorf(
			"%w: credential update 需要 <account_ref|provider:id> --from-env",
			errInvalidCommand,
		)
	}
	target, err := aihaccount.ParseAccountTarget(arguments[1])
	if err != nil {
		writeAccountCredentialUsage(runtime.stderr)
		return fmt.Errorf("%w: 账号目标必须是 account_ref 或 provider:id", errInvalidCommand)
	}
	return runAccountCredentialUpdate(ctx, target, runtime)
}

// runAccountCredentialUpdate 读取目标 Provider 官方环境变量并原地更新静态凭据。
func runAccountCredentialUpdate(
	ctx context.Context,
	target aihaccount.AccountTarget,
	runtime commandRuntime,
) error {
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	account, err := resolveManagementAccount(ctx, client, target)
	if err != nil {
		return fmt.Errorf("读取待更新 Server 账号失败: %w", err)
	}
	input, err := staticCredentialFromEnvironment(account.ProviderID, runtime.lookupEnv)
	if err != nil {
		return err
	}
	updated, err := client.UpdateStaticCredential(ctx, account.AccountRef, input)
	if err != nil {
		return fmt.Errorf("更新 Server 静态凭据失败: %w", err)
	}
	writeAccountCredentialResult(runtime.stdout, updated, input.Kind)
	return nil
}

// writeAccountCredentialResult 只输出凭据类型和 Server 提交后的公开身份。
func writeAccountCredentialResult(
	output io.Writer,
	account managementapi.AccountSnapshot,
	kind string,
) {
	_, _ = fmt.Fprintln(output, "静态凭据已更新。")
	writeAccountDetailField(output, "Provider", account.ProviderID)
	writeAccountDetailField(output, "账号别名", account.CLIAccountID.String())
	writeAccountDetailField(output, "AccountRef", account.AccountRef.String())
	writeAccountDetailField(output, "凭据类型", kind)
	writeAccountDetailField(output, "用户状态", accountEnabledLabel(account.Enabled))
}

// writeAccountCredentialUsage 说明官方变量、原地更新语义和 OAuth 边界。
func writeAccountCredentialUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih account credential update <account_ref|provider:id> --from-env")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "行为:")
	_, _ = fmt.Fprintln(output, "  通过运行中的 Go Server 原地更新静态凭据，保持 AccountRef、数字别名、启停和默认关系。")
	_, _ = fmt.Fprintln(output, "  Server 提交新凭据后异步刷新模型，并清理旧 usage、runtime 与 cooldown 派生状态。")
	_, _ = fmt.Fprintln(output, "  OAuth 账号不支持本命令，必须使用 Provider 重新授权流程。终端不会输出凭据正文。")
	_, _ = fmt.Fprintln(output)
	writeStaticCredentialEnvironmentHelp(output)
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "API:")
	_, _ = fmt.Fprintln(output, "  PUT /v1/management/accounts/{account_ref}/credential")
}
