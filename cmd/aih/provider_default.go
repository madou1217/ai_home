package main

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// runProviderDefaultCommand 执行 set-default / unset-default。
func runProviderDefaultCommand(
	ctx context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) error {
	if len(arguments) == 0 {
		writeProviderDefaultUsage(runtime.stderr, providerID)
		return fmt.Errorf("%w: 缺少 set-default / unset-default", errInvalidCommand)
	}
	for _, argument := range arguments {
		if isRootHelp(argument) {
			writeProviderDefaultUsage(runtime.stdout, providerID)
			return nil
		}
	}
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	switch arguments[0] {
	case "set-default":
		restart := false
		positional := make([]string, 0, 1)
		for _, argument := range arguments[1:] {
			switch argument {
			case "--restart-client", "--force-quit-client":
				restart = true
			default:
				positional = append(positional, argument)
			}
		}
		if len(positional) != 1 {
			writeProviderDefaultUsage(runtime.stderr, providerID)
			return fmt.Errorf("%w: set-default 需要一个账号 ID", errInvalidCommand)
		}
		accountID := strings.TrimSpace(positional[0])
		if _, parseErr := strconv.ParseUint(accountID, 10, 64); parseErr != nil {
			writeProviderDefaultUsage(runtime.stderr, providerID)
			return fmt.Errorf("%w: 账号 ID 必须是正整数", errInvalidCommand)
		}
		view, resolveErr := resolveProviderAccountView(ctx, providerID, accountID, runtime)
		if resolveErr != nil {
			return fmt.Errorf("解析默认账号目标失败: %w", resolveErr)
		}
		snapshot, setErr := client.SetProviderDefault(ctx, providerID, view.AccountRef)
		if setErr != nil {
			return fmt.Errorf("设置默认账号失败: %w", setErr)
		}
		_, _ = fmt.Fprintf(runtime.stdout, "已设置 %s 默认账号: %s\n", providerID, snapshot.AccountRef)
		if restart {
			return runProviderRestart(ctx, providerID, accountID, runtime)
		}
		return nil
	case "unset-default":
		if len(arguments) != 1 {
			writeProviderDefaultUsage(runtime.stderr, providerID)
			return fmt.Errorf("%w: unset-default 不接受参数", errInvalidCommand)
		}
		if clearErr := client.ClearProviderDefault(ctx, providerID); clearErr != nil {
			return fmt.Errorf("清除默认账号失败: %w", clearErr)
		}
		_, _ = fmt.Fprintf(runtime.stdout, "已清除 %s 默认账号\n", providerID)
		return nil
	default:
		writeProviderDefaultUsage(runtime.stderr, providerID)
		return fmt.Errorf("%w: 未知默认账号命令 %s", errInvalidCommand, arguments[0])
	}
}

func writeProviderDefaultUsage(output io.Writer, providerID string) {
	_, _ = fmt.Fprintf(output, "用法:\n  aih %s set-default <id> [--restart-client]\n  aih %s unset-default\n", providerID, providerID)
}
