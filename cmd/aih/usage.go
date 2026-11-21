package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/managementops"
)

type usageOptions struct {
	command                 string
	provider                string
	model                   string
	sessionID               string
	from                    string
	to                      string
	limit                   int
	scan                    bool
	json                    bool
	dryRun                  bool
	reindexCodexForkHistory bool
}

func runUsage(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) == 0 || arguments[0] != "usage" {
		return false, nil
	}
	if nativeUsageHelpRequested(arguments[1:]) {
		writeNativeUsageHelp(runtime.stdout)
		return true, nil
	}
	// `aih usage <数字>`：数字是 CLI 账号编号，旧入口按唯一 Provider 改写成
	// `<provider> usage <数字>`。归属不唯一时明确拒绝，不猜 Provider。
	if len(arguments) >= 2 && isNumericToken(arguments[1]) {
		provider, resolved := resolveUniqueProviderForCLIAccountID(ctx, arguments[1], runtime)
		if !resolved {
			return true, fmt.Errorf("账号 %s 的 Provider 归属不唯一或不存在", strings.TrimSpace(arguments[1]))
		}
		return true, runProviderUsage(ctx, provider, arguments[1:], runtime)
	}
	options, err := parseUsageOptions(arguments[1:])
	if err != nil {
		return true, err
	}
	home, err := resolveAIHome(runtime)
	if err != nil {
		return true, err
	}
	switch options.command {
	case "scan":
		return true, runUsageScan(ctx, home, options, runtime)
	case "recalculate-costs":
		return true, runUsageRecalculateCosts(ctx, home, options, runtime)
	case "stats", "summary", "models", "cost-by-model", "by-model", "sessions", "session", "session-detail":
	default:
		return true, fmt.Errorf("未知 usage 命令: %s", options.command)
	}
	if (options.command == "session" || options.command == "session-detail") && options.sessionID == "" {
		return true, errors.New("session-detail 需要 --session-id")
	}
	query, err := managementops.ParseUsageQuery(
		options.from, options.to, options.provider, options.model, options.sessionID,
		options.limit, options.scan, time.Now(),
	)
	if err != nil {
		return true, fmt.Errorf("用量查询条件无效: %w", err)
	}
	// 本机读取：会话文件与用量投影都在 aih.db，不经过管理面 HTTP，不依赖 Management Key。
	reader, closeReader, err := openLocalUsageReader(ctx, home, runtime)
	if err != nil {
		return true, err
	}
	defer closeReader()
	usage, err := reader.Prepare(ctx, query)
	if err != nil {
		return true, err
	}
	rng := managementops.UsageRange{From: query.From, To: query.To}
	switch options.command {
	case "stats", "summary":
		stats, err := usage.Stats(ctx, query)
		if err != nil {
			return true, err
		}
		if options.json {
			return true, writeUsageJSON(runtime, "stats", rng, map[string]any{"stats": stats})
		}
		printUsageStats(runtime, rng, stats)
	case "models", "cost-by-model", "by-model":
		models, err := usage.Models(ctx, query)
		if err != nil {
			return true, err
		}
		if options.json {
			return true, writeUsageJSON(runtime, "models", rng, map[string]any{"models": models})
		}
		printUsageModels(runtime, rng, models)
	case "sessions":
		sessions, err := usage.Sessions(ctx, query)
		if err != nil {
			return true, err
		}
		if options.json {
			return true, writeUsageJSON(runtime, "sessions", rng, map[string]any{"sessions": sessions})
		}
		printUsageSessions(runtime, rng, sessions)
	case "session", "session-detail":
		detail, err := usage.SessionDetail(ctx, query)
		if err != nil {
			return true, err
		}
		if options.json {
			return true, writeUsageJSON(runtime, "session-detail", rng, map[string]any{"session": detail})
		}
		printUsageSessionDetail(runtime, query.SessionID, detail)
	}
	return true, nil
}

func writeUsageJSON(
	runtime commandRuntime,
	command string,
	usageRange managementops.UsageRange,
	payload map[string]any,
) error {
	payload["ok"] = true
	payload["command"] = command
	payload["range"] = usageRange
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
	return nil
}

func parseUsageOptions(args []string) (usageOptions, error) {
	options := usageOptions{command: "stats", limit: 20, scan: true}
	if len(args) > 0 && !strings.HasPrefix(strings.TrimSpace(args[0]), "-") {
		options.command = strings.ToLower(strings.TrimSpace(args[0]))
		args = args[1:]
	}
	for index := 0; index < len(args); index++ {
		token := strings.TrimSpace(args[index])
		switch token {
		case "--from":
			value, next, err := usageFlagValue(args, index, token)
			if err != nil {
				return options, err
			}
			options.from = value
			index = next
		case "--to":
			value, next, err := usageFlagValue(args, index, token)
			if err != nil {
				return options, err
			}
			options.to = value
			index = next
		case "--provider", "--source":
			value, next, err := usageFlagValue(args, index, token)
			if err != nil {
				return options, err
			}
			options.provider = value
			index = next
		case "--model":
			value, next, err := usageFlagValue(args, index, token)
			if err != nil {
				return options, err
			}
			options.model = value
			index = next
		case "--session-id":
			value, next, err := usageFlagValue(args, index, token)
			if err != nil {
				return options, err
			}
			options.sessionID = value
			index = next
		case "--limit", "-n":
			value, next, err := usageFlagValue(args, index, token)
			if err != nil {
				return options, err
			}
			parsed, parseErr := strconv.Atoi(value)
			if parseErr != nil || parsed < 1 {
				return options, errors.New("--limit must be a positive number")
			}
			options.limit = parsed
			index = next
		case "--no-scan":
			options.scan = false
		case "--json":
			options.json = true
		case "--dry-run":
			options.dryRun = true
		case "--reindex-codex-forks":
			options.reindexCodexForkHistory = true
		default:
			return options, fmt.Errorf("未知 usage 参数: %s", token)
		}
	}
	return options, nil
}

func usageFlagValue(args []string, index int, flag string) (string, int, error) {
	if index+1 >= len(args) || strings.HasPrefix(args[index+1], "-") {
		return "", index, fmt.Errorf("缺少 %s 参数值", flag)
	}
	return strings.TrimSpace(args[index+1]), index + 1, nil
}

func printUsageStats(
	runtime commandRuntime,
	usageRange managementops.UsageRange,
	stats managementops.UsageStatsSummary,
) {
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] 模型用量统计 %s ~ %s\n", usageRange.From, usageRange.To)
	_, _ = fmt.Fprintf(runtime.stdout, "  调用: %d\n", stats.TotalCalls)
	_, _ = fmt.Fprintf(runtime.stdout, "  会话: %d\n", stats.TotalSessions)
	_, _ = fmt.Fprintf(runtime.stdout, "  Prompt: %d\n", stats.TotalPrompts)
	_, _ = fmt.Fprintf(runtime.stdout, "  Tokens: %s (input %s, output %s, cache %s, reasoning %s)\n",
		formatTokenCount(stats.TotalTokens),
		formatTokenCount(stats.InputTokens),
		formatTokenCount(stats.OutputTokens),
		formatTokenCount(stats.CacheReadInputTokens+stats.CacheCreationInputTokens),
		formatTokenCount(stats.ReasoningOutputTokens))
	_, _ = fmt.Fprintf(runtime.stdout, "  估算成本: %s\n", formatUsageCost(stats.TotalCostUSD))
}

func printUsageModels(
	runtime commandRuntime,
	usageRange managementops.UsageRange,
	models []managementops.UsageModelItem,
) {
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] 模型用量按模型 %s ~ %s\n", usageRange.From, usageRange.To)
	if len(models) == 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "  无记录")
		return
	}
	_, _ = fmt.Fprintln(runtime.stdout, "provider  model  calls  tokens  cost")
	for _, row := range models {
		_, _ = fmt.Fprintf(runtime.stdout, "%s  %s  %d  %s  %s\n",
			row.Provider, row.Model, row.Calls,
			formatTokenCount(row.TotalTokens), formatUsageCost(row.CostUSD))
	}
}

func printUsageSessions(
	runtime commandRuntime,
	usageRange managementops.UsageRange,
	sessions []managementops.UsageSessionItem,
) {
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] 模型用量按会话 %s ~ %s\n", usageRange.From, usageRange.To)
	if len(sessions) == 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "  无记录")
		return
	}
	_, _ = fmt.Fprintln(runtime.stdout, "provider  session  project  calls  tokens  cost")
	for _, row := range sessions {
		sessionID := row.SessionID
		if len(sessionID) > 18 {
			sessionID = sessionID[:18]
		}
		_, _ = fmt.Fprintf(runtime.stdout, "%s  %s  %s  %d  %s  %s\n",
			row.Provider, sessionID, row.Project, row.Calls,
			formatTokenCount(row.TotalTokens), formatUsageCost(row.CostUSD))
	}
}

func printUsageSessionDetail(
	runtime commandRuntime,
	sessionID string,
	detail []managementops.UsageSessionModelDetail,
) {
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] 会话模型明细 %s\n", sessionID)
	if len(detail) == 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "  无记录")
		return
	}
	_, _ = fmt.Fprintln(runtime.stdout, "provider  model  calls  input  output  cache  cost")
	for _, row := range detail {
		_, _ = fmt.Fprintf(runtime.stdout, "%s  %s  %d  %s  %s  %s  %s\n",
			row.Provider, row.Model, row.Calls,
			formatTokenCount(row.InputTokens), formatTokenCount(row.OutputTokens),
			formatTokenCount(row.CacheReadInputTokens+row.CacheCreationInputTokens),
			formatUsageCost(row.CostUSD))
	}
}

func formatTokenCount(value int64) string {
	if value >= 1_000_000 {
		return fmt.Sprintf("%.2fM", float64(value)/1_000_000)
	}
	if value >= 1_000 {
		return fmt.Sprintf("%.1fK", float64(value)/1_000)
	}
	return strconv.FormatInt(value, 10)
}

func formatUsageCost(value float64) string {
	if value <= 0 {
		return "$0.0000"
	}
	if value < 0.01 {
		return fmt.Sprintf("$%.4f", value)
	}
	return fmt.Sprintf("$%.2f", value)
}
