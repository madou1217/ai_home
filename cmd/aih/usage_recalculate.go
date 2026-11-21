package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/managementops"
)

func runUsageRecalculateCosts(ctx context.Context, home string, options usageOptions, runtime commandRuntime) error {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return err
	}
	dbPath, err := appstate.DatabasePath(home)
	if err != nil {
		return err
	}
	store, err := managementops.NewUsageStore(ctx, dbPath, usageCatalogProviderIDs(catalog), time.Now)
	if err != nil {
		return err
	}
	defer store.Close()
	result, err := store.RecalculateCosts(ctx, options.dryRun)
	if err != nil {
		return err
	}
	if options.json {
		encoded, err := json.MarshalIndent(map[string]any{"ok": true, "command": "recalculate-costs", "dryRun": options.dryRun, "result": result}, "", "  ")
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
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] 模型用量成本重算完成%s: scanned=%d, recalculated=%d, batches=%d\n",
		mode, result.Scanned, result.Recalculated, result.Batches)
	return nil
}
