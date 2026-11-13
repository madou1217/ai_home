package housekeeping

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// ProjectionPruneOptions 配置陈旧运行时投影清理任务的输入与安全端口。
type ProjectionPruneOptions struct {
	AIHomeDir      string
	Catalog        *providers.Catalog
	KnownProviders map[string]struct{}
	Accounts       RegisteredAccountsReader
	Reconciler     ResourceReconciler
}

// PruneStaleRuntimeProjections 扫描 auth-projections 与 codex-desktop 目录，
// 保留仍在账号表中的目录；对孤立目录先完成资源对账，成功后再整棵删除。
func PruneStaleRuntimeProjections(
	ctx context.Context,
	opts ProjectionPruneOptions,
) (PruneSummary, error) {
	if ctx == nil ||
		strings.TrimSpace(opts.AIHomeDir) == "" ||
		opts.Accounts == nil ||
		opts.Reconciler == nil {
		return PruneSummary{}, ErrInvalidOptions
	}
	if err := ctx.Err(); err != nil {
		return PruneSummary{}, err
	}

	knownProviders := resolveKnownProviders(opts)
	accounts, err := opts.Accounts.ListRegisteredAccounts(ctx)
	if err != nil {
		return PruneSummary{}, err
	}

	registered := make(map[string]struct{}, len(accounts))
	for _, account := range accounts {
		provider := strings.ToLower(strings.TrimSpace(account.Provider))
		ref := strings.TrimSpace(account.AccountRef)
		if provider != "" && IsValidAccountRef(ref) {
			registered[provider+":"+ref] = struct{}{}
		}
	}

	var summary PruneSummary
	aiHomeDir := filepath.Clean(strings.TrimSpace(opts.AIHomeDir))

	authProjectionsRoot := filepath.Join(aiHomeDir, "run", "auth-projections")
	providerEntries, err := os.ReadDir(authProjectionsRoot)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return PruneSummary{}, err
	}
	for _, providerEntry := range providerEntries {
		if err := ctx.Err(); err != nil {
			return summary, err
		}
		providerName := providerEntry.Name()
		if !isPlainDirEntry(providerEntry) {
			summary.Failed++
			continue
		}
		if _, known := knownProviders[providerName]; !known {
			summary.Failed++
			continue
		}
		providerDir := filepath.Join(authProjectionsRoot, providerName)
		accountEntries, readErr := os.ReadDir(providerDir)
		if readErr != nil {
			summary.Failed++
			continue
		}
		pruneAccountRootEntries(ctx, accountEntries, providerDir, providerName, "auth-projections", knownProviders, registered, opts.Reconciler, &summary)
	}

	codexDesktopRoot := filepath.Join(aiHomeDir, "run", "codex-desktop")
	desktopEntries, err := os.ReadDir(codexDesktopRoot)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return PruneSummary{}, err
	}
	if len(desktopEntries) > 0 {
		pruneAccountRootEntries(ctx, desktopEntries, codexDesktopRoot, "codex", "codex-desktop", knownProviders, registered, opts.Reconciler, &summary)
	}

	return summary, nil
}

func pruneAccountRootEntries(
	ctx context.Context,
	entries []os.DirEntry,
	parentDir string,
	provider string,
	rootKind string,
	knownProviders map[string]struct{},
	registered map[string]struct{},
	reconciler ResourceReconciler,
	summary *PruneSummary,
) {
	_, providerKnown := knownProviders[provider]
	for _, entry := range entries {
		if ctx.Err() != nil {
			summary.Failed++
			continue
		}
		accountRef := entry.Name()
		if !providerKnown || !isPlainDirEntry(entry) || !IsValidAccountRef(accountRef) {
			summary.Failed++
			continue
		}
		if _, active := registered[provider+":"+accountRef]; active {
			summary.Kept++
			continue
		}
		entryPath := filepath.Join(parentDir, accountRef)
		if err := reconciler.Reconcile(ctx, provider, accountRef, rootKind, entryPath); err != nil {
			summary.Failed++
			continue
		}
		if err := os.RemoveAll(entryPath); err != nil {
			summary.Failed++
			continue
		}
		summary.Removed++
	}
}

func resolveKnownProviders(opts ProjectionPruneOptions) map[string]struct{} {
	if len(opts.KnownProviders) > 0 {
		out := make(map[string]struct{}, len(opts.KnownProviders))
		for k := range opts.KnownProviders {
			if normalized := strings.ToLower(strings.TrimSpace(k)); normalized != "" {
				out[normalized] = struct{}{}
			}
		}
		return out
	}
	catalog := opts.Catalog
	if catalog == nil {
		if built, err := providers.NewCatalog(providers.BuiltinManifest()); err == nil {
			catalog = built
		}
	}
	if catalog == nil {
		return nil
	}
	defs := catalog.List()
	out := make(map[string]struct{}, len(defs))
	for _, def := range defs {
		out[def.ID] = struct{}{}
	}
	return out
}

func isPlainDirEntry(entry os.DirEntry) bool {
	return entry.IsDir() && entry.Type()&os.ModeSymlink == 0
}
