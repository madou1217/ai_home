package sqliteaccount

import (
	"context"
	"fmt"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
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

func TestStoreAccountOverviewQueryUsesPrimaryKeys(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	rows, err := store.db.Query(
		"EXPLAIN QUERY PLAN "+accountOverviewSQL,
		"",
		50,
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
		"SEARCH p USING PRIMARY KEY",
	} {
		if !strings.Contains(queryPlan, expected) {
			t.Fatalf("overview query plan = %q, want %q", queryPlan, expected)
		}
	}
}
