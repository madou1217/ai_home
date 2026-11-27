package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// isDesktopUnsupportedVerb 判断参数是否是桌面端无法执行的 CLI 动词。
func isDesktopUnsupportedVerb(token string) bool {
	switch strings.ToLower(strings.TrimSpace(token)) {
	case "relay", "resume", "fork":
		return true
	default:
		return false
	}
}

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

// stripDesktopFlag 摘掉启动位上的 --desktop；显式 `--` 之后保持原样交给原生 CLI。
func stripDesktopFlag(arguments []string) ([]string, bool) {
	result := make([]string, 0, len(arguments))
	wantDesktop := false
	for index := 0; index < len(arguments); index++ {
		text := strings.TrimSpace(arguments[index])
		if text == "--" {
			result = append(result, arguments[index:]...)
			break
		}
		if text == "--desktop" {
			wantDesktop = true
			continue
		}
		result = append(result, arguments[index])
	}
	return result, wantDesktop
}

// providerHasDesktopClient 报告 Provider 是否声明了桌面客户端。
func providerHasDesktopClient(providerID string) bool {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil || catalog == nil {
		return false
	}
	definition, found := catalog.Get(strings.ToLower(strings.TrimSpace(providerID)))
	return found && definition.Clients.Desktop
}

// isInstallRequiredError 识别 Management API 的 428 install_required。
// 走类型化 RemoteError，避免错误正文里恰好出现 "428" 时被误判。
func isInstallRequiredError(err error) bool {
	var remote managementapi.RemoteError
	if errors.As(err, &remote) {
		return remote.StatusCode == http.StatusPreconditionRequired
	}
	return false
}

// runDesktopOnlyProviderLaunch 处理桌面端启动（workbuddy 这类无 CLI 的 Provider，
// 以及带 --desktop 的普通 Provider）：账号投影与启动由本机 Management API 的 open-app 完成。
// 同一账号重复启动由 Server 的 already_running 单例判定兜底。
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
		if isDesktopUnsupportedVerb(text) {
			return fmt.Errorf("%w: %s 的桌面端启动只接受账号，不支持 %s；去掉 --desktop 用 CLI 启动", errInvalidCommand, providerID, text)
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
		// 428 = install_required：桌面端没装或不可启动，属于可修复前置条件。
		if isInstallRequiredError(err) {
			_, _ = fmt.Fprintf(runtime.stdout, "[aih] 未找到 %s 桌面端；请先安装或手动打开一次，或去掉 --desktop 用 CLI。\n", providerID)
			return nil
		}
		return fmt.Errorf("启动 %s 桌面端失败: %w", providerID, err)
	}
	switch {
	case result.OK && result.Status == "already_running":
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] %s 桌面端已在运行（账号 #%s），未重复启动。\n", providerID, view.CLIAccountID.String())
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
