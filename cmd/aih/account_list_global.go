package main

import (
	"context"
	"fmt"
	"io"
	"strings"
)

// runGlobalAccountList 实现 aih ls [id] [--scope <provider...>]。
// 数据来自本机 aih.db 的只读投影，不依赖运行中的 Server。
// Provider 解析与 runRootLS 共用 resolveLSProviders：同一个选择器语义，
// 同一个"匹配不到就报错"的约定。
func runGlobalAccountList(ctx context.Context, arguments []string, runtime commandRuntime) error {
	parsed, err := parseLSArguments(arguments)
	if err != nil {
		return err
	}
	if parsed.Help {
		writeGlobalAccountListUsage(runtime.stdout)
		return nil
	}
	providers, explicit, err := resolveLSProviders(parsed)
	if err != nil {
		return err
	}
	return runLSList(ctx, runtime, lsOptions{
		Providers:        providers,
		FilterID:         parsed.FilterID,
		ProviderExplicit: explicit,
		JSON:             parsed.JSON,
	})
}

func writeGlobalAccountListUsage(output io.Writer) {
	writeLSHelp(output, paletteFor(output), "aih ls")
}

// 兼容旧调用：只打印一行说明，不再走 Management API。
func writeGlobalAccountListUsageLegacy(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih ls [id] [--scope <provider...>]")
	_, _ = fmt.Fprintln(output, strings.Repeat(" ", 2)+"账号、额度与运行态来自本机 aih.db。")
}
