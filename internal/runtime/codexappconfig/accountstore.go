package codexappconfig

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// AccountStore 从 aih.db 读取 Codex 账号凭据，供 Desktop identity 使用。
type AccountStore struct {
	databasePath string
}

// OpenAccountStore 按 AIH 数据根打开只读账号库。
func OpenAccountStore(aiHomeDir string) (*AccountStore, error) {
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	return &AccountStore{databasePath: path}, nil
}

// ReadDesktopArtifacts 读取账号的 native auth；非 codex 账号返回 ok=false。
func (store *AccountStore) ReadDesktopArtifacts(ctx context.Context, accountRef string) (DesktopArtifacts, bool, error) {
	ref := strings.TrimSpace(accountRef)
	if store == nil || !desktopAccountRefPattern.MatchString(ref) {
		return DesktopArtifacts{}, false, nil
	}
	db, err := appstate.OpenReadOnly(ctx, store.databasePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return DesktopArtifacts{}, false, nil
		}
		return DesktopArtifacts{}, false, err
	}
	defer func() { _ = db.Close() }()

	provider, nativeJSON, found := readModernCredential(ctx, db, ref)
	if !found {
		return DesktopArtifacts{}, false, nil
	}
	if provider != "" && !strings.EqualFold(provider, "codex") {
		return DesktopArtifacts{}, false, nil
	}
	auth := map[string]any{}
	if strings.TrimSpace(nativeJSON) != "" && json.Unmarshal([]byte(nativeJSON), &auth) != nil {
		return DesktopArtifacts{}, false, nil
	}
	return DesktopArtifacts{AccountRef: ref, AuthJSON: auth}, true, nil
}

func readModernCredential(ctx context.Context, db *sql.DB, accountRef string) (string, string, bool) {
	var credentialJSON string
	if err := db.QueryRowContext(ctx, `
		SELECT credential_json FROM account_credentials WHERE account_ref = ? LIMIT 1`, accountRef).Scan(&credentialJSON); err != nil {
		return "", "", false
	}
	var credential map[string]any
	if json.Unmarshal([]byte(credentialJSON), &credential) != nil {
		return "", "", false
	}
	native, _ := credential["native_auth_json"].(map[string]any)
	if native == nil {
		native, _ = credential["nativeAuth"].(map[string]any)
	}
	if native == nil {
		return "", "", false
	}
	encoded, err := json.Marshal(native)
	if err != nil {
		return "", "", false
	}
	provider, _ := credential["provider"].(string)
	if provider == "" {
		provider = lookupProvider(ctx, db, accountRef)
	}
	return strings.TrimSpace(provider), string(encoded), true
}

func lookupProvider(ctx context.Context, db *sql.DB, accountRef string) string {
	var provider string
	if err := db.QueryRowContext(ctx, `SELECT provider_id FROM accounts WHERE account_ref = ? LIMIT 1`, accountRef).Scan(&provider); err == nil {
		return provider
	}
	return ""
}

// DefaultCodexAccountRef 返回默认 Codex 账号；不存在时返回空串。
func (store *AccountStore) DefaultCodexAccountRef(ctx context.Context) string {
	if store == nil {
		return ""
	}
	db, err := appstate.OpenReadOnly(ctx, store.databasePath)
	if err != nil {
		return ""
	}
	defer func() { _ = db.Close() }()
	var ref string
	if err := db.QueryRowContext(ctx, `SELECT account_ref FROM account_defaults WHERE provider_id = 'codex' LIMIT 1`).Scan(&ref); err == nil {
		return strings.TrimSpace(ref)
	}
	raw, found, readErr := appstate.ReadKV(ctx, store.databasePath, appstate.KeyCodexAccountDefault)
	if readErr != nil || !found {
		return ""
	}
	var value string
	if json.Unmarshal([]byte(raw), &value) == nil {
		return strings.TrimSpace(value)
	}
	return strings.TrimSpace(strings.Trim(raw, `"`))
}

// ListCodexAccountRefs 返回可用的 Codex 账号 refs（顺序稳定）。
func (store *AccountStore) ListCodexAccountRefs(ctx context.Context) []string {
	if store == nil {
		return []string{}
	}
	db, err := appstate.OpenReadOnly(ctx, store.databasePath)
	if err != nil {
		return []string{}
	}
	defer func() { _ = db.Close() }()
	return listCodexRefs(ctx, db)
}

func listCodexRefs(ctx context.Context, db *sql.DB) []string {
	queries := []string{
		`SELECT account_ref FROM accounts WHERE provider_id = 'codex' ORDER BY account_ref`,
	}
	for _, query := range queries {
		rows, err := db.QueryContext(ctx, query)
		if err != nil {
			continue
		}
		refs := make([]string, 0)
		for rows.Next() {
			var ref string
			if scanErr := rows.Scan(&ref); scanErr == nil && strings.TrimSpace(ref) != "" {
				refs = append(refs, strings.TrimSpace(ref))
			}
		}
		_ = rows.Close()
		if len(refs) > 0 {
			return refs
		}
	}
	return []string{}
}

// CandidateRefs 按 desktop 钉选、默认账号、全部账号的顺序去重。
func (store *AccountStore) CandidateRefs(ctx context.Context, desktopAccountRef string) []string {
	refs := make([]string, 0)
	seen := map[string]struct{}{}
	appendRef := func(value string) {
		ref := strings.TrimSpace(value)
		if !desktopAccountRefPattern.MatchString(ref) {
			return
		}
		if _, exists := seen[ref]; exists {
			return
		}
		seen[ref] = struct{}{}
		refs = append(refs, ref)
	}
	appendRef(desktopAccountRef)
	appendRef(store.DefaultCodexAccountRef(ctx))
	for _, ref := range store.ListCodexAccountRefs(ctx) {
		appendRef(ref)
	}
	return refs
}
