package egress

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	serverConfigKey = "config:server"
	goAccountsDB    = "aih.db"
)

// AccountRecord 汇总来自 aih.db 与 app-state.db 的账号元信息。
type AccountRecord struct {
	AccountRef   string `json:"accountRef"`
	Provider     string `json:"provider"`
	CLIAccountID string `json:"cliAccountId,omitempty"`
	Email        string `json:"email,omitempty"`
	DisplayName  string `json:"displayName,omitempty"`
	Name         string `json:"name,omitempty"`
	Label        string `json:"label,omitempty"`
	AuthMode     string `json:"authMode,omitempty"`
	AuthType     string `json:"authType,omitempty"`
	APIKeyMode   bool   `json:"apiKeyMode,omitempty"`
	BaseURL      string `json:"baseUrl,omitempty"`
	// OpenAIBaseURL 是 OpenAI 兼容入口的 base URL（自定义上游按账号覆盖时使用）。
	OpenAIBaseURL string `json:"openaiBaseUrl,omitempty"`
	Enabled       bool   `json:"enabled"`
}

// AccountLabel 生成前端与日志展示用的可读账号名称（如 #1 user@example.com）。
func (a AccountRecord) AccountLabel() string {
	var parts []string
	if id := strings.TrimSpace(a.CLIAccountID); id != "" {
		parts = append(parts, "#"+id)
	}
	name := strings.TrimSpace(a.Email)
	if name == "" {
		name = strings.TrimSpace(a.DisplayName)
	}
	if name == "" {
		name = strings.TrimSpace(a.Name)
	}
	if name == "" {
		name = strings.TrimSpace(a.Label)
	}
	if name != "" {
		parts = append(parts, name)
	}
	return strings.Join(parts, " ")
}

// BoundAccountSummary 描述绑定了出口池的账号摘要。
type BoundAccountSummary struct {
	AccountRef string `json:"accountRef"`
	Provider   string `json:"provider"`
	UpdatedAt  int64  `json:"updatedAt"`
}

// ServerConfigEgress 读取服务端配置中与出口判定相关的标量字段。
type ServerConfigEgress struct {
	ProxyURL            string
	NoProxy             string
	EgressEvidenceTTLMS int64
}

func appStateDBPath(aiHomeDir string) (string, error) {
	return appstate.DatabasePath(strings.TrimSpace(aiHomeDir))
}

func readJSONKV(ctx context.Context, aiHomeDir string, key string, target any) (bool, error) {
	dbPath, err := appStateDBPath(aiHomeDir)
	if err != nil {
		return false, err
	}
	raw, found, err := appstate.ReadKV(ctx, dbPath, key)
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return false, err
	}
	if err := json.Unmarshal([]byte(raw), target); err != nil {
		return false, err
	}
	return true, nil
}

func writeJSONKV(ctx context.Context, aiHomeDir string, key string, value any, nowMS int64) error {
	dbPath, err := appStateDBPath(aiHomeDir)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return appstate.WriteKV(ctx, dbPath, key, string(encoded), nowMS)
}

func deleteKV(ctx context.Context, aiHomeDir string, key string) error {
	dbPath, err := appStateDBPath(aiHomeDir)
	if err != nil {
		return err
	}
	return appstate.DeleteKV(ctx, dbPath, key)
}

func readKVPrefix(ctx context.Context, aiHomeDir string, prefix string) (map[string]string, error) {
	result := make(map[string]string)
	dbPath, err := appStateDBPath(aiHomeDir)
	if err != nil {
		return result, err
	}
	if _, statErr := os.Stat(dbPath); statErr != nil {
		if errors.Is(statErr, os.ErrNotExist) {
			return result, nil
		}
		return result, statErr
	}
	db, err := appstate.OpenReadOnly(ctx, dbPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return result, nil
		}
		return result, err
	}
	defer func() { _ = db.Close() }()

	if prefix == "" {
		rows, queryErr := db.QueryContext(ctx, "SELECT key, value FROM app_kv ORDER BY key")
		if queryErr != nil {
			if strings.Contains(strings.ToLower(queryErr.Error()), "no such table") {
				return result, nil
			}
			return result, queryErr
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var k, v string
			if scanErr := rows.Scan(&k, &v); scanErr == nil {
				result[k] = v
			}
		}
		return result, rows.Err()
	}

	upper := prefix[:len(prefix)-1] + string(prefix[len(prefix)-1]+1)
	rows, queryErr := db.QueryContext(ctx, "SELECT key, value FROM app_kv WHERE key >= ? AND key < ? ORDER BY key", prefix, upper)
	if queryErr != nil {
		if strings.Contains(strings.ToLower(queryErr.Error()), "no such table") {
			return result, nil
		}
		return result, queryErr
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var k, v string
		if scanErr := rows.Scan(&k, &v); scanErr == nil {
			result[k] = v
		}
	}
	return result, rows.Err()
}

// ReadServerConfigEgress 读取 app_kv 中的 config:server 出口相关字段。
func ReadServerConfigEgress(ctx context.Context, aiHomeDir string) ServerConfigEgress {
	var raw struct {
		ProxyURL            string `json:"proxyUrl"`
		NoProxy             string `json:"noProxy"`
		EgressEvidenceTTLMS int64  `json:"egressEvidenceTtlMs"`
	}
	found, err := readJSONKV(ctx, aiHomeDir, serverConfigKey, &raw)
	if err != nil || !found {
		return ServerConfigEgress{}
	}
	ttl := raw.EgressEvidenceTTLMS
	if ttl >= 60000 {
		if ttl > 31536000000 {
			ttl = 31536000000
		}
	} else {
		ttl = 0
	}
	return ServerConfigEgress{
		ProxyURL:            strings.TrimSpace(raw.ProxyURL),
		NoProxy:             strings.TrimSpace(raw.NoProxy),
		EgressEvidenceTTLMS: ttl,
	}
}

// ResolveServerProxyConfig 按 Node http-utils-utils.js 的优先序与 noProxy 规则推导默认全局代理。
func ResolveServerProxyConfig(targetURL string, cfg ServerConfigEgress) string {
	explicit := firstNonEmpty(cfg.ProxyURL, os.Getenv("AIH_SERVER_PROXY_URL"))
	envProxy := firstNonEmpty(os.Getenv("HTTPS_PROXY"), os.Getenv("https_proxy"), os.Getenv("HTTP_PROXY"), os.Getenv("http_proxy"))
	proxyURL := explicit
	if proxyURL == "" {
		proxyURL = envProxy
	}
	if proxyURL == "" {
		return ""
	}
	noProxy := firstNonEmpty(cfg.NoProxy, os.Getenv("AIH_SERVER_NO_PROXY"), os.Getenv("NO_PROXY"), os.Getenv("no_proxy"))
	if shouldBypassProxy(targetURL, noProxy) {
		return ""
	}
	parsed, err := url.Parse(proxyURL)
	if err != nil {
		return ""
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https", "socks5", "socks5h":
		return proxyURL
	default:
		return ""
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func shouldBypassProxy(targetURL string, noProxy string) bool {
	trimmedList := strings.TrimSpace(noProxy)
	if trimmedList == "" {
		return false
	}
	if trimmedList == "*" {
		return true
	}
	parsed, err := url.Parse(strings.TrimSpace(targetURL))
	if err != nil || parsed.Hostname() == "" {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	for _, token := range strings.Split(trimmedList, ",") {
		rule := strings.ToLower(strings.TrimSpace(token))
		if rule == "" {
			continue
		}
		if rule == "*" || rule == host {
			return true
		}
		clean := strings.TrimPrefix(rule, ".")
		if strings.HasSuffix(host, "."+clean) || host == clean {
			return true
		}
	}
	return false
}

// ListKnownAccounts 从 aih.db 与 app-state.db 读取全量已知账号摘要。
func ListKnownAccounts(ctx context.Context, aiHomeDir string) ([]AccountRecord, error) {
	byRef := make(map[string]AccountRecord)

	trimmedHome := strings.TrimSpace(aiHomeDir)
	if trimmedHome == "" {
		return nil, nil
	}

	aihDBPath := filepath.Join(trimmedHome, goAccountsDB)
	if _, statErr := os.Stat(aihDBPath); statErr == nil {
		if db, err := appstate.OpenReadOnly(ctx, aihDBPath); err == nil {
			readAccountsFromGoDB(ctx, db, byRef)
			_ = db.Close()
		}
	}

	appStatePath := filepath.Join(trimmedHome, appstate.DatabaseFileName)
	if _, statErr := os.Stat(appStatePath); statErr == nil {
		if db, err := appstate.OpenReadOnly(ctx, appStatePath); err == nil {
			readAccountsFromAppStateDB(ctx, db, byRef)
			_ = db.Close()
		}
	}

	out := make([]AccountRecord, 0, len(byRef))
	for _, item := range byRef {
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].AccountRef < out[j].AccountRef
	})
	return out, nil
}

// ResolveAccount 按 accountRef 从双库查找账号详情。
func ResolveAccount(ctx context.Context, aiHomeDir string, accountRef string) (AccountRecord, bool, error) {
	if _, err := accountcore.ParseAccountRef(strings.TrimSpace(accountRef)); err != nil {
		return AccountRecord{}, false, nil
	}
	ref := strings.TrimSpace(accountRef)
	accounts, err := ListKnownAccounts(ctx, aiHomeDir)
	if err != nil {
		return AccountRecord{}, false, err
	}
	for _, item := range accounts {
		if item.AccountRef == ref {
			return item, true, nil
		}
	}
	dbPath, err := appStateDBPath(aiHomeDir)
	if err != nil {
		return AccountRecord{}, false, nil
	}
	provider, found, err := appstate.LookupAccountProvider(ctx, dbPath, ref)
	if err != nil || !found {
		return AccountRecord{}, false, err
	}
	return AccountRecord{
		AccountRef: ref,
		Provider:   strings.ToLower(strings.TrimSpace(provider)),
		Enabled:    true,
	}, true, nil
}

func readAccountsFromGoDB(ctx context.Context, db *sql.DB, byRef map[string]AccountRecord) {
	tables := existingSQLiteTables(ctx, db)
	if !tables["accounts"] {
		return
	}
	uiDisplay := "''"
	uiAuthMode := "''"
	uiAPIKeyMode := "0"
	uiBaseURL := "''"
	if tables["account_ui_state"] {
		uiDisplay = "COALESCE((SELECT u.display_name FROM account_ui_state AS u WHERE u.account_ref = a.account_ref), '')"
		uiAuthMode = "COALESCE((SELECT u.auth_mode FROM account_ui_state AS u WHERE u.account_ref = a.account_ref), '')"
		uiAPIKeyMode = "COALESCE((SELECT u.api_key_mode FROM account_ui_state AS u WHERE u.account_ref = a.account_ref), 0)"
		uiBaseURL = "COALESCE((SELECT u.base_url FROM account_ui_state AS u WHERE u.account_ref = a.account_ref), '')"
	}
	profDisplay := "''"
	profEmail := "''"
	if tables["account_profiles"] {
		profDisplay = "COALESCE((SELECT p.display_name FROM account_profiles AS p WHERE p.account_ref = a.account_ref), '')"
		profEmail = "COALESCE((SELECT p.email FROM account_profiles AS p WHERE p.account_ref = a.account_ref), '')"
	}
	credEmail := "''"
	if tables["account_credentials"] {
		credEmail = "COALESCE((SELECT CASE WHEN json_valid(c.credential_json) THEN COALESCE(json_extract(c.credential_json, '$.email'), '') ELSE '' END FROM account_credentials AS c WHERE c.account_ref = a.account_ref), '')"
	}
	query := "SELECT a.account_ref, a.provider_id, a.cli_account_id, a.enabled, " +
		uiDisplay + ", " + uiAuthMode + ", " + uiAPIKeyMode + ", " + uiBaseURL + ", " + profDisplay + ", " + profEmail + ", " + credEmail +
		" FROM accounts AS a ORDER BY a.account_ref"
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var (
			ref, provider, cliID, uiName, authMode, baseURL, profName, profMail, credMail string
			enabledInt, apiKeyInt                                                         int
		)
		if scanErr := rows.Scan(&ref, &provider, &cliID, &enabledInt, &uiName, &authMode, &apiKeyInt, &baseURL, &profName, &profMail, &credMail); scanErr != nil {
			continue
		}
		email := firstNonEmpty(profMail, credMail)
		displayName := firstNonEmpty(uiName, profName)
		authNorm := strings.ToLower(strings.TrimSpace(authMode))
		apiKeyMode := apiKeyInt != 0 || authNorm == "api-key"
		byRef[ref] = AccountRecord{
			AccountRef:   ref,
			Provider:     strings.ToLower(strings.TrimSpace(provider)),
			CLIAccountID: strings.TrimSpace(cliID),
			Email:        email,
			DisplayName:  displayName,
			AuthMode:     authNorm,
			AuthType:     authNorm,
			APIKeyMode:   apiKeyMode,
			BaseURL:      strings.TrimSpace(baseURL),
			Enabled:      enabledInt != 0,
		}
	}
}

func readAccountsFromAppStateDB(ctx context.Context, db *sql.DB, byRef map[string]AccountRecord) {
	tables := existingSQLiteTables(ctx, db)
	if !tables["account_refs"] {
		return
	}
	cliAliasExpr := "''"
	if tables["account_cli_aliases"] {
		cliAliasExpr = "COALESCE((SELECT c.cli_account_id FROM account_cli_aliases AS c WHERE c.account_ref = r.account_ref LIMIT 1), '')"
	}
	query := "SELECT r.account_ref, r.provider, " + cliAliasExpr + " FROM account_refs AS r ORDER BY r.account_ref"
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var ref, provider, cliID string
		if scanErr := rows.Scan(&ref, &provider, &cliID); scanErr != nil {
			continue
		}
		existing, exists := byRef[ref]
		if exists {
			if existing.Provider == "" {
				existing.Provider = strings.ToLower(strings.TrimSpace(provider))
			}
			if existing.CLIAccountID == "" {
				existing.CLIAccountID = strings.TrimSpace(cliID)
			}
			byRef[ref] = existing
			continue
		}
		byRef[ref] = AccountRecord{
			AccountRef:   strings.TrimSpace(ref),
			Provider:     strings.ToLower(strings.TrimSpace(provider)),
			CLIAccountID: strings.TrimSpace(cliID),
			Enabled:      true,
		}
	}
}

func existingSQLiteTables(ctx context.Context, db *sql.DB) map[string]bool {
	out := make(map[string]bool)
	rows, err := db.QueryContext(ctx, "SELECT name FROM sqlite_master WHERE type = 'table'")
	if err != nil {
		return out
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var name string
		if rows.Scan(&name) == nil {
			out[name] = true
		}
	}
	return out
}

// AccountBindingRecord 把账号出口绑定与所属账号摘要绑定在一起。
type AccountBindingRecord struct {
	AccountRef string
	Provider   string
	Binding    agyegress.Binding
}

// ReadAccountEgressBindings 列出所有仍存在账号的有效/已下线出口绑定。
func ReadAccountEgressBindings(ctx context.Context, aiHomeDir string) ([]AccountBindingRecord, error) {
	accounts, err := ListKnownAccounts(ctx, aiHomeDir)
	if err != nil {
		return nil, err
	}
	accountMap := make(map[string]AccountRecord, len(accounts))
	for _, acc := range accounts {
		accountMap[acc.AccountRef] = acc
	}
	store := agyegress.NewStore(aiHomeDir)
	kvMap, err := readKVPrefix(ctx, aiHomeDir, "account:egress:")
	if err != nil {
		return nil, err
	}
	var out []AccountBindingRecord
	for key := range kvMap {
		ref := strings.TrimPrefix(key, "account:egress:")
		acc, exists := accountMap[ref]
		if !exists {
			continue
		}
		binding, found, readErr := store.Read(ctx, ref)
		if readErr != nil || !found {
			continue
		}
		out = append(out, AccountBindingRecord{
			AccountRef: ref,
			Provider:   acc.Provider,
			Binding:    binding,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].AccountRef < out[j].AccountRef
	})
	return out, nil
}

// ListEgressPoolBoundAccounts 返回所有当前绑定到出口池（mode=pool 且未下线）的账号列表。
func ListEgressPoolBoundAccounts(ctx context.Context, aiHomeDir string) ([]BoundAccountSummary, error) {
	bindings, err := ReadAccountEgressBindings(ctx, aiHomeDir)
	if err != nil {
		return nil, err
	}
	out := make([]BoundAccountSummary, 0)
	for _, item := range bindings {
		if item.Binding.Retired || item.Binding.Mode != agyegress.ModePool {
			continue
		}
		out = append(out, BoundAccountSummary{
			AccountRef: item.AccountRef,
			Provider:   item.Provider,
			UpdatedAt:  item.Binding.UpdatedAtMS,
		})
	}
	return out, nil
}
