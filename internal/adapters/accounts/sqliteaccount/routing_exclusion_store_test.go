package sqliteaccount

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

// openRoutingExclusionStore 建一个双账号临时库。
//
// 排除是账号级事实，单账号库分不清「被排除」和「本来就没有候选」。
func openRoutingExclusionStore(
	t *testing.T,
) (*Store, string, *providers.Catalog, [2]accountcore.AccountRef) {
	t.Helper()
	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	dir := t.TempDir()
	store, err := Open(ctx, OpenOptions{AIHomeDir: dir, Catalog: catalog})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	var refs [2]accountcore.AccountRef
	for index, text := range []string{
		"acct_0123456789abcdef0123",
		"acct_ffffffffffffffffffff",
	} {
		ref, parseErr := accountcore.ParseAccountRef(text)
		if parseErr != nil {
			t.Fatalf("ParseAccountRef(%q) error = %v", text, parseErr)
		}
		alias, aliasErr := accountcore.NewCLIAccountID(int64(index + 1))
		if aliasErr != nil {
			t.Fatalf("NewCLIAccountID() error = %v", aliasErr)
		}
		account, restoreErr := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
			Ref: ref, ProviderID: "codex", CLIAccountID: alias, Enabled: true,
			CreatedAt: time.UnixMilli(100).UTC(), UpdatedAt: time.UnixMilli(100).UTC(),
		})
		if restoreErr != nil {
			t.Fatalf("RestoreAccount() error = %v", restoreErr)
		}
		if createErr := store.Create(ctx, account); createErr != nil {
			t.Fatalf("Create() error = %v", createErr)
		}
		refs[index] = ref
	}
	return store, dir, catalog, refs
}

// publishModels 让账号带上上游发现模型，路由候选和目录才有内容可排除。
func publishModels(
	t *testing.T,
	store *Store,
	accountRef accountcore.AccountRef,
	models ...string,
) {
	t.Helper()
	ids := make([]runtimecore.ModelID, 0, len(models))
	for _, model := range models {
		modelID, err := runtimecore.NewModelID(model)
		if err != nil {
			t.Fatalf("NewModelID(%q) error = %v", model, err)
		}
		ids = append(ids, modelID)
	}
	if _, err := store.ReplaceDiscoveredModels(
		context.Background(),
		accountRef,
		ids,
		time.UnixMilli(200).UTC(),
	); err != nil {
		t.Fatalf("ReplaceDiscoveredModels() error = %v", err)
	}
}

func mustModelID(t *testing.T, value string) runtimecore.ModelID {
	t.Helper()
	modelID, err := runtimecore.NewModelID(value)
	if err != nil {
		t.Fatalf("NewModelID(%q) error = %v", value, err)
	}
	return modelID
}

// 排除必须同时退出路由候选和 /v1/models 目录：只退出一处，
// 请求会选中一个 Go 根本发不出去的自定义上游账号。
func TestRoutingExclusionLeavesCandidatesAndCatalog(t *testing.T) {
	ctx := context.Background()
	store, _, _, refs := openRoutingExclusionStore(t)
	publishModels(t, store, refs[0], "gpt-5", "gpt-5-codex")
	publishModels(t, store, refs[1], "gpt-5")

	gpt5 := mustModelID(t, "gpt-5")
	candidates, err := store.LoadRoutingCandidates(ctx, "codex", gpt5)
	if err != nil {
		t.Fatalf("LoadRoutingCandidates() error = %v", err)
	}
	if candidates.Len() != 2 {
		t.Fatalf("排除前候选数 = %d, want 2", candidates.Len())
	}

	if err := store.SetRoutingExclusion(
		ctx,
		refs[0],
		true,
		"自定义上游",
		time.UnixMilli(300).UTC(),
	); err != nil {
		t.Fatalf("SetRoutingExclusion() error = %v", err)
	}

	candidates, err = store.LoadRoutingCandidates(ctx, "codex", gpt5)
	if err != nil {
		t.Fatalf("LoadRoutingCandidates() error = %v", err)
	}
	if candidates.Len() != 1 {
		t.Fatalf("排除后候选数 = %d, want 1", candidates.Len())
	}
	if _, found := candidates.FindByRef(refs[0]); found {
		t.Fatal("被排除账号仍在路由候选里")
	}
	// 该模型只有被排除账号提供，目录里也必须消失。
	codexOnly, err := store.LoadRoutingCandidates(ctx, "codex", mustModelID(t, "gpt-5-codex"))
	if err != nil {
		t.Fatalf("LoadRoutingCandidates() error = %v", err)
	}
	if codexOnly.Len() != 0 {
		t.Fatalf("被排除账号独有模型的候选数 = %d, want 0", codexOnly.Len())
	}
	models, err := store.ListRoutableModels(ctx)
	if err != nil {
		t.Fatalf("ListRoutableModels() error = %v", err)
	}
	if len(models) != 1 || models[0].ModelID() != gpt5 {
		t.Fatalf("目录模型 = %+v, want 只剩 gpt-5", models)
	}
	exclusions, err := store.LoadRoutingExclusions(ctx)
	if err != nil {
		t.Fatalf("LoadRoutingExclusions() error = %v", err)
	}
	if !exclusions[refs[0].String()] || len(exclusions) != 1 {
		t.Fatalf("排除集合 = %+v, want 只含 %s", exclusions, refs[0])
	}

	// 解除排除后必须回到候选与目录，否则账号会被永久锁死。
	if err := store.SetRoutingExclusion(ctx, refs[0], false, "", time.UnixMilli(400).UTC()); err != nil {
		t.Fatalf("SetRoutingExclusion() error = %v", err)
	}
	candidates, err = store.LoadRoutingCandidates(ctx, "codex", gpt5)
	if err != nil {
		t.Fatalf("LoadRoutingCandidates() error = %v", err)
	}
	if candidates.Len() != 2 {
		t.Fatalf("解除排除后候选数 = %d, want 2", candidates.Len())
	}
	models, err = store.ListRoutableModels(ctx)
	if err != nil {
		t.Fatalf("ListRoutableModels() error = %v", err)
	}
	if len(models) != 2 {
		t.Fatalf("解除排除后目录模型数 = %d, want 2", len(models))
	}
}

// 重启后仍要记得排除：否则一次 Go 重启就把自定义上游账号放回候选。
func TestRoutingExclusionSurvivesReopen(t *testing.T) {
	ctx := context.Background()
	store, dir, catalog, refs := openRoutingExclusionStore(t)
	publishModels(t, store, refs[0], "gpt-5")
	if err := store.SetRoutingExclusion(
		ctx,
		refs[0],
		true,
		"自定义上游",
		time.UnixMilli(300).UTC(),
	); err != nil {
		t.Fatalf("SetRoutingExclusion() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	reopened, err := Open(ctx, OpenOptions{AIHomeDir: dir, Catalog: catalog})
	if err != nil {
		t.Fatalf("重新 Open() error = %v", err)
	}
	defer func() { _ = reopened.Close() }()
	candidates, err := reopened.LoadRoutingCandidates(ctx, "codex", mustModelID(t, "gpt-5"))
	if err != nil {
		t.Fatalf("LoadRoutingCandidates() error = %v", err)
	}
	if candidates.Len() != 0 {
		t.Fatalf("重启后候选数 = %d, want 0", candidates.Len())
	}
	exclusions, err := reopened.LoadRoutingExclusions(ctx)
	if err != nil {
		t.Fatalf("LoadRoutingExclusions() error = %v", err)
	}
	if !exclusions[refs[0].String()] {
		t.Fatalf("重启后排除集合 = %+v, want 含 %s", exclusions, refs[0])
	}
}

func TestSetRoutingExclusionRejectsUnknownAccount(t *testing.T) {
	ctx := context.Background()
	store, _, _, _ := openRoutingExclusionStore(t)
	missing, err := accountcore.ParseAccountRef("acct_00000000000000000000")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	err = store.SetRoutingExclusion(ctx, missing, true, "", time.UnixMilli(300).UTC())
	if !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("SetRoutingExclusion() error = %v, want ErrAccountNotFound", err)
	}
}

// 表缺失时读排除必须是空集合而不是错误：账号视图读不出来比少一条排除更糟。
func TestLoadRoutingExclusionsWithoutTable(t *testing.T) {
	ctx := context.Background()
	store, _, _, refs := openRoutingExclusionStore(t)
	if err := store.SetRoutingExclusion(ctx, refs[0], true, "", time.UnixMilli(300).UTC()); err != nil {
		t.Fatalf("SetRoutingExclusion() error = %v", err)
	}
	if _, err := store.db.ExecContext(ctx, "DROP TABLE account_routing_exclusions"); err != nil {
		t.Fatalf("DROP TABLE error = %v", err)
	}
	exclusions, err := store.LoadRoutingExclusions(ctx)
	if err != nil {
		t.Fatalf("LoadRoutingExclusions() error = %v", err)
	}
	if len(exclusions) != 0 {
		t.Fatalf("缺表时排除集合 = %+v, want 空", exclusions)
	}
}
