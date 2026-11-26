package main

// `aih client-keys`：离线管理客户端 API Key。
//
// 与 WebUI 使用同一张 aih.db 表；写路径不依赖 server 进程。创建/轮换只打印
// 一次明文 secret，其余命令只显示前缀。

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	clientkeysapp "github.com/madou1217/ai_home/application/clientkeys"
	"github.com/madou1217/ai_home/application/clientkeystats"
	coreclientkeys "github.com/madou1217/ai_home/core/clientkeys"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

func showClientKeysUsage(runtime commandRuntime) {
	lines := []string{
		"用法:",
		"  aih client-keys list [--json]",
		"  aih client-keys create --name <name> [--max-concurrency N] [--rpm N] [--tpm N]",
		"  aih client-keys show <key_id> [--json]",
		"  aih client-keys rename <key_id> --name <name>",
		"  aih client-keys enable|disable <key_id>",
		"  aih client-keys delete <key_id>",
		"  aih client-keys rotate <key_id>",
		"  aih client-keys limits <key_id> [--max-concurrency N] [--rpm N] [--tpm N] [--daily-tokens N]",
		"  aih client-keys stats [--key <id>] [--granularity minute|hour] [--from-ms N] [--to-ms N] [--json]",
		"",
		"说明:",
		"  secret 只在 create/rotate 输出一次；列表只显示前缀。",
		"  max-concurrency / rpm / tpm 字段本轮只存储和展示，尚未执行。",
	}
	for _, line := range lines {
		_, _ = fmt.Fprintln(runtime.stdout, line)
	}
}

func runClientKeys(ctx context.Context, args []string, runtime commandRuntime) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		showClientKeysUsage(runtime)
		return nil
	}
	home, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{AIHomeDir: home, Catalog: catalog})
	if err != nil {
		return err
	}
	defer func() { _ = store.Close() }()
	service, err := clientkeysapp.NewService(store, func() string { return "" }, time.Now)
	if err != nil {
		return err
	}
	switch strings.ToLower(args[0]) {
	case "list", "ls":
		return clientKeysList(ctx, service, store, runtime, args[1:])
	case "create":
		return clientKeysCreate(ctx, service, runtime, args[1:])
	case "show":
		return clientKeysShow(ctx, service, runtime, args[1:])
	case "rename":
		return clientKeysRename(ctx, service, runtime, args[1:])
	case "enable", "disable":
		return clientKeysSetEnabled(ctx, service, runtime, args[0], args[1:])
	case "delete", "revoke":
		return clientKeysDelete(ctx, service, runtime, args[1:])
	case "rotate":
		return clientKeysRotate(ctx, service, runtime, args[1:])
	case "limits":
		return clientKeysLimits(ctx, service, runtime, args[1:])
	case "stats":
		return clientKeysStats(ctx, store, runtime, args[1:])
	default:
		return fmt.Errorf("unknown client-keys action: %s", args[0])
	}
}

func clientKeysList(
	ctx context.Context,
	service *clientkeysapp.Service,
	store *sqliteaccount.Store,
	runtime commandRuntime,
	args []string,
) error {
	flags := flag.NewFlagSet("client-keys list", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	asJSON := flags.Bool("json", false, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return errors.New("client-keys list 参数无效")
	}
	keys, err := service.List(ctx)
	if err != nil {
		return err
	}
	live, _ := clientkeystats.NewTracker(clientkeystats.Options{Store: store, Clock: time.Now})
	var liveRows []clientkeystats.LiveRow
	if live != nil {
		liveRows = live.Live()
	}
	if *asJSON {
		return json.NewEncoder(runtime.stdout).Encode(map[string]any{
			"ok": true, "keys": keys, "live": liveRows,
		})
	}
	_, _ = fmt.Fprintln(runtime.stdout, "KEY_ID                    NAME                 PREFIX                    ENABLED  MAX_CONC  LAST_USED")
	for _, key := range keys {
		lastUsed := "-"
		if key.LastUsedAtMS > 0 {
			lastUsed = time.UnixMilli(key.LastUsedAtMS).Format("01-02 15:04")
		}
		_, _ = fmt.Fprintf(runtime.stdout, "%-25s %-20s %-25s %-8v %-9d %s\n",
			key.ID, key.Name, key.Prefix, key.Active(), key.Limits.MaxConcurrency, lastUsed)
	}
	return nil
}

func clientKeysCreate(ctx context.Context, service *clientkeysapp.Service, runtime commandRuntime, args []string) error {
	flags := flag.NewFlagSet("client-keys create", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	name := flags.String("name", "", "")
	limits := coreclientkeys.Limits{}
	flags.IntVar(&limits.MaxConcurrency, "max-concurrency", 0, "")
	flags.IntVar(&limits.RPMLimit, "rpm", 0, "")
	flags.IntVar(&limits.TPMLimit, "tpm", 0, "")
	flags.IntVar(&limits.DailyTokenLimit, "daily-tokens", 0, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return errors.New("client-keys create 参数无效")
	}
	key, secret, err := service.Create(ctx, *name, limits)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(runtime.stdout, "已创建客户端 API Key\n  ID:     %s\n  名称:   %s\n  前缀:   %s\n", key.ID, key.Name, key.Prefix)
	_, _ = fmt.Fprintf(runtime.stdout, "\nSecret（只显示一次，请立即保存）:\n%s\n", secret)
	_, _ = fmt.Fprintln(runtime.stderr, "提示：该 secret 不会再次显示；丢失后请执行 rotate。")
	return nil
}

func clientKeysShow(ctx context.Context, service *clientkeysapp.Service, runtime commandRuntime, args []string) error {
	flags := flag.NewFlagSet("client-keys show", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	asJSON := flags.Bool("json", false, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 1 {
		return errors.New("client-keys show 需要 <key_id>")
	}
	key, err := service.Get(ctx, flags.Arg(0))
	if err != nil {
		return err
	}
	if *asJSON {
		return json.NewEncoder(runtime.stdout).Encode(key)
	}
	_, _ = fmt.Fprintf(runtime.stdout, "ID: %s\n名称: %s\n前缀: %s\n启用: %v\n创建: %s\n最后使用: %s\n",
		key.ID, key.Name, key.Prefix, key.Active(),
		time.UnixMilli(key.CreatedAtMS).Format(time.RFC3339),
		formatOptionalMS(key.LastUsedAtMS))
	_, _ = fmt.Fprintf(runtime.stdout, "限流字段（未生效）: maxConcurrency=%d rpm=%d tpm=%d dailyTokens=%d\n",
		key.Limits.MaxConcurrency, key.Limits.RPMLimit, key.Limits.TPMLimit, key.Limits.DailyTokenLimit)
	return nil
}

func clientKeysRename(ctx context.Context, service *clientkeysapp.Service, runtime commandRuntime, args []string) error {
	flags := flag.NewFlagSet("client-keys rename", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	name := flags.String("name", "", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 1 || strings.TrimSpace(*name) == "" {
		return errors.New("client-keys rename <key_id> --name <name>")
	}
	key, err := service.Update(ctx, flags.Arg(0), func(key *coreclientkeys.Key) error {
		key.Name = strings.TrimSpace(*name)
		return nil
	})
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(runtime.stdout, "已重命名: %s -> %s\n", key.ID, key.Name)
	return nil
}

func clientKeysSetEnabled(
	ctx context.Context,
	service *clientkeysapp.Service,
	runtime commandRuntime,
	action string,
	args []string,
) error {
	if len(args) != 1 {
		return fmt.Errorf("client-keys %s 需要 <key_id>", action)
	}
	enabled := action == "enable"
	key, err := service.Update(ctx, args[0], func(key *coreclientkeys.Key) error {
		key.Enabled = enabled
		return nil
	})
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(runtime.stdout, "%s: %s\n", key.ID, enabledLabel(enabled))
	return nil
}

func clientKeysDelete(ctx context.Context, service *clientkeysapp.Service, runtime commandRuntime, args []string) error {
	if len(args) != 1 {
		return errors.New("client-keys delete 需要 <key_id>")
	}
	if err := service.Delete(ctx, args[0]); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(runtime.stdout, "已删除: %s\n", args[0])
	return nil
}

func clientKeysRotate(ctx context.Context, service *clientkeysapp.Service, runtime commandRuntime, args []string) error {
	if len(args) != 1 {
		return errors.New("client-keys rotate 需要 <key_id>")
	}
	secret, err := service.Rotate(ctx, args[0])
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(runtime.stdout, "已轮换 %s\n\nSecret（只显示一次）:\n%s\n", args[0], secret)
	return nil
}

func clientKeysLimits(ctx context.Context, service *clientkeysapp.Service, runtime commandRuntime, args []string) error {
	flags := flag.NewFlagSet("client-keys limits", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	maxConcurrency := flags.Int("max-concurrency", -1, "")
	rpm := flags.Int("rpm", -1, "")
	tpm := flags.Int("tpm", -1, "")
	daily := flags.Int("daily-tokens", -1, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 1 {
		return errors.New("client-keys limits <key_id> [flags]")
	}
	key, err := service.Update(ctx, flags.Arg(0), func(key *coreclientkeys.Key) error {
		if *maxConcurrency >= 0 {
			key.Limits.MaxConcurrency = *maxConcurrency
		}
		if *rpm >= 0 {
			key.Limits.RPMLimit = *rpm
		}
		if *tpm >= 0 {
			key.Limits.TPMLimit = *tpm
		}
		if *daily >= 0 {
			key.Limits.DailyTokenLimit = *daily
		}
		return nil
	})
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(runtime.stdout, "已更新限流字段（未生效）: maxConcurrency=%d rpm=%d tpm=%d dailyTokens=%d\n",
		key.Limits.MaxConcurrency, key.Limits.RPMLimit, key.Limits.TPMLimit, key.Limits.DailyTokenLimit)
	return nil
}

func clientKeysStats(
	ctx context.Context,
	store *sqliteaccount.Store,
	runtime commandRuntime,
	args []string,
) error {
	flags := flag.NewFlagSet("client-keys stats", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	key := flags.String("key", "", "")
	granularity := flags.String("granularity", coreclientkeys.GranularityMinute, "")
	fromMS := flags.Int64("from-ms", 0, "")
	toMS := flags.Int64("to-ms", 0, "")
	asJSON := flags.Bool("json", false, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return errors.New("client-keys stats 参数无效")
	}
	tracker, err := clientkeystats.NewTracker(clientkeystats.Options{Store: store, Clock: time.Now})
	if err != nil {
		return err
	}
	query := clientkeystats.Query{Granularity: *granularity, KeyID: strings.TrimSpace(*key)}
	if *fromMS > 0 {
		query.From = time.UnixMilli(*fromMS)
	}
	if *toMS > 0 {
		query.To = time.UnixMilli(*toMS)
	}
	attempts, err := tracker.QueryAttempts(ctx, query)
	if err != nil {
		return err
	}
	requests, err := tracker.QueryRequests(ctx, query)
	if err != nil {
		return err
	}
	if *asJSON {
		return json.NewEncoder(runtime.stdout).Encode(map[string]any{
			"ok": true, "attempts": attempts, "requests": requests, "live": tracker.Live(),
		})
	}
	_, _ = fmt.Fprintln(runtime.stdout, "REQUESTS")
	_, _ = fmt.Fprintln(runtime.stdout, "KEY_ID                    SURFACE              REQUESTS  ABORTED")
	for _, row := range requests {
		_, _ = fmt.Fprintf(runtime.stdout, "%-25s %-20s %-9d %d\n", row.KeyID, row.Surface, row.Requests, row.Aborted)
	}
	_, _ = fmt.Fprintln(runtime.stdout, "\nATTEMPTS")
	_, _ = fmt.Fprintln(runtime.stdout, "KEY_ID                    PROVIDER  MODEL        ACCOUNT                   ATT  OK  FAIL  TOKENS")
	for _, row := range attempts {
		_, _ = fmt.Fprintf(runtime.stdout, "%-25s %-9s %-12s %-25s %-4d %-3d %-5d %d\n",
			row.KeyID, row.ProviderID, row.ModelID, row.AccountRef,
			row.Attempts, row.Successes, row.Failures, row.TotalTokens)
	}
	return nil
}

func enabledLabel(enabled bool) string {
	if enabled {
		return "enabled"
	}
	return "disabled"
}

func formatOptionalMS(value int64) string {
	if value <= 0 {
		return "-"
	}
	return time.UnixMilli(value).Format(time.RFC3339)
}
