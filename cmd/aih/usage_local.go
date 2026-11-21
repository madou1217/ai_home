package main

import (
	"context"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/managementops"
)

// localUsageScanner 用本机会话文件同步刷新用量投影，扫描口径与服务端 ScanSync 相同。
type localUsageScanner struct {
	store        *managementops.UsageStore
	accountStore *sqliteaccount.Store
	catalog      *providers.Catalog
	aiHomeDir    string
	hostHomeDir  string
}

func (scanner *localUsageScanner) ScanSync(
	ctx context.Context,
	provider string,
) (managementops.UsageScanResult, error) {
	return managementops.ScanModelUsageSources(ctx, managementops.ScanUsageOptions{
		AIHomeDir:    scanner.aiHomeDir,
		HostHomeDir:  scanner.hostHomeDir,
		Store:        scanner.store,
		AccountStore: scanner.accountStore,
		Catalog:      scanner.catalog,
		Providers:    optionalProvider(provider),
	})
}

// openLocalUsageReader 打开本机 aih.db 的用量投影并组合同步扫描器。
//
// `aih usage` 读的是本机数据：会话文件在宿主机、投影库在 aih.db，都不需要运行中的
// Server，更不需要 Management Key。这里走与 WebUI 管理面相同的 UsageReader，
// 只是把传输层换成进程内调用。
func openLocalUsageReader(
	ctx context.Context,
	home string,
	runtime commandRuntime,
) (*managementops.UsageReader, func(), error) {
	cleanup := func() {}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil, cleanup, err
	}
	dbPath, err := appstate.DatabasePath(home)
	if err != nil {
		return nil, cleanup, err
	}
	store, err := managementops.NewUsageStore(ctx, dbPath, usageCatalogProviderIDs(catalog), time.Now)
	if err != nil {
		return nil, cleanup, err
	}
	// 账号库只用于扫描归属修正；未初始化时扫描仍可用，因此与 `usage scan` 一样容忍失败。
	accountStore, _ := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{AIHomeDir: home, Catalog: catalog})
	scanner := &localUsageScanner{
		store:        store,
		accountStore: accountStore,
		catalog:      catalog,
		aiHomeDir:    home,
		hostHomeDir:  hostHomeForCLI(runtime),
	}
	reader := managementops.NewUsageReader(store, scanner, func(provider string) bool {
		return catalog.Supports(provider, providers.CapabilityUsageScan)
	})
	return reader, func() {
		if accountStore != nil {
			_ = accountStore.Close()
		}
		_ = store.Close()
	}, nil
}

func usageCatalogProviderIDs(catalog *providers.Catalog) []string {
	if catalog == nil {
		return nil
	}
	ids := make([]string, 0)
	for _, item := range catalog.List() {
		if item.ID != "" {
			ids = append(ids, item.ID)
		}
	}
	return ids
}
