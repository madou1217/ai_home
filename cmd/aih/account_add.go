package main

import (
	"context"
	"fmt"
	"io"

	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
)

// runAccountAdd 从官方环境变量读取静态凭据并注册到目标 Go Server。
func runAccountAdd(
	ctx context.Context,
	providerID string,
	runtime commandRuntime,
) error {
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	credential, err := staticCredentialFromEnvironment(providerID, runtime.lookupEnv)
	if err != nil {
		return err
	}
	account, err := client.CreateStaticAccount(ctx, providerID, credential)
	if err != nil {
		return fmt.Errorf("添加 Server 静态账号失败: %w", err)
	}
	writeAccountAddResult(runtime.stdout, account, credential.Kind)
	return nil
}

// writeAccountAddResult 只输出 Server 已提交的公开身份和异步模型语义。
func writeAccountAddResult(
	output io.Writer,
	account managementapi.AccountSnapshot,
	authKind string,
) {
	_, _ = fmt.Fprintln(output, "静态账号已添加。")
	writeAccountDetailField(output, "Provider", account.ProviderID)
	writeAccountDetailField(output, "账号别名", account.CLIAccountID.String())
	writeAccountDetailField(output, "AccountRef", account.AccountRef.String())
	writeAccountDetailField(output, "凭据类型", authKind)
	writeAccountDetailField(output, "用户状态", accountEnabledLabel(account.Enabled))
	writeAccountDetailField(output, "模型目录", "Server 后台异步刷新（不阻塞账号创建）")
}

// writeAccountAddUsage 说明静态账号创建的输入、异步边界和 HTTP 合同。
func writeAccountAddUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih account add <codex|claude> --from-env")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "行为:")
	_, _ = fmt.Fprintln(output, "  从官方环境变量读取静态凭据，通过目标 Go Server 原子写入账号与凭据。")
	_, _ = fmt.Fprintln(output, "  创建成功立即返回；模型目录由 Server 在提交后异步刷新，不阻塞本命令。")
	_, _ = fmt.Fprintln(output, "  OAuth 登录态请使用 account import 或 Server OAuth 流程；终端不会输出凭据正文。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "Provider 官方环境变量:")
	_, _ = fmt.Fprintln(output, "  codex:  OPENAI_API_KEY，OPENAI_BASE_URL（可选）")
	_, _ = fmt.Fprintln(output, "  claude: ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN（二选一），ANTHROPIC_BASE_URL（可选）")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "Server 环境变量:")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_BASE_URL（默认 http://127.0.0.1:9527）")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_MANAGEMENT_KEY（必填）")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "API:")
	_, _ = fmt.Fprintln(output, "  POST /v1/management/accounts")
	_, _ = fmt.Fprintln(output, `  {"provider_id":"claude","auth":{"kind":"auth_token","auth_token":"<redacted>","base_url":"..."}}`)
}
