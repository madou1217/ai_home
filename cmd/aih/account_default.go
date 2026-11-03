package main

import (
	"context"
	"fmt"
	"io"

	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// runAccountDefault 解析并执行 Provider 默认启动账号子命令。
func runAccountDefault(
	ctx context.Context,
	arguments []string,
	runtime commandRuntime,
) error {
	if len(arguments) == 0 || isRootHelp(arguments[0]) || arguments[0] == "help" {
		writeAccountDefaultUsage(runtime.stdout)
		return nil
	}
	if len(arguments) == 2 &&
		(arguments[0] == "show" || arguments[0] == "set" || arguments[0] == "clear") &&
		isRootHelp(arguments[1]) {
		writeAccountDefaultUsage(runtime.stdout)
		return nil
	}
	switch arguments[0] {
	case "show":
		if len(arguments) != 2 || !isCLIProvider(arguments[1]) {
			return invalidAccountDefaultCommand(runtime.stderr)
		}
		return runAccountDefaultShow(ctx, arguments[1], runtime)
	case "set":
		return runAccountDefaultSetCommand(ctx, arguments[1:], runtime)
	case "clear":
		if len(arguments) != 2 || !isCLIProvider(arguments[1]) {
			return invalidAccountDefaultCommand(runtime.stderr)
		}
		return runAccountDefaultClear(ctx, arguments[1], runtime)
	default:
		return invalidAccountDefaultCommand(runtime.stderr)
	}
}

// runAccountDefaultSetCommand 校验 Provider 与显式账号目标归属后执行设置。
func runAccountDefaultSetCommand(
	ctx context.Context,
	arguments []string,
	runtime commandRuntime,
) error {
	if len(arguments) != 2 || !isCLIProvider(arguments[0]) {
		return invalidAccountDefaultCommand(runtime.stderr)
	}
	target, err := aihaccount.ParseAccountTarget(arguments[1])
	if err != nil || (target.ProviderID != "" && target.ProviderID != arguments[0]) {
		return invalidAccountDefaultCommand(runtime.stderr)
	}
	return runAccountDefaultSet(ctx, arguments[0], target, runtime)
}

// runAccountDefaultShow 读取目标 Server 当前默认关系。
func runAccountDefaultShow(
	ctx context.Context,
	providerID string,
	runtime commandRuntime,
) error {
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	result, err := client.GetProviderDefault(ctx, providerID)
	if err != nil {
		return fmt.Errorf("读取 Server 默认账号失败: %w", err)
	}
	writeAccountDefaultResult(runtime.stdout, "默认账号:", result)
	return nil
}

// runAccountDefaultSet 使用稳定 AccountRef 原子设置目标 Server 默认关系。
func runAccountDefaultSet(
	ctx context.Context,
	providerID string,
	target aihaccount.AccountTarget,
	runtime commandRuntime,
) error {
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	accountRef, err := resolveManagementAccountRef(ctx, client, target)
	if err != nil {
		return fmt.Errorf("解析 Server 默认账号目标失败: %w", err)
	}
	result, err := client.SetProviderDefault(ctx, providerID, accountRef)
	if err != nil {
		return fmt.Errorf("设置 Server 默认账号失败: %w", err)
	}
	writeAccountDefaultResult(runtime.stdout, "默认账号已设置。", result)
	return nil
}

// runAccountDefaultClear 幂等清除目标 Server 默认关系。
func runAccountDefaultClear(
	ctx context.Context,
	providerID string,
	runtime commandRuntime,
) error {
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	if err := client.ClearProviderDefault(ctx, providerID); err != nil {
		return fmt.Errorf("清除 Server 默认账号失败: %w", err)
	}
	_, _ = fmt.Fprintf(runtime.stdout, "%s 默认账号已清除。\n", providerID)
	return nil
}

// writeAccountDefaultResult 输出 Server 已提交的无敏感默认关系。
func writeAccountDefaultResult(
	output io.Writer,
	title string,
	result managementapi.ProviderDefaultSnapshot,
) {
	_, _ = fmt.Fprintln(output, title)
	writeAccountDetailField(output, "Provider", result.ProviderID)
	writeAccountDetailField(output, "AccountRef", result.AccountRef.String())
	writeAccountDetailField(output, "更新时间", accountTimeLabel(result.UpdatedAt))
}

// invalidAccountDefaultCommand 输出稳定帮助并返回根命令错误。
func invalidAccountDefaultCommand(output io.Writer) error {
	writeAccountDefaultUsage(output)
	return fmt.Errorf("%w: 默认账号命令参数无效", errInvalidCommand)
}

// writeAccountDefaultUsage 说明默认关系不参与 Gateway 公平征召。
func writeAccountDefaultUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih account default show <codex|claude>")
	_, _ = fmt.Fprintln(output, "  aih account default set <codex|claude> <account_ref|provider:id>")
	_, _ = fmt.Fprintln(output, "  aih account default clear <codex|claude>")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "行为:")
	_, _ = fmt.Fprintln(output, "  管理 Provider 默认启动账号，只影响未显式指定账号的启动选择。")
	_, _ = fmt.Fprintln(output, "  Gateway 账号池仍按模型公平征召，不读取该默认关系。")
	_, _ = fmt.Fprintln(output, "  停用、缺少凭据或 Provider 不匹配的账号不能设为默认账号。")
	_, _ = fmt.Fprintln(output, "  clear 幂等清除默认关系，不删除账号、模型、usage 或凭据。")
	_, _ = fmt.Fprintln(output, "  provider:id 由目标 Server 解析；CLI 不直接读写 SQLite。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "API:")
	_, _ = fmt.Fprintln(output, "  GET    /v1/management/account-defaults/{provider}")
	_, _ = fmt.Fprintln(output, "  PUT    /v1/management/account-defaults/{provider}  {\"account_ref\":\"acct_...\"}")
	_, _ = fmt.Fprintln(output, "  DELETE /v1/management/account-defaults/{provider}（204，无响应体）")
}
