package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"github.com/madou1217/ai_home/internal/runtime/managementops"
)

func runUsageScan(ctx context.Context, home string, options usageOptions, runtime commandRuntime) error {
	provider := options.provider
	if options.reindexCodexForkHistory {
		provider = "codex"
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return err
	}
	dbPath, err := appstate.DatabasePath(home)
	if err != nil {
		return err
	}
	cleanup := func() {}
	if options.dryRun {
		dbPath, cleanup, err = dryRunDatabase(ctx, dbPath)
		if err != nil {
			return err
		}
	}
	defer cleanup()
	ids := make([]string, 0)
	for _, item := range catalog.List() {
		if item.ID != "" {
			ids = append(ids, item.ID)
		}
	}
	store, err := managementops.NewUsageStore(ctx, dbPath, ids, time.Now)
	if err != nil {
		return err
	}
	defer store.Close()
	accountStore, _ := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{AIHomeDir: home, Catalog: catalog})
	if accountStore != nil {
		defer accountStore.Close()
	}
	result, err := managementops.ScanModelUsageSources(ctx, managementops.ScanUsageOptions{
		AIHomeDir: home, HostHomeDir: hostHomeForCLI(runtime),
		Store: store, AccountStore: accountStore, Catalog: catalog,
		Providers: optionalProvider(provider), ProviderIDs: optionalProvider(provider),
		ReindexCodexForkHistory: options.reindexCodexForkHistory,
	})
	if err != nil {
		return err
	}
	if options.json {
		encoded, err := json.MarshalIndent(map[string]any{"ok": true, "command": "scan", "result": result}, "", "  ")
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
		return nil
	}
	mode := ""
	if options.dryRun {
		mode = " (dry-run)"
	}
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] 模型用量扫描完成%s: files=%d, records=%d, prompts=%d, skipped=%d, filesDeferred=%d, reindexRequired=%d\n",
		mode, result.Files, result.Records, result.Prompts, result.Skipped, result.FilesDeferred, result.ReindexRequired)
	for name, item := range result.Providers {
		reason := ""
		if item.Reason != "" {
			reason = " (" + item.Reason + ")"
		}
		_, _ = fmt.Fprintf(runtime.stdout, "  - %s: files=%d, records=%d, prompts=%d, skipped=%d, filesDeferred=%d, reindexRequired=%d%s\n",
			name, item.Files, item.Records, item.Prompts, item.Skipped, item.FilesDeferred, item.ReindexRequired, reason)
	}
	if result.ReindexRequired > 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "  需要显式维护: aih usage scan --reindex-codex-forks")
	}
	return nil
}

func dryRunDatabase(ctx context.Context, source string) (string, func(), error) {
	temp, err := os.CreateTemp("", "aih-usage-dry-*.db")
	if err != nil {
		return "", func() {}, err
	}
	path := temp.Name()
	_ = temp.Close()
	_ = os.Remove(path)
	// VACUUM INTO 要拿读锁；服务端在写时裸 DSN（busy_timeout=0）会立刻失败。
	// 用带忙等的只读 file URI 打开，让 CLI 在并发写期间正常等待。
	fileURL := sqlitefile.URL(source)
	query := fileURL.Query()
	query.Set("mode", "ro")
	query.Add("_pragma", "busy_timeout(5000)")
	fileURL.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", fileURL.String())
	if err != nil {
		return "", func() {}, err
	}
	if _, err := db.ExecContext(ctx, "VACUUM INTO ?", path); err != nil {
		_ = db.Close()
		_ = os.Remove(path)
		return "", func() {}, err
	}
	_ = db.Close()
	return path, func() { _ = os.Remove(path) }, nil
}

func optionalProvider(provider string) []string {
	if provider == "" {
		return nil
	}
	return []string{provider}
}

func hostHomeForCLI(runtime commandRuntime) string {
	if value := readEnv(runtime.lookupEnv, "HOME"); value != "" {
		return value
	}
	home, _ := runtime.userHomeDir()
	return home
}
