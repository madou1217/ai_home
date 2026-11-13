package accountactivity

// 活动候选账号的只读来源。
//
// 同时兼容 Go 的 aih.db（accounts + account_credentials）与遗留的
// app-state.db（account_refs + account_credentials），两者取并集、去重并按
// account_ref 排序返回。库文件或表缺失时返回空清单，避免未初始化时误报 503。

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// accountRefPattern 与 Node 的 isAccountRef 一致：acct_ + 20 位小写十六进制。
var accountRefPattern = regexp.MustCompile(`^acct_[a-f0-9]{20}$`)

// AccountLister 是活动的候选账号端口。
type AccountLister interface {
	ListByProvider(ctx context.Context, provider string) ([]string, error)
}

// CredentialAccountLister 从 aih.db 与 app-state.db 读取拥有非空凭据的账号引用。
type CredentialAccountLister struct {
	databasePath string
	aihDBPath    string
	aiHomeDir    string
}

// NewCredentialAccountLister 创建只读账号来源；aiHomeDir 为空时报错。
func NewCredentialAccountLister(aiHomeDir string) (*CredentialAccountLister, error) {
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	return &CredentialAccountLister{
		databasePath: path,
		aihDBPath:    filepath.Join(strings.TrimSpace(aiHomeDir), "aih.db"),
		aiHomeDir:    strings.TrimSpace(aiHomeDir),
	}, nil
}

// ListByProvider 返回该 Provider 下凭据非空的账号引用（按 ref 排序）。
func (lister *CredentialAccountLister) ListByProvider(ctx context.Context, provider string) ([]string, error) {
	normalized := strings.ToLower(strings.TrimSpace(provider))
	if normalized == "" || lister == nil {
		return nil, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	seen := make(map[string]struct{}, 16)

	if err := collectAccountRefsFromAihDB(ctx, lister.aihDBPath, normalized, seen); err != nil {
		return nil, err
	}
	if err := collectAccountRefsFromAppState(ctx, lister.databasePath, normalized, seen); err != nil {
		return nil, err
	}

	if len(seen) == 0 {
		return nil, nil
	}
	refs := make([]string, 0, len(seen))
	for ref := range seen {
		refs = append(refs, ref)
	}
	sort.Strings(refs)
	return refs, nil
}

func collectAccountRefsFromAihDB(
	ctx context.Context,
	aihDBPath string,
	provider string,
	seen map[string]struct{},
) error {
	if aihDBPath == "" {
		return nil
	}
	info, err := os.Stat(aihDBPath)
	if err != nil || !info.Mode().IsRegular() {
		return nil
	}
	db, err := sql.Open("sqlite", "file:"+aihDBPath+"?mode=ro&_busy_timeout=5000")
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()

	rows, err := db.QueryContext(ctx, `
		SELECT a.account_ref
		FROM accounts AS a
		INNER JOIN account_credentials AS c ON c.account_ref = a.account_ref
		WHERE a.provider_id = ?
		  AND length(trim(c.credential_json)) > 2
		ORDER BY a.account_ref
	`, provider)
	if err != nil {
		if isNoSuchTableError(err) {
			return nil
		}
		return err
	}
	defer func() { _ = rows.Close() }()
	return scanValidAccountRefs(rows, seen)
}

func collectAccountRefsFromAppState(
	ctx context.Context,
	databasePath string,
	provider string,
	seen map[string]struct{},
) error {
	if databasePath == "" {
		return nil
	}
	if _, err := os.Stat(databasePath); err != nil {
		return nil
	}
	database, err := appstate.OpenReadOnly(ctx, databasePath)
	if err != nil {
		return err
	}
	defer func() { _ = database.Close() }()

	rows, err := database.QueryContext(ctx, `
		SELECT c.account_ref
		FROM account_credentials AS c
		INNER JOIN account_refs AS r ON r.account_ref = c.account_ref
		WHERE (c.env_json <> '{}' OR c.native_auth_json <> '{}')
		  AND r.provider = ?
		ORDER BY c.account_ref
	`, provider)
	if err != nil {
		if isNoSuchTableError(err) {
			return nil
		}
		return err
	}
	defer func() { _ = rows.Close() }()
	return scanValidAccountRefs(rows, seen)
}

func scanValidAccountRefs(rows *sql.Rows, seen map[string]struct{}) error {
	for rows.Next() {
		var ref string
		if err := rows.Scan(&ref); err != nil {
			return err
		}
		ref = strings.TrimSpace(ref)
		if accountRefPattern.MatchString(ref) {
			seen[ref] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil && !isNoSuchTableError(err) {
		return err
	}
	return nil
}

func isNoSuchTableError(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "no such table")
}

var _ AccountLister = (*CredentialAccountLister)(nil)
