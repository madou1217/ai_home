package main

import (
	"context"
	"fmt"
	"io"

	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeartifact"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

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
	account, err := client.ImportNative(ctx, providerID, artifacts.Envelope)
	if err != nil {
		return fmt.Errorf("导入官方登录态到 Server 失败: %w", err)
	}
	models, err := client.ListAccountModels(ctx, account.AccountRef)
	if err != nil {
		return fmt.Errorf("读取 Server 账号模型目录失败: %w", err)
	}
	modelIDs := make([]string, 0, len(models.Models))
	for _, model := range models.Models {
		if model.Effective {
			modelIDs = append(modelIDs, model.ModelID)
		}
	}
	writeImportResult(runtime.stdout, aihaccount.ImportResult{
		ProviderID:   account.ProviderID,
		CLIAccountID: account.CLIAccountID.Int64(),
		AccountRef:   account.AccountRef.String(),
		Email:        account.Email,
		Models:       modelIDs,
		Sources:      append([]string(nil), artifacts.Sources...),
	})
	return nil
}

// writeImportResult 只输出公开账号信息，绝不回显任何凭据。
func writeImportResult(
	output io.Writer,
	result aihaccount.ImportResult,
) {
	_, _ = fmt.Fprintf(output, "已导入 %s 官方登录态:\n", result.ProviderID)
	_, _ = fmt.Fprintf(output, "  账号别名   %d\n", result.CLIAccountID)
	_, _ = fmt.Fprintf(output, "  账号身份   %s\n", result.AccountRef)
	if result.Email != "" {
		_, _ = fmt.Fprintf(output, "  登录邮箱   %s\n", result.Email)
	}
	for index, source := range result.Sources {
		label := "  官方来源  "
		if index > 0 {
			label = "            "
		}
		_, _ = fmt.Fprintf(output, "%s %s\n", label, source)
	}
	_, _ = fmt.Fprintf(output, "  可用模型   %d 个\n", len(result.Models))
	for _, modelID := range result.Models {
		_, _ = fmt.Fprintf(output, "             %s\n", modelID)
	}
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "后续用法:")
	_, _ = fmt.Fprintf(
		output,
		"  aih %s %d --model <上面列出的真实模型>\n",
		result.ProviderID,
		result.CLIAccountID,
	)
}

// writeAccountImportUsage 说明导入命令读取哪些官方文件以及会做什么。
func writeAccountImportUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih account import <codex|claude>")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "行为:")
	_, _ = fmt.Fprintln(output, "  从本机官方 CLI 读取 artifact，再提交到 AIH_SERVER_BASE_URL 注册账号并分配数字别名。")
	_, _ = fmt.Fprintln(output, "  Server 在导入事务中发现并物化一次真实模型目录；运行期不再实时查询目录。")
	_, _ = fmt.Fprintln(output, "  只读取官方 artifact，不修改官方登录态，也不创建任何 Provider 或账号级 HOME。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "官方来源:")
	_, _ = fmt.Fprintln(output, "  claude: macOS Keychain（优先）或 $CLAUDE_CONFIG_DIR/.credentials.json，以及 .claude.json 的 oauthAccount")
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
