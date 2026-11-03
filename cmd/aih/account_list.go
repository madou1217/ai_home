package main

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"text/tabwriter"

	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// parseAccountListOptions 严格解析唯一的 keyset 分页参数。
func parseAccountListOptions(arguments []string) (aihaccount.ListOptions, error) {
	options := aihaccount.ListOptions{}
	seenLimit := false
	seenAfter := false
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		if index+1 >= len(arguments) {
			return aihaccount.ListOptions{}, fmt.Errorf("%w: %s 缺少值", errInvalidCommand, argument)
		}
		value := arguments[index+1]
		index++
		switch argument {
		case "--limit":
			if seenLimit {
				return aihaccount.ListOptions{}, fmt.Errorf("%w: --limit 不能重复", errInvalidCommand)
			}
			limit, err := strconv.Atoi(value)
			if err != nil || limit < 1 || limit > aihaccount.MaxListLimit {
				return aihaccount.ListOptions{}, fmt.Errorf(
					"%w: --limit 必须在 1 到 %d 之间",
					errInvalidCommand,
					aihaccount.MaxListLimit,
				)
			}
			options.Limit = limit
			seenLimit = true
		case "--after":
			if seenAfter || value == "" {
				return aihaccount.ListOptions{}, fmt.Errorf("%w: --after 无效或重复", errInvalidCommand)
			}
			options.AfterRef = value
			seenAfter = true
		default:
			return aihaccount.ListOptions{}, fmt.Errorf("%w: 未知 list 参数 %s", errInvalidCommand, argument)
		}
	}
	return options, nil
}

// runAccountList 从当前目标 Server 读取一页公开账号投影。
func runAccountList(
	ctx context.Context,
	options aihaccount.ListOptions,
	runtime commandRuntime,
) error {
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	result, err := client.ListAccounts(ctx, managementapi.ListOptions{
		AfterRef: options.AfterRef,
		Limit:    options.Limit,
	})
	if err != nil {
		return fmt.Errorf("读取 Server 账号列表失败: %w", err)
	}
	writeAccountListResult(runtime.stdout, newHostAccountListResult(result))
	return nil
}

// writeAccountListResult 使用固定列输出无敏感账号信息和下一页命令。
func writeAccountListResult(output io.Writer, result aihaccount.ListResult) {
	if len(result.Accounts) == 0 {
		_, _ = fmt.Fprintln(output, "当前账号库没有账号。")
		return
	}
	_, _ = fmt.Fprintf(output, "账号列表（%d）:\n", len(result.Accounts))
	writer := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(writer, "PROVIDER\tID\tSTATUS\tAUTH\tPLAN\tACCOUNT_REF\tEMAIL")
	for _, account := range result.Accounts {
		_, _ = fmt.Fprintf(
			writer,
			"%s\t%d\t%s\t%s\t%s\t%s\t%s\n",
			account.ProviderID,
			account.CLIAccountID,
			accountEnabledLabel(account.Enabled),
			accountAuthLabel(account),
			accountSubscriptionLabel(account),
			account.AccountRef,
			account.Email,
		)
	}
	_ = writer.Flush()
	if result.HasMore {
		_, _ = fmt.Fprintln(output)
		_, _ = fmt.Fprintf(
			output,
			"下一页: aih account list --limit %d --after %s\n",
			result.Limit,
			result.NextAfterRef,
		)
	}
}

// writeAccountListUsage 说明账号列表的性能和数据安全边界。
func writeAccountListUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih account list [--limit N] [--after account_ref]")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "参数:")
	_, _ = fmt.Fprintf(output, "  --limit N            每页 1-%d 行，默认 %d\n", aihaccount.MaxListLimit, aihaccount.DefaultListLimit)
	_, _ = fmt.Fprintln(output, "  --after account_ref  从上一页最后一个稳定 AccountRef 之后继续")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "行为:")
	_, _ = fmt.Fprintln(output, "  通过 AIH_SERVER_BASE_URL 使用 AccountRef keyset 分页；不做 OFFSET 全表扫描。")
	_, _ = fmt.Fprintln(output, "  只读取目标 Server 的账号基础信息、认证类型和公开资料，不读取或输出凭据正文、usage、模型或运行态。")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_BASE_URL 默认 http://127.0.0.1:9527；AIH_SERVER_MANAGEMENT_KEY 必填。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "示例:")
	_, _ = fmt.Fprintln(output, "  aih account list")
	_, _ = fmt.Fprintln(output, "  aih account list --limit 100")
	_, _ = fmt.Fprintln(output, "  aih account list --limit 100 --after acct_0123456789abcdef0123")
}
