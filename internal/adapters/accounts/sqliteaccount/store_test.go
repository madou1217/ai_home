package sqliteaccount

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

func TestStoreCreatesReadsAndDisablesAccount(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	account := newCodexAPIKeyAccount(t, store, 7, "sk-test-store-secret")

	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	byRef, err := store.GetByRef(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetByRef() error = %v", err)
	}
	byAlias, err := store.GetByCLIAccountID(ctx, " CODEX ", account.CLIAccountID())
	if err != nil {
		t.Fatalf("GetByCLIAccountID() error = %v", err)
	}
	if byRef != account || byAlias != account {
		t.Fatalf("读取账号不一致: byRef=%#v byAlias=%#v", byRef, byAlias)
	}

	changedAt := account.UpdatedAt().Add(time.Second)
	disabled, err := store.SetEnabled(ctx, account.Ref(), false, changedAt)
	if err != nil {
		t.Fatalf("SetEnabled(false) error = %v", err)
	}
	if disabled.Enabled() || !disabled.UpdatedAt().Equal(changedAt) {
		t.Fatalf("禁用账号结果错误: %#v", disabled)
	}
	unchanged, err := store.SetEnabled(ctx, account.Ref(), false, time.Time{})
	if err != nil || unchanged != disabled {
		t.Fatalf("幂等 SetEnabled() = (%#v, %v), want unchanged", unchanged, err)
	}
}

func TestStoreMapsIdentityAndAliasCollisions(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	first := newCodexAPIKeyAccount(t, store, 1, "sk-test-first-store-secret")
	sameAlias := newCodexAPIKeyAccount(t, store, 1, "sk-test-second-store-secret")

	if err := store.Create(ctx, first); err != nil {
		t.Fatalf("Create(first) error = %v", err)
	}
	for _, account := range []accountcore.Account{first, sameAlias} {
		err := store.Create(ctx, account)
		if !errors.Is(err, accountapp.ErrAccountConflict) {
			t.Fatalf("Create(conflict) error = %v, want ErrAccountConflict", err)
		}
	}
}

func TestStoreListsRoutingCandidatesWithStableCursor(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	createdAt := testAccountTime()
	models, err := accountapp.NormalizeDiscoveredModels([]string{"gpt-5.6-sol"})
	if err != nil {
		t.Fatalf("NormalizeDiscoveredModels() error = %v", err)
	}
	for index := 1; index <= 40; index++ {
		account := newCodexAPIKeyAccountAt(
			t,
			store,
			int64(index),
			fmt.Sprintf("sk-test-routing-secret-%d", index),
			createdAt,
		)
		if index%5 == 0 {
			var err error
			account, err = account.WithEnabled(false, createdAt.Add(time.Second))
			if err != nil {
				t.Fatalf("WithEnabled(false) error = %v", err)
			}
		}
		if err := store.Create(ctx, account); err != nil {
			t.Fatalf("Create(%d) error = %v", index, err)
		}
		if _, err := store.ReplaceDiscoveredModels(
			ctx,
			account.Ref(),
			models,
			createdAt,
		); err != nil {
			t.Fatalf("ReplaceDiscoveredModels(%d) error = %v", index, err)
		}
	}

	query, err := accountapp.NewRoutingQuery(
		store.catalog,
		"codex",
		"gpt-5.6-sol",
		"",
		10,
	)
	if err != nil {
		t.Fatalf("NewRoutingQuery(first) error = %v", err)
	}
	firstPage, err := store.ListRoutingCandidates(ctx, query)
	if err != nil {
		t.Fatalf("ListRoutingCandidates(first) error = %v", err)
	}
	if len(firstPage) != 10 {
		t.Fatalf("first page count = %d, want 10", len(firstPage))
	}
	nextQuery, err := accountapp.NewRoutingQuery(
		store.catalog,
		"codex",
		"gpt-5.6-sol",
		firstPage[len(firstPage)-1].Ref(),
		10,
	)
	if err != nil {
		t.Fatalf("NewRoutingQuery(next) error = %v", err)
	}
	secondPage, err := store.ListRoutingCandidates(ctx, nextQuery)
	if err != nil {
		t.Fatalf("ListRoutingCandidates(next) error = %v", err)
	}
	if len(secondPage) != 10 || secondPage[0].Ref() <= firstPage[len(firstPage)-1].Ref() {
		t.Fatalf("第二页游标错误: first=%#v second=%#v", firstPage, secondPage)
	}

	var enabledCount int
	if err := store.db.QueryRowContext(
		ctx,
		"SELECT COUNT(*) FROM accounts WHERE provider_id = 'codex' AND enabled = 1",
	).Scan(&enabledCount); err != nil {
		t.Fatalf("count enabled accounts error = %v", err)
	}
	if enabledCount != 32 {
		t.Fatalf("enabled count = %d, want 32", enabledCount)
	}
}

func TestStoreRoutingQueryDoesNotReadSQLite(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	ctx := context.Background()
	account := newCodexAPIKeyAccount(t, store, 1, "sk-local-index")
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	models, err := accountapp.NormalizeDiscoveredModels([]string{"gpt-5.6-sol"})
	if err != nil {
		t.Fatalf("NormalizeDiscoveredModels() error = %v", err)
	}
	if _, err := store.ReplaceDiscoveredModels(
		ctx,
		account.Ref(),
		models,
		testAccountTime(),
	); err != nil {
		t.Fatalf("ReplaceDiscoveredModels() error = %v", err)
	}
	query, err := accountapp.NewRoutingQuery(
		store.catalog,
		"codex",
		"gpt-5.6-sol",
		"",
		1,
	)
	if err != nil {
		t.Fatalf("NewRoutingQuery() error = %v", err)
	}
	if err := store.db.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	candidates, err := store.ListRoutingCandidates(ctx, query)
	if err != nil {
		t.Fatalf("ListRoutingCandidates() error = %v", err)
	}
	if len(candidates) != 1 || candidates[0].Ref() != account.Ref() {
		t.Fatalf("local candidates = %#v", candidates)
	}
}

// TestStoreAtomicallyPublishesRoutingSnapshots 验证管理写发布新快照且不修改在途旧快照。
func TestStoreAtomicallyPublishesRoutingSnapshots(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	account := newCodexAPIKeyAccount(t, store, 1, "sk-atomic-routing-snapshot")
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	models, err := accountapp.NormalizeDiscoveredModels([]string{"gpt-5.6-sol"})
	if err != nil {
		t.Fatalf("NormalizeDiscoveredModels() error = %v", err)
	}
	if _, err := store.ReplaceDiscoveredModels(
		ctx,
		account.Ref(),
		models,
		testAccountTime(),
	); err != nil {
		t.Fatalf("ReplaceDiscoveredModels() error = %v", err)
	}
	modelID := mustModelID(t, "gpt-5.6-sol")
	oldSnapshot, err := store.LoadRoutingCandidates(ctx, "codex", modelID)
	if err != nil || oldSnapshot.Len() != 1 {
		t.Fatalf("LoadRoutingCandidates(old) len=%d error=%v", oldSnapshot.Len(), err)
	}
	if _, err := store.SetEnabled(
		ctx,
		account.Ref(),
		false,
		testAccountTime().Add(time.Second),
	); err != nil {
		t.Fatalf("SetEnabled(false) error = %v", err)
	}
	newSnapshot, err := store.LoadRoutingCandidates(ctx, "codex", modelID)
	if err != nil {
		t.Fatalf("LoadRoutingCandidates(new) error = %v", err)
	}
	oldAccount, oldFound := oldSnapshot.At(0)
	if oldSnapshot.Len() != 1 ||
		!oldFound ||
		oldAccount.Ref() != account.Ref() ||
		newSnapshot.Len() != 0 {
		t.Fatalf(
			"old_len=%d old_found=%t old_ref=%s new_len=%d",
			oldSnapshot.Len(),
			oldFound,
			oldAccount.Ref(),
			newSnapshot.Len(),
		)
	}
}

// TestStoreListsUniqueRoutableModelsWithoutSQLite 验证标准目录只读取本地倒排。
func TestStoreListsUniqueRoutableModelsWithoutSQLite(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	first := newCodexAPIKeyAccount(t, store, 1, "sk-model-list-first")
	second := newCodexAPIKeyAccount(t, store, 2, "sk-model-list-second")
	for _, account := range []accountcore.Account{first, second} {
		if err := store.Create(ctx, account); err != nil {
			t.Fatalf("Create() error = %v", err)
		}
		models, err := accountapp.NormalizeDiscoveredModels(
			[]string{"gpt-shared", "gpt-zeta"},
		)
		if err != nil {
			t.Fatalf("NormalizeDiscoveredModels() error = %v", err)
		}
		if _, err := store.ReplaceDiscoveredModels(
			ctx,
			account.Ref(),
			models,
			testAccountTime(),
		); err != nil {
			t.Fatalf("ReplaceDiscoveredModels() error = %v", err)
		}
	}
	if _, err := store.SetEnabled(
		ctx,
		second.Ref(),
		false,
		testAccountTime().Add(time.Second),
	); err != nil {
		t.Fatalf("SetEnabled(false) error = %v", err)
	}
	if err := store.db.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	models, err := store.ListRoutableModels(ctx)
	if err != nil {
		t.Fatalf("ListRoutableModels() error = %v", err)
	}
	if len(models) != 2 ||
		models[0].ProviderID() != "codex" ||
		models[0].ModelID().String() != "gpt-shared" ||
		models[1].ModelID().String() != "gpt-zeta" {
		t.Fatalf("routable models = %#v", models)
	}
}

// TestStorePreservesManualPoliciesAcrossDiscoveryRefresh 验证自动发现不会覆盖人工策略。
func TestStorePreservesManualPoliciesAcrossDiscoveryRefresh(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	account := newCodexAPIKeyAccount(t, store, 1, "sk-model-policy")
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	discovered, err := accountapp.NormalizeDiscoveredModels(
		[]string{"gpt-disabled", "gpt-removed"},
	)
	if err != nil {
		t.Fatalf("NormalizeDiscoveredModels(initial) error = %v", err)
	}
	if _, err := store.ReplaceDiscoveredModels(
		ctx,
		account.Ref(),
		discovered,
		testAccountTime(),
	); err != nil {
		t.Fatalf("ReplaceDiscoveredModels(initial) error = %v", err)
	}
	if _, err := store.SetManualModelPolicy(
		ctx,
		account.Ref(),
		mustModelID(t, "gpt-disabled"),
		accountapp.ModelPolicyForceDisable,
		testAccountTime().Add(time.Second),
	); err != nil {
		t.Fatalf("SetManualModelPolicy(disable) error = %v", err)
	}
	if _, err := store.SetManualModelPolicy(
		ctx,
		account.Ref(),
		mustModelID(t, "gpt-manual"),
		accountapp.ModelPolicyForceEnable,
		testAccountTime().Add(2*time.Second),
	); err != nil {
		t.Fatalf("SetManualModelPolicy(enable) error = %v", err)
	}
	refreshed, err := accountapp.NormalizeDiscoveredModels(
		[]string{"gpt-disabled", "gpt-new"},
	)
	if err != nil {
		t.Fatalf("NormalizeDiscoveredModels(refresh) error = %v", err)
	}
	snapshot, err := store.ReplaceDiscoveredModels(
		ctx,
		account.Ref(),
		refreshed,
		testAccountTime().Add(3*time.Second),
	)
	if err != nil {
		t.Fatalf("ReplaceDiscoveredModels(refresh) error = %v", err)
	}
	assertAccountModelSnapshot(t, snapshot, map[string]modelExpectation{
		"gpt-disabled": {
			upstream:  true,
			policy:    accountapp.ModelPolicyForceDisable,
			effective: false,
		},
		"gpt-manual": {
			upstream:  false,
			policy:    accountapp.ModelPolicyForceEnable,
			effective: true,
		},
		"gpt-new": {
			upstream:  true,
			policy:    accountapp.ModelPolicyInherit,
			effective: true,
		},
	})
	assertRoutingCandidateCount(t, store, "gpt-disabled", 0)
	assertRoutingCandidateCount(t, store, "gpt-removed", 0)
	assertRoutingCandidateCount(t, store, "gpt-manual", 1)
	assertRoutingCandidateCount(t, store, "gpt-new", 1)

	snapshot, err = store.SetManualModelPolicy(
		ctx,
		account.Ref(),
		mustModelID(t, "gpt-manual"),
		accountapp.ModelPolicyInherit,
		testAccountTime().Add(4*time.Second),
	)
	if err != nil {
		t.Fatalf("SetManualModelPolicy(inherit) error = %v", err)
	}
	if len(snapshot) != 2 {
		t.Fatalf("inherit 应清理无上游来源模型: %#v", snapshot)
	}
	assertRoutingCandidateCount(t, store, "gpt-manual", 0)
}

// TestStoreKeepsRoutingIndexConsistentDuringConcurrentEnableAndModelWrites
// 验证启停事务与模型事务并发时，SQLite 最终事实和本地正排、倒排保持一致。
func TestStoreKeepsRoutingIndexConsistentDuringConcurrentEnableAndModelWrites(
	t *testing.T,
) {
	t.Parallel()

	const rounds = 32
	ctx := context.Background()
	store := openTestStore(t)
	account := newCodexAPIKeyAccount(t, store, 1, "sk-routing-write-order")
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	modelA, err := accountapp.NormalizeDiscoveredModels([]string{"gpt-write-a"})
	if err != nil {
		t.Fatalf("NormalizeDiscoveredModels(a) error = %v", err)
	}
	modelB, err := accountapp.NormalizeDiscoveredModels([]string{"gpt-write-b"})
	if err != nil {
		t.Fatalf("NormalizeDiscoveredModels(b) error = %v", err)
	}
	if _, err := store.ReplaceDiscoveredModels(
		ctx,
		account.Ref(),
		modelA,
		testAccountTime(),
	); err != nil {
		t.Fatalf("ReplaceDiscoveredModels(initial) error = %v", err)
	}

	lifecycleTime := testAccountTime()
	for round := range rounds {
		start := make(chan struct{})
		writeErrors := make(chan error, 2)
		var waitGroup sync.WaitGroup
		waitGroup.Add(2)
		lifecycleTime = lifecycleTime.Add(time.Second)
		disableAt := lifecycleTime
		go func() {
			defer waitGroup.Done()
			<-start
			_, writeErr := store.SetEnabled(
				ctx,
				account.Ref(),
				false,
				disableAt,
			)
			writeErrors <- writeErr
		}()
		go func() {
			defer waitGroup.Done()
			<-start
			_, writeErr := store.ReplaceDiscoveredModels(
				ctx,
				account.Ref(),
				modelB,
				testAccountTime().Add(time.Duration(round+1)*time.Minute),
			)
			writeErrors <- writeErr
		}()
		close(start)
		waitGroup.Wait()
		close(writeErrors)
		for writeErr := range writeErrors {
			if writeErr != nil {
				t.Fatalf("round %d concurrent write error = %v", round, writeErr)
			}
		}

		storedAccount, err := store.GetByRef(ctx, account.Ref())
		if err != nil {
			t.Fatalf("round %d GetByRef() error = %v", round, err)
		}
		storedModels, err := store.ListAccountModels(ctx, account.Ref())
		if err != nil {
			t.Fatalf("round %d ListAccountModels() error = %v", round, err)
		}
		if storedAccount.Enabled() ||
			len(storedModels) != 1 ||
			storedModels[0].ModelID().String() != "gpt-write-b" ||
			!storedModels[0].Effective() {
			t.Fatalf(
				"round %d sqlite snapshot account=%#v models=%#v",
				round,
				storedAccount,
				storedModels,
			)
		}
		assertRoutingCandidateCount(t, store, "gpt-write-a", 0)
		assertRoutingCandidateCount(t, store, "gpt-write-b", 0)

		lifecycleTime = lifecycleTime.Add(time.Second)
		if _, err := store.SetEnabled(
			ctx,
			account.Ref(),
			true,
			lifecycleTime,
		); err != nil {
			t.Fatalf("round %d SetEnabled(true) error = %v", round, err)
		}
		assertRoutingCandidateCount(t, store, "gpt-write-a", 0)
		assertRoutingCandidateCount(t, store, "gpt-write-b", 1)
		if _, err := store.ReplaceDiscoveredModels(
			ctx,
			account.Ref(),
			modelA,
			testAccountTime().Add(time.Duration(round+1)*time.Hour),
		); err != nil {
			t.Fatalf("round %d reset models error = %v", round, err)
		}
		assertRoutingCandidateCount(t, store, "gpt-write-a", 1)
		assertRoutingCandidateCount(t, store, "gpt-write-b", 0)
	}
}

// TestStoreRebuildsRoutingIndexesAfterRestart 验证正排和倒排只从持久快照重建。
func TestStoreRebuildsRoutingIndexesAfterRestart(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	aiHomeDir := t.TempDir()
	first := openTestStoreAt(t, aiHomeDir)
	account := newCodexAPIKeyAccount(t, first, 1, "sk-routing-restart")
	if err := first.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	models, err := accountapp.NormalizeDiscoveredModels(
		[]string{"gpt-restart-a", "gpt-restart-b"},
	)
	if err != nil {
		t.Fatalf("NormalizeDiscoveredModels() error = %v", err)
	}
	if _, err := first.ReplaceDiscoveredModels(
		ctx,
		account.Ref(),
		models,
		testAccountTime(),
	); err != nil {
		t.Fatalf("ReplaceDiscoveredModels() error = %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("first.Close() error = %v", err)
	}
	second, err := Open(ctx, OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   newTestCatalog(t),
	})
	if err != nil {
		t.Fatalf("Open(restart) error = %v", err)
	}
	t.Cleanup(func() {
		_ = second.Close()
	})
	assertRoutingCandidateCount(t, second, "gpt-restart-a", 1)
	assertRoutingCandidateCount(t, second, "gpt-restart-b", 1)
	snapshot, err := second.ListAccountModels(ctx, account.Ref())
	if err != nil {
		t.Fatalf("ListAccountModels() error = %v", err)
	}
	if len(snapshot) != 2 {
		t.Fatalf("restarted model snapshot = %#v", snapshot)
	}
}

func TestStoreReturnsStableNotFoundErrors(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	accountRef, err := accountcore.ParseAccountRef("acct_4a6fd2d115fe1edacb4a")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	if _, err := store.GetByRef(ctx, accountRef); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("GetByRef() error = %v, want ErrAccountNotFound", err)
	}
	if _, err := store.GetByCLIAccountID(ctx, "codex", alias); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("GetByCLIAccountID() error = %v, want ErrAccountNotFound", err)
	}
}

func newCodexAPIKeyAccount(
	t *testing.T,
	store *Store,
	alias int64,
	secret string,
) accountcore.Account {
	t.Helper()
	return newCodexAPIKeyAccountAt(t, store, alias, secret, testAccountTime())
}

func newCodexAPIKeyAccountAt(
	t *testing.T,
	store *Store,
	alias int64,
	secret string,
	createdAt time.Time,
) accountcore.Account {
	t.Helper()

	auth, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: secret})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(alias)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(store.catalog, accountcore.NewAccountInput{
		Identity:     auth,
		CLIAccountID: cliAccountID,
		CreatedAt:    createdAt,
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	return account
}

func testAccountTime() time.Time {
	return time.Date(2026, time.July, 27, 0, 0, 0, 0, time.UTC)
}

// modelExpectation 描述模型关系测试需要复核的三项语义。
type modelExpectation struct {
	upstream  bool
	policy    accountapp.ModelManualPolicy
	effective bool
}

// assertAccountModelSnapshot 按模型 ID 复核自动、人工和最终有效状态。
func assertAccountModelSnapshot(
	t *testing.T,
	models []accountapp.AccountModel,
	expected map[string]modelExpectation,
) {
	t.Helper()

	if len(models) != len(expected) {
		t.Fatalf("model count = %d, want %d: %#v", len(models), len(expected), models)
	}
	for _, model := range models {
		want, found := expected[model.ModelID().String()]
		if !found ||
			model.UpstreamAvailable() != want.upstream ||
			model.ManualPolicy() != want.policy ||
			model.Effective() != want.effective {
			t.Fatalf("model snapshot contains unexpected relation: %#v", model)
		}
	}
}

// assertRoutingCandidateCount 复核本地倒排对单一模型返回的账号数量。
func assertRoutingCandidateCount(
	t *testing.T,
	store *Store,
	modelID string,
	expected int,
) {
	t.Helper()

	query, err := accountapp.NewRoutingQuery(
		store.catalog,
		"codex",
		modelID,
		"",
		1,
	)
	if err != nil {
		t.Fatalf("NewRoutingQuery(%s) error = %v", modelID, err)
	}
	candidates, err := store.ListRoutingCandidates(context.Background(), query)
	if err != nil {
		t.Fatalf("ListRoutingCandidates(%s) error = %v", modelID, err)
	}
	if len(candidates) != expected {
		t.Fatalf(
			"ListRoutingCandidates(%s) count = %d, want %d",
			modelID,
			len(candidates),
			expected,
		)
	}
}

// mustModelID 创建测试使用的真实模型标识。
func mustModelID(t *testing.T, value string) runtimecore.ModelID {
	t.Helper()

	modelID, err := runtimecore.NewModelID(value)
	if err != nil {
		t.Fatalf("NewModelID(%s) error = %v", value, err)
	}
	return modelID
}
