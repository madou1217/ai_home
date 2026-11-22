package main

// `aih failure-policy`：查看/解释/覆盖上游失败语义。
//
// 读命令在进程内直接加载契约与 config:server 覆盖，不依赖正在运行的 server；
// 写命令复用 server config 的本地写路径（webuiserverconfigapi.ApplyConfigPatch），
// 因此与 WebUI 使用同一份 app_kv 权威数据。

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	failurecontract "github.com/madou1217/ai_home/contracts/upstream-failure"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/internal/runtime/upstreamfailurepolicy"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
)

func showFailurePolicyUsage(runtime commandRuntime) {
	lines := []string{
		"用法:",
		"  aih failure-policy list [--provider P] [--json]",
		"  aih failure-policy explain <provider> <status|*> [--code C] [--type T] [--retry-after-ms N] [--json]",
		"  aih failure-policy set <provider> <status> --semantic S [--block-scope account|account_model]",
		"  aih failure-policy set-policy <kind> [--threshold N] [--window-ms M] [--cooldown-ms C]",
		"  aih failure-policy unset <signal-id>",
		"  aih failure-policy unset-policy <kind>",
		"  aih failure-policy disable <signal-id> | enable <signal-id>",
		"",
		"说明:",
		"  覆盖写入 config:server 的 upstreamFailurePolicy，保存后服务端热生效。",
		"  优先级：账号规则 > 全局覆盖 > 内置契约（contracts/upstream-failure/failures.json）。",
	}
	for _, line := range lines {
		_, _ = fmt.Fprintln(runtime.stdout, line)
	}
}

func runFailurePolicy(ctx context.Context, args []string, runtime commandRuntime) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		showFailurePolicyUsage(runtime)
		return nil
	}
	home, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := upstreamfailurepolicy.Load(ctx, home); err != nil {
		return err
	}
	switch strings.ToLower(args[0]) {
	case "list", "ls":
		return failurePolicyList(runtime, args[1:])
	case "explain":
		return failurePolicyExplain(runtime, args[1:])
	case "set":
		return failurePolicySet(ctx, home, runtime, args[1:])
	case "set-policy", "policy":
		return failurePolicySetPolicy(ctx, home, runtime, args[1:])
	case "unset":
		return failurePolicyUnset(ctx, home, runtime, args[1:])
	case "unset-policy":
		return failurePolicyUnsetPolicy(ctx, home, runtime, args[1:])
	case "disable", "enable":
		return failurePolicyToggle(ctx, home, runtime, args[0], args[1:])
	case "hits":
		return failurePolicyHits(ctx, runtime, args[1:])
	default:
		return fmt.Errorf("unknown failure-policy action: %s", args[0])
	}
}

func failurePolicyList(runtime commandRuntime, args []string) error {
	flags := flag.NewFlagSet("failure-policy list", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	provider := flags.String("provider", "", "")
	asJSON := flags.Bool("json", false, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return errors.New("failure-policy list 参数无效")
	}
	document := upstreamfailurepolicy.Effective()
	if document == nil {
		return errors.New("失败语义契约不可用")
	}
	signals := make([]failurecontract.Signal, 0, len(document.Signals))
	for _, signal := range document.Signals {
		if *provider != "" && !strings.EqualFold(strings.TrimSpace(signal.Provider), strings.TrimSpace(*provider)) &&
			!strings.EqualFold(strings.TrimSpace(signal.Provider), "all") {
			continue
		}
		signals = append(signals, signal)
	}
	sort.SliceStable(signals, func(left, right int) bool {
		if signals[left].Provider != signals[right].Provider {
			return signals[left].Provider < signals[right].Provider
		}
		if signals[left].Priority != signals[right].Priority {
			return signals[left].Priority < signals[right].Priority
		}
		return signals[left].ID < signals[right].ID
	})
	if *asJSON {
		return json.NewEncoder(runtime.stdout).Encode(map[string]any{
			"ok":      true,
			"signals": signals,
		})
	}
	_, _ = fmt.Fprintln(runtime.stdout, "PROVIDER  STATUS/ERROR              SEMANTIC           ACTION           SOURCE               ID")
	for _, signal := range signals {
		policy, _ := document.Policy(signal.Semantic)
		_, _ = fmt.Fprintf(runtime.stdout, "%-9s %-24s %-18s %-16s %-20s %s\n",
			signal.Provider,
			failureSignalMatcherText(signal),
			signal.Semantic,
			policy.Action,
			failureSignalSourceText(signal),
			signal.ID,
		)
	}
	return nil
}

func failurePolicyExplain(runtime commandRuntime, args []string) error {
	flags := flag.NewFlagSet("failure-policy explain", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	code := flags.String("code", "", "")
	errorType := flags.String("type", "", "")
	retryAfterMS := flags.Int64("retry-after-ms", 0, "")
	asJSON := flags.Bool("json", false, "")
	positional, flagArgs := splitFailurePolicyArgs(args, map[string]bool{
		"--code": true, "--type": true, "--retry-after-ms": true,
	})
	if err := flags.Parse(flagArgs); err != nil || len(positional) != 2 {
		return errors.New("failure-policy explain 需要 <provider> <status|*>")
	}
	provider := positional[0]
	status, err := parseFailureStatus(positional[1])
	if err != nil {
		return err
	}
	match, found := failurecontract.Resolve(failurecontract.SignalInput{
		Provider:   provider,
		StatusCode: status,
		ErrorType:  *errorType,
		ErrorCode:  *code,
		RetryAfter: *retryAfterMS,
	})
	document := upstreamfailurepolicy.Effective()
	if !found {
		if *asJSON {
			return json.NewEncoder(runtime.stdout).Encode(map[string]any{"ok": true, "matched": false})
		}
		_, _ = fmt.Fprintln(runtime.stdout, "未命中任何信号（回落到 Provider 内置分类器）。")
		return nil
	}
	policy, _ := document.Policy(match.Semantic)
	if *asJSON {
		return json.NewEncoder(runtime.stdout).Encode(map[string]any{
			"ok":        true,
			"matched":   true,
			"match":     match,
			"policy":    policy,
			"effective": failurePolicyStateFields(),
		})
	}
	_, _ = fmt.Fprintf(runtime.stdout, "命中信号: %s (source=%s, provider=%s)\n", match.SignalID, match.Source, match.Provider)
	_, _ = fmt.Fprintf(runtime.stdout, "语义:     %s  动作: %s\n", match.Semantic, policy.Action)
	if policy.Action == string(runtimecore.ActionModelCooldown) {
		_, _ = fmt.Fprintf(runtime.stdout, "阈值:     %d 次 / 窗口 %s\n", policy.Threshold, time.Duration(policy.FailureWindowMS)*time.Millisecond)
		_, _ = fmt.Fprintf(runtime.stdout, "冷却:     %s\n", time.Duration(policy.DefaultCooldownMS)*time.Millisecond)
	}
	if match.BlockScope != "" {
		_, _ = fmt.Fprintf(runtime.stdout, "阻塞范围: %s\n", match.BlockScope)
	}
	return nil
}

func failurePolicySet(ctx context.Context, home string, runtime commandRuntime, args []string) error {
	flags := flag.NewFlagSet("failure-policy set", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	semantic := flags.String("semantic", "", "")
	scope := flags.String("block-scope", "", "")
	status := flags.String("statuses", "", "")
	positional, flagArgs := splitFailurePolicyArgs(args, map[string]bool{
		"--semantic": true, "--block-scope": true, "--statuses": true,
	})
	if err := flags.Parse(flagArgs); err != nil || len(positional) < 1 {
		return errors.New("failure-policy set 需要 <provider> [<status>]，并用 --semantic 指定语义")
	}
	provider := positional[0]
	if strings.TrimSpace(*semantic) == "" {
		return errors.New("--semantic 必填")
	}
	override, err := readFailurePolicyOverride(ctx, home)
	if err != nil {
		return err
	}
	signal := failurecontract.Signal{
		ID:              "override." + provider + "." + failureOverrideSlot(failurePolicyArg(positional, 1), *status, *semantic),
		Provider:        provider,
		Semantic:        strings.TrimSpace(*semantic),
		BlockScope:      strings.TrimSpace(*scope),
		ErrorTypeOrCode: nil,
	}
	if len(positional) >= 2 && strings.TrimSpace(positional[1]) != "*" {
		value, convErr := strconv.Atoi(strings.TrimSpace(positional[1]))
		if convErr != nil {
			return fmt.Errorf("status 必须是整数或 *: %s", positional[1])
		}
		signal.Statuses = []int{value}
	} else {
		code := strings.TrimSpace(*status)
		if code == "" {
			return errors.New("status 为 * 时必须用 --statuses 指定匹配的错误码")
		}
		signal.ErrorCode = code
	}
	upsertFailurePolicySignal(&override, signal)
	return writeFailurePolicyOverride(ctx, home, runtime, override)
}

func failurePolicySetPolicy(ctx context.Context, home string, runtime commandRuntime, args []string) error {
	flags := flag.NewFlagSet("failure-policy set-policy", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	threshold := flags.Int("threshold", 0, "")
	windowMS := flags.Int64("window-ms", -1, "")
	cooldownMS := flags.Int64("cooldown-ms", -1, "")
	positional, flagArgs := splitFailurePolicyArgs(args, map[string]bool{
		"--threshold": true, "--window-ms": true, "--cooldown-ms": true,
	})
	if err := flags.Parse(flagArgs); err != nil || len(positional) != 1 {
		return errors.New("failure-policy set-policy 需要 <kind>")
	}
	kind := strings.TrimSpace(positional[0])
	if *threshold == 0 && *windowMS < 0 && *cooldownMS < 0 {
		return errors.New("至少提供一个覆盖参数")
	}
	override, err := readFailurePolicyOverride(ctx, home)
	if err != nil {
		return err
	}
	if override.Policies == nil {
		override.Policies = map[string]failurecontract.PolicyOverride{}
	}
	patch := override.Policies[kind]
	if *threshold > 0 {
		patch.Threshold = threshold
	}
	if *windowMS >= 0 {
		patch.FailureWindowMS = windowMS
	}
	if *cooldownMS >= 0 {
		patch.DefaultCooldownMS = cooldownMS
	}
	override.Policies[kind] = patch
	return writeFailurePolicyOverride(ctx, home, runtime, override)
}

func failurePolicyUnset(ctx context.Context, home string, runtime commandRuntime, args []string) error {
	if len(args) != 1 {
		return errors.New("failure-policy unset 需要 <signal-id>")
	}
	override, err := readFailurePolicyOverride(ctx, home)
	if err != nil {
		return err
	}
	id := strings.TrimSpace(args[0])
	kept := override.Signals[:0]
	removed := false
	for _, signal := range override.Signals {
		if signal.ID == id {
			removed = true
			continue
		}
		kept = append(kept, signal)
	}
	override.Signals = kept
	override.Disable = removeFailurePolicyValue(override.Disable, id)
	if !removed {
		return fmt.Errorf("没有找到覆盖信号: %s", id)
	}
	return writeFailurePolicyOverride(ctx, home, runtime, override)
}

func failurePolicyUnsetPolicy(ctx context.Context, home string, runtime commandRuntime, args []string) error {
	if len(args) != 1 {
		return errors.New("failure-policy unset-policy 需要 <kind>")
	}
	override, err := readFailurePolicyOverride(ctx, home)
	if err != nil {
		return err
	}
	kind := strings.TrimSpace(args[0])
	if _, found := override.Policies[kind]; !found {
		return fmt.Errorf("没有找到策略覆盖: %s", kind)
	}
	delete(override.Policies, kind)
	return writeFailurePolicyOverride(ctx, home, runtime, override)
}

func failurePolicyToggle(ctx context.Context, home string, runtime commandRuntime, action string, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("failure-policy %s 需要 <signal-id>", action)
	}
	override, err := readFailurePolicyOverride(ctx, home)
	if err != nil {
		return err
	}
	id := strings.TrimSpace(args[0])
	if action == "disable" {
		if !containsFailurePolicyValue(override.Disable, id) {
			override.Disable = append(override.Disable, id)
		}
	} else {
		override.Disable = removeFailurePolicyValue(override.Disable, id)
	}
	return writeFailurePolicyOverride(ctx, home, runtime, override)
}

func readFailurePolicyOverride(ctx context.Context, home string) (failurecontract.Override, error) {
	config, err := webuiserverconfigapi.ReadFullConfig(ctx, home)
	if err != nil {
		return failurecontract.Override{}, err
	}
	override, err := upstreamfailurepolicy.ParseOverride(config.UpstreamFailurePolicy)
	if err != nil {
		return failurecontract.Override{}, err
	}
	if override == nil {
		return failurecontract.Override{}, nil
	}
	return *override, nil
}

func writeFailurePolicyOverride(
	ctx context.Context,
	home string,
	runtime commandRuntime,
	override failurecontract.Override,
) error {
	raw := map[string]any{
		"version":  1,
		"policies": override.Policies,
		"signals":  override.Signals,
	}
	if len(override.Disable) > 0 {
		raw["disable"] = override.Disable
	}
	if len(override.Policies) == 0 {
		delete(raw, "policies")
	}
	if len(override.Signals) == 0 {
		delete(raw, "signals")
	}
	if len(raw) == 1 {
		raw = map[string]any{}
	}
	if err := upstreamfailurepolicy.Validate(raw); err != nil {
		return err
	}
	if _, err := webuiserverconfigapi.ApplyConfigPatch(ctx, home, map[string]any{
		upstreamfailurepolicy.ConfigKey: raw,
	}); err != nil {
		return err
	}
	_, _ = fmt.Fprintln(runtime.stdout, "已保存；server 若在运行会热生效。")
	return nil
}

func upsertFailurePolicySignal(override *failurecontract.Override, signal failurecontract.Signal) {
	for index := range override.Signals {
		if override.Signals[index].ID == signal.ID {
			override.Signals[index] = signal
			return
		}
	}
	override.Signals = append(override.Signals, signal)
}

func failureSignalMatcherText(signal failurecontract.Signal) string {
	parts := make([]string, 0, 3)
	if len(signal.Statuses) > 0 {
		values := make([]string, 0, len(signal.Statuses))
		for _, status := range signal.Statuses {
			values = append(values, strconv.Itoa(status))
		}
		parts = append(parts, strings.Join(values, ","))
	}
	if signal.StatusMin != nil || signal.StatusMax != nil {
		minText, maxText := "-", "-"
		if signal.StatusMin != nil {
			minText = strconv.Itoa(*signal.StatusMin)
		}
		if signal.StatusMax != nil {
			maxText = strconv.Itoa(*signal.StatusMax)
		}
		parts = append(parts, minText+".."+maxText)
	}
	if len(signal.ErrorTypeOrCode) > 0 {
		parts = append(parts, strings.Join(signal.ErrorTypeOrCode, "|"))
	}
	if signal.ErrorType != "" {
		parts = append(parts, "type="+signal.ErrorType)
	}
	if signal.ErrorCode != "" {
		parts = append(parts, "code="+signal.ErrorCode)
	}
	return strings.Join(parts, " ")
}

func failureSignalSourceText(signal failurecontract.Signal) string {
	source := signal.Source
	if source == "" {
		source = failurecontract.SourceBuiltin
	}
	if signal.Shadowed {
		return source + "(disabled)"
	}
	if signal.Enabled != nil && !*signal.Enabled {
		return source + "(disabled)"
	}
	return source
}

func parseFailureStatus(value string) (int, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "*" || trimmed == "" {
		return 0, nil
	}
	status, err := strconv.Atoi(trimmed)
	if err != nil || status < 100 || status > 599 {
		return 0, fmt.Errorf("status 必须是 100..599 的整数或 *: %s", value)
	}
	return status, nil
}

func failureOverrideSlot(statusArg, code, semantic string) string {
	if strings.TrimSpace(statusArg) != "" && strings.TrimSpace(statusArg) != "*" {
		return strings.TrimSpace(statusArg)
	}
	if strings.TrimSpace(code) != "" {
		return strings.TrimSpace(code)
	}
	return strings.TrimSpace(semantic)
}

func containsFailurePolicyValue(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func removeFailurePolicyValue(values []string, target string) []string {
	kept := values[:0]
	for _, value := range values {
		if value == target {
			continue
		}
		kept = append(kept, value)
	}
	return kept
}

// failurePolicyStateFields 返回进程内实际生效的冷却参数（含 env 覆盖后的值）。
func failurePolicyStateFields() map[string]any {
	document := upstreamfailurepolicy.Effective()
	result := map[string]any{}
	if document == nil {
		return result
	}
	for _, policy := range document.Policies {
		kind := runtimecore.FailureKind(policy.Kind)
		effective, err := runtimecore.PolicyFor(kind)
		if err != nil {
			continue
		}
		entry := map[string]any{"action": string(effective.Action())}
		if effective.EntersCooldown() {
			entry["threshold"] = effective.FailureThreshold()
			entry["failure_window_ms"] = effective.FailureWindow().Milliseconds()
			entry["default_cooldown_ms"] = effective.DefaultCooldown().Milliseconds()
		}
		result[policy.Kind] = entry
	}
	return result
}

// splitFailurePolicyArgs 允许位置参数出现在 flag 之前。
//
// Go 的 flag 包在第一个非 flag 处停止解析；本命令对外承诺
// `aih failure-policy set all 502 --semantic pool_exhausted` 的写法，
// 因此先把位置参数与 flag 分开，再交给 flag 包。
func splitFailurePolicyArgs(args []string, valueFlags map[string]bool) ([]string, []string) {
	positional := make([]string, 0, len(args))
	flagArgs := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			positional = append(positional, arg)
			continue
		}
		flagArgs = append(flagArgs, arg)
		name := arg
		if cut := strings.Index(arg, "="); cut > 0 {
			name = arg[:cut]
		}
		if valueFlags[name] && !strings.Contains(arg, "=") && index+1 < len(args) {
			index++
			flagArgs = append(flagArgs, args[index])
		}
	}
	return positional, flagArgs
}

func failurePolicyArg(values []string, index int) string {
	if index < 0 || index >= len(values) {
		return ""
	}
	return values[index]
}

// failurePolicyHits 读取正在运行的 server 的最近命中记录。
//
// 环形缓冲在 server 进程内，CLI 只能通过管理 API 读取；未运行 server 时给
// 出明确错误，而不是伪造空结果。
func failurePolicyHits(ctx context.Context, runtime commandRuntime, args []string) error {
	flags := flag.NewFlagSet("failure-policy hits", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	limit := flags.Int("limit", 50, "")
	provider := flags.String("provider", "", "")
	account := flags.String("account", "", "")
	semantic := flags.String("semantic", "", "")
	asJSON := flags.Bool("json", false, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return errors.New("failure-policy hits 参数无效")
	}
	key, found := runtime.lookupEnv("AIH_SERVER_MANAGEMENT_KEY")
	if !found || strings.TrimSpace(key) == "" {
		return errors.New("failure-policy hits 需要 AIH_SERVER_MANAGEMENT_KEY")
	}
	query := url.Values{}
	query.Set("limit", strconv.Itoa(*limit))
	if *provider != "" {
		query.Set("provider", *provider)
	}
	if *account != "" {
		query.Set("account_ref", *account)
	}
	if *semantic != "" {
		query.Set("semantic", *semantic)
	}
	endpoint := strings.TrimRight(resolveManagementBaseURL(runtime), "/") +
		"/v1/management/failure-provenance?" + query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return errors.New("无法创建失败命中请求")
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(key))
	response, err := runtime.managementAPI.Do(request)
	if err != nil {
		return fmt.Errorf("读取失败命中失败（server 未运行？）: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	var payload struct {
		OK      bool             `json:"ok"`
		Entries []map[string]any `json:"entries"`
		Dropped uint64           `json:"dropped"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&payload); err != nil {
		return errors.New("失败命中响应不是合法 JSON")
	}
	if !payload.OK {
		return fmt.Errorf("读取失败命中失败: HTTP %d", response.StatusCode)
	}
	if *asJSON {
		return json.NewEncoder(runtime.stdout).Encode(payload)
	}
	_, _ = fmt.Fprintf(runtime.stdout, "最近命中 %d 条（dropped=%d）\n", len(payload.Entries), payload.Dropped)
	_, _ = fmt.Fprintln(runtime.stdout, "TIME                ACCOUNT              MODEL        STATUS SEMANTIC           ACTION           SOURCE:SIGNAL")
	for _, entry := range payload.Entries {
		_, _ = fmt.Fprintf(runtime.stdout, "%-19s %-20s %-12s %-6v %-18v %-16v %v:%v\n",
			failureHitTime(entry["atMs"]),
			failureHitString(entry["accountRef"]),
			failureHitString(entry["model"]),
			entry["httpStatus"],
			entry["semantic"],
			entry["action"],
			entry["source"],
			entry["signalId"],
		)
	}
	return nil
}

func failureHitString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func failureHitTime(value any) string {
	number, ok := value.(float64)
	if !ok || number <= 0 {
		return "-"
	}
	return time.UnixMilli(int64(number)).Format("2006-01-02 15:04:05")
}
