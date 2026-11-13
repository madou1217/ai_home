package main

import (
	"context"
	"fmt"
	"sort"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// errFamilyForkUnsupported 与 Node 统一动词拒绝文案保持一致：
// 家族 CLI 没有分叉入口，aih 不猜参数。
func errFamilyForkUnsupported(providerID string) error {
	return fmt.Errorf(
		"%s 未声明会话分叉入口，aih 不猜参数；需要分叉请用原生命令（aih %s --help）。",
		providerID,
		providerID,
	)
}

// rewriteFamilySessionVerb 把 `aih <family> [<账号>] resume|fork ...` 统一动词
// 翻译成官方 CLI 参数；handled=false 表示没有动词，调用方照常解析启动意图。
func rewriteFamilySessionVerb(
	ctx context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) ([]string, bool, error) {
	verbIndex := -1
	if len(arguments) >= 2 && isFamilySessionVerb(arguments[1]) {
		verbIndex = 1
	} else if len(arguments) >= 3 &&
		!strings.HasPrefix(arguments[1], "-") &&
		isFamilySessionVerb(arguments[2]) {
		verbIndex = 2
	}
	if verbIndex < 0 {
		return arguments, false, nil
	}
	verb := arguments[verbIndex]
	rest := arguments[verbIndex+1:]
	if verb == "fork" {
		return nil, true, errFamilyForkUnsupported(providerID)
	}
	target := ""
	if verbIndex == 2 {
		target = arguments[1]
	}
	accountID, err := resolveResumeAccountID(ctx, providerID, target, runtime)
	if err != nil {
		return nil, true, err
	}
	resumeArguments := []string{"--continue"}
	if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		resumeArguments = []string{"--resume", rest[0]}
		resumeArguments = append(resumeArguments, rest[1:]...)
	} else {
		resumeArguments = append(resumeArguments, rest...)
	}
	rewritten := append(
		[]string{providerID, fmt.Sprintf("%d", accountID.Int64())},
		resumeArguments...,
	)
	return rewritten, true, nil
}

// isFamilySessionVerb 只认家族 CLI 真实存在的统一动词。
func isFamilySessionVerb(value string) bool {
	return value == "resume" || value == "fork"
}

// resolveResumeAccountID 选择 resume 使用的账号：显式目标优先，其次 Provider
// 默认账号，最后取列表里第一个启用账号（与 Node resume 的当前账号语义一致）。
func resolveResumeAccountID(
	ctx context.Context,
	providerID string,
	target string,
	runtime commandRuntime,
) (accountcore.CLIAccountID, error) {
	explicitID, explicitRef, err := parseResumeAccountTarget(target)
	if err != nil {
		return 0, err
	}
	// 显式数字别名不需要再读账号列表：启动参数本来就只吃 CLI 别名。
	if explicitRef == "" && explicitID != 0 {
		return explicitID, nil
	}
	view, err := resolveProviderAccountView(ctx, providerID, target, runtime)
	if err != nil {
		return 0, err
	}
	return view.CLIAccountID, nil
}

// resolveProviderAccountView 是 resume/home 共用的账号解析：显式数字别名、
// AccountRef，或回退到 Provider 默认/首个启用账号。返回完整视图是为了同时拿到
// CLI 别名与 AccountRef（投影目录需要后者）。
func resolveProviderAccountView(
	ctx context.Context,
	providerID string,
	target string,
	runtime commandRuntime,
) (managementapi.AccountView, error) {
	explicitID, explicitRef, err := parseResumeAccountTarget(target)
	if err != nil {
		return managementapi.AccountView{}, err
	}
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return managementapi.AccountView{}, err
	}
	accounts, err := listProviderAccounts(ctx, client, providerID)
	if err != nil {
		return managementapi.AccountView{}, err
	}
	if explicitRef != "" {
		for _, account := range accounts {
			if account.AccountRef == explicitRef {
				return account, nil
			}
		}
		return managementapi.AccountView{}, fmt.Errorf(
			"%w: %s 没有账号 %s",
			errInvalidCommand,
			providerID,
			explicitRef,
		)
	}
	if explicitID != 0 {
		for _, account := range accounts {
			if account.CLIAccountID == explicitID {
				return account, nil
			}
		}
		return managementapi.AccountView{}, fmt.Errorf(
			"%w: %s 没有账号 #%d",
			errInvalidCommand,
			providerID,
			explicitID.Int64(),
		)
	}
	if len(accounts) == 0 {
		return managementapi.AccountView{}, fmt.Errorf("%w: %s 没有可用账号", errInvalidCommand, providerID)
	}
	if snapshot, defaultErr := client.GetProviderDefault(ctx, providerID); defaultErr == nil {
		for _, account := range accounts {
			if account.AccountRef == snapshot.AccountRef {
				return account, nil
			}
		}
	}
	for _, account := range accounts {
		if account.Enabled {
			return account, nil
		}
	}
	return managementapi.AccountView{}, fmt.Errorf(
		"%w: %s 没有启用账号",
		errInvalidCommand,
		strings.TrimSpace(providerID),
	)
}

// listProviderAccounts 分页读取该 Provider 的全部账号视图（按 CLI 别名升序）。
func listProviderAccounts(
	ctx context.Context,
	client *managementapi.Client,
	providerID string,
) ([]managementapi.AccountView, error) {
	accounts := make([]managementapi.AccountView, 0)
	afterRef := ""
	for page := 0; page < 10; page++ {
		result, err := client.ListAccounts(ctx, managementapi.ListOptions{
			AfterRef: afterRef,
			Limit:    200,
		})
		if err != nil {
			return nil, fmt.Errorf("读取 Server 账号列表失败: %w", err)
		}
		for _, account := range result.Accounts {
			if account.ProviderID == providerID {
				accounts = append(accounts, account)
			}
		}
		if !result.HasMore || result.NextAfterRef == "" {
			break
		}
		afterRef = result.NextAfterRef
	}
	sort.SliceStable(accounts, func(left, right int) bool {
		return accounts[left].CLIAccountID < accounts[right].CLIAccountID
	})
	return accounts, nil
}

// parseResumeAccountTarget 解析 `resume <账号>` 的账号位：数字 CLI 别名或
// AccountRef（provider:id 形式的前缀在 launch 参数里不适用，这里只认数字）。
func parseResumeAccountTarget(target string) (accountcore.CLIAccountID, accountcore.AccountRef, error) {
	text := strings.TrimSpace(target)
	if text == "" {
		return 0, "", nil
	}
	if cliAccountID, err := accountcore.ParseCLIAccountID(text); err == nil {
		return cliAccountID, "", nil
	}
	parsed, err := aihaccount.ParseAccountTarget(text)
	if err != nil {
		return 0, "", fmt.Errorf("%w: 账号目标无效: %s", errInvalidCommand, text)
	}
	if parsed.AccountRef != "" {
		accountRef, refErr := accountcore.ParseAccountRef(parsed.AccountRef)
		if refErr != nil {
			return 0, "", fmt.Errorf("%w: 账号目标无效: %s", errInvalidCommand, text)
		}
		return 0, accountRef, nil
	}
	cliAccountID, idErr := accountcore.NewCLIAccountID(parsed.CLIAccountID)
	if idErr != nil {
		return 0, "", fmt.Errorf("%w: 账号目标无效: %s", errInvalidCommand, text)
	}
	return cliAccountID, "", nil
}
