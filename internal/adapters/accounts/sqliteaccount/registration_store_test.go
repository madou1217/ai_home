package sqliteaccount

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestRegistrationStoreAllocatesProviderScopedAliases 验证别名在 Provider 内连续且相互隔离。
func TestRegistrationStoreAllocatesProviderScopedAliases(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	tests := []struct {
		name       string
		credential accountapp.Credential
		wantAlias  int64
	}{
		{
			name:       "codex first",
			credential: mustCodexAPIKey(t, "registration-codex-first"),
			wantAlias:  1,
		},
		{
			name:       "codex second",
			credential: mustCodexAPIKey(t, "registration-codex-second"),
			wantAlias:  2,
		},
		{
			name:       "claude first",
			credential: mustClaudeAPIKey(t, "registration-claude-first"),
			wantAlias:  1,
		},
	}
	for _, test := range tests {
		request := newRegistrationRequest(t, store, test.credential, nil)
		account, err := store.RegisterNew(context.Background(), request)
		if err != nil {
			t.Fatalf("RegisterNew(%s) error = %v", test.name, err)
		}
		if account.ProviderID() != test.credential.ProviderID() ||
			account.CLIAccountID().Int64() != test.wantAlias ||
			account.Ref() != request.AccountRef() {
			t.Fatalf("RegisterNew(%s) account = %#v", test.name, account)
		}
		restored, err := store.GetCredential(context.Background(), account.Ref())
		if err != nil {
			t.Fatalf("GetCredential(%s) error = %v", test.name, err)
		}
		if restored.IdentitySeed() != test.credential.IdentitySeed() {
			t.Fatalf("GetCredential(%s) identity mismatch", test.name)
		}
	}
}

// TestRegistrationStoreAllocatesUniqueAliasesConcurrently 验证并发注册不会重复或跳过别名。
func TestRegistrationStoreAllocatesUniqueAliasesConcurrently(t *testing.T) {
	t.Parallel()

	const accountCount = 64
	store := openTestStore(t)
	requests := make([]accountapp.RegistrationRequest, 0, accountCount)
	for index := 0; index < accountCount; index++ {
		requests = append(
			requests,
			newRegistrationRequest(
				t,
				store,
				mustCodexAPIKey(
					t,
					fmt.Sprintf("registration-concurrent-%d", index),
				),
				nil,
			),
		)
	}

	accounts, registrationErrors := registerNewConcurrently(store, requests)
	aliases := make(map[int64]struct{}, accountCount)
	for index, registrationErr := range registrationErrors {
		if registrationErr != nil {
			t.Fatalf("RegisterNew(%d) error = %v", index, registrationErr)
		}
		aliases[accounts[index].CLIAccountID().Int64()] = struct{}{}
	}
	if len(aliases) != accountCount {
		t.Fatalf("unique aliases = %d, want %d", len(aliases), accountCount)
	}
	for alias := int64(1); alias <= accountCount; alias++ {
		if _, found := aliases[alias]; !found {
			t.Fatalf("missing allocated alias %d", alias)
		}
	}
}

// TestRegistrationStoreAllowsOneConcurrentRegistrationPerIdentity 验证同一身份竞争只有一个成功。
func TestRegistrationStoreAllowsOneConcurrentRegistrationPerIdentity(t *testing.T) {
	t.Parallel()

	const attemptCount = 16
	store := openTestStore(t)
	request := newRegistrationRequest(
		t,
		store,
		mustCodexAPIKey(t, "registration-concurrent-identity"),
		nil,
	)
	requests := make([]accountapp.RegistrationRequest, attemptCount)
	for index := range requests {
		requests[index] = request
	}

	_, registrationErrors := registerNewConcurrently(store, requests)
	successes := 0
	conflicts := 0
	for _, registrationErr := range registrationErrors {
		switch {
		case registrationErr == nil:
			successes++
		case errors.Is(registrationErr, accountapp.ErrAccountConflict):
			conflicts++
		default:
			t.Fatalf("RegisterNew() unexpected error = %v", registrationErr)
		}
	}
	if successes != 1 || conflicts != attemptCount-1 {
		t.Fatalf(
			"registration outcomes = success:%d conflict:%d, want 1/%d",
			successes,
			conflicts,
			attemptCount-1,
		)
	}
}

// TestRegistrationStoreReportsAliasExhaustion 验证最大 SQLite 整数之后不会溢出或复用别名。
func TestRegistrationStoreReportsAliasExhaustion(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	occupiedCredential := mustCodexAPIKey(t, "registration-max-alias-holder")
	occupied := newAccountForCredential(t, store, occupiedCredential, math.MaxInt64)
	if err := store.Create(context.Background(), occupied); err != nil {
		t.Fatalf("Create(max alias) error = %v", err)
	}
	request := newRegistrationRequest(
		t,
		store,
		mustCodexAPIKey(t, "registration-after-max-alias"),
		nil,
	)

	if _, err := store.RegisterNew(
		context.Background(),
		request,
	); !errors.Is(err, accountapp.ErrCLIAccountIDExhausted) {
		t.Fatalf("RegisterNew() error = %v, want ErrCLIAccountIDExhausted", err)
	}
	if _, err := store.GetByRef(
		context.Background(),
		request.AccountRef(),
	); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("exhausted registration left account row: %v", err)
	}
}

// TestRegistrationStoreRollsBackAccountAndCredentialWhenProfileFails 验证资料写入失败会回滚整笔注册。
func TestRegistrationStoreRollsBackAccountAndCredentialWhenProfileFails(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	if _, err := store.db.Exec(`
		CREATE TRIGGER reject_registration_profile
		BEFORE INSERT ON account_profiles
		BEGIN
			SELECT RAISE(ABORT, 'synthetic profile failure');
		END`); err != nil {
		t.Fatalf("create profile rejection trigger error = %v", err)
	}
	credential := newTestCodexOAuth(t)
	request := newRegistrationRequest(
		t,
		store,
		credential,
		newTestCodexAccountProfile(t),
	)

	if _, err := store.RegisterNew(context.Background(), request); err == nil {
		t.Fatal("RegisterNew() error = nil, want profile failure")
	}
	if _, err := store.GetByRef(
		context.Background(),
		request.AccountRef(),
	); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("failed registration left account row: %v", err)
	}
	if _, err := store.GetCredential(
		context.Background(),
		request.AccountRef(),
	); !errors.Is(err, accountapp.ErrCredentialNotFound) {
		t.Fatalf("failed registration left credential row: %v", err)
	}
}

// TestRegistrationAliasQueryUsesProviderIndex 验证别名分配不扫描完整账号表。
func TestRegistrationAliasQueryUsesProviderIndex(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	rows, err := store.db.Query(
		"EXPLAIN QUERY PLAN "+
			"SELECT MAX(cli_account_id) FROM accounts WHERE provider_id = ?",
		"codex",
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
	if !strings.Contains(queryPlan, "USING COVERING INDEX") ||
		!strings.Contains(queryPlan, "provider_id=?") {
		t.Fatalf("alias query plan = %q, want provider covering index", queryPlan)
	}
}

// newRegistrationRequest 创建已经绑定凭据、资料和时间的注册命令。
func newRegistrationRequest(
	t *testing.T,
	store *Store,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
) accountapp.RegistrationRequest {
	t.Helper()

	request, err := accountapp.NewRegistrationRequest(
		store.catalog,
		credential,
		profile,
		testAccountTime(),
	)
	if err != nil {
		t.Fatalf("NewRegistrationRequest() error = %v", err)
	}
	return request
}

// registerNewConcurrently 让注册命令同时竞争 Provider 别名分配。
func registerNewConcurrently(
	store *Store,
	requests []accountapp.RegistrationRequest,
) ([]accountcore.Account, []error) {
	start := make(chan struct{})
	accounts := make([]accountcore.Account, len(requests))
	registrationErrors := make([]error, len(requests))
	var waitGroup sync.WaitGroup
	waitGroup.Add(len(requests))
	for index, request := range requests {
		go func() {
			defer waitGroup.Done()
			<-start
			accounts[index], registrationErrors[index] = store.RegisterNew(
				context.Background(),
				request,
			)
		}()
	}
	close(start)
	waitGroup.Wait()
	return accounts, registrationErrors
}
