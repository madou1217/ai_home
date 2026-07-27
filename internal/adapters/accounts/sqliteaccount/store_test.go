package sqliteaccount

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
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
	}

	query, err := accountapp.NewRoutingQuery(store.catalog, "codex", "", 10)
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

func TestStoreRoutingQueryUsesCoveringIndex(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	rows, err := store.db.Query(
		"EXPLAIN QUERY PLAN "+routingCandidatesSQL,
		"codex",
		"",
		32,
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
	if !strings.Contains(
		queryPlan,
		"USING COVERING INDEX idx_accounts_routing",
	) {
		t.Fatalf("routing query plan = %q, want covering routing index", queryPlan)
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
