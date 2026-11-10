package aihserver

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

// openStatusRefresherStore 在临时 AIH 目录里打开真实 SQLite store。
//
// 状态段的判据全部来自存储读回，用假 store 只能验证调用顺序，验证不了「凭据能解码」
// 与「运行态文档能解析」这两件事本身。
func openStatusRefresherStore(t *testing.T) (*sqliteaccount.Store, string, *providers.Catalog) {
	t.Helper()
	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	aiHomeDir := t.TempDir()
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, aiHomeDir, catalog
}

// registerStatusAccount 注册一个凭据可读的 codex 静态账号。
func registerStatusAccount(
	t *testing.T,
	catalog *providers.Catalog,
	store *sqliteaccount.Store,
) accountcore.AccountRef {
	t.Helper()
	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  "sk-status-refresh-test",
		BaseURL: "https://status.example/v1",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	registrar, err := accountapp.NewRegistrar(catalog, store, func() time.Time {
		return time.UnixMilli(1_000).UTC()
	})
	if err != nil {
		t.Fatalf("NewRegistrar() error = %v", err)
	}
	account, err := registrar.Register(context.Background(), credential, nil)
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	return account.Ref()
}

// replaceStatusAccountState 写入一份合法运行态文档。
func replaceStatusAccountState(
	t *testing.T,
	store *sqliteaccount.Store,
	accountRef accountcore.AccountRef,
) {
	t.Helper()
	state, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
		AccountRef: accountRef,
		Document:   []byte(`{"rateLimitUntil":30000,"lastFailureKind":"rate_limited","lastFailureAt":10000}`),
		UpdatedAt:  time.UnixMilli(2_000).UTC(),
	})
	if err != nil {
		t.Fatalf("NewAccountState() error = %v", err)
	}
	if err := store.ReplaceAccountState(context.Background(), state, nil); err != nil {
		t.Fatalf("ReplaceAccountState() error = %v", err)
	}
}

// TestWebUIAccountStatusAcceptsReadableAccount 覆盖最常见的健康态：
// 凭据能读回，账号从未被上游标记过，运行态文档不存在。
func TestWebUIAccountStatusAcceptsReadableAccount(t *testing.T) {
	store, _, catalog := openStatusRefresherStore(t)
	accountRef := registerStatusAccount(t, catalog, store)

	refresher := webuiAccountStatusRefresher{store: store}
	if err := refresher.RefreshAccountStatus(context.Background(), accountRef); err != nil {
		t.Fatalf("RefreshAccountStatus() error = %v", err)
	}
}

// TestWebUIAccountStatusRejectsMissingCredential 覆盖「只有账号行、没有凭据」：
// 这一段必须失败，不能因为账号本身存在就报成功。
func TestWebUIAccountStatusRejectsMissingCredential(t *testing.T) {
	store, _, catalog := openStatusRefresherStore(t)
	ctx := context.Background()
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref: accountRef, ProviderID: "codex", CLIAccountID: 1, Enabled: true,
		CreatedAt: time.UnixMilli(1_000).UTC(), UpdatedAt: time.UnixMilli(1_000).UTC(),
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	refresher := webuiAccountStatusRefresher{store: store}
	err = refresher.RefreshAccountStatus(ctx, accountRef)
	if err == nil {
		t.Fatal("RefreshAccountStatus() error = nil, want 凭据不可读")
	}
	if !strings.Contains(err.Error(), "凭据不可读") {
		t.Fatalf("RefreshAccountStatus() error = %v, want 凭据不可读", err)
	}
}

// TestWebUIAccountStatusAcceptsValidRuntimeDocument 覆盖运行态文档存在且可解析。
func TestWebUIAccountStatusAcceptsValidRuntimeDocument(t *testing.T) {
	store, _, catalog := openStatusRefresherStore(t)
	accountRef := registerStatusAccount(t, catalog, store)
	replaceStatusAccountState(t, store, accountRef)

	refresher := webuiAccountStatusRefresher{store: store}
	if err := refresher.RefreshAccountStatus(context.Background(), accountRef); err != nil {
		t.Fatalf("RefreshAccountStatus() error = %v", err)
	}
}

// TestWebUIAccountStatusRejectsInvalidRuntimeDocument 覆盖运行态文档损坏。
//
// 损坏文档无法经 Store 写入（写路径会先校验），所以用第二条连接把已落盘的行改成
// 非法 JSON，模拟磁盘上的历史数据或外部进程写坏的真实情况。
func TestWebUIAccountStatusRejectsInvalidRuntimeDocument(t *testing.T) {
	store, aiHomeDir, catalog := openStatusRefresherStore(t)
	ctx := context.Background()
	accountRef := registerStatusAccount(t, catalog, store)
	replaceStatusAccountState(t, store, accountRef)

	databasePath, err := sqliteaccount.DatabasePath(aiHomeDir)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	database, err := sql.Open(
		"sqlite",
		"file:"+filepath.ToSlash(databasePath)+"?_pragma=busy_timeout(5000)",
	)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if _, err := database.ExecContext(
		ctx,
		`UPDATE account_runtime_states SET state_json = ? WHERE account_ref = ?`,
		"{not-json",
		accountRef.String(),
	); err != nil {
		t.Fatalf("损坏运行态文档失败: %v", err)
	}

	refresher := webuiAccountStatusRefresher{store: store}
	err = refresher.RefreshAccountStatus(ctx, accountRef)
	if err == nil {
		t.Fatal("RefreshAccountStatus() error = nil, want 运行态文档不可读")
	}
	if !strings.Contains(err.Error(), "运行态文档不可读") {
		t.Fatalf("RefreshAccountStatus() error = %v, want 运行态文档不可读", err)
	}
}

// TestWebUIAccountStatusRejectsInvalidAccountRef 覆盖无效账号身份：
// 连存储都不该碰，直接按参数错误返回。
func TestWebUIAccountStatusRejectsInvalidAccountRef(t *testing.T) {
	refresher := webuiAccountStatusRefresher{}
	err := refresher.RefreshAccountStatus(context.Background(), accountcore.AccountRef(""))
	if !errors.Is(err, accountcore.ErrInvalidAccountRef) {
		t.Fatalf("RefreshAccountStatus() error = %v, want ErrInvalidAccountRef", err)
	}
}
