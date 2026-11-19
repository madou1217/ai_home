package main

import (
	"context"
	"fmt"
)

// runSummaryAlias exposes the usage stats report as the top-level "aih summary".
func runSummaryAlias(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) == 0 || arguments[0] != "summary" {
		return false, nil
	}
	if len(arguments) > 1 {
		switch arguments[1] {
		case "--help", "-h", "help":
			_, _ = fmt.Fprintln(runtime.stdout, "aih summary — 模型用量总览（等价 aih usage stats）")
			_, _ = fmt.Fprintln(runtime.stdout, "用法: aih summary [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--provider P] [--model M] [--json] [--no-scan]")
			return true, nil
		}
	}
	return runUsage(ctx, append([]string{"usage", "stats"}, arguments[1:]...), runtime)
}
