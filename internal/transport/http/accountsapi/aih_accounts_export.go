package accountsapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/accounts/gemini"
)

// aihAccountsDocument 是 Node `aih-accounts` v1 的 Go 导出投影。
// 只导出可逆的静态凭据；OAuth/native envelope 由后续格式扩展，不在这里猜测。
type aihAccountsDocument struct {
	Kind       string            `json:"kind"`
	Version    int               `json:"version"`
	ExportedAt string            `json:"exportedAt"`
	Source     map[string]string `json:"source"`
	Accounts   []aihAccountEntry `json:"accounts"`
}

type aihAccountEntry struct {
	Provider     string            `json:"provider"`
	AccountRef   string            `json:"accountRef"`
	CLIAccountID string            `json:"cliAccountId"`
	Status       string            `json:"status"`
	Env          map[string]string `json:"env"`
	NativeAuth   map[string]any    `json:"nativeAuth"`
}

// aihAccountsExporter 从一个账号事实构造可导入的迁移文档。
type aihAccountsExporter struct {
	management  Management
	credentials CredentialSnapshotReader
	now         func() time.Time
}

// ExportAccount 返回单个账号的 aih-accounts v1 文档；未知凭据形态 fail-closed。
func (exporter *aihAccountsExporter) ExportAccount(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) ([]byte, error) {
	if exporter == nil || exporter.management == nil || exporter.credentials == nil {
		return nil, accountapp.ErrUnsupportedAccountExport
	}
	overview, err := exporter.management.GetAccountOverview(ctx, accountRef)
	if err != nil {
		return nil, err
	}
	snapshot, err := exporter.credentials.GetCredentialSnapshot(ctx, accountRef)
	if err != nil {
		return nil, err
	}
	account := overview.Account()
	env, err := exportStaticEnv(snapshot.Credential())
	if err != nil {
		return nil, err
	}
	now := time.Now
	if exporter.now != nil {
		now = exporter.now
	}
	document := aihAccountsDocument{
		Kind:       "aih-accounts",
		Version:    1,
		ExportedAt: now().UTC().Format(time.RFC3339),
		Source:     map[string]string{"host": ""},
		Accounts: []aihAccountEntry{{
			Provider:     account.ProviderID(),
			AccountRef:   account.Ref().String(),
			CLIAccountID: strconv.FormatInt(account.CLIAccountID().Int64(), 10),
			Status:       exportStatus(account.Enabled()),
			Env:          env,
			NativeAuth:   map[string]any{},
		}},
	}
	return json.MarshalIndent(document, "", "  ")
}

// handleAccountsExport 导出满足过滤条件的全部账号（集合级 aih-accounts）。
func (handler *Handler) handleAccountsExport(
	response http.ResponseWriter,
	request *http.Request,
) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(response)
		return
	}
	filters, err := ParseExportFilters(request.URL.Query())
	if err != nil {
		writeAPIError(response, http.StatusBadRequest, "invalid_export_query", "导出过滤参数无效")
		return
	}
	result, err := ExportAccountCollection(
		request.Context(),
		handler.management,
		handler.credentialSnapshots,
		filters,
	)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	setExportCountHeaders(response.Header(), result)
	writeExportJSON(response, result.Document, "aih-accounts.json")
}

// exportAccountEntry 把一个账号投影成可导入条目；未知凭据形态返回 false。
func exportAccountEntry(
	overview accountapp.AccountOverview,
	snapshot accountapp.CredentialSnapshot,
) (aihAccountEntry, bool) {
	account := overview.Account()
	entry := aihAccountEntry{
		Provider:     account.ProviderID(),
		AccountRef:   account.Ref().String(),
		CLIAccountID: strconv.FormatInt(account.CLIAccountID().Int64(), 10),
		Status:       exportStatus(account.Enabled()),
		Env:          map[string]string{},
		NativeAuth:   map[string]any{},
	}
	if env, err := exportStaticEnv(snapshot.Credential()); err == nil {
		entry.Env = env
		return entry, true
	}
	switch credential := snapshot.Credential().(type) {
	case *agy.OAuthAuth:
		entry.NativeAuth = map[string]any{
			"email": credential.Email(),
			"oauthToken": map[string]any{
				"auth_method": string(credential.AuthMethod()),
				"token": map[string]any{
					"access_token":    credential.AccessToken(),
					"refresh_token":   credential.RefreshToken(),
					"expires_at_ms":   credential.ExpiresAtMS(),
					"refreshed_at_ms": credential.RefreshedAtMS(),
					"token_type":      credential.TokenType(),
				},
			},
		}
		return entry, true
	case *codex.OAuthAuth:
		tokens := map[string]any{
			"access_token":  credential.AccessToken(),
			"refresh_token": credential.RefreshToken(),
			"id_token":      credential.IDToken(),
		}
		if accountID := credential.UpstreamAccountID(); accountID != "" {
			tokens["account_id"] = accountID
		}
		auth := map[string]any{
			"auth_mode":      "chatgpt",
			"OPENAI_API_KEY": nil,
			"tokens":         tokens,
		}
		if refreshedAt := credential.RefreshedAtMS(); refreshedAt > 0 {
			auth["last_refresh"] = time.UnixMilli(refreshedAt).UTC()
		}
		entry.NativeAuth = map[string]any{"auth": auth}
		return entry, true
	case *claude.OAuthAuth:
		oauth := map[string]any{
			"accessToken":  credential.AccessToken(),
			"refreshToken": credential.RefreshToken(),
			"expiresAt":    credential.ExpiresAtMS(),
			"scopes":       credential.Scopes(),
		}
		if refreshExpiry := credential.RefreshTokenExpiresAtMS(); refreshExpiry > 0 {
			oauth["refreshTokenExpiresAt"] = refreshExpiry
		}
		entry.NativeAuth = map[string]any{
			"credentials": map[string]any{"claudeAiOauth": oauth},
		}
		return entry, true
	}
	native, ok := snapshot.Credential().(*accountcore.NativeCredential)
	if !ok {
		return aihAccountEntry{}, false
	}
	var payload map[string]any
	if err := json.Unmarshal(native.Payload(), &payload); err != nil || len(payload) == 0 {
		return aihAccountEntry{}, false
	}
	entry.NativeAuth = payload
	return entry, true
}

// exportStaticEnv 只处理 Go 已能验证并回写的静态凭据形态。
func exportStaticEnv(credential accountapp.Credential) (map[string]string, error) {
	switch value := credential.(type) {
	case *codex.APIKeyAuth:
		return map[string]string{
			"OPENAI_API_KEY":  value.APIKey(),
			"OPENAI_BASE_URL": value.BaseURL(),
		}, nil
	case *claude.APIKeyAuth:
		return map[string]string{
			"ANTHROPIC_API_KEY":  value.APIKey(),
			"ANTHROPIC_BASE_URL": value.BaseURL(),
		}, nil
	case *claude.AuthTokenAuth:
		return map[string]string{
			"ANTHROPIC_AUTH_TOKEN":       value.AuthToken(),
			"ANTHROPIC_BASE_URL":         value.BaseURL(),
			"AIH_CLAUDE_CREDENTIAL_TYPE": "auth-token",
		}, nil
	case *gemini.VertexAuth:
		env := map[string]string{
			"VERTEX_AI_PROJECT_ID":  value.ProjectID(),
			"VERTEX_AI_LOCATION":    value.Location(),
			"VERTEX_AI_PLACEHOLDER": strconv.FormatBool(value.Placeholder()),
		}
		if apiKey := value.APIKey(); apiKey != "" {
			env["GEMINI_API_KEY"] = apiKey
			env["GOOGLE_API_KEY"] = apiKey
		}
		if baseURL := value.BaseURL(); baseURL != "" {
			env["GEMINI_BASE_URL"] = baseURL
		}
		return env, nil
	default:
		return nil, accountapp.ErrUnsupportedAccountExport
	}
}

func exportStatus(enabled bool) string {
	if enabled {
		return "up"
	}
	return "down"
}
