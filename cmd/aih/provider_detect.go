package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
)

// runProviderDetect 触发本机账号扫描（Go 原生检测器），打印与 WebUI 同源的统计。
func runProviderDetect(
	ctx context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) error {
	if len(arguments) != 0 {
		return fmt.Errorf("%w: 用法 aih %s detect", errInvalidCommand, providerID)
	}
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	result, err := client.DetectHostAccounts(ctx)
	if err != nil {
		return detectFailure(err)
	}
	if !result.OK {
		return fmt.Errorf("扫描本机账号失败")
	}
	_, _ = fmt.Fprintf(
		runtime.stdout,
		"[aih] 扫描本机已登录账号：%d 个来源，新增/更新 %d 个\n",
		result.Scanned,
		result.Updated,
	)
	if inventory := detectInventory(result.Accounts); inventory != "" {
		_, _ = fmt.Fprintf(runtime.stdout, "        已入库：%s\n", inventory)
	}
	if len(result.Skipped) > 0 {
		details := make([]string, 0, len(result.Skipped))
		for _, item := range result.Skipped {
			provider := item.Provider
			if provider == "" {
				provider = "?"
			}
			source := item.Source
			if source == "" {
				source = "?"
			}
			details = append(details, fmt.Sprintf("%s/%s:%s", provider, source, item.Reason))
		}
		_, _ = fmt.Fprintf(runtime.stdout, "        跳过：%s\n", strings.Join(details, "、"))
	}
	if result.Reloaded {
		_, _ = fmt.Fprintln(
			runtime.stdout,
			"        账号集合有变化：运行中的 server 会在下一轮同步（≤5s）自动重载账号池",
		)
	}
	return nil
}

// detectFailure 把运行中 Server 缺路由的 404 翻成可执行的提示：接口在源码里，
// 但已启动的 aih-server 可能还是旧二进制。
func detectFailure(err error) error {
	var remote managementapi.RemoteError
	if errors.As(err, &remote) && remote.StatusCode == http.StatusNotFound {
		return fmt.Errorf("扫描本机账号失败: 当前运行的 aih-server 没有账号扫描接口（版本过旧），重启 server 后再试")
	}
	return fmt.Errorf("扫描本机账号失败: %w", err)
}

// detectInventory 按 provider 名稳定排序，避免 map 迭代导致输出抖动。
func detectInventory(accounts map[string]int) string {
	if len(accounts) == 0 {
		return ""
	}
	providers := make([]string, 0, len(accounts))
	for provider, count := range accounts {
		if count > 0 {
			providers = append(providers, provider)
		}
	}
	sort.Strings(providers)
	parts := make([]string, 0, len(providers))
	for _, provider := range providers {
		parts = append(parts, fmt.Sprintf("%s %d", provider, accounts[provider]))
	}
	return strings.Join(parts, "、")
}
