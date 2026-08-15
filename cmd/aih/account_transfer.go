package main

import (
	"context"
	"fmt"
	"io"

	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
)

// runAccountTransfer 解析并执行标准单账号迁移命令。
func runAccountTransfer(
	ctx context.Context,
	arguments []string,
	runtime commandRuntime,
) error {
	if len(arguments) == 0 || isRootHelp(arguments[0]) || arguments[0] == "help" {
		writeAccountTransferUsage(runtime.stdout)
		return nil
	}
	switch arguments[0] {
	case "export":
		if len(arguments) == 2 && isRootHelp(arguments[1]) {
			writeAccountTransferExportUsage(runtime.stdout)
			return nil
		}
		options, err := parseTransferExportOptions(arguments[1:])
		if err != nil {
			writeAccountTransferExportUsage(runtime.stderr)
			return err
		}
		return runAccountTransferExport(ctx, options, runtime)
	case "import":
		if len(arguments) == 2 && isRootHelp(arguments[1]) {
			writeAccountTransferImportUsage(runtime.stdout)
			return nil
		}
		options, err := parseTransferImportOptions(arguments[1:])
		if err != nil {
			writeAccountTransferImportUsage(runtime.stderr)
			return err
		}
		return runAccountTransferImport(ctx, options, runtime)
	default:
		writeAccountTransferUsage(runtime.stderr)
		return fmt.Errorf("%w: 未知账号迁移子命令 %s", errInvalidCommand, arguments[0])
	}
}

// runAccountTransferExport 从目标 Server 下载并独占创建敏感导出文件。
func runAccountTransferExport(
	ctx context.Context,
	options transferExportOptions,
	runtime commandRuntime,
) error {
	if err := ensureExportPathAvailable(options.outputPath); err != nil {
		return err
	}
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	account, err := resolveManagementAccount(ctx, client, options.target)
	if err != nil {
		return fmt.Errorf("读取待导出 Server 账号失败: %w", err)
	}
	document, err := exportAccountDocument(ctx, client, account, options.format)
	if err != nil {
		return err
	}
	if err := writeSensitiveFile(options.outputPath, document); err != nil {
		return err
	}
	writeAccountTransferExportResult(runtime.stdout, account, options)
	return nil
}

// runAccountTransferImport 读取有界标准文件并交给目标 Server 导入或匹配。
func runAccountTransferImport(
	ctx context.Context,
	options transferImportOptions,
	runtime commandRuntime,
) error {
	document, err := readTransferInput(options.inputPath)
	if err != nil {
		return err
	}
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	result, err := client.ImportSub2API(ctx, document)
	if err != nil {
		return fmt.Errorf("导入 sub2api Server 账号失败: %w", err)
	}
	writeAccountTransferImportResult(
		runtime.stdout,
		result.Account,
		result.Created,
		options.inputPath,
	)
	return nil
}

// exportAccountDocument 把格式选择限制在两个明确的 Management API 资源。
func exportAccountDocument(
	ctx context.Context,
	client *managementapi.Client,
	account managementapi.AccountSnapshot,
	format accountTransferFormat,
) ([]byte, error) {
	switch format {
	case transferFormatSub2API:
		document, err := client.ExportSub2API(ctx, account.AccountRef)
		if err != nil {
			return nil, fmt.Errorf("导出 sub2api 账号失败: %w", err)
		}
		return document, nil
	case transferFormatCLIProxyAPI:
		document, err := client.ExportCLIProxyAPI(ctx, account.AccountRef)
		if err != nil {
			return nil, fmt.Errorf("导出 CLIProxyAPI auth-file 失败: %w", err)
		}
		return document, nil
	default:
		return nil, errInvalidCommand
	}
}

// writeAccountTransferExportResult 只输出公开身份、格式、路径和文件权限。
func writeAccountTransferExportResult(
	output io.Writer,
	account managementapi.AccountSnapshot,
	options transferExportOptions,
) {
	_, _ = fmt.Fprintln(output, "账号已导出。")
	writeAccountDetailField(output, "Provider", account.ProviderID)
	writeAccountDetailField(output, "账号别名", account.CLIAccountID.String())
	writeAccountDetailField(output, "AccountRef", account.AccountRef.String())
	writeAccountDetailField(output, "格式", string(options.format))
	writeAccountDetailField(output, "文件", options.outputPath)
	writeAccountDetailField(output, "权限", "0600")
}

// writeAccountTransferImportResult 只输出导入后的公开身份、结果语义和来源。
func writeAccountTransferImportResult(
	output io.Writer,
	account managementapi.AccountView,
	created bool,
	inputPath string,
) {
	if created {
		_, _ = fmt.Fprintln(output, "账号已导入。")
	} else {
		_, _ = fmt.Fprintln(output, "账号已匹配（未新建）。")
	}
	writeAccountDetailField(output, "Provider", account.ProviderID)
	writeAccountDetailField(output, "账号别名", account.CLIAccountID.String())
	writeAccountDetailField(output, "AccountRef", account.AccountRef.String())
	writeAccountDetailField(output, "格式", string(transferFormatSub2API))
	writeAccountDetailField(output, "来源", inputPath)
}

// writeAccountTransferUsage 说明两个迁移方向和不支持的有损路径。
func writeAccountTransferUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih account transfer export <target> --format <sub2api|cliproxyapi> --output <file>")
	_, _ = fmt.Fprintln(output, "  aih account transfer import --format sub2api --input <file>")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "说明:")
	_, _ = fmt.Fprintln(output, "  sub2api 支持单账号双向迁移；cliproxyapi 只导出官方 OAuth auth-file。")
	_, _ = fmt.Fprintln(output, "  凭据文件只写入显式路径，权限 0600，不输出到终端，也不覆盖已有文件。")
}

// writeAccountTransferExportUsage 说明导出格式和 API 资源。
func writeAccountTransferExportUsage(output io.Writer) {
	writeAccountTransferUsage(output)
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "API:")
	_, _ = fmt.Fprintln(output, "  GET /v1/management/accounts/{account_ref}/export")
	_, _ = fmt.Fprintln(output, "  GET /v1/management/accounts/{account_ref}/export/cliproxyapi")
}

// writeAccountTransferImportUsage 说明只接受标准单账号 sub2api-data 文档。
func writeAccountTransferImportUsage(output io.Writer) {
	writeAccountTransferUsage(output)
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "API:")
	_, _ = fmt.Fprintln(output, "  POST /v1/management/account-imports/sub2api")
}
