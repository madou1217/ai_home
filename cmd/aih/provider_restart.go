package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

// runProviderRestart 实现 aih <family> <id> --restart-client [--force-quit-client]：
// 经 Management API 先 close 再 open 桌面应用（Go 桌面启动器接管后不再走 Node）。
func runProviderRestart(
	ctx context.Context,
	providerID string,
	accountToken string,
	runtime commandRuntime,
) error {
	id, err := strconv.ParseInt(strings.TrimSpace(accountToken), 10, 64)
	if err != nil || id <= 0 {
		return fmt.Errorf("%w: Invalid ID. Usage: aih %s <id> --restart-client", errInvalidCommand, providerID)
	}
	view, err := resolveProviderAccountView(ctx, providerID, accountToken, runtime)
	if err != nil {
		return err
	}
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	// 先尽力关闭；未运行时 close 返回 skipped 属于正常情况。
	_, _ = client.OpenApp(ctx, providerID, view.AccountRef.String(), "desktop", "close")
	result, err := client.OpenApp(ctx, providerID, view.AccountRef.String(), "desktop", "open")
	if err != nil {
		return fmt.Errorf("重启 %s 桌面端失败: %w", providerID, err)
	}
	switch {
	case result.OK && (result.Status == "launched" || result.Status == "restarted"):
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] Restarted local %s desktop client.\n", providerID)
	case result.InstallRequired:
		_, _ = fmt.Fprintf(
			runtime.stdout,
			"[aih] 未找到 %s 桌面端；先手动打开一次后重试 --restart-client。\n",
			providerID,
		)
	default:
		reason := strings.TrimSpace(result.Reason)
		if reason == "" {
			reason = strings.TrimSpace(result.Error)
		}
		if reason == "" {
			reason = "unavailable"
		}
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] Desktop client restart skipped (%s).\n", reason)
	}
	return nil
}
