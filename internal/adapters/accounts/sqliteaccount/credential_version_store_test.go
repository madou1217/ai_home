package sqliteaccount

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

// TestCredentialVersionStoreReplacesCredentialWithCAS 验证单行 CAS 成功替换完整凭据。
func TestCredentialVersionStoreReplacesCredentialWithCAS(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	initial := newVersionedCodexOAuth(
		t,
		"initial-access",
		"initial-refresh",
		2_000_000_000,
	)
	account := newAccountForCredential(t, store, initial, 1)
	if err := registerVersionedCredential(
		ctx,
		store,
		account,
		initial,
		testAccountTime(),
	); err != nil {
		t.Fatalf("registerVersionedCredential() error = %v", err)
	}
	snapshot, err := store.GetCredentialSnapshot(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetCredentialSnapshot() error = %v", err)
	}
	if !snapshot.UpdatedAt().Equal(testAccountTime()) {
		t.Fatalf("snapshot.UpdatedAt() = %s", snapshot.UpdatedAt())
	}

	refreshed := newVersionedCodexOAuth(
		t,
		"refreshed-access",
		"refreshed-refresh",
		2_100_000_000,
	)
	nextVersion := testAccountTime().Add(time.Millisecond)
	replacement, err := accountapp.NewCredentialReplacement(
		snapshot,
		refreshed,
		nextVersion,
	)
	if err != nil {
		t.Fatalf("NewCredentialReplacement() error = %v", err)
	}
	if err := store.ReplaceCredential(ctx, replacement); err != nil {
		t.Fatalf("ReplaceCredential() error = %v", err)
	}

	persisted, err := store.GetCredentialSnapshot(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetCredentialSnapshot(persisted) error = %v", err)
	}
	persistedAuth, ok := persisted.Credential().(*codex.OAuthAuth)
	if !ok ||
		persistedAuth.AccessToken() != refreshed.AccessToken() ||
		persistedAuth.RefreshToken() != refreshed.RefreshToken() ||
		!persisted.UpdatedAt().Equal(nextVersion) {
		t.Fatalf("persisted credential = %T %#v", persisted.Credential(), persisted)
	}
}

// TestCredentialVersionStoreRejectsStaleReplacement 验证旧版本不能覆盖已提交版本。
func TestCredentialVersionStoreRejectsStaleReplacement(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	initial := newVersionedCodexOAuth(
		t,
		"initial-access",
		"initial-refresh",
		2_000_000_000,
	)
	account := newAccountForCredential(t, store, initial, 1)
	if err := registerVersionedCredential(
		ctx,
		store,
		account,
		initial,
		testAccountTime(),
	); err != nil {
		t.Fatalf("registerVersionedCredential() error = %v", err)
	}
	staleSnapshot, err := store.GetCredentialSnapshot(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetCredentialSnapshot() error = %v", err)
	}

	winner := newVersionedCodexOAuth(
		t,
		"winner-access",
		"winner-refresh",
		2_100_000_000,
	)
	winnerReplacement, err := accountapp.NewCredentialReplacement(
		staleSnapshot,
		winner,
		testAccountTime().Add(time.Millisecond),
	)
	if err != nil {
		t.Fatalf("NewCredentialReplacement(winner) error = %v", err)
	}
	if err := store.ReplaceCredential(ctx, winnerReplacement); err != nil {
		t.Fatalf("ReplaceCredential(winner) error = %v", err)
	}

	loser := newVersionedCodexOAuth(
		t,
		"loser-access",
		"loser-refresh",
		2_200_000_000,
	)
	loserReplacement, err := accountapp.NewCredentialReplacement(
		staleSnapshot,
		loser,
		testAccountTime().Add(2*time.Millisecond),
	)
	if err != nil {
		t.Fatalf("NewCredentialReplacement(loser) error = %v", err)
	}
	if err := store.ReplaceCredential(
		ctx,
		loserReplacement,
	); !errors.Is(err, accountapp.ErrCredentialConflict) {
		t.Fatalf("ReplaceCredential(loser) error = %v", err)
	}

	persisted, err := store.GetCredentialSnapshot(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetCredentialSnapshot(persisted) error = %v", err)
	}
	persistedAuth := persisted.Credential().(*codex.OAuthAuth)
	if persistedAuth.AccessToken() != winner.AccessToken() ||
		persistedAuth.RefreshToken() != winner.RefreshToken() {
		t.Fatal("旧版本覆盖了已经成功写入的新凭据")
	}
}

// TestCredentialSnapshotQueryUsesPrimaryKeys 验证按需凭据读取只执行两次主键点查。
func TestCredentialSnapshotQueryUsesPrimaryKeys(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	rows, err := store.db.Query(
		"EXPLAIN QUERY PLAN "+credentialSnapshotQuery,
		"acct_4a6fd2d115fe1edacb4a",
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
		"SEARCH c USING PRIMARY KEY",
		"SEARCH a USING PRIMARY KEY",
	} {
		if !strings.Contains(queryPlan, expected) {
			t.Fatalf(
				"credential snapshot query plan = %q, want %q",
				queryPlan,
				expected,
			)
		}
	}
}

// registerVersionedCredential 使用生产注册端口写入测试初始凭据。
func registerVersionedCredential(
	ctx context.Context,
	store *Store,
	account accountcore.Account,
	credential accountapp.Credential,
	updatedAt time.Time,
) error {
	registration, err := accountapp.NewRegistration(
		account,
		credential,
		updatedAt,
	)
	if err != nil {
		return err
	}
	return store.Register(ctx, registration)
}

// newVersionedCodexOAuth 创建稳定身份相同而 Token 可变化的 Codex OAuth。
func newVersionedCodexOAuth(
	t *testing.T,
	accessToken string,
	refreshToken string,
	expiresAtSeconds int64,
) *codex.OAuthAuth {
	t.Helper()

	auth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken: testJWT(t, map[string]any{
			"exp":   expiresAtSeconds,
			"token": accessToken,
		}),
		RefreshToken: refreshToken,
		IDToken: testJWT(t, map[string]any{
			"sub": "credential-version-user",
			"https://api.openai.com/auth": map[string]any{
				"chatgpt_user_id":    "credential-version-user",
				"chatgpt_account_id": "credential-version-workspace",
			},
		}),
		RefreshedAtMS:     testAccountTime().UnixMilli(),
		ExplicitAccountID: "credential-version-workspace",
	})
	if err != nil {
		t.Fatalf("codex.NewOAuthAuth() error = %v", err)
	}
	return auth
}
