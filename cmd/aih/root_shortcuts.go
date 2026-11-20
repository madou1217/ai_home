package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

// 根命令的两个兼容入口都来自旧 Node 路由，现在由 Go 直接承担：
//
//	aih <数字> …       数字是某个 Provider 内的 CLI 账号编号；恰好只在一个
//	                   Provider 里存在时才可无歧义解释（与 Node resolveUniqueCliForAccountId 同语义）。
//	aih usage <数字>   同上，改写成该 Provider 的 usage。
//
// 不能按「第一个匹配」去猜：同一个数字在多个 Provider 里都存在时，猜错就是
// 给别人的账号起会话。

// isNumericToken 判断 token 是否为纯数字（账号编号只认十进制）。
func isNumericToken(value string) bool {
	text := strings.TrimSpace(value)
	if text == "" {
		return false
	}
	for _, char := range text {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

// resolveUniqueProviderForCLIAccountID 返回某个 CLI 账号编号唯一归属的 Provider。
func resolveUniqueProviderForCLIAccountID(
	ctx context.Context,
	id string,
	runtime commandRuntime,
) (string, bool) {
	parsed, err := strconv.ParseInt(strings.TrimSpace(id), 10, 64)
	if err != nil || parsed <= 0 {
		return "", false
	}
	data, err := loadLSData(ctx, runtime, lsOptions{FilterID: parsed})
	if err != nil || data == nil {
		return "", false
	}
	providers := make(map[string]bool)
	for _, account := range data.Accounts {
		if account == nil || account.Account.CLIAccountID != parsed {
			continue
		}
		provider := strings.ToLower(strings.TrimSpace(account.Account.Provider))
		if provider != "" {
			providers[provider] = true
		}
	}
	if len(providers) != 1 {
		return "", false
	}
	for provider := range providers {
		return provider, true
	}
	return "", false
}

// runUnknownRootCommand 复刻旧入口的未知命令契约：黄色提示 + 根用法，
// 退出码固定 2（shell 集成据此把候选变成「确认后运行」）。
func runUnknownRootCommand(providerID string, runtime commandRuntime) error {
	_, _ = fmt.Fprintf(
		runtime.stdout,
		"\x1b[33m[aih] 未识别的命令 '%s'，以下是可用用法：\x1b[0m\n",
		providerID,
	)
	writeUsage(runtime.stdout)
	return cliExitCode{code: 2}
}
