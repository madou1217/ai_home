package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
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
	reindexCodexForkHistory bool
}

func runUsage(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) == 0 || arguments[0] != "usage" {
		return false, nil
	}
	if len(arguments) > 1 {
		switch strings.TrimSpace(arguments[1]) {
		case "--help", "-h", "help":
			return false, nil
		}
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
		// scan / recalculate-costs / help remain on the legacy CLI for now.
		return false, nil
	}
	config, err := webuiserverconfigapi.ReadFullConfig(ctx, home)
	if err != nil {
		return true, err
	}
	baseURL := fmt.Sprintf("http://127.0.0.1:%d/v0/management", config.Port)
	if config.Port <= 0 || config.Port > 65535 {
		baseURL = "http://127.0.0.1:9527/v0/management"
	}
	path := "/usage/stats"
	switch options.command {
	case "models", "cost-by-model", "by-model":
		path = "/usage/models"
	case "sessions":
		path = "/usage/sessions"
	case "session", "session-detail":
		path = "/usage/session-detail"
		if options.sessionID == "" {
			return true, errors.New("session-detail 需要 --session-id")
		}
	}
	query := url.Values{}
	if options.provider != "" {
		query.Set("provider", options.provider)
	}
	if options.model != "" {
		query.Set("model", options.model)
	}
	if options.sessionID != "" {
		query.Set("session_id", options.sessionID)
	}
	if options.from != "" {
		query.Set("from", options.from)
	}
	if options.to != "" {
		query.Set("to", options.to)
	}
	if options.limit > 0 {
		query.Set("limit", strconv.Itoa(options.limit))
	}
	query.Set("scan", strconv.FormatBool(options.scan))
	response, err := fetchUsage(ctx, baseURL+path+"?"+query.Encode(), config.ManagementKey)
	if err != nil {
		return true, err
	}
	if options.json {
		response["command"] = normalizeUsageCommand(options.command)
		encoded, err := json.MarshalIndent(response, "", "  ")
		if err != nil {
			return true, err
		}
		_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
		return true, nil
	}
	switch options.command {
	case "stats", "summary":
		printUsageStats(runtime, response)
	case "models", "cost-by-model", "by-model":
		printUsageModels(runtime, response)
	case "sessions":
		printUsageSessions(runtime, response)
	case "session", "session-detail":
		printUsageSessionDetail(runtime, response, options.sessionID)
	}
	return true, nil
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

func normalizeUsageCommand(command string) string {
	switch command {
	case "summary":
		return "stats"
	case "cost-by-model", "by-model":
		return "models"
	case "session":
		return "session-detail"
	default:
		return command
	}
}

func fetchUsage(ctx context.Context, endpoint, managementKey string) (map[string]any, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	if managementKey != "" {
		request.Header.Set("Authorization", "Bearer "+managementKey)
	}
	client := &http.Client{Timeout: 90 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024))
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("usage HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(raw)))
	}
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		return nil, errors.New("usage response is not valid JSON")
	}
	return payload, nil
}

func printUsageStats(runtime commandRuntime, payload map[string]any) {
	stats, _ := payload["stats"].(map[string]any)
	from, to := usageRange(payload)
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] 模型用量统计 %s ~ %s\n", from, to)
	_, _ = fmt.Fprintf(runtime.stdout, "  调用: %v\n", intValue(stats["totalCalls"]))
	_, _ = fmt.Fprintf(runtime.stdout, "  会话: %v\n", intValue(stats["totalSessions"]))
	_, _ = fmt.Fprintf(runtime.stdout, "  Prompt: %v\n", intValue(stats["totalPrompts"]))
	_, _ = fmt.Fprintf(runtime.stdout, "  Tokens: %s (input %s, output %s, cache %s, reasoning %s)\n",
		formatTokenCount(intValue(stats["totalTokens"])),
		formatTokenCount(intValue(stats["inputTokens"])),
		formatTokenCount(intValue(stats["outputTokens"])),
		formatTokenCount(intValue(stats["cacheReadInputTokens"])+intValue(stats["cacheCreationInputTokens"])),
		formatTokenCount(intValue(stats["reasoningOutputTokens"])))
	_, _ = fmt.Fprintf(runtime.stdout, "  估算成本: %s\n", formatUsageCost(floatValue(stats["totalCostUsd"])))
}

func printUsageModels(runtime commandRuntime, payload map[string]any) {
	from, to := usageRange(payload)
	models, _ := payload["models"].([]any)
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] 模型用量按模型 %s ~ %s\n", from, to)
	if len(models) == 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "  无记录")
		return
	}
	_, _ = fmt.Fprintln(runtime.stdout, "provider  model  calls  tokens  cost")
	for _, item := range models {
		row, _ := item.(map[string]any)
		_, _ = fmt.Fprintf(runtime.stdout, "%v  %v  %v  %s  %s\n",
			row["provider"], row["model"], intValue(row["calls"]),
			formatTokenCount(intValue(row["totalTokens"])), formatUsageCost(floatValue(row["costUsd"])))
	}
}

func printUsageSessions(runtime commandRuntime, payload map[string]any) {
	from, to := usageRange(payload)
	sessions, _ := payload["sessions"].([]any)
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] 模型用量按会话 %s ~ %s\n", from, to)
	if len(sessions) == 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "  无记录")
		return
	}
	_, _ = fmt.Fprintln(runtime.stdout, "provider  session  project  calls  tokens  cost")
	for _, item := range sessions {
		row, _ := item.(map[string]any)
		sessionID := fmt.Sprint(row["sessionId"])
		if len(sessionID) > 18 {
			sessionID = sessionID[:18]
		}
		_, _ = fmt.Fprintf(runtime.stdout, "%v  %s  %v  %v  %s  %s\n",
			row["provider"], sessionID, row["project"], intValue(row["calls"]),
			formatTokenCount(intValue(row["totalTokens"])), formatUsageCost(floatValue(row["costUsd"])))
	}
}

func printUsageSessionDetail(runtime commandRuntime, payload map[string]any, sessionID string) {
	session, _ := payload["session"].([]any)
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] 会话模型明细 %s\n", sessionID)
	if len(session) == 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "  无记录")
		return
	}
	_, _ = fmt.Fprintln(runtime.stdout, "provider  model  calls  input  output  cache  cost")
	for _, item := range session {
		row, _ := item.(map[string]any)
		_, _ = fmt.Fprintf(runtime.stdout, "%v  %v  %v  %s  %s  %s  %s\n",
			row["provider"], row["model"], intValue(row["calls"]),
			formatTokenCount(intValue(row["inputTokens"])), formatTokenCount(intValue(row["outputTokens"])),
			formatTokenCount(intValue(row["cacheReadInputTokens"])+intValue(row["cacheCreationInputTokens"])),
			formatUsageCost(floatValue(row["costUsd"])))
	}
}

func usageRange(payload map[string]any) (string, string) {
	rng, _ := payload["range"].(map[string]any)
	return fmt.Sprint(rng["from"]), fmt.Sprint(rng["to"])
}

func intValue(value any) int64 {
	number, _ := value.(float64)
	return int64(number)
}

func floatValue(value any) float64 {
	number, _ := value.(float64)
	return number
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
