package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// isDesktopAccountToken 判断参数是否是账号别名（数字或 acct_ 引用）。
func isDesktopAccountToken(text string) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return false
	}
	if isNumericAccountToken(trimmed) {
		return true
	}
	parsed, err := aihaccount.ParseAccountTarget(trimmed)
	return err == nil && parsed.AccountRef != ""
}

// runDesktopOnlyProviderLaunch 处理没有原生 CLI 的 Provider（workbuddy / workbuddycn）：
// 账号投影与桌面端启动由本机 Management API 的 open-app 完成，CLI 只解析账号。
func runDesktopOnlyProviderLaunch(ctx context.Context, providerID string, arguments []string, runtime commandRuntime) error {
	token := ""
	for _, argument := range arguments {
		text := strings.TrimSpace(argument)
		if text == "" {
			continue
		}
		if text == "--help" || text == "-h" || text == "help" {
			writeProviderUsage(runtime.stdout, providerID)
			return nil
		}
		if strings.HasPrefix(text, "-") {
			return fmt.Errorf("%w: %s 是桌面端，不支持参数 %s；用法: aih %s [<id>]", errInvalidCommand, providerID, text, providerID)
		}
		if token != "" {
			return fmt.Errorf("%w: 多余参数 %s；用法: aih %s [<id>]", errInvalidCommand, text, providerID)
		}
		token = text
	}
	view, err := resolveProviderAccountView(ctx, providerID, token, runtime)
	if err != nil {
		return err
	}
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	result, err := client.OpenApp(ctx, providerID, view.AccountRef.String(), "desktop", "open")
	if err != nil {
		return fmt.Errorf("启动 %s 桌面端失败: %w", providerID, err)
	}
	switch {
	case result.OK && (result.Status == "launched" || result.Status == "restarted" || result.Status == "focused"):
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] 已启动 %s 桌面端（账号 #%s）。\n", providerID, view.CLIAccountID.String())
	case result.InstallRequired:
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] 未找到 %s 桌面端；请先安装或手动打开一次。\n", providerID)
	default:
		reason := strings.TrimSpace(result.Reason)
		if reason == "" {
			reason = strings.TrimSpace(result.Error)
		}
		if reason == "" {
			reason = "unavailable"
		}
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] %s 桌面端未启动（%s）。\n", providerID, reason)
	}
	return nil
}
