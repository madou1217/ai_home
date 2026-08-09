package main

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// accountCommandName 是账号管理根命令，不与任何官方 CLI Provider 名冲突。
const accountCommandName = "account"

// accountApplication 是账号管理命令依赖的最小 Host 端口。
type accountApplication interface {
	ImportOfficialLogin(
		ctx context.Context,
		providerID string,
	) (aihaccount.ImportResult, error)
	ListAccounts(
		ctx context.Context,
		options aihaccount.ListOptions,
	) (aihaccount.ListResult, error)
	ShowAccount(
		ctx context.Context,
		target aihaccount.AccountTarget,
	) (aihaccount.AccountView, error)
	ListAccountModels(
		ctx context.Context,
		target aihaccount.AccountTarget,
	) (aihaccount.AccountModelsResult, error)
	RefreshAccountModels(
		ctx context.Context,
		target aihaccount.AccountTarget,
	) (aihaccount.AccountModelsResult, error)
	SetAccountModelPolicy(
		ctx context.Context,
		command aihaccount.AccountModelPolicyCommand,
	) (aihaccount.AccountModelsResult, error)
	Close() error
}

// runAccount 解析并执行 aih account 子命令。
func runAccount(
	ctx context.Context,
	arguments []string,
	runtime commandRuntime,
) error {
	if len(arguments) == 0 || isRootHelp(arguments[0]) || arguments[0] == "help" {
		writeAccountUsage(runtime.stdout)
		return nil
	}
	switch arguments[0] {
	case "import":
		if len(arguments) == 2 && isRootHelp(arguments[1]) {
			writeAccountImportUsage(runtime.stdout)
			return nil
		}
		if len(arguments) != 2 || !isCLIProvider(arguments[1]) {
			writeAccountImportUsage(runtime.stderr)
			return fmt.Errorf("%w: import 需要一个 Provider（codex 或 claude）", errInvalidCommand)
		}
		return runAccountImport(ctx, arguments[1], runtime)
	case "list":
		if len(arguments) == 2 && isRootHelp(arguments[1]) {
			writeAccountListUsage(runtime.stdout)
			return nil
		}
		options, err := parseAccountListOptions(arguments[1:])
		if err != nil {
			writeAccountListUsage(runtime.stderr)
			return err
		}
		return runAccountList(ctx, options, runtime)
	case "show":
		if len(arguments) == 2 && isRootHelp(arguments[1]) {
			writeAccountShowUsage(runtime.stdout)
			return nil
		}
		if len(arguments) != 2 {
			writeAccountShowUsage(runtime.stderr)
			return fmt.Errorf("%w: show 需要一个账号目标", errInvalidCommand)
		}
		target, err := aihaccount.ParseAccountTarget(arguments[1])
		if err != nil {
			writeAccountShowUsage(runtime.stderr)
			return fmt.Errorf("%w: 账号目标必须是 account_ref 或 provider:id", errInvalidCommand)
		}
		return runAccountShow(ctx, target, runtime)
	case "enable", "disable":
		if len(arguments) == 2 && isRootHelp(arguments[1]) {
			writeAccountStateUsage(runtime.stdout)
			return nil
		}
		if len(arguments) != 2 {
			writeAccountStateUsage(runtime.stderr)
			return fmt.Errorf("%w: %s 需要一个账号目标", errInvalidCommand, arguments[0])
		}
		target, err := aihaccount.ParseAccountTarget(arguments[1])
		if err != nil {
			writeAccountStateUsage(runtime.stderr)
			return fmt.Errorf("%w: 账号目标必须是 account_ref 或 provider:id", errInvalidCommand)
		}
		return runAccountSetEnabled(ctx, target, arguments[0] == "enable", runtime)
	case "models":
		return runAccountModels(ctx, arguments[1:], runtime)
	default:
		return fmt.Errorf("%w: 未知账号子命令 %s", errInvalidCommand, arguments[0])
	}
}

// writeAccountUsage 说明当前已实现的账号管理命令。
func writeAccountUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih account list [--limit N] [--after account_ref] # 分页列出公开账号信息")
	_, _ = fmt.Fprintln(output, "  aih account show <account_ref|provider:id>          # 查看一个公开账号详情")
	_, _ = fmt.Fprintln(output, "  aih account enable <account_ref|provider:id>        # 启用账号并加入 Server 路由")
	_, _ = fmt.Fprintln(output, "  aih account disable <account_ref|provider:id>       # 停用账号并移出 Server 路由")
	_, _ = fmt.Fprintln(output, "  aih account models list <account_ref|provider:id>   # 查看已物化账号模型")
	_, _ = fmt.Fprintln(output, "  aih account models refresh <account_ref|provider:id> # 刷新账号模型目录")
	_, _ = fmt.Fprintln(output, "  aih account models set-policy <target> <model> <policy> # 设置人工模型策略")
	_, _ = fmt.Fprintln(output, "  aih account import <codex|claude>   # 导入该 Provider 官方 CLI 当前登录态")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "查看子命令说明:")
	_, _ = fmt.Fprintln(output, "  aih account list --help")
	_, _ = fmt.Fprintln(output, "  aih account show --help")
	_, _ = fmt.Fprintln(output, "  aih account enable --help")
	_, _ = fmt.Fprintln(output, "  aih account models --help")
	_, _ = fmt.Fprintln(output, "  aih account import --help")
}

// accountUsageLine 供根帮助复用，保持两处命令描述一致。
func accountUsageLine() string {
	return strings.TrimSpace(
		"aih account <list|show|enable|disable|models|import> [args...] # Go 账号管理",
	)
}
