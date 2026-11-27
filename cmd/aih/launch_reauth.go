package main

import (
	"bufio"
	"context"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/core/providers"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
)

// promptPinnedAccountReauth 在启动固定账号前检查 auth_invalid。
//
// 与 WebUI 的「需要重新登录后才能打开 CLI」保持同一语义：
//   - 交互终端：提示 [Y/n]；N 直接退出，Y 走官方登录流程，登录成功后继续启动；
//   - 非交互终端：明确失败，不带着失效 token 启动。
//
// 返回 proceed=false 表示用户取消或必须中止，调用方不得继续启动 CLI。
// 只处理固定账号；relay 账号池不在这里猜账号，交给网关调度。
func promptPinnedAccountReauth(
	ctx context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) (bool, error) {
	for _, argument := range arguments {
		if isRootHelp(argument) {
			return true, nil
		}
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return true, nil
	}
	intent, err := providerlaunch.ParseLaunchIntent(catalog, providerID, arguments)
	if err != nil || !intent.HasPinnedAccount() {
		return true, nil
	}
	accountProvider := strings.ToLower(strings.TrimSpace(intent.RelayProviderID()))
	if accountProvider == "" {
		accountProvider = strings.ToLower(strings.TrimSpace(providerID))
	}
	if !codebuddyfamilystorage.IsFamilyProvider(accountProvider) {
		return true, nil
	}
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return true, nil
	}
	snapshot, err := client.ResolveAlias(ctx, accountProvider, intent.CLIAccountID())
	if err != nil {
		return true, nil
	}
	accountRef := snapshot.AccountRef
	state, err := client.GetAccountRuntimeState(ctx, accountRef)
	if err != nil {
		return true, nil
	}
	status := strings.ToLower(strings.TrimSpace(state.Status))
	if status != "auth_invalid" && status != "token_expired" {
		return true, nil
	}
	reason := strings.TrimSpace(state.Reason)
	if reason == "" {
		reason = "登录态已失效"
	}
	accountID := intent.CLIAccountID().Int64()
	if !stdinIsTerminal(runtime.stdin) {
		return false, fmt.Errorf(
			"账号 #%d 登录态已失效（%s）；当前不是交互终端，未启动 CLI。请先运行 aih %s login",
			accountID,
			reason,
			accountProvider,
		)
	}
	_, _ = fmt.Fprintf(
		runtime.stderr,
		"[aih] 账号 #%d 登录态已失效：%s\n      现在重新登录？[Y/n] ",
		accountID,
		reason,
	)
	reader := bufio.NewReader(runtime.stdin)
	line, _ := reader.ReadString('\n')
	answer := strings.ToLower(strings.TrimSpace(line))
	if answer != "" && answer != "y" && answer != "yes" {
		_, _ = fmt.Fprintln(runtime.stderr, "已取消：未登录，未启动 CLI。")
		return false, nil
	}
	account, err := runProviderLoginAccount(ctx, accountProvider, nil, runtime)
	if err != nil {
		return false, err
	}
	if account.Ref() != accountRef {
		return false, fmt.Errorf(
			"登录的账号是 #%d（%s），不是 #%d（%s）；未启动 CLI。请用对应账号 ID 重新启动",
			account.CLIAccountID().Int64(),
			account.Ref(),
			accountID,
			accountRef,
		)
	}
	if err := client.ClearAccountRuntimeState(ctx, accountRef); err != nil {
		_, _ = fmt.Fprintf(runtime.stderr, "[aih] 登录成功，但清除认证失效状态失败：%v\n", err)
	}
	_, _ = fmt.Fprintln(runtime.stderr, "[aih] 登录完成，继续启动 CLI。")
	return true, nil
}
