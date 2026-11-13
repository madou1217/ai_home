package main

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/host/aihaccount"
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
		if len(arguments) != 2 {
			writeProviderDefaultUsage(runtime.stderr, providerID)
			return fmt.Errorf("%w: set-default 需要一个账号 ID", errInvalidCommand)
		}
		accountID := strings.TrimSpace(arguments[1])
		if _, parseErr := strconv.ParseUint(accountID, 10, 64); parseErr != nil {
			writeProviderDefaultUsage(runtime.stderr, providerID)
			return fmt.Errorf("%w: 账号 ID 必须是正整数", errInvalidCommand)
		}
		target, parseErr := aihaccount.ParseAccountTarget(providerID + ":" + accountID)
		if parseErr != nil {
			return fmt.Errorf("%w: 账号目标无效", errInvalidCommand)
		}
		accountRef, resolveErr := resolveManagementAccountRef(ctx, client, target)
		if resolveErr != nil {
			return fmt.Errorf("解析默认账号目标失败: %w", resolveErr)
		}
		snapshot, setErr := client.SetProviderDefault(ctx, providerID, accountRef)
		if setErr != nil {
			return fmt.Errorf("设置默认账号失败: %w", setErr)
		}
		_, _ = fmt.Fprintf(runtime.stdout, "已设置 %s 默认账号: %s\n", providerID, snapshot.AccountRef)
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
	_, _ = fmt.Fprintf(output, "用法:\n  aih %s set-default <id>\n  aih %s unset-default\n", providerID, providerID)
}
