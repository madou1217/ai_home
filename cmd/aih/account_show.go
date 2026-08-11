package main

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"time"

	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// runAccountShow 从当前目标 Server 读取一个公开账号详情。
func runAccountShow(
	ctx context.Context,
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
	account, err := client.GetAccountView(ctx, accountRef)
	if err != nil {
		return fmt.Errorf("读取 Server 账号详情失败: %w", err)
	}
	writeAccountDetail(runtime.stdout, newHostAccountView(account))
	return nil
}

// writeAccountDetail 输出与 Management API 相同边界的无敏感账号详情。
func writeAccountDetail(output io.Writer, account aihaccount.AccountView) {
	_, _ = fmt.Fprintln(output, "账号详情:")
	writeAccountDetailField(output, "Provider", account.ProviderID)
	writeAccountDetailField(output, "账号别名", strconv.FormatInt(account.CLIAccountID, 10))
	writeAccountDetailField(output, "AccountRef", account.AccountRef)
	writeAccountDetailField(output, "用户状态", accountEnabledLabel(account.Enabled))
	writeAccountDetailField(output, "凭据状态", accountPresenceLabel(account.HasCredential))
	writeAccountDetailField(output, "认证类型", accountAuthLabel(account))
	writeAccountDetailField(output, "资料状态", accountPresenceLabel(account.HasProfile))
	writeAccountDetailField(output, "展示名称", accountOptionalLabel(account.DisplayName))
	writeAccountDetailField(output, "登录邮箱", accountOptionalLabel(account.Email))
	writeAccountDetailField(output, "订阅分类", accountSubscriptionLabel(account))
	writeAccountDetailField(output, "原始订阅", accountOptionalLabel(account.SubscriptionRaw))
	writeAccountDetailField(output, "资料更新时间", accountTimeLabel(account.ProfileUpdatedAt))
	writeAccountDetailField(output, "创建时间", accountTimeLabel(account.CreatedAt))
	writeAccountDetailField(output, "更新时间", accountTimeLabel(account.UpdatedAt))
}

// writeAccountDetailField 保持详情标签和值的稳定布局。
func writeAccountDetailField(output io.Writer, label string, value string) {
	_, _ = fmt.Fprintf(output, "  %s: %s\n", label, value)
}

// accountPresenceLabel 返回公开子资源是否存在，不推断其运行健康状态。
func accountPresenceLabel(present bool) string {
	if present {
		return "configured"
	}
	return "missing"
}

// accountOptionalLabel 为缺失的公开标量提供一致占位符。
func accountOptionalLabel(value string) string {
	if value == "" {
		return "-"
	}
	return value
}

// accountTimeLabel 使用稳定 UTC RFC3339 格式显示持久化时间。
func accountTimeLabel(value time.Time) string {
	if value.IsZero() {
		return "-"
	}
	return value.UTC().Format(time.RFC3339)
}

// writeAccountShowUsage 说明详情目标和无敏感读取边界。
func writeAccountShowUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih account show <account_ref|provider:id>")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "目标:")
	_, _ = fmt.Fprintln(output, "  acct_...   全链路稳定 AccountRef")
	_, _ = fmt.Fprintln(output, "  provider:id Provider 内数字别名，例如 claude:1 或 codex:2")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "行为:")
	_, _ = fmt.Fprintln(output, "  通过 AIH_SERVER_BASE_URL 返回基础账号、用户启停状态、认证类型、公开资料和时间戳。")
	_, _ = fmt.Fprintln(output, "  不读取或输出凭据正文、usage、模型或运行态；停用账号仍可查看。")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_MANAGEMENT_KEY 必填；AIH_HOME 不参与查询。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "示例:")
	_, _ = fmt.Fprintln(output, "  aih account show claude:1")
	_, _ = fmt.Fprintln(output, "  aih account show acct_0123456789abcdef0123")
}
