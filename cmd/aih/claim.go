package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accountactivity"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
)

// runClaim 执行账号福利/活动领取。领取动作与参数来自 Go 的活动目录，
// 实际执行由 Go Server 的 NativeExecutor 完成；CLI 只负责选择与展示。
func runClaim(ctx context.Context, arguments []string, runtime commandRuntime) error {
	options, err := parseClaimArgs(arguments)
	if err != nil {
		writeClaimUsage(runtime.stderr)
		return err
	}
	if options.help {
		writeClaimUsage(runtime.stdout)
		return nil
	}
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	catalog := accountactivity.BuiltinCatalog()
	providers, err := claimProviders(catalog, options.providers)
	if err != nil {
		return err
	}
	accounts, err := listClaimAccounts(ctx, client)
	if err != nil {
		return err
	}
	results := make([]map[string]any, 0)
	for _, provider := range providers {
		actions := catalog.Actions(provider)
		if len(actions) == 0 {
			results = append(results, map[string]any{"provider": provider, "accountRef": "", "status": "error", "error": "activity_unsupported"})
			continue
		}
		actionID := actions[0].ID
		targets := make([]managementapi.AccountView, 0)
		for _, account := range accounts {
			if !strings.EqualFold(account.ProviderID, provider) {
				continue
			}
			if options.account != "" && !claimAccountMatches(options.account, account) {
				continue
			}
			targets = append(targets, account)
		}
		if len(targets) == 0 {
			if options.account != "" {
				results = append(results, map[string]any{"provider": provider, "accountRef": options.account, "status": "error", "error": "account_not_found"})
			} else {
				results = append(results, map[string]any{"provider": provider, "accountRef": "", "status": "no_accounts"})
			}
			continue
		}
		for _, target := range targets {
			result, claimErr := runClaimForAccount(ctx, runtime, provider, string(target.AccountRef), actionID, options.dryRun)
			if claimErr != nil {
				results = append(results, map[string]any{"provider": provider, "accountRef": string(target.AccountRef), "status": "error", "error": claimErr.Error()})
				continue
			}
			results = append(results, result)
		}
	}
	summary := summarizeClaimResults(results)
	payload := map[string]any{
		"ok":         summary["failed"] == 0,
		"capturedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"dryRun":     options.dryRun,
		"results":    results,
		"summary":    summary,
	}
	if options.json {
		return writeJSONDocument(runtime.stdout, payload)
	}
	writeClaimResults(runtime.stdout, results, summary, options)
	if failed, _ := summary["failed"].(int); failed > 0 {
		return &cliExitCode{code: 1}
	}
	return nil
}

type claimOptions struct {
	providers      []string
	account        string
	json           bool
	quiet          bool
	dryRun         bool
	help           bool
	appVersion     string
	captchaBrowser string
	timeoutMS      int
}

func parseClaimArgs(arguments []string) (claimOptions, error) {
	options := claimOptions{}
	numeric := make([]string, 0)
	for index := 0; index < len(arguments); index++ {
		token := strings.TrimSpace(arguments[index])
		switch token {
		case "":
			continue
		case "--help", "-h", "help":
			options.help = true
		case "--json":
			options.json = true
		case "--quiet", "-q":
			options.quiet = true
		case "--dry-run", "--dryrun":
			options.dryRun = true
		case "--account", "--account-ref", "--id":
			if index+1 < len(arguments) {
				index++
				options.account = strings.TrimSpace(arguments[index])
			}
		case "--app-version":
			if index+1 < len(arguments) {
				index++
				options.appVersion = strings.TrimSpace(arguments[index])
			}
		case "--captcha-browser":
			if index+1 < len(arguments) {
				index++
				options.captchaBrowser = strings.TrimSpace(arguments[index])
			}
		case "--timeout-ms":
			if index+1 < len(arguments) {
				index++
				_, _ = fmt.Sscanf(strings.TrimSpace(arguments[index]), "%d", &options.timeoutMS)
			}
		default:
			if strings.HasPrefix(token, "-") {
				return options, fmt.Errorf("unknown_option:%s", token)
			}
			if isNumericAccountToken(token) {
				numeric = append(numeric, token)
				continue
			}
			options.providers = append(options.providers, strings.ToLower(token))
		}
	}
	if len(numeric) > 0 {
		if len(options.providers) != 1 || len(numeric) > 1 {
			return options, fmt.Errorf("ambiguous_account_id: pass exactly one provider and one id")
		}
		options.account = numeric[0]
	}
	return options, nil
}

func claimProviders(catalog *accountactivity.Catalog, requested []string) ([]string, error) {
	all := catalog.Providers()
	if len(requested) == 0 {
		return all, nil
	}
	known := make(map[string]bool, len(all))
	for _, provider := range all {
		known[provider] = true
	}
	result := make([]string, 0, len(requested))
	seen := map[string]bool{}
	for _, item := range requested {
		if item == "all" {
			for _, provider := range all {
				if !seen[provider] {
					seen[provider] = true
					result = append(result, provider)
				}
			}
			continue
		}
		if !known[item] {
			return nil, fmt.Errorf("unknown_provider:%s: expected %s or all", item, strings.Join(all, ", "))
		}
		if !seen[item] {
			seen[item] = true
			result = append(result, item)
		}
	}
	return result, nil
}

func listClaimAccounts(ctx context.Context, client *managementapi.Client) ([]managementapi.AccountView, error) {
	accounts := make([]managementapi.AccountView, 0)
	after := ""
	for {
		result, err := client.ListAccounts(ctx, managementapi.ListOptions{Limit: managementapi.MaxListLimit, AfterRef: after})
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, result.Accounts...)
		if !result.HasMore || result.NextAfterRef == "" {
			break
		}
		after = result.NextAfterRef
	}
	return accounts, nil
}

func claimAccountMatches(selector string, account managementapi.AccountView) bool {
	selector = strings.TrimSpace(selector)
	if selector == "" {
		return true
	}
	if selector == string(account.AccountRef) {
		return true
	}
	return selector == fmt.Sprintf("%d", account.CLIAccountID.Int64())
}

func runClaimForAccount(ctx context.Context, runtime commandRuntime, provider, accountRef, actionID string, dryRun bool) (map[string]any, error) {
	body := map[string]any{
		"providers": []string{provider},
		"actionId":  actionID,
		"params":    map[string]any{"accountRefs": []string{accountRef}},
		"dryRun":    dryRun,
	}
	status, payload, err := claimRequest(ctx, runtime, http.MethodPost, "/v1/management/webui/account-activity/run", body)
	if err != nil {
		return nil, err
	}
	if status != http.StatusAccepted && status != http.StatusOK {
		return nil, claimError(payload, status)
	}
	job, _ := payload["job"].(map[string]any)
	jobID, _ := job["id"].(string)
	if jobID == "" {
		return nil, fmt.Errorf("activity_job_missing")
	}
	deadline := time.Now().Add(3 * time.Minute)
	for {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("activity_job_timeout")
		}
		status, payload, err = claimRequest(ctx, runtime, http.MethodGet, "/v1/management/webui/account-activity/jobs/"+jobID, nil)
		if err != nil {
			return nil, err
		}
		if status != http.StatusOK {
			return nil, claimError(payload, status)
		}
		job, _ = payload["job"].(map[string]any)
		phase, _ := job["status"].(string)
		switch phase {
		case "succeeded", "partial", "failed":
			results, _ := job["results"].([]any)
			for _, item := range results {
				result, _ := item.(map[string]any)
				if stringValue(result["accountRef"]) == accountRef || accountRef == "" {
					return result, nil
				}
			}
			if len(results) > 0 {
				result, _ := results[0].(map[string]any)
				return result, nil
			}
			return map[string]any{"provider": provider, "accountRef": accountRef, "status": "error", "error": "activity_result_missing"}, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func claimRequest(ctx context.Context, runtime commandRuntime, method, path string, body any) (int, map[string]any, error) {
	key := strings.TrimSpace(osEnv(runtime, "AIH_SERVER_MANAGEMENT_KEY"))
	if key == "" {
		return 0, nil, fmt.Errorf("claim requires AIH_SERVER_MANAGEMENT_KEY")
	}
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(resolveManagementBaseURL(runtime), "/")+path, reader)
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Authorization", "Bearer "+key)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := runtime.managementAPI.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return 0, nil, err
	}
	var payload map[string]any
	if len(bytes.TrimSpace(raw)) > 0 {
		_ = json.Unmarshal(raw, &payload)
	}
	if payload == nil {
		payload = map[string]any{}
	}
	return response.StatusCode, payload, nil
}

func osEnv(runtime commandRuntime, name string) string {
	value, _ := runtime.lookupEnv(name)
	return value
}

func claimError(payload map[string]any, status int) error {
	message := stringValue(payload["message"])
	if message == "" {
		message = stringValue(payload["error"])
	}
	if message == "" {
		message = fmt.Sprintf("http_%d", status)
	}
	return fmt.Errorf("%s", message)
}

func summarizeClaimResults(results []map[string]any) map[string]any {
	summary := map[string]any{"accounts": 0, "claimed": 0, "alreadyClaimed": 0, "nothingClaimable": 0, "dryRun": 0, "notApplicable": 0, "failed": 0}
	accounts, _ := summary["accounts"].(int)
	for _, result := range results {
		status := stringValue(result["status"])
		if status == "no_accounts" {
			continue
		}
		accounts++
		switch status {
		case "claimed":
			summary["claimed"] = summary["claimed"].(int) + 1
		case "already_claimed":
			summary["alreadyClaimed"] = summary["alreadyClaimed"].(int) + 1
		case "nothing_claimable":
			summary["nothingClaimable"] = summary["nothingClaimable"].(int) + 1
		case "dry_run":
			summary["dryRun"] = summary["dryRun"].(int) + 1
		case "not_applicable":
			summary["notApplicable"] = summary["notApplicable"].(int) + 1
		case "error":
			summary["failed"] = summary["failed"].(int) + 1
		}
	}
	summary["accounts"] = accounts
	return summary
}

func writeClaimResults(output io.Writer, results []map[string]any, summary map[string]any, options claimOptions) {
	_, _ = fmt.Fprintf(output, "aih claim %s%s\n", time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), map[bool]string{true: " (dry run)", false: ""}[options.dryRun])
	for _, result := range results {
		provider := stringValue(result["provider"])
		if stringValue(result["status"]) == "no_accounts" {
			_, _ = fmt.Fprintf(output, "  %-8s  no accounts\n", provider)
			continue
		}
		if options.quiet && stringValue(result["status"]) != "error" {
			continue
		}
		_, _ = fmt.Fprintf(output, "  %-8s  %-30s  %-17s  %s\n",
			provider,
			stringValue(result["accountRef"]),
			stringValue(result["status"]),
			claimDetail(result),
		)
	}
	_, _ = fmt.Fprintf(output, "%v claimed · %v already claimed · %v nothing claimable · %v failed\n",
		summary["claimed"], summary["alreadyClaimed"], summary["nothingClaimable"], summary["failed"])
}

func claimDetail(result map[string]any) string {
	switch stringValue(result["status"]) {
	case "claimed":
		if plan, ok := result["plan"].(map[string]any); ok {
			return stringValue(plan["name"])
		}
		return "benefit claimed"
	case "dry_run":
		if items, ok := result["claimable"].([]any); ok && len(items) > 0 {
			return "claimable"
		}
		return "nothing claimable"
	case "error":
		return strings.TrimSpace(stringValue(result["error"]) + ": " + stringValue(result["message"]))
	case "already_claimed":
		return "nothing to do"
	case "nothing_claimable":
		return "no active activity"
	case "not_applicable":
		return "API key account"
	default:
		return ""
	}
}

func writeClaimUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "AIH Claim - 领取 provider 账号的每日/活动福利")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "用法: aih claim [provider ...] [options]")
	_, _ = fmt.Fprintln(output, "  all          every provider above (default)")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "Options:")
	_, _ = fmt.Fprintln(output, "  --dry-run                 只预览可领取项")
	_, _ = fmt.Fprintln(output, "  --account <ref|id>        只处理指定账号")
	_, _ = fmt.Fprintln(output, "  --json                    输出机器可读结果")
	_, _ = fmt.Fprintln(output, "  --quiet                   只输出错误")
	_, _ = fmt.Fprintln(output, "  --app-version <v>         ZCode app_version override")
	_, _ = fmt.Fprintln(output, "  --captcha-browser <path>  ZCode 验证码浏览器")
	_, _ = fmt.Fprintln(output, "  --timeout-ms <n>          单请求超时")
}

// cliExitCode 让执行入口以指定退出码结束而不重复打印错误。
type cliExitCode struct{ code int }

func (code cliExitCode) Error() string { return "" }
func (code cliExitCode) ExitCode() int { return code.code }
func (code cliExitCode) SilentExit()   {}
