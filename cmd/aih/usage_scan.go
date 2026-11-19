package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
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
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] 模型用量扫描完成: files=%d, records=%d, prompts=%d, skipped=%d, filesDeferred=%d, reindexRequired=%d\n",
		result.Files, result.Records, result.Prompts, result.Skipped, result.FilesDeferred, result.ReindexRequired)
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
