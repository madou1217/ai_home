package main

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"text/tabwriter"
	"time"

	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// runAccountUsage 解析离线查看和显式上游刷新子命令。
func runAccountUsage(
	ctx context.Context,
	arguments []string,
	runtime commandRuntime,
) error {
	if len(arguments) == 0 || isRootHelp(arguments[0]) || arguments[0] == "help" {
		writeAccountUsageUsage(runtime.stdout)
		return nil
	}
	command := arguments[0]
	if command != "show" && command != "refresh" {
		return fmt.Errorf("%w: 未知账号额度子命令 %s", errInvalidCommand, command)
	}
	if len(arguments) == 2 && isRootHelp(arguments[1]) {
		writeAccountUsageUsage(runtime.stdout)
		return nil
	}
	if len(arguments) != 2 {
		writeAccountUsageUsage(runtime.stderr)
		return fmt.Errorf("%w: usage %s 需要一个账号目标", errInvalidCommand, command)
	}
	target, err := aihaccount.ParseAccountTarget(arguments[1])
	if err != nil {
		writeAccountUsageUsage(runtime.stderr)
		return fmt.Errorf("%w: 账号目标必须是 account_ref 或 provider:id", errInvalidCommand)
	}
	return runAccountUsageCommand(ctx, command, target, runtime)
}

// runAccountUsageCommand 通过目标 Go Server 读取或刷新同一账号额度事实。
func runAccountUsageCommand(
	ctx context.Context,
	command string,
	target aihaccount.AccountTarget,
	runtime commandRuntime,
) error {
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	accountRef, err := resolveManagementAccountRef(ctx, client, target)
	if err != nil {
		return fmt.Errorf("解析 Server 账号目标失败: %w", err)
	}
	var result managementapi.UsageResult
	switch command {
	case "show":
		result, err = client.GetUsage(ctx, accountRef)
	case "refresh":
		result, err = client.RefreshUsage(ctx, accountRef)
	default:
		return fmt.Errorf("%w: 未知账号额度操作 %s", errInvalidCommand, command)
	}
	if err != nil {
		return fmt.Errorf("%s Server 账号额度失败: %w", accountUsageAction(command), err)
	}
	if command == "refresh" {
		_, _ = fmt.Fprintln(runtime.stdout, "额度刷新完成。")
	}
	writeAccountUsageResult(runtime.stdout, result)
	return nil
}

// accountUsageAction 返回适合错误上下文的中文动作。
func accountUsageAction(command string) string {
	if command == "refresh" {
		return "刷新"
	}
	return "读取"
}

// writeAccountUsageResult 输出完整额度维度，不把未知值伪造成零。
func writeAccountUsageResult(output io.Writer, result managementapi.UsageResult) {
	snapshot := result.Snapshot()
	_, _ = fmt.Fprintf(
		output,
		"账号额度（%s，provider=%s，source=%s，captured=%s，stale=%t）:\n",
		snapshot.AccountRef(),
		snapshot.ProviderID(),
		snapshot.Source(),
		accountTimeLabel(snapshot.CapturedAt()),
		result.Stale(),
	)
	writer := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(
		writer,
		"LIMIT\tBUCKET\tKIND\tSCOPE\tREMAINING\tAVAILABILITY\tWINDOW\tRESET_AT",
	)
	for _, entry := range snapshot.Entries() {
		_, _ = fmt.Fprintf(
			writer,
			"%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			accountUsageLimitLabel(entry),
			entry.Bucket(),
			entry.Kind(),
			accountUsageScopeLabel(entry),
			accountUsageRemainingLabel(entry),
			entry.Availability(),
			accountUsageWindowLabel(entry.WindowSeconds()),
			accountTimeLabel(entry.ResetAt()),
		)
	}
	_ = writer.Flush()
}

// accountUsageLimitLabel 优先展示稳定额度 ID，没有 ID 时展示 Provider 名称。
func accountUsageLimitLabel(entry usagecore.Entry) string {
	if entry.LimitID() != "" {
		return entry.LimitID()
	}
	if entry.LimitName() != "" {
		return entry.LimitName()
	}
	return "-"
}

// accountUsageScopeLabel 展示账号级或模型族级额度边界。
func accountUsageScopeLabel(entry usagecore.Entry) string {
	if entry.ScopeKey() == "" {
		return string(entry.Scope())
	}
	return string(entry.Scope()) + ":" + entry.ScopeKey()
}

// accountUsageRemainingLabel 用整数基点格式化百分比，避免重复乘以一百。
func accountUsageRemainingLabel(entry usagecore.Entry) string {
	remaining, known := entry.RemainingBasisPoints()
	if !known {
		return "unknown"
	}
	whole := remaining / 100
	fraction := remaining % 100
	switch {
	case fraction == 0:
		return strconv.FormatUint(uint64(whole), 10) + "%"
	case fraction%10 == 0:
		return fmt.Sprintf("%d.%d%%", whole, fraction/10)
	default:
		return fmt.Sprintf("%d.%02d%%", whole, fraction)
	}
}

// accountUsageWindowLabel 格式化 Provider 窗口长度；零表示未知。
func accountUsageWindowLabel(seconds int64) string {
	if seconds == 0 {
		return "-"
	}
	return (time.Duration(seconds) * time.Second).String()
}

// writeAccountUsageUsage 明确离线读取与真实 Provider 刷新的网络边界。
func writeAccountUsageUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih account usage show <account_ref|provider:id>")
	_, _ = fmt.Fprintln(output, "  aih account usage refresh <account_ref|provider:id>")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "行为:")
	_, _ = fmt.Fprintln(output, "  show    只读取 Go Server 最近一次成功快照，不访问 Provider。")
	_, _ = fmt.Fprintln(output, "  refresh 使用 Server 内当前规范凭据真实刷新，并保存 last-known-good 快照。")
	_, _ = fmt.Fprintln(output, "  provider:id 由目标 Server 解析；命令不打开本地数据库、不输出凭据正文。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "环境变量:")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_BASE_URL（默认 http://127.0.0.1:9527）")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_MANAGEMENT_KEY（必填）")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "API:")
	_, _ = fmt.Fprintln(output, "  GET  /v1/management/accounts/{account_ref}/usage")
	_, _ = fmt.Fprintln(output, "  POST /v1/management/accounts/{account_ref}/usage/refresh（无请求正文）")
}
