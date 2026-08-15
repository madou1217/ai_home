package sqliteaccount

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

func TestStoreListsAccountOverviewsWithoutSecretDocuments(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	pending := newCodexAPIKeyAccount(t, store, 1, "sk-test-overview-pending")
	if err := store.Create(context.Background(), pending); err != nil {
		t.Fatalf("Create(pending) error = %v", err)
	}

	credential := newTestCodexOAuth(t)
	registered := newAccountForCredential(t, store, credential, 2)
	registerAccountWithCredential(t, store, registered, credential)
	profile := newProfileSnapshot(
		t,
		store,
		newTestCodexAccountProfile(t),
		testAccountTime(),
	)
	if err := store.UpsertProfile(context.Background(), profile); err != nil {
		t.Fatalf("UpsertProfile() error = %v", err)
	}

	query, err := accountapp.NewOverviewQuery("", 10)
	if err != nil {
		t.Fatalf("NewOverviewQuery() error = %v", err)
	}
	overviews, err := store.ListAccountOverviews(context.Background(), query)
	if err != nil {
		t.Fatalf("ListAccountOverviews() error = %v", err)
	}
	if len(overviews) != 2 {
		t.Fatalf("overview count = %d, want 2", len(overviews))
	}
	byRef := make(map[string]accountapp.AccountOverview, len(overviews))
	for _, overview := range overviews {
		byRef[overview.Account().Ref().String()] = overview
	}
	pendingOverview := byRef[pending.Ref().String()]
	if pendingOverview.HasCredential() ||
		pendingOverview.HasProfile() ||
		pendingOverview.AuthKind() != "" {
		t.Fatalf("pending overview 包含不存在的数据: %#v", pendingOverview)
	}
	registeredOverview := byRef[registered.Ref().String()]
	if !registeredOverview.HasCredential() ||
		registeredOverview.AuthKind() != "oauth" ||
		!registeredOverview.HasProfile() ||
		registeredOverview.Email() != "codex@example.com" ||
		registeredOverview.SubscriptionKind() != "plus" {
		t.Fatalf("registered overview 字段错误: %#v", registeredOverview)
	}
	if strings.Contains(accountOverviewSQL, "credential_json") ||
		strings.Contains(accountOverviewSQL, "profile_json") {
		t.Fatal("账号管理 SQL 不得读取凭据或公开资料 JSON")
	}
}

func TestStoreListsPersistedModelAndUsageEvidenceWithoutNPlusOneReads(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	unknown := newCodexAPIKeyAccount(t, store, 1, "sk-test-overview-unknown")
	known := newCodexAPIKeyAccount(t, store, 2, "sk-test-overview-known")
	for _, account := range []accountcore.Account{unknown, known} {
		if err := store.Create(ctx, account); err != nil {
			t.Fatalf("Create(%s) error = %v", account.Ref(), err)
		}
	}
	modelUpdatedAt := testAccountTime().Add(time.Minute)
	models := []runtimecore.ModelID{
		runtimecore.ModelID("gpt-5.4"),
		runtimecore.ModelID("gpt-5.6-sol"),
	}
	if _, err := store.ReplaceDiscoveredModels(
		ctx,
		known.Ref(),
		models,
		modelUpdatedAt,
	); err != nil {
		t.Fatalf("ReplaceDiscoveredModels() error = %v", err)
	}
	if _, err := store.SetManualModelPolicy(
		ctx,
		known.Ref(),
		models[0],
		accountapp.ModelPolicyForceDisable,
		modelUpdatedAt.Add(time.Minute),
	); err != nil {
		t.Fatalf("SetManualModelPolicy() error = %v", err)
	}
	usageSnapshot := newUsageStoreSnapshot(
		t,
		known.Ref(),
		testAccountTime().Add(2*time.Minute),
		[]usagecore.EntryInput{{
			Bucket:               "primary",
			Kind:                 usagecore.KindWindow,
			Scope:                usagecore.ScopeAccount,
			HasRemaining:         true,
			RemainingBasisPoints: 6_500,
			WindowSeconds:        18_000,
			ResetAt:              testAccountTime().Add(5 * time.Hour),
			Availability:         usagecore.AvailabilityAvailable,
		}},
	)
	if err := store.ReplaceUsageSnapshot(ctx, usageSnapshot); err != nil {
		t.Fatalf("ReplaceUsageSnapshot() error = %v", err)
	}
	query, err := accountapp.NewOverviewQuery("", 10)
	if err != nil {
		t.Fatalf("NewOverviewQuery() error = %v", err)
	}
	overviews, err := store.ListAccountOverviews(ctx, query)
	if err != nil {
		t.Fatalf("ListAccountOverviews() error = %v", err)
	}
	byRef := make(map[accountcore.AccountRef]accountapp.AccountOverview, len(overviews))
	for _, overview := range overviews {
		byRef[overview.Account().Ref()] = overview
	}
	unknownOverview := byRef[unknown.Ref()]
	if unknownOverview.ModelSummary().IsKnown() {
		t.Fatalf("无模型行账号被伪造成已知快照: %#v", unknownOverview.ModelSummary())
	}
	if _, found := unknownOverview.UsageSnapshot(); found {
		t.Fatal("无额度行账号被伪造成空快照")
	}
	knownOverview := byRef[known.Ref()]
	modelSummary := knownOverview.ModelSummary()
	if !modelSummary.IsKnown() ||
		modelSummary.StoredCount() != 2 ||
		modelSummary.EffectiveCount() != 1 ||
		!modelSummary.UpdatedAt().Equal(modelUpdatedAt.Add(time.Minute)) {
		t.Fatalf("model summary = %#v", modelSummary)
	}
	storedUsage, found := knownOverview.UsageSnapshot()
	if !found || !storedUsage.IsValid() ||
		storedUsage.Source() != usageSnapshot.Source() ||
		len(storedUsage.Entries()) != 1 ||
		storedUsage.Entries()[0].Bucket() != "primary" {
		t.Fatalf("usage snapshot = %#v found=%v", storedUsage, found)
	}
}

func TestStoreAccountOverviewUsesStableCursor(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	for index := 1; index <= 12; index++ {
		account := newCodexAPIKeyAccount(
			t,
			store,
			int64(index),
			fmt.Sprintf("sk-test-overview-cursor-%d", index),
		)
		if err := store.Create(context.Background(), account); err != nil {
			t.Fatalf("Create(%d) error = %v", index, err)
		}
	}
	firstQuery, err := accountapp.NewOverviewQuery("", 5)
	if err != nil {
		t.Fatalf("NewOverviewQuery(first) error = %v", err)
	}
	first, err := store.ListAccountOverviews(context.Background(), firstQuery)
	if err != nil {
		t.Fatalf("ListAccountOverviews(first) error = %v", err)
	}
	nextQuery, err := accountapp.NewOverviewQuery(
		first[len(first)-1].Account().Ref(),
		5,
	)
	if err != nil {
		t.Fatalf("NewOverviewQuery(next) error = %v", err)
	}
	second, err := store.ListAccountOverviews(context.Background(), nextQuery)
	if err != nil {
		t.Fatalf("ListAccountOverviews(second) error = %v", err)
	}
	if len(first) != 5 ||
		len(second) != 5 ||
		second[0].Account().Ref() <= first[len(first)-1].Account().Ref() {
		t.Fatalf("overview cursor invalid: first=%#v second=%#v", first, second)
	}
}

// TestStoreGetsAccountOverviewByRef 验证单账号查询返回公开管理投影。
func TestStoreGetsAccountOverviewByRef(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	credential := newTestCodexOAuth(t)
	account := newAccountForCredential(t, store, credential, 1)
	registerAccountWithCredential(t, store, account, credential)
	profile := newProfileSnapshot(
		t,
		store,
		newTestCodexAccountProfile(t),
		testAccountTime(),
	)
	if err := store.UpsertProfile(context.Background(), profile); err != nil {
		t.Fatalf("UpsertProfile() error = %v", err)
	}

	overview, err := store.GetAccountOverview(context.Background(), account.Ref())
	if err != nil {
		t.Fatalf("GetAccountOverview() error = %v", err)
	}
	if overview.Account() != account ||
		!overview.HasCredential() ||
		overview.AuthKind() != "oauth" ||
		!overview.HasProfile() ||
		overview.Email() != "codex@example.com" ||
		overview.SubscriptionKind() != "plus" {
		t.Fatalf("account overview invalid: %#v", overview)
	}
}

// TestStoreGetsAccountOverviewByAlias 验证 Provider 数字别名使用唯一索引
// 点查完整公开投影，不扫描凭据或资料 JSON。
func TestStoreGetsAccountOverviewByAlias(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	credential := newTestCodexOAuth(t)
	account := newAccountForCredential(t, store, credential, 7)
	registerAccountWithCredential(t, store, account, credential)
	overview, err := store.GetAccountOverviewByCLIAccountID(
		context.Background(),
		"codex",
		account.CLIAccountID(),
	)
	if err != nil {
		t.Fatalf("GetAccountOverviewByCLIAccountID() error = %v", err)
	}
	if overview.Account() != account ||
		!overview.HasCredential() ||
		overview.AuthKind() != "oauth" {
		t.Fatalf("alias overview invalid: %#v", overview)
	}
	if _, err := store.GetAccountOverviewByCLIAccountID(
		context.Background(),
		"CODEX",
		account.CLIAccountID(),
	); !errors.Is(err, accountapp.ErrInvalidOverview) {
		t.Fatalf("non-canonical provider error = %v", err)
	}
}

// TestStoreGetAccountOverviewRejectsInvalidAndMissingRefs 验证无效或不存在身份不会降级查询。
func TestStoreGetAccountOverviewRejectsInvalidAndMissingRefs(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	if _, err := store.GetAccountOverview(
		context.Background(),
		"invalid",
	); !errors.Is(err, accountcore.ErrInvalidAccountRef) {
		t.Fatalf("invalid ref error = %v, want ErrInvalidAccountRef", err)
	}
	missingRef, err := accountcore.ParseAccountRef("acct_4a6fd2d115fe1edacb4a")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	if _, err := store.GetAccountOverview(
		context.Background(),
		missingRef,
	); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("missing ref error = %v, want ErrAccountNotFound", err)
	}
}

// TestStoreGetAccountOverviewRejectsIncompatiblePublicMetadata 验证数据库公开标量被篡改后失败关闭。
func TestStoreGetAccountOverviewRejectsIncompatiblePublicMetadata(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	credential := newTestCodexOAuth(t)
	account := newAccountForCredential(t, store, credential, 1)
	registerAccountWithCredential(t, store, account, credential)
	profile := newProfileSnapshot(
		t,
		store,
		newTestCodexAccountProfile(t),
		testAccountTime(),
	)
	if err := store.UpsertProfile(context.Background(), profile); err != nil {
		t.Fatalf("UpsertProfile() error = %v", err)
	}
	if _, err := store.db.Exec(
		"UPDATE account_profiles SET display_name = ? WHERE account_ref = ?",
		"invalid\nname",
		account.Ref().String(),
	); err != nil {
		t.Fatalf("tamper profile error = %v", err)
	}

	if _, err := store.GetAccountOverview(
		context.Background(),
		account.Ref(),
	); !errors.Is(err, ErrIncompatibleDatabase) {
		t.Fatalf("GetAccountOverview() error = %v, want ErrIncompatibleDatabase", err)
	}
}

func TestStoreAccountOverviewQueryUsesPrimaryKeys(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	tests := []struct {
		name      string
		statement string
		arguments []any
	}{
		{
			name:      "keyset list",
			statement: accountOverviewSQL,
			arguments: []any{"", 50},
		},
		{
			name:      "point lookup",
			statement: accountOverviewByRefSQL,
			arguments: []any{"acct_4a6fd2d115fe1edacb4a"},
		},
		{
			name:      "alias point lookup",
			statement: accountOverviewByAliasSQL,
			arguments: []any{"codex", 7},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			rows, err := store.db.Query(
				"EXPLAIN QUERY PLAN "+test.statement,
				test.arguments...,
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
			accountLookup := "SEARCH a USING PRIMARY KEY"
			if test.name == "alias point lookup" {
				accountLookup = "SEARCH a USING INDEX sqlite_autoindex_accounts_2"
			}
			for _, expected := range []string{
				accountLookup,
				"SEARCH c USING PRIMARY KEY",
				"SEARCH p USING PRIMARY KEY",
				"SEARCH m USING PRIMARY KEY",
				"SEARCH u USING PRIMARY KEY",
			} {
				if !strings.Contains(queryPlan, expected) {
					t.Fatalf("overview query plan = %q, want %q", queryPlan, expected)
				}
			}
			if strings.Contains(test.statement, "credential_json") ||
				strings.Contains(test.statement, "profile_json") {
				t.Fatal("账号管理 SQL 不得读取凭据或公开资料 JSON")
			}
		})
	}
}
