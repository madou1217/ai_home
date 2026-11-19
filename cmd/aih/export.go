package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/madou1217/ai_home/internal/host/backupaccounts"
)

func runRootExport(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) == 0 || arguments[0] != "export" {
		return false, nil
	}
	for _, argument := range arguments[1:] {
		if argument == "--help" || argument == "-h" || argument == "help" {
			writeExportUsage(runtime.stdout)
			return true, nil
		}
	}
	home, err := resolveAIHome(runtime)
	if err != nil {
		return true, err
	}
	directory, err := os.Getwd()
	if err != nil {
		return true, err
	}
	request := map[string]any{
		"version": 1, "tokens": arguments[1:], "provider": "", "directory": directory,
	}
	raw, err := json.Marshal(request)
	if err != nil {
		return true, err
	}
	result, err := backupaccounts.ExportPublic(ctx, home, raw)
	if err != nil {
		return true, err
	}
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] 已导出 %d 个账号 → %s\n", result.Exported, result.Path)
	for _, item := range result.Skipped {
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] 跳过 %s %s：没有凭据\n", item.Provider, item.AccountRef)
	}
	_, _ = fmt.Fprintln(runtime.stdout, "[aih] 文件包含明文凭据，请妥善保管。")
	if result.Exported == 0 {
		return true, &cliExitError{code: 1}
	}
	return true, nil
}

func writeExportUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih export [账号ID...] [文件.json]   # 导出账号与明文凭据")
	_, _ = fmt.Fprintln(output, "  aih export --help                  # 显示本帮助")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "不指定文件时导出到当前目录；文件含明文凭据，请妥善保管。")
}
