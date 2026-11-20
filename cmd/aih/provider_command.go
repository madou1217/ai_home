package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/nativeresources"
)

// `aih provider <capabilities|doctor|ls>`：Provider 目录与原生资源边界。
//
// 旧入口的 caps/doctor 只是同一份 doctor 探测的两种视图；Go 的
// nativeresources.Report 已经是这两者的唯一事实来源，因此不再保留两套探测。
// `ls` 仍与账号列表分开：它回答「有哪些 Provider、各多少账号、有没有原生 CLI」。

const providerCommandUsage = `Usage: aih provider <capabilities|doctor|ls> [--json]

  capabilities [--json]  Show every provider resource boundary and imported-host gap
  doctor [--json]        Add local runtime availability and managed-resource state
  ls [pattern...]        List providers with account counts and CLI availability
                         Patterns accept * and ? (quote them so the shell keeps them),
                         e.g. aih provider ls '*buddy*'
`

// runProviderCommand 执行一次 `aih provider`，arguments 含 "provider" 本身。
func runProviderCommand(ctx context.Context, arguments []string, runtime commandRuntime) error {
	rest := arguments[1:]
	command := ""
	if len(rest) > 0 {
		command = strings.ToLower(strings.TrimSpace(rest[0]))
	}
	switch command {
	case "capabilities", "doctor", "ls":
	default:
		_, _ = fmt.Fprint(runtime.stdout, providerCommandUsage)
		return nil
	}
	if containsArgument(rest[1:], "--help") || containsArgument(rest[1:], "-h") {
		_, _ = fmt.Fprint(runtime.stdout, providerCommandUsage)
		return nil
	}
	if command == "ls" {
		return runProviderDirectory(ctx, rest[1:], runtime)
	}
	jsonOutput := containsArgument(rest[1:], "--json")
	aiHomeDir, err := resolveAIHome(runtime)
	if err != nil {
		return err
	}
	hostHomeDir, err := runtime.userHomeDir()
	if err != nil {
		return err
	}
	if override := strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_HOST_HOME")); override != "" {
		hostHomeDir = override
	}
	service, err := nativeresources.NewService(nativeresources.Config{
		AIHomeDir:   aiHomeDir,
		HostHomeDir: hostHomeDir,
		Env:         environMap(os.Environ()),
	})
	if err != nil {
		return err
	}
	report, err := service.Report(ctx)
	if err != nil {
		return err
	}
	if jsonOutput {
		encoder := json.NewEncoder(runtime.stdout)
		encoder.SetEscapeHTML(false)
		if encodeErr := encoder.Encode(report); encodeErr != nil {
			return encodeErr
		}
	} else {
		writeProviderDoctorText(runtime.stdout, command, report)
	}
	// 与旧入口一致：探测出现未知态时以非零退出，脚本据此发现环境问题。
	if !providerReportHealthy(report) {
		return cliExitCode{code: 1}
	}
	return nil
}

func writeProviderDoctorText(output io.Writer, command string, report nativeresources.ReportResponse) {
	title := "capabilities"
	if command == "doctor" {
		title = "doctor"
	}
	_, _ = fmt.Fprintf(output, "Provider %s\n", title)
	for _, row := range report.Providers {
		state := func(kind string) string {
			if item, found := row.Resources[kind]; found {
				return item.State
			}
			return "unsupported"
		}
		runtimeState := "unavailable"
		if row.Runtime.Available {
			runtimeState = "available"
		}
		_, _ = fmt.Fprintf(
			output,
			"%s  runtime:%s  plugin:%s  skill:%s  mcp:%s\n",
			row.Provider, runtimeState, state("plugin"), state("skill"), state("mcp"),
		)
	}
	for _, row := range report.Hosts {
		reason := row.Reason
		if reason == "" {
			reason = "host_runtime_unavailable"
		}
		_, _ = fmt.Fprintf(output, "host/%s  %s  %s\n", row.Host, row.State, reason)
	}
}

// providerReportHealthy 与旧入口同口径：任一资源或宿主行处于未知态即不健康。
func providerReportHealthy(report nativeresources.ReportResponse) bool {
	for _, row := range report.Providers {
		for _, item := range row.Resources {
			if item.State == "unknown" {
				return false
			}
		}
	}
	for _, row := range report.Hosts {
		if row.State == "unknown" {
			return false
		}
	}
	return true
}

// runProviderDirectory 输出 Provider 目录：账号计数来自同一份账号快照。
func runProviderDirectory(ctx context.Context, arguments []string, runtime commandRuntime) error {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return err
	}
	all := make([]string, 0, len(catalog.List()))
	for _, definition := range catalog.List() {
		all = append(all, definition.ID)
	}
	patterns := make([]string, 0, len(arguments))
	for _, argument := range arguments {
		if strings.HasPrefix(strings.TrimSpace(argument), "-") {
			continue
		}
		patterns = append(patterns, argument)
	}
	selected := all
	if len(patterns) > 0 {
		matched, matchErr := matchLSProviders(patterns, all)
		if matchErr != nil {
			return matchErr
		}
		selected = matched
	}
	counts := map[string]int{}
	if data, loadErr := loadLSData(ctx, runtime, lsOptions{}); loadErr == nil && data != nil {
		for _, account := range data.Accounts {
			if account == nil {
				continue
			}
			counts[strings.ToLower(strings.TrimSpace(account.Account.Provider))]++
		}
	}
	withCLI := make(map[string]bool)
	for _, name := range supportedCLINames(catalog) {
		withCLI[name] = true
	}
	_, _ = fmt.Fprintf(runtime.stdout, "\x1b[36m▶ Providers\x1b[0m \x1b[90m(%d)\x1b[0m\n\n", len(selected))
	for _, provider := range selected {
		count := counts[provider]
		countText := fmt.Sprintf("\x1b[90m0 accounts\x1b[0m")
		if count > 0 {
			suffix := "s"
			if count == 1 {
				suffix = ""
			}
			countText = fmt.Sprintf("\x1b[32m%d account%s\x1b[0m", count, suffix)
		}
		cliSuffix := ""
		if !withCLI[provider] {
			cliSuffix = " \x1b[90m(no native CLI)\x1b[0m"
		}
		padding := 14 - len(provider)
		if padding < 0 {
			padding = 0
		}
		_, _ = fmt.Fprintf(runtime.stdout, "  %s%s%s%s\n", provider, strings.Repeat(" ", padding), countText, cliSuffix)
	}
	_, _ = fmt.Fprintln(runtime.stdout)
	return nil
}

// supportedCLINames 返回合同里声明了原生 CLI 的 Provider。
func supportedCLINames(catalog *providers.Catalog) []string {
	names := make([]string, 0)
	for _, definition := range catalog.List() {
		if definition.CLI != nil {
			names = append(names, definition.ID)
		}
	}
	sort.Strings(names)
	return names
}

func environMap(entries []string) map[string]string {
	env := make(map[string]string, len(entries))
	for _, entry := range entries {
		key, value, ok := strings.Cut(entry, "=")
		if ok && key != "" {
			env[key] = value
		}
	}
	return env
}
