package sqliteaccount

import (
	"context"
	"sort"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// TestStoreListsEnabledAccountsForModelRefreshSweep 验证重扫包含已物化目录的账号
// （目录漂移正是要修的场景），排除停用和无凭据账号，并保持稳定 keyset 分页。
func TestStoreListsEnabledAccountsForModelRefreshSweep(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	pending := newCodexAPIKeyAccount(t, store, 1, "synthetic-sweep-pending")
	if err := store.Create(ctx, pending); err != nil {
		t.Fatalf("Create(pending) error = %v", err)
	}
	stale := registerInitialModelRefreshTestAccount(t, store, "synthetic-sweep-stale")
	fresh := registerInitialModelRefreshTestAccount(t, store, "synthetic-sweep-fresh")
	disabled := registerInitialModelRefreshTestAccount(t, store, "synthetic-sweep-disabled")

	staleModel := initialModelRefreshTestModelID(t, "gpt-5.6-terra")
	if _, err := store.ReplaceDiscoveredModels(
		ctx,
		stale.Ref(),
		[]runtimecore.ModelID{staleModel},
		testAccountTime(),
	); err != nil {
		t.Fatalf("ReplaceDiscoveredModels(stale) error = %v", err)
	}
	if _, err := store.SetEnabled(ctx, disabled.Ref(), false, testAccountTime()); err != nil {
		t.Fatalf("SetEnabled(false) error = %v", err)
	}

	wantRefs := []string{stale.Ref().String(), fresh.Ref().String()}
	sort.Strings(wantRefs)
	firstQuery, err := accountapp.NewModelRefreshSweepQuery("codex", "", 1)
	if err != nil {
		t.Fatalf("NewModelRefreshSweepQuery(first) error = %v", err)
	}
	first, err := store.ListModelRefreshSweepCandidates(ctx, firstQuery)
	if err != nil {
		t.Fatalf("ListModelRefreshSweepCandidates(first) error = %v", err)
	}
	if len(first) != 1 {
		t.Fatalf("首个重扫页数量 = %d, want 1", len(first))
	}
	restQuery, err := accountapp.NewModelRefreshSweepQuery("", first[0].AccountRef(), 10)
	if err != nil {
		t.Fatalf("NewModelRefreshSweepQuery(rest) error = %v", err)
	}
	rest, err := store.ListModelRefreshSweepCandidates(ctx, restQuery)
	if err != nil {
		t.Fatalf("ListModelRefreshSweepCandidates(rest) error = %v", err)
	}
	candidates := append(first, rest...)
	if len(candidates) != len(wantRefs) {
		t.Fatalf("重扫候选数量 = %d, want %d: %#v", len(candidates), len(wantRefs), candidates)
	}
	for index, candidate := range candidates {
		if candidate.AccountRef().String() != wantRefs[index] || candidate.ProviderID() != "codex" {
			t.Fatalf("重扫候选 %d = %#v, want ref=%s", index, candidate, wantRefs[index])
		}
	}

	otherProvider, err := accountapp.NewModelRefreshSweepQuery("claude", "", 10)
	if err != nil {
		t.Fatalf("NewModelRefreshSweepQuery(claude) error = %v", err)
	}
	none, err := store.ListModelRefreshSweepCandidates(ctx, otherProvider)
	if err != nil {
		t.Fatalf("ListModelRefreshSweepCandidates(claude) error = %v", err)
	}
	if len(none) != 0 {
		t.Fatalf("Provider 过滤失效: %#v", none)
	}
}

// TestModelRefreshSweepQueryAvoidsCredentialDocuments 验证重扫查询走主键且不读取凭据文档。
func TestModelRefreshSweepQueryAvoidsCredentialDocuments(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	rows, err := store.db.Query(
		"EXPLAIN QUERY PLAN "+modelRefreshSweepSQL,
		"",
		"codex",
		"codex",
		accountapp.ModelRefreshSweepBatchSize,
	)
	if err != nil {
		t.Fatalf("EXPLAIN QUERY PLAN error = %v", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	var details []string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatalf("scan query plan error = %v", err)
		}
		details = append(details, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate query plan error = %v", err)
	}
	queryPlan := strings.Join(details, "\n")
	if !strings.Contains(queryPlan, "SEARCH c USING PRIMARY KEY") {
		t.Fatalf("重扫查询计划 = %q, want credential primary key lookup", queryPlan)
	}
	if strings.Contains(modelRefreshSweepSQL, "credential_json") ||
		!strings.Contains(modelRefreshSweepSQL, "a.enabled = 1") {
		t.Fatalf("重扫 SQL 合同错误: %s", modelRefreshSweepSQL)
	}
}
