package main

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// runAccountImport 把 Provider 官方 CLI 当前登录态导入唯一业务数据库。
func runAccountImport(
	ctx context.Context,
	providerID string,
	runtime commandRuntime,
) error {
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	app, err := runtime.newAccountApp(ctx, aihaccount.Options{AIHomeDir: aiHomeDir})
	if err != nil {
		return fmt.Errorf("初始化账号管理失败: %w", err)
	}
	result, importErr := app.ImportOfficialLogin(ctx, providerID)
	closeErr := app.Close()
	if importErr != nil || closeErr != nil {
		return errors.Join(importErr, closeErr)
	}
	writeImportResult(runtime.stdout, aiHomeDir, result)
	return nil
}

// writeImportResult 只输出公开账号信息，绝不回显任何凭据。
func writeImportResult(
	output io.Writer,
	aiHomeDir string,
	result aihaccount.ImportResult,
) {
	_, _ = fmt.Fprintf(output, "已导入 %s 官方登录态:\n", result.ProviderID)
	_, _ = fmt.Fprintf(output, "  账号别名   %d\n", result.CLIAccountID)
	_, _ = fmt.Fprintf(output, "  账号身份   %s\n", result.AccountRef)
	if result.Email != "" {
		_, _ = fmt.Fprintf(output, "  登录邮箱   %s\n", result.Email)
	}
	_, _ = fmt.Fprintf(output, "  数据目录   %s\n", aiHomeDir)
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
	_, _ = fmt.Fprintln(output, "  读取该 Provider 官方 CLI 的当前登录 artifact，注册成一个 AIH 账号并分配数字别名。")
	_, _ = fmt.Fprintln(output, "  导入时向上游拉取一次该账号真实可用的模型目录并落库；运行期不再实时查询目录。")
	_, _ = fmt.Fprintln(output, "  只读取官方文件，不修改官方登录态，也不创建任何 Provider 或账号级 HOME。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "官方来源:")
	_, _ = fmt.Fprintln(output, "  claude: $CLAUDE_CONFIG_DIR/.credentials.json 与 .claude.json 的 oauthAccount")
	_, _ = fmt.Fprintln(output, "  codex:  $CODEX_HOME/auth.json")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "环境变量:")
	_, _ = fmt.Fprintln(output, "  AIH_HOME（账号写入该目录下的 aih.db，默认 ~/.ai_home）")
	_, _ = fmt.Fprintln(output, "  CLAUDE_CONFIG_DIR / CODEX_HOME（官方 CLI 自己的配置目录）")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "示例:")
	_, _ = fmt.Fprintln(output, "  aih account import claude")
	_, _ = fmt.Fprintln(output, "  AIH_HOME=/tmp/aih-verify aih account import claude")
}
