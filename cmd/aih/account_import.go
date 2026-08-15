package main

import (
	"context"
	"fmt"
	"io"

	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeartifact"
)

// accountImportResult 是命令输出所需的最小非敏感导入结果。
type accountImportResult struct {
	providerID   string
	cliAccountID int64
	accountRef   string
	email        string
	sources      []string
	created      bool
}

// runAccountImport 从本机官方 artifact 读取登录态并提交到当前目标 Server。
func runAccountImport(
	ctx context.Context,
	providerID string,
	runtime commandRuntime,
) error {
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	reader := nativeartifact.New(nativeartifact.Options{
		LookupEnv:   runtime.lookupEnv,
		UserHomeDir: runtime.userHomeDir,
	})
	artifacts, err := reader.Read(providerID)
	if err != nil {
		return err
	}
	defer clear(artifacts.Envelope)
	result, err := client.ImportNative(ctx, providerID, artifacts.Envelope)
	if err != nil {
		return fmt.Errorf("导入官方登录态到 Server 失败: %w", err)
	}
	writeImportResult(runtime.stdout, accountImportResult{
		providerID:   result.Account.ProviderID,
		cliAccountID: result.Account.CLIAccountID.Int64(),
		accountRef:   result.Account.AccountRef.String(),
		email:        result.Account.Email,
		sources:      append([]string(nil), artifacts.Sources...),
		created:      result.Created,
	})
	return nil
}

// writeImportResult 只输出公开账号信息，绝不回显任何凭据。
func writeImportResult(
	output io.Writer,
	result accountImportResult,
) {
	if result.created {
		_, _ = fmt.Fprintf(output, "已导入 %s 官方登录态:\n", result.providerID)
	} else {
		_, _ = fmt.Fprintf(
			output,
			"已更新 %s 官方登录态（未新建账号）:\n",
			result.providerID,
		)
	}
	_, _ = fmt.Fprintf(output, "  账号别名   %d\n", result.cliAccountID)
	_, _ = fmt.Fprintf(output, "  账号身份   %s\n", result.accountRef)
	if result.email != "" {
		_, _ = fmt.Fprintf(output, "  登录邮箱   %s\n", result.email)
	}
	for index, source := range result.sources {
		label := "  官方来源  "
		if index > 0 {
			label = "            "
		}
		_, _ = fmt.Fprintf(output, "%s %s\n", label, source)
	}
	_, _ = fmt.Fprintln(output, "  模型目录   Server 后台异步刷新（不阻塞账号导入）")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "后续用法:")
	_, _ = fmt.Fprintf(
		output,
		"  aih account models list %s:%d\n",
		result.providerID,
		result.cliAccountID,
	)
}

// writeAccountImportUsage 说明导入命令读取哪些官方文件以及会做什么。
func writeAccountImportUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih account import <codex|claude>")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "行为:")
	_, _ = fmt.Fprintln(output, "  从本机官方 CLI 读取 artifact，再提交到 AIH_SERVER_BASE_URL；首次导入分配数字别名，同身份导入原地更新。")
	_, _ = fmt.Fprintln(output, "  Server 提交账号后异步发现并物化模型目录；网络探测不阻塞账号导入。")
	_, _ = fmt.Fprintln(output, "  只读取官方 artifact，不修改官方登录态，也不创建任何 Provider 或账号级 HOME。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "官方来源:")
	_, _ = fmt.Fprintln(output, "  claude: macOS Keychain 与 $CLAUDE_CONFIG_DIR/.credentials.json 按完整性、同身份和更新时间仲裁，再与 .claude.json 的 oauthAccount 组合")
	_, _ = fmt.Fprintln(output, "  codex:  $CODEX_HOME/auth.json")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "环境变量:")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_BASE_URL（账号写入目标 Go Server，默认 http://127.0.0.1:9527）")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_MANAGEMENT_KEY（必填）")
	_, _ = fmt.Fprintln(output, "  CLAUDE_CONFIG_DIR / CODEX_HOME（官方 CLI 自己的配置目录）")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "示例:")
	_, _ = fmt.Fprintln(output, "  aih account import claude")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_BASE_URL=http://127.0.0.1:9527 aih account import claude")
}
