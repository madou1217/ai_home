package main

// `aih limits`：并发/速率上限的离线查看、写入与生效值预览。
//
// 全局配置写入 config:server 的 concurrency 对象（与 WebUI 同源）；账号覆盖
// 写入 aih.db 的 account_concurrency_limits。本轮只存储与预览，不执行拦截。

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	clientkeysapp "github.com/madou1217/ai_home/application/clientkeys"
	coreclientkeys "github.com/madou1217/ai_home/core/clientkeys"
	"github.com/madou1217/ai_home/core/concurrency"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
)

func showLimitsUsage(runtime commandRuntime) {
	lines := []string{
		"用法:",
		"  aih limits show [--json]",
		"  aih limits set-global [--system-max N] [--queue-limit N] [--queue-wait-ms N] [--retry-after N] [--account-default N] [--json]",
		"  aih limits set-provider <provider> --max N [--json]",
		"  aih limits unset-provider <provider> [--json]",
		"  aih limits set-account <accountRef> [--model <model>] --max N [--rpm N] [--tpm N] [--json]",
		"  aih limits unset-account <accountRef> [--model <model>] [--json]",
		"  aih limits preview --provider <p> --account <ref> [--model <m>] [--key <keyId>] [--json]",
		"",
		"说明:",
		"  全局配置写入 config:server.concurrency；账号覆盖写入 account_concurrency_limits。",
		"  并发上限已执行拦截；RPM/TPM 只存储与预览。",
	}
	for _, line := range lines {
		_, _ = fmt.Fprintln(runtime.stdout, line)
	}
}

func runLimits(ctx context.Context, args []string, runtime commandRuntime) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		showLimitsUsage(runtime)
		return nil
	}
	home, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	switch strings.ToLower(args[0]) {
	case "show":
		return limitsShow(ctx, home, runtime, args[1:])
	case "set-global":
		return limitsSetGlobal(ctx, home, runtime, args[1:])
	case "set-provider":
		return limitsSetProvider(ctx, home, runtime, args[1:])
	case "unset-provider":
		return limitsUnsetProvider(ctx, home, runtime, args[1:])
	case "set-account":
		return limitsSetAccount(ctx, home, runtime, args[1:])
	case "unset-account":
		return limitsUnsetAccount(ctx, home, runtime, args[1:])
	case "preview":
		return limitsPreview(ctx, home, runtime, args[1:])
	default:
		return fmt.Errorf("unknown limits action: %s", args[0])
	}
}

func limitsShow(ctx context.Context, home string, runtime commandRuntime, args []string) error {
	flags := flag.NewFlagSet("limits show", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	asJSON := flags.Bool("json", false, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return errors.New("limits show 参数无效")
	}
	config, err := readLimitsConfig(ctx, home)
	if err != nil {
		return err
	}
	if *asJSON {
		return json.NewEncoder(runtime.stdout).Encode(map[string]any{
			"ok": true, "concurrency": config, "enforced": false,
		})
	}
	_, _ = fmt.Fprintln(runtime.stdout, "CONCURRENCY（并发准入已启用；RPM/TPM 未执行）")
	_, _ = fmt.Fprintf(runtime.stdout, "systemMax:          %d\n", config.SystemMax)
	_, _ = fmt.Fprintf(runtime.stdout, "queueLimit:         %d\n", config.QueueLimit)
	_, _ = fmt.Fprintf(runtime.stdout, "queueWaitTimeoutMs: %d\n", config.QueueWaitTimeoutMS)
	_, _ = fmt.Fprintf(runtime.stdout, "retryAfterSeconds:  %d\n", config.RetryAfterSeconds)
	_, _ = fmt.Fprintf(runtime.stdout, "accountDefault:     %d\n", config.AccountDefault)
	_, _ = fmt.Fprintln(runtime.stdout, "\nPROVIDER DEFAULTS")
	for _, provider := range sortedProviderDefaults(config.ProviderDefaults) {
		_, _ = fmt.Fprintf(runtime.stdout, "  %-12s %d\n", provider, config.ProviderDefaults[provider])
	}
	return nil
}

func limitsSetGlobal(ctx context.Context, home string, runtime commandRuntime, args []string) error {
	flags := flag.NewFlagSet("limits set-global", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	systemMax := flags.Int("system-max", -1, "")
	queueLimit := flags.Int("queue-limit", -1, "")
	queueWaitMS := flags.Int64("queue-wait-ms", -1, "")
	retryAfter := flags.Int("retry-after", -1, "")
	accountDefault := flags.Int("account-default", -1, "")
	asJSON := flags.Bool("json", false, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return errors.New("limits set-global 参数无效")
	}
	if *systemMax < 0 && *queueLimit < 0 && *queueWaitMS < 0 && *retryAfter < 0 && *accountDefault < 0 {
		return errors.New("limits set-global 至少需要提供一个上限参数")
	}
	config, err := readLimitsConfig(ctx, home)
	if err != nil {
		return err
	}
	if *systemMax >= 0 {
		config.SystemMax = *systemMax
	}
	if *queueLimit >= 0 {
		config.QueueLimit = *queueLimit
	}
	if *queueWaitMS >= 0 {
		config.QueueWaitTimeoutMS = *queueWaitMS
	}
	if *retryAfter >= 0 {
		config.RetryAfterSeconds = *retryAfter
	}
	if *accountDefault >= 0 {
		config.AccountDefault = *accountDefault
	}
	saved, err := writeLimitsConfig(ctx, home, config)
	if err != nil {
		return err
	}
	return printLimitsConfig(runtime, saved, *asJSON)
}

func limitsSetProvider(ctx context.Context, home string, runtime commandRuntime, args []string) error {
	flags := flag.NewFlagSet("limits set-provider", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	maxConcurrency := flags.Int("max", -1, "")
	asJSON := flags.Bool("json", false, "")
	positional, flagArgs := splitLeadingPositional(args)
	if err := flags.Parse(flagArgs); err != nil || len(positional) != 1 || *maxConcurrency < 0 {
		return errors.New("limits set-provider <provider> --max N")
	}
	provider := strings.ToLower(strings.TrimSpace(positional[0]))
	if provider == "" {
		return errors.New("provider 不能为空")
	}
	config, err := readLimitsConfig(ctx, home)
	if err != nil {
		return err
	}
	if config.ProviderDefaults == nil {
		config.ProviderDefaults = map[string]int{}
	}
	config.ProviderDefaults[provider] = *maxConcurrency
	saved, err := writeLimitsConfig(ctx, home, config)
	if err != nil {
		return err
	}
	if *asJSON {
		return json.NewEncoder(runtime.stdout).Encode(map[string]any{"ok": true, "provider": provider, "max": saved.ProviderDefaults[provider], "enforced": false})
	}
	_, _ = fmt.Fprintf(runtime.stdout, "已设置 %s 默认并发 = %d（已生效）\n", provider, saved.ProviderDefaults[provider])
	return nil
}

func limitsUnsetProvider(ctx context.Context, home string, runtime commandRuntime, args []string) error {
	flags := flag.NewFlagSet("limits unset-provider", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	asJSON := flags.Bool("json", false, "")
	positional, flagArgs := splitLeadingPositional(args)
	if err := flags.Parse(flagArgs); err != nil || len(positional) != 1 {
		return errors.New("limits unset-provider <provider>")
	}
	provider := strings.ToLower(strings.TrimSpace(positional[0]))
	config, err := readLimitsConfig(ctx, home)
	if err != nil {
		return err
	}
	delete(config.ProviderDefaults, provider)
	saved, err := writeLimitsConfig(ctx, home, config)
	if err != nil {
		return err
	}
	if *asJSON {
		return json.NewEncoder(runtime.stdout).Encode(map[string]any{"ok": true, "provider": provider, "unset": true})
	}
	_, _ = fmt.Fprintf(runtime.stdout, "已移除 %s 默认并发；回落到 accountDefault=%d\n", provider, saved.AccountDefault)
	return nil
}

func limitsSetAccount(ctx context.Context, home string, runtime commandRuntime, args []string) error {
	flags := flag.NewFlagSet("limits set-account", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	model := flags.String("model", "", "")
	maxConcurrency := flags.Int("max", -1, "")
	rpm := flags.Int("rpm", -1, "")
	tpm := flags.Int("tpm", -1, "")
	asJSON := flags.Bool("json", false, "")
	positional, flagArgs := splitLeadingPositional(args)
	if err := flags.Parse(flagArgs); err != nil || len(positional) != 1 || *maxConcurrency < 0 {
		return errors.New("limits set-account <accountRef> [--model <model>] --max N [--rpm N] [--tpm N]")
	}
	accountRef := strings.TrimSpace(positional[0])
	if accountRef == "" {
		return errors.New("accountRef 不能为空")
	}
	store, err := openLimitsStore(ctx, home)
	if err != nil {
		return err
	}
	defer func() { _ = store.Close() }()
	limits, err := store.ListAccountConcurrencyLimits(ctx)
	if err != nil {
		return err
	}
	limit := concurrency.AccountLimit{
		AccountRef: accountRef,
		ModelID:    strings.TrimSpace(*model),
	}
	for _, existing := range limits {
		if existing.AccountRef == limit.AccountRef && existing.ModelID == limit.ModelID {
			limit = existing
			break
		}
	}
	limit.MaxConcurrency = *maxConcurrency
	if *rpm >= 0 {
		limit.RPMLimit = *rpm
	}
	if *tpm >= 0 {
		limit.TPMLimit = *tpm
	}
	if err := store.SetAccountConcurrencyLimit(ctx, limit); err != nil {
		return err
	}
	if *asJSON {
		return json.NewEncoder(runtime.stdout).Encode(map[string]any{"ok": true, "limit": limit, "enforced": false})
	}
	_, _ = fmt.Fprintf(runtime.stdout, "已设置账号覆盖: account=%s model=%s max=%d rpm=%d tpm=%d（并发已生效，rpm/tpm 未执行）\n",
		limit.AccountRef, displayOrAll(limit.ModelID), limit.MaxConcurrency, limit.RPMLimit, limit.TPMLimit)
	return nil
}

func limitsUnsetAccount(ctx context.Context, home string, runtime commandRuntime, args []string) error {
	flags := flag.NewFlagSet("limits unset-account", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	model := flags.String("model", "", "")
	asJSON := flags.Bool("json", false, "")
	positional, flagArgs := splitLeadingPositional(args)
	if err := flags.Parse(flagArgs); err != nil || len(positional) != 1 {
		return errors.New("limits unset-account <accountRef> [--model <model>]")
	}
	accountRef := strings.TrimSpace(positional[0])
	modelID := strings.TrimSpace(*model)
	store, err := openLimitsStore(ctx, home)
	if err != nil {
		return err
	}
	defer func() { _ = store.Close() }()
	removed, err := store.DeleteAccountConcurrencyLimit(ctx, accountRef, modelID)
	if err != nil {
		return err
	}
	if *asJSON {
		return json.NewEncoder(runtime.stdout).Encode(map[string]any{"ok": true, "account": accountRef, "model": modelID, "removed": removed})
	}
	if !removed {
		_, _ = fmt.Fprintf(runtime.stdout, "没有找到 %s / %s 的账号覆盖\n", accountRef, displayOrAll(modelID))
		return nil
	}
	_, _ = fmt.Fprintf(runtime.stdout, "已删除账号覆盖: account=%s model=%s\n", accountRef, displayOrAll(modelID))
	return nil
}

func limitsPreview(ctx context.Context, home string, runtime commandRuntime, args []string) error {
	flags := flag.NewFlagSet("limits preview", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	provider := flags.String("provider", "", "")
	accountRef := flags.String("account", "", "")
	model := flags.String("model", "", "")
	keyID := flags.String("key", "", "")
	asJSON := flags.Bool("json", false, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return errors.New("limits preview 参数无效")
	}
	config, err := readLimitsConfig(ctx, home)
	if err != nil {
		return err
	}
	store, err := openLimitsStore(ctx, home)
	if err != nil {
		return err
	}
	defer func() { _ = store.Close() }()
	limits, err := store.ListAccountConcurrencyLimits(ctx)
	if err != nil {
		return err
	}
	accountMax := config.AccountConcurrency(*provider, *accountRef, *model, limits)
	keyMax := 0
	key := strings.TrimSpace(*keyID)
	if key != "" && key != coreclientkeys.MasterKeyID {
		service, serviceErr := clientkeysapp.NewService(store, func() string { return "" }, time.Now)
		if serviceErr != nil {
			return serviceErr
		}
		loaded, getErr := service.Get(ctx, key)
		if getErr != nil {
			return getErr
		}
		keyMax = config.KeyConcurrency(loaded.Limits.MaxConcurrency)
	}
	effective := config.ClampToSystem(accountMax)
	if keyMax > 0 && (effective <= 0 || keyMax < effective) {
		effective = keyMax
	}
	result := map[string]any{
		"ok":                 true,
		"enforced":           false,
		"provider":           strings.TrimSpace(*provider),
		"account":            strings.TrimSpace(*accountRef),
		"model":              strings.TrimSpace(*model),
		"key":                key,
		"systemMax":          config.SystemMax,
		"accountMax":         accountMax,
		"keyMax":             keyMax,
		"providerDefault":    config.ProviderDefaults[strings.ToLower(strings.TrimSpace(*provider))],
		"accountDefault":     config.AccountDefault,
		"effective":          effective,
		"queueLimit":         config.QueueLimit,
		"queueWaitTimeoutMs": config.QueueWaitTimeoutMS,
		"retryAfterSeconds":  config.RetryAfterSeconds,
	}
	if *asJSON {
		return json.NewEncoder(runtime.stdout).Encode(result)
	}
	_, _ = fmt.Fprintf(runtime.stdout, "PROVIDER=%s ACCOUNT=%s MODEL=%s KEY=%s\n",
		displayOrAll(result["provider"].(string)), displayOrAll(result["account"].(string)),
		displayOrAll(result["model"].(string)), displayOrAll(key))
	_, _ = fmt.Fprintf(runtime.stdout, "systemMax=%d accountMax=%d keyMax=%d effective=%d\n", config.SystemMax, accountMax, keyMax, effective)
	_, _ = fmt.Fprintf(runtime.stdout, "providerDefault=%d accountDefault=%d (not enforced)\n",
		result["providerDefault"].(int), config.AccountDefault)
	return nil
}

func readLimitsConfig(ctx context.Context, home string) (concurrency.Config, error) {
	view, err := webuiserverconfigapi.ReadFullConfig(ctx, home)
	if err != nil {
		return concurrency.Config{}, err
	}
	return concurrency.ParseConfig(view.Concurrency)
}

func writeLimitsConfig(ctx context.Context, home string, config concurrency.Config) (concurrency.Config, error) {
	providerDefaults := config.ProviderDefaults
	if providerDefaults == nil {
		providerDefaults = map[string]int{}
	}
	payload := map[string]any{
		"systemMax":          config.SystemMax,
		"queueLimit":         config.QueueLimit,
		"queueWaitTimeoutMs": config.QueueWaitTimeoutMS,
		"retryAfterSeconds":  config.RetryAfterSeconds,
		"accountDefault":     config.AccountDefault,
		"providerDefaults":   providerDefaults,
	}
	view, err := webuiserverconfigapi.ApplyConfigPatch(ctx, home, map[string]any{"concurrency": payload})
	if err != nil {
		return concurrency.Config{}, err
	}
	return concurrency.ParseConfig(view.Concurrency)
}

func openLimitsStore(ctx context.Context, home string) (*sqliteaccount.Store, error) {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil, err
	}
	return sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{AIHomeDir: home, Catalog: catalog})
}

func printLimitsConfig(runtime commandRuntime, config concurrency.Config, asJSON bool) error {
	if asJSON {
		return json.NewEncoder(runtime.stdout).Encode(map[string]any{"ok": true, "concurrency": config, "enforced": false})
	}
	_, _ = fmt.Fprintf(runtime.stdout, "已保存并热生效: systemMax=%d queueLimit=%d queueWaitTimeoutMs=%d retryAfterSeconds=%d accountDefault=%d\n",
		config.SystemMax, config.QueueLimit, config.QueueWaitTimeoutMS, config.RetryAfterSeconds, config.AccountDefault)
	return nil
}

func sortedProviderDefaults(values map[string]int) []string {
	providersList := make([]string, 0, len(values))
	for provider := range values {
		providersList = append(providersList, provider)
	}
	sort.Strings(providersList)
	return providersList
}

// splitLeadingPositional 把命令名之后的第一个位置参数与后续 flag 分开；
// Go flag 包遇到第一个非 flag 参数就停止解析，因此不能直接传 "codex --max 4"。
func splitLeadingPositional(args []string) ([]string, []string) {
	positional := make([]string, 0, 1)
	index := 0
	for index < len(args) && !strings.HasPrefix(args[index], "-") {
		positional = append(positional, args[index])
		index++
	}
	return positional, args[index:]
}

func displayOrAll(value string) string {
	if strings.TrimSpace(value) == "" {
		return "*"
	}
	return value
}
