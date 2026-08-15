package sqliteaccount

import (
	"context"
	"sort"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestStoreListsOnlyAccountsMissingUpstreamModels 验证恢复扫描只返回已有凭据且
// 没有任何 upstream_available=1 模型的账号，并保持稳定 keyset 顺序。
func TestStoreListsOnlyAccountsMissingUpstreamModels(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	pending := newCodexAPIKeyAccount(
		t,
		store,
		1,
		"synthetic-initial-recovery-pending",
	)
	if err := store.Create(ctx, pending); err != nil {
		t.Fatalf("Create(pending) error = %v", err)
	}

	empty := registerInitialModelRefreshTestAccount(
		t,
		store,
		"synthetic-initial-recovery-empty",
	)
	forced := registerInitialModelRefreshTestAccount(
		t,
		store,
		"synthetic-initial-recovery-forced",
	)
	disabled := registerInitialModelRefreshTestAccount(
		t,
		store,
		"synthetic-initial-recovery-disabled",
	)
	materialized := registerInitialModelRefreshTestAccount(
		t,
		store,
		"synthetic-initial-recovery-materialized",
	)

	forcedModel := initialModelRefreshTestModelID(t, "gpt-manually-enabled")
	if _, err := store.SetManualModelPolicy(
		ctx,
		forced.Ref(),
		forcedModel,
		accountapp.ModelPolicyForceEnable,
		testAccountTime(),
	); err != nil {
		t.Fatalf("SetManualModelPolicy(forced) error = %v", err)
	}
	disabledModel := initialModelRefreshTestModelID(t, "gpt-manually-disabled")
	if _, err := store.SetManualModelPolicy(
		ctx,
		disabled.Ref(),
		disabledModel,
		accountapp.ModelPolicyForceDisable,
		testAccountTime(),
	); err != nil {
		t.Fatalf("SetManualModelPolicy(disabled) error = %v", err)
	}
	upstreamModel := initialModelRefreshTestModelID(t, "gpt-upstream-materialized")
	if _, err := store.ReplaceDiscoveredModels(
		ctx,
		materialized.Ref(),
		[]runtimecore.ModelID{upstreamModel},
		testAccountTime(),
	); err != nil {
		t.Fatalf("ReplaceDiscoveredModels(materialized) error = %v", err)
	}
	if _, err := store.SetManualModelPolicy(
		ctx,
		materialized.Ref(),
		upstreamModel,
		accountapp.ModelPolicyForceDisable,
		testAccountTime(),
	); err != nil {
		t.Fatalf("SetManualModelPolicy(materialized) error = %v", err)
	}

	wantRefs := []string{
		empty.Ref().String(),
		forced.Ref().String(),
		disabled.Ref().String(),
	}
	sort.Strings(wantRefs)
	firstQuery, err := accountapp.NewInitialModelRefreshRecoveryQuery("", 2)
	if err != nil {
		t.Fatalf("NewInitialModelRefreshRecoveryQuery(first) error = %v", err)
	}
	first, err := store.ListInitialModelRefreshCandidates(ctx, firstQuery)
	if err != nil {
		t.Fatalf("ListInitialModelRefreshCandidates(first) error = %v", err)
	}
	if len(first) != 2 {
		t.Fatalf("首个恢复页数量 = %d, want 2", len(first))
	}
	secondQuery, err := accountapp.NewInitialModelRefreshRecoveryQuery(
		first[len(first)-1].AccountRef(),
		2,
	)
	if err != nil {
		t.Fatalf("NewInitialModelRefreshRecoveryQuery(second) error = %v", err)
	}
	second, err := store.ListInitialModelRefreshCandidates(ctx, secondQuery)
	if err != nil {
		t.Fatalf("ListInitialModelRefreshCandidates(second) error = %v", err)
	}
	candidates := append(first, second...)
	if len(candidates) != len(wantRefs) {
		t.Fatalf("恢复候选数量 = %d, want %d", len(candidates), len(wantRefs))
	}
	for index, candidate := range candidates {
		if candidate.AccountRef().String() != wantRefs[index] ||
			candidate.ProviderID() != "codex" {
			t.Fatalf("恢复候选 %d = %#v, want ref=%s", index, candidate, wantRefs[index])
		}
		if candidate.AccountRef() == pending.Ref() ||
			candidate.AccountRef() == materialized.Ref() {
			t.Fatalf("恢复扫描包含不应调度的账号: %s", candidate.AccountRef())
		}
	}
}

// TestInitialModelRefreshRecoveryQueryUsesPrimaryKeys 验证单条 NOT EXISTS 查询
// 使用账号、凭据和账号模型主键，不读取任何凭据文档。
func TestInitialModelRefreshRecoveryQueryUsesPrimaryKeys(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	rows, err := store.db.Query(
		"EXPLAIN QUERY PLAN "+initialModelRefreshRecoverySQL,
		"",
		accountapp.InitialModelRefreshRecoveryBatchSize,
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
	for _, expected := range []string{
		"SEARCH a USING PRIMARY KEY",
		"SEARCH c USING PRIMARY KEY",
		"SEARCH m USING PRIMARY KEY",
	} {
		if !strings.Contains(queryPlan, expected) {
			t.Fatalf("恢复查询计划 = %q, want %q", queryPlan, expected)
		}
	}
	if strings.Contains(initialModelRefreshRecoverySQL, "credential_json") ||
		strings.Count(initialModelRefreshRecoverySQL, "SELECT") != 2 ||
		!strings.Contains(initialModelRefreshRecoverySQL, "NOT EXISTS") {
		t.Fatalf("恢复 SQL 合同错误: %s", initialModelRefreshRecoverySQL)
	}
}

func registerInitialModelRefreshTestAccount(
	t *testing.T,
	store *Store,
	secret string,
) accountcore.Account {
	t.Helper()
	request := newRegistrationRequest(t, store, mustCodexAPIKey(t, secret), nil)
	account, err := store.RegisterNew(context.Background(), request)
	if err != nil {
		t.Fatalf("RegisterNew(%s) error = %v", secret, err)
	}
	return account
}

func initialModelRefreshTestModelID(
	t *testing.T,
	value string,
) runtimecore.ModelID {
	t.Helper()
	modelID, err := runtimecore.NewModelID(value)
	if err != nil {
		t.Fatalf("NewModelID(%s) error = %v", value, err)
	}
	return modelID
}
