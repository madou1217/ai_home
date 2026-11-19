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
	return true, executeImport(ctx, "", arguments[1:], runtime)
}

// runProviderImport \u5904\u7406 `aih <provider> import <file...>`\uff0c\u53ea\u5bfc\u5165\u8be5 Provider \u7684\u6761\u76ee\u3002
func runProviderImport(ctx context.Context, providerID string, arguments []string, runtime commandRuntime) error {
	return executeImport(ctx, providerID, arguments, runtime)
}

func executeImport(ctx context.Context, providerID string, arguments []string, runtime commandRuntime) error {
	dryRun := false
	files := make([]string, 0, len(arguments))
	for _, token := range arguments {
		switch token {
		case "--dry-run":
			dryRun = true
		case "--help", "-h", "help":
			writeImportUsage(runtime.stdout)
			return nil
		default:
			if strings.HasPrefix(token, "-") {
				return fmt.Errorf("unknown option: %s", token)
			}
			files = append(files, token)
		}
	}
	if len(files) == 0 {
		return fmt.Errorf("aih import requires at least one file")
	}
	home, err := resolveAIHome(runtime)
	if err != nil {
		return err
	}
	provider := strings.ToLower(strings.TrimSpace(providerID))
	summary := map[string]int{"total": 0, "created": 0, "updated": 0, "unchanged": 0, "invalid": 0, "failed": 0}
	failed := false
	for _, file := range files {
		raw, readErr := os.ReadFile(file)
		if readErr != nil {
			return readErr
		}
		var request backupaccounts.Request
		if json.Unmarshal([]byte(strings.TrimPrefix(string(raw), "\ufeff")), &request) != nil {
			return fmt.Errorf("invalid account document: %s", file)
		}
		if provider != "" {
			filtered := request.Accounts[:0]
			for _, entry := range request.Accounts {
				if strings.EqualFold(strings.TrimSpace(entry.Provider), provider) {
					filtered = append(filtered, entry)
				}
			}
			request.Accounts = filtered
		}
		result, importErr := backupaccounts.Import(ctx, home, request, dryRun)
		if importErr != nil {
			return importErr
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
		return &cliExitError{code: 1}
	}
	return nil
}

func writeImportUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih import <文件.json...> [--dry-run]   # 导入账号（同身份更新、不重复）")
	_, _ = fmt.Fprintln(output, "  aih import --help                     # 显示本帮助")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "--dry-run 只报告将要发生的变更，不写账号库。")
}
