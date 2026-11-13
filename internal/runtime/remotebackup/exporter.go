package remotebackup

import (
	"context"
	"encoding/json"
	"os"
	"os/user"
	"runtime"
	"strconv"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/accounts/gemini"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/zcodecred"
)

// AccountRecord 表示可移植 aih-accounts v1 导出条目，结构与 Node native-account-transfer 一致。
type AccountRecord struct {
	Provider     string            `json:"provider"`
	AccountRef   string            `json:"accountRef"`
	CLIAccountID string            `json:"cliAccountId"`
	Status       string            `json:"status"`
	Env          map[string]string `json:"env"`
	NativeAuth   map[string]any    `json:"nativeAuth"`
}

// SkippedAccount 记录因缺少或无法导出凭据而被跳过的账号。
type SkippedAccount struct {
	AccountRef string `json:"accountRef"`
	Provider   string `json:"provider,omitempty"`
	Reason     string `json:"reason"`
}

// ExportResult 描述一次本地全量账号导出结果。
type ExportResult struct {
	Accounts []AccountRecord
	Skipped  []SkippedAccount
}

// AccountExporter 从持久化账号仓库导出全部可用于远程备份的可移植账号记录。
type AccountExporter interface {
	ExportAccounts(ctx context.Context) (ExportResult, error)
}

// SQLiteAccountExporter 从 sqliteaccount.Store 读取账号概览与凭据快照并生成 aih-accounts v1 记录。
type SQLiteAccountExporter struct {
	Store   *sqliteaccount.Store
	Catalog *providers.Catalog
}

// ExportAccounts 分页读取全部账号并转换为便携记录；缺少或不可移植凭据计入 Skipped。
func (exporter SQLiteAccountExporter) ExportAccounts(ctx context.Context) (ExportResult, error) {
	if exporter.Store == nil {
		return ExportResult{}, errorsNew("backup account store 未配置")
	}
	catalog := exporter.Catalog
	if catalog == nil {
		if built, err := providers.NewCatalog(providers.BuiltinManifest()); err == nil {
			catalog = built
		}
	}

	var result ExportResult
	var afterRef accountcore.AccountRef
	for {
		query, err := accountapp.NewOverviewQuery(afterRef, accountapp.MaxOverviewLimit)
		if err != nil {
			return ExportResult{}, err
		}
		page, err := exporter.Store.ListAccountOverviews(ctx, query)
		if err != nil {
			return ExportResult{}, err
		}
		if len(page) == 0 {
			break
		}
		for _, overview := range page {
			account := overview.Account()
			snapshot, snapErr := exporter.Store.GetCredentialSnapshot(ctx, account.Ref())
			if snapErr != nil {
				result.Skipped = append(result.Skipped, SkippedAccount{
					AccountRef: account.Ref().String(),
					Provider:   account.ProviderID(),
					Reason:     "credentials_missing",
				})
				continue
			}
			record, ok := exportCredentialEntry(overview, snapshot, catalog)
			if !ok {
				result.Skipped = append(result.Skipped, SkippedAccount{
					AccountRef: account.Ref().String(),
					Provider:   account.ProviderID(),
					Reason:     "unsupported_credential",
				})
				continue
			}
			if len(record.Env) == 0 && len(record.NativeAuth) == 0 {
				result.Skipped = append(result.Skipped, SkippedAccount{
					AccountRef: account.Ref().String(),
					Provider:   account.ProviderID(),
					Reason:     "credentials_missing",
				})
				continue
			}
			result.Accounts = append(result.Accounts, record)
		}
		if len(page) < accountapp.MaxOverviewLimit {
			break
		}
		afterRef = page[len(page)-1].Account().Ref()
	}
	return result, nil
}

func exportCredentialEntry(
	overview accountapp.AccountOverview,
	snapshot accountapp.CredentialSnapshot,
	catalog *providers.Catalog,
) (AccountRecord, bool) {
	account := overview.Account()
	status := "down"
	if account.Enabled() {
		status = "up"
	}
	record := AccountRecord{
		Provider:     account.ProviderID(),
		AccountRef:   account.Ref().String(),
		CLIAccountID: strconv.FormatInt(account.CLIAccountID().Int64(), 10),
		Status:       status,
		Env:          map[string]string{},
		NativeAuth:   map[string]any{},
	}

	switch cred := snapshot.Credential().(type) {
	case *codex.APIKeyAuth:
		record.Env = map[string]string{
			"OPENAI_API_KEY":  cred.APIKey(),
			"OPENAI_BASE_URL": cred.BaseURL(),
		}
		return record, true
	case *claude.APIKeyAuth:
		record.Env = map[string]string{
			"ANTHROPIC_API_KEY":  cred.APIKey(),
			"ANTHROPIC_BASE_URL": cred.BaseURL(),
		}
		return record, true
	case *claude.AuthTokenAuth:
		record.Env = map[string]string{
			"ANTHROPIC_AUTH_TOKEN":       cred.AuthToken(),
			"ANTHROPIC_BASE_URL":         cred.BaseURL(),
			"AIH_CLAUDE_CREDENTIAL_TYPE": "auth-token",
		}
		return record, true
	case *gemini.VertexAuth:
		env := map[string]string{
			"VERTEX_AI_PROJECT_ID":  cred.ProjectID(),
			"VERTEX_AI_LOCATION":    cred.Location(),
			"VERTEX_AI_PLACEHOLDER": strconv.FormatBool(cred.Placeholder()),
		}
		if apiKey := cred.APIKey(); apiKey != "" {
			env["GEMINI_API_KEY"] = apiKey
			env["GOOGLE_API_KEY"] = apiKey
		}
		if baseURL := cred.BaseURL(); baseURL != "" {
			env["GEMINI_BASE_URL"] = baseURL
		}
		record.Env = env
		return record, true
	case *accountcore.StaticAPIKeyAuth:
		if catalog == nil {
			return AccountRecord{}, false
		}
		def, found := catalog.Get(cred.ProviderID())
		if !found || def.Credentials == nil || len(def.Credentials.APIKeyEnv) == 0 {
			return AccountRecord{}, false
		}
		record.Env[def.Credentials.APIKeyEnv[0]] = cred.APIKey()
		if cred.ProviderID() == "gemini" && len(def.Credentials.APIKeyEnv) > 1 {
			record.Env[def.Credentials.APIKeyEnv[1]] = cred.APIKey()
		}
		if baseURL := cred.BaseURL(); baseURL != "" && len(def.Credentials.BaseURLEnv) > 0 {
			record.Env[def.Credentials.BaseURLEnv[0]] = baseURL
		}
		return record, true
	case *agy.OAuthAuth:
		record.NativeAuth = map[string]any{
			"email": cred.Email(),
			"oauthToken": map[string]any{
				"auth_method": string(cred.AuthMethod()),
				"token": map[string]any{
					"access_token":    cred.AccessToken(),
					"refresh_token":   cred.RefreshToken(),
					"expires_at_ms":   cred.ExpiresAtMS(),
					"refreshed_at_ms": cred.RefreshedAtMS(),
					"token_type":      cred.TokenType(),
				},
			},
		}
		return record, true
	case *codex.OAuthAuth:
		tokens := map[string]any{
			"access_token":  cred.AccessToken(),
			"refresh_token": cred.RefreshToken(),
			"id_token":      cred.IDToken(),
		}
		if accountID := cred.UpstreamAccountID(); accountID != "" {
			tokens["account_id"] = accountID
		}
		auth := map[string]any{
			"auth_mode":      "chatgpt",
			"OPENAI_API_KEY": nil,
			"tokens":         tokens,
		}
		if refreshedAt := cred.RefreshedAtMS(); refreshedAt > 0 {
			auth["last_refresh"] = time.UnixMilli(refreshedAt).UTC()
		}
		record.NativeAuth = map[string]any{"auth": auth}
		return record, true
	case *claude.OAuthAuth:
		oauth := map[string]any{
			"accessToken":  cred.AccessToken(),
			"refreshToken": cred.RefreshToken(),
			"expiresAt":    cred.ExpiresAtMS(),
			"scopes":       cred.Scopes(),
		}
		if refreshExpiry := cred.RefreshTokenExpiresAtMS(); refreshExpiry > 0 {
			oauth["refreshTokenExpiresAt"] = refreshExpiry
		}
		record.NativeAuth = map[string]any{
			"credentials": map[string]any{"claudeAiOauth": oauth},
		}
		return record, true
	case *accountcore.NativeCredential:
		if cred == nil {
			return AccountRecord{}, false
		}
		var payload map[string]any
		if err := json.Unmarshal(cred.Payload(), &payload); err != nil || len(payload) == 0 {
			return AccountRecord{}, false
		}
		if cred.ProviderID() == "zcode" {
			payload = PortableZcodeNativeAuth(payload)
		}
		record.NativeAuth = payload
		return record, true
	default:
		return AccountRecord{}, false
	}
}

// PortableZcodeNativeAuth 将 zcode credentials 中的本机 enc:v1 密文尽力解密为可移植明文；
// 若密钥不匹配无法解密则保留原密文而不丢失字段，与 Node `portableNativeAuth` 一致。
func PortableZcodeNativeAuth(nativeAuth map[string]any) map[string]any {
	if len(nativeAuth) == 0 {
		return nativeAuth
	}
	rawCreds, ok := nativeAuth["credentials"].(map[string]any)
	if !ok || len(rawCreds) == 0 {
		return nativeAuth
	}
	hasEncrypted := false
	for _, val := range rawCreds {
		if str, isStr := val.(string); isStr && zcodecred.IsEncrypted(str) {
			hasEncrypted = true
			break
		}
	}
	if !hasEncrypted {
		return nativeAuth
	}

	secret := currentZcodeSecret()
	copiedCreds := make(map[string]any, len(rawCreds))
	for k, v := range rawCreds {
		if str, isStr := v.(string); isStr && zcodecred.IsEncrypted(str) {
			if plain, decOK := zcodecred.DecryptValue(str, secret); decOK && plain != "" {
				copiedCreds[k] = plain
				continue
			}
		}
		copiedCreds[k] = v
	}
	cloned := make(map[string]any, len(nativeAuth))
	for k, v := range nativeAuth {
		cloned[k] = v
	}
	cloned["credentials"] = copiedCreds
	return cloned
}

func currentZcodeSecret() string {
	home, _ := os.UserHomeDir()
	username := "unknown"
	if cur, err := user.Current(); err == nil && strings.TrimSpace(cur.Username) != "" {
		username = cur.Username
	}
	return zcodecred.ResolveSecret(os.Getenv("ZCODE_CREDENTIAL_SECRET"), currentZcodePlatform(), home, username)
}

func currentZcodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

func errorsNew(msg string) error {
	return &exporterError{msg: msg}
}

type exporterError struct{ msg string }

func (e *exporterError) Error() string { return e.msg }
