package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/madou1217/ai_home/internal/host/backupaccounts"
)

func runRootImport(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) == 0 || arguments[0] != "import" {
		return false, nil
	}
	dryRun := false
	files := make([]string, 0, len(arguments)-1)
	for _, token := range arguments[1:] {
		switch token {
		case "--dry-run":
			dryRun = true
		case "--help", "-h", "help":
			writeImportUsage(runtime.stdout)
			return true, nil
		default:
			if strings.HasPrefix(token, "-") {
				return true, fmt.Errorf("unknown option: %s", token)
			}
			files = append(files, token)
		}
	}
	if len(files) == 0 {
		return true, fmt.Errorf("aih import requires at least one file")
	}
	home, err := resolveAIHome(runtime)
	if err != nil {
		return true, err
	}
	summary := map[string]int{"total": 0, "created": 0, "updated": 0, "unchanged": 0, "invalid": 0, "failed": 0}
	failed := false
	for _, file := range files {
		raw, readErr := os.ReadFile(file)
		if readErr != nil {
			return true, readErr
		}
		var request backupaccounts.Request
		if json.Unmarshal([]byte(strings.TrimPrefix(string(raw), "\ufeff")), &request) != nil {
			return true, fmt.Errorf("invalid account document: %s", file)
		}
		result, importErr := backupaccounts.Import(ctx, home, request, dryRun)
		if importErr != nil {
			return true, importErr
		}
		for key, value := range result.Summary {
			summary[key] += value
		}
		if !result.OK {
			failed = true
		}
	}
	mode := "write"
	if dryRun {
		mode = "dry-run"
	}
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] import done (%s)\n", mode)
	_, _ = fmt.Fprintf(runtime.stdout, "  total: %d\n", summary["total"])
	_, _ = fmt.Fprintf(runtime.stdout, "  created: %d\n", summary["created"])
	_, _ = fmt.Fprintf(runtime.stdout, "  updated: %d\n", summary["updated"])
	_, _ = fmt.Fprintf(runtime.stdout, "  unchanged: %d\n", summary["unchanged"])
	_, _ = fmt.Fprintf(runtime.stdout, "  invalid: %d\n", summary["invalid"])
	_, _ = fmt.Fprintf(runtime.stdout, "  failed: %d\n", summary["failed"])
	if failed {
		return true, &cliExitError{code: 1}
	}
	return true, nil
}

func writeImportUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih import <文件.json...> [--dry-run]   # 导入账号（同身份更新、不重复）")
	_, _ = fmt.Fprintln(output, "  aih import --help                     # 显示本帮助")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "--dry-run 只报告将要发生的变更，不写账号库。")
}
