package main

import (
	"context"
	"fmt"
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
	if explicitRef == "" && explicitID != 0 {
		return explicitID, nil
	}
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return 0, err
	}
	accounts := make([]managementapi.AccountView, 0)
	afterRef := ""
	for page := 0; page < 10; page++ {
		result, listErr := client.ListAccounts(ctx, managementapi.ListOptions{
			AfterRef: afterRef,
			Limit:    200,
		})
		if listErr != nil {
			return 0, fmt.Errorf("读取 Server 账号列表失败: %w", listErr)
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
	if explicitRef != "" {
		for _, account := range accounts {
			if account.AccountRef == explicitRef {
				return account.CLIAccountID, nil
			}
		}
		return 0, fmt.Errorf(
			"%w: %s 没有账号 %s",
			errInvalidCommand,
			providerID,
			explicitRef,
		)
	}
	if len(accounts) == 0 {
		return 0, fmt.Errorf("%w: %s 没有可用账号", errInvalidCommand, providerID)
	}
	if snapshot, defaultErr := client.GetProviderDefault(ctx, providerID); defaultErr == nil {
		for _, account := range accounts {
			if account.AccountRef == snapshot.AccountRef {
				return account.CLIAccountID, nil
			}
		}
	}
	for _, account := range accounts {
		if account.Enabled {
			return account.CLIAccountID, nil
		}
	}
	return 0, fmt.Errorf("%w: %s 没有启用账号", errInvalidCommand, strings.TrimSpace(providerID))
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
